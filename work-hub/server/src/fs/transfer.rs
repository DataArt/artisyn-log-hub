//! Upload, move and download (D12). Upload and move write under the view container's lock and
//! end with one commit of exactly the paths they touched.

use std::io::{Read, Write};
use std::path::Path;

use super::{
    FileContent, ViewCtx, base_name, commit_paths, join_rel, parent_of, read_file, run, sh_args,
    shell_operand,
};
use crate::docker::archive::{self, PutEntry, PutSource, TempFile};
use crate::error::ApiError;
use crate::git;
use crate::repo_path;
use crate::state::AppState;

/// Mode of uploaded files.
pub const UPLOAD_MODE: u32 = 0o644;

/// The zip name of the view root when it is downloaded as a folder.
pub const ROOT_ZIP_NAME: &str = "project";

// ---------------------------------------------------------------- upload

/// One uploaded file: the multipart part's filename (a relative path under the drop target) and
/// its content spooled by the HTTP layer to a temp file in `<DATA_DIR>/tmp`.
#[derive(Debug)]
pub struct UploadFile {
    pub name: String,
    pub file: TempFile,
}

/// `$1` = root, then the operands; prints every one that exists (NUL-terminated).
const EXISTING_SH: &str = "cd \"$1\" || exit 2; shift; for p in \"$@\"; do if [ -e \"$p\" ] || [ -L \"$p\" ]; then printf '%s\\0' \"$p\"; fi; done";

/// The commit message of an upload into `dir` ("" = the project root).
pub fn upload_message(count: usize, dir: &str) -> String {
    let target = if dir.is_empty() { "project" } else { dir };
    format!("Upload {count} file(s) to {target}")
}

/// `POST …/upload?dir=&overwrite=` (D12 Upload). Every filename is joined to `dir` and
/// normalized (`invalid_path` otherwise; a later duplicate wins). Under the container lock:
/// without `overwrite`, any existing target answers `target_exists {paths}`; the files are
/// written in one tar owned by the container user (missing folders are created) and the
/// non-ignored ones committed together. Returns the repo-relative paths written.
pub async fn upload(
    st: &AppState,
    ctx: &ViewCtx,
    dir: &str,
    overwrite: bool,
    files: Vec<UploadFile>,
) -> Result<Vec<String>, ApiError> {
    let dir = repo_path::normalize(dir)?;
    let mut targets: Vec<(String, UploadFile)> = Vec::new();
    for f in files {
        let rel = repo_path::normalize(&join_rel(&dir, f.name.trim_start_matches('/')))?;
        if rel.is_empty() || (!dir.is_empty() && !rel.starts_with(&format!("{dir}/"))) {
            return Err(ApiError::invalid_path());
        }
        targets.retain(|(p, _)| *p != rel);
        targets.push((rel, f));
    }
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let paths: Vec<String> = targets.iter().map(|(p, _)| p.clone()).collect();

    let _lock = st.locks.lock(ctx.lock_key()).await;
    if !overwrite {
        let existing = existing_paths(st, ctx, &paths).await?;
        if !existing.is_empty() {
            return Err(ApiError::target_exists(existing));
        }
    }

    let entries: Vec<PutEntry> = targets
        .iter()
        .map(|(rel, f)| PutEntry {
            path: rel.clone(),
            source: PutSource::File(f.file.path().to_path_buf()),
        })
        .collect();
    archive::put_files(
        &st.docker,
        &st.config.tmp_dir(),
        &ctx.container,
        ctx.root,
        entries,
        ctx.owner(UPLOAD_MODE),
    )
    .await?;
    // The spooled parts can go now.
    drop(targets);

    commit_paths(st, ctx, &paths, |kept| upload_message(kept.len(), &dir)).await?;
    Ok(paths)
}

/// The paths of `paths` (normalized, relative) that exist in the view (symlinks included).
async fn existing_paths(
    st: &AppState,
    ctx: &ViewCtx,
    paths: &[String],
) -> Result<Vec<String>, ApiError> {
    let operands: Vec<String> = paths.iter().map(|p| shell_operand(p)).collect();
    let mut args: Vec<&str> = vec![ctx.root];
    args.extend(operands.iter().map(String::as_str));
    let out = run(ctx, st, &sh_args(EXISTING_SH, &args)).await?.check()?;
    Ok(out
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| {
            let s = String::from_utf8_lossy(p);
            s.strip_prefix("./").unwrap_or(&s).to_string()
        })
        .collect())
}

// ---------------------------------------------------------------- move

/// `$1` root, `$2` from, `$3` to-dir, `$4` to, `$5` overwrite (1/0). Exit 3: no source, 4: no
/// target folder, 5: the target exists and overwrite is off.
const MOVE_SH: &str = concat!(
    "cd \"$1\" || exit 2; f=$2; d=$3; t=$4; ",
    "[ -e \"$f\" ] || [ -L \"$f\" ] || exit 3; ",
    "[ -d \"$d\" ] || exit 4; ",
    "if [ -e \"$t\" ] || [ -L \"$t\" ]; then [ \"$5\" = 1 ] || exit 5; rm -rf -- \"$t\" || exit 6; fi; ",
    "exec mv -T -- \"$f\" \"$t\""
);

/// `POST …/move` (D12 Move): moves `from` into the folder `to_dir` under the container lock.
/// A move into itself (or below itself) is `invalid_path`; a missing source or folder is
/// `not_found`; a taken target without `overwrite` is `target_exists {paths:[to]}` (with it, the
/// target is replaced). Then `add -A -- <from> <to>` and one commit "Move <from> to <to>".
/// Returns the new path.
pub async fn move_path(
    st: &AppState,
    ctx: &ViewCtx,
    from: &str,
    to_dir: &str,
    overwrite: bool,
) -> Result<String, ApiError> {
    let from = repo_path::normalize(from)?;
    let to_dir = repo_path::normalize(to_dir)?;
    if from.is_empty() || to_dir == from || to_dir.starts_with(&format!("{from}/")) {
        return Err(ApiError::invalid_path());
    }
    let to = join_rel(&to_dir, base_name(&from));
    if parent_of(&from) == to_dir {
        return Ok(from); // already there
    }

    let _lock = st.locks.lock(ctx.lock_key()).await;
    // Whether git knows the source, so its removal can be staged (an untracked, now-missing
    // pathspec would make `git add` fail).
    let tracked = run(
        ctx,
        st,
        &git::git(ctx.root, &["ls-files", "-z", "--", &from]),
    )
    .await?
    .check()?;
    let from_tracked = !tracked.stdout.is_empty();

    let (f, d, t) = (
        shell_operand(&from),
        shell_operand(&to_dir),
        shell_operand(&to),
    );
    let flag = if overwrite { "1" } else { "0" };
    let out = run(ctx, st, &sh_args(MOVE_SH, &[ctx.root, &f, &d, &t, flag])).await?;
    match out.exit_code {
        0 => {}
        3 | 4 => return Err(ApiError::not_found()),
        5 => return Err(ApiError::target_exists(vec![to])),
        _ => {
            return Err(ApiError::internal(format!(
                "moving {from:?} to {to:?} in {} failed: {}",
                ctx.container,
                out.stderr_str()
            )));
        }
    }

    let mut paths = Vec::with_capacity(2);
    if from_tracked {
        paths.push(from.clone());
    }
    paths.push(to.clone());
    commit_paths(st, ctx, &paths, |_| format!("Move {from} to {to}")).await?;
    Ok(to)
}

// ---------------------------------------------------------------- download

/// What `GET …/download` sends.
#[derive(Debug)]
pub enum DownloadBody {
    /// A file, as read by [`read_file`].
    File(FileContent),
    /// A folder zipped into a temp file in `<DATA_DIR>/tmp` (deleted when dropped, i.e. after
    /// it was sent through [`super::TempFileStream`]).
    Zip { file: TempFile, size: u64 },
}

#[derive(Debug)]
pub struct Download {
    /// The attachment's file name (`<folder>.zip` for a folder).
    pub name: String,
    pub body: DownloadBody,
}

/// Prints `d` for a directory, `f` for anything else that exists, `-` when missing.
const KIND_SH: &str = "cd \"$1\" || exit 2; p=$2; if [ -d \"$p\" ] && [ ! -L \"$p\" ]; then echo d; elif [ -e \"$p\" ]; then echo f; else echo -; fi";

/// `GET …/download?path=` (D12 Download): a file as is, a folder (the root included) as
/// `<name>.zip` without its `.git`.
pub async fn download(st: &AppState, ctx: &ViewCtx, path: &str) -> Result<Download, ApiError> {
    let rel = repo_path::normalize(path)?;
    let operand = shell_operand(&rel);
    let out = run(ctx, st, &sh_args(KIND_SH, &[ctx.root, &operand]))
        .await?
        .check()?;
    match out.stdout_str().trim() {
        "d" => {}
        "f" => {
            let content = read_file(st, ctx, &rel).await?;
            return Ok(Download {
                name: content.name.clone(),
                body: DownloadBody::File(content),
            });
        }
        _ => return Err(ApiError::not_found()),
    }

    let stem = if rel.is_empty() {
        ROOT_ZIP_NAME.to_string()
    } else {
        base_name(&rel).to_string()
    };
    let tmp_dir = st.config.tmp_dir();
    let tar = TempFile::new_in(&tmp_dir, ".tar")?;
    {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut out = tokio::fs::File::create(tar.path())
            .await
            .map_err(ApiError::internal)?;
        let mut stream = std::pin::pin!(archive::tar_stream(
            &st.docker,
            &ctx.container,
            &ctx.abs(&rel)
        ));
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => out.write_all(&bytes).await.map_err(ApiError::internal)?,
                Err(e) if e.is_not_found() => return Err(ApiError::not_found()),
                Err(e) => return Err(e.into()),
            }
        }
        out.flush().await.map_err(ApiError::internal)?;
    }
    let zip = TempFile::new_in(&tmp_dir, ".zip")?;
    let (tar_path, zip_path, s) = (
        tar.path().to_path_buf(),
        zip.path().to_path_buf(),
        stem.clone(),
    );
    let size = tokio::task::spawn_blocking(move || tar_to_zip(&tar_path, &zip_path, &s))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    drop(tar);
    Ok(Download {
        name: format!("{stem}.zip"),
        body: DownloadBody::Zip { file: zip, size },
    })
}

/// Converts the archive endpoint's tar of a folder (entries prefixed with the folder's name)
/// into a zip whose entries are prefixed with `stem`. `.git` entries are left out, and so are
/// symlinks and special files (not portable in a zip). Returns the zip's size.
fn tar_to_zip(tar_path: &Path, zip_path: &Path, stem: &str) -> Result<u64, String> {
    use zip::CompressionMethod;
    use zip::write::SimpleFileOptions;

    let input = std::fs::File::open(tar_path).map_err(|e| e.to_string())?;
    let mut archive = tar::Archive::new(std::io::BufReader::new(input));
    let output = std::fs::File::create(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(output);
    let mut buf = vec![0u8; 64 * 1024];

    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let parts: Vec<String> = path
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        // The first component is the folder's own name.
        let rest = parts.get(1..).unwrap_or_default();
        if rest.iter().any(|p| p == ".git") {
            continue;
        }
        let name = std::iter::once(stem.to_string())
            .chain(rest.iter().cloned())
            .collect::<Vec<_>>()
            .join("/");
        let header = entry.header();
        let mode = header.mode().unwrap_or(0o644) & 0o7777;
        let kind = header.entry_type();
        if kind.is_dir() {
            let opts = SimpleFileOptions::default().unix_permissions(mode | 0o700);
            zip.add_directory(format!("{name}/"), opts)
                .map_err(|e| e.to_string())?;
        } else if kind.is_file() {
            let size = entry.size();
            let opts = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(mode)
                .large_file(size >= u64::from(u32::MAX));
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            loop {
                let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            }
        }
    }
    let file = zip.finish().map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    Ok(size)
}
