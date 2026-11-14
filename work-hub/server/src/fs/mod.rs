//! File service (D12): what the IDE sees of a view and how it changes it.
//!
//! A view is `main` (the workspace container, root `/workspace/repo`) or a workstream uuid (its
//! container, root `/workspace/worktree`). Paths are repo-relative and go through
//! [`repo_path::normalize`]. Every change the user makes (save, upload, move) is written as the
//! container user, committed on its own (FR-15a) and done under the view container's git-write
//! lock ([`ViewCtx::lock_key`]). Reading never takes the lock.
//!
//! - this module: view resolution, listing, read and save, and the shared git commit helper;
//! - [`poll`]: the one-exec poll of listings and versions;
//! - [`transfer`]: upload, move and download.

pub mod poll;
pub mod transfer;

use std::io::Read;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_util::Stream;
use serde::Serialize;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::docker::DockerError;
use crate::docker::archive::{self, FetchedFile, FileOwner, PutEntry, PutSource, TempFile};
use crate::docker::exec::{self, EXEC_TIMEOUT_DEFAULT, ExecOutput};
use crate::docker::names::{WORKSPACE_REPO_DIR, WORKSTREAM_WORKTREE_DIR};
use crate::error::ApiError;
use crate::git;
use crate::repo_path;
use crate::state::AppState;
use crate::workspaces;
use crate::workstreams;

/// Largest file the editor opens as text (D12).
pub const MAX_EDITABLE_BYTES: u64 = 2 * 1024 * 1024;

/// How many leading bytes are searched for a NUL when telling text from binary (D12).
pub const BINARY_SNIFF_BYTES: usize = 8000;

/// Extensions shown as an image (D12). HTML and SVG are never rendered.
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"];

/// The `{view}` of the workspace's own checkout.
pub const MAIN_VIEW: &str = "main";

// ---------------------------------------------------------------- view

/// A resolved view (D18): where its files are and who writes them.
#[derive(Debug, Clone)]
pub struct ViewCtx {
    /// The running container of the view.
    pub container: String,
    /// `/workspace/repo` (main) or `/workspace/worktree` (a workstream).
    pub root: &'static str,
    /// The workspace's container user; every exec and every written file uses it.
    pub user: String,
    pub uid: i32,
    pub gid: i32,
}

impl ViewCtx {
    /// The [`crate::locks::ContainerLocks`] key of the view's git writes: the container name,
    /// the same key the workspace and workstream services take around their git writes.
    pub fn lock_key(&self) -> &str {
        &self.container
    }

    /// The absolute container path of a normalized relative path.
    pub fn abs(&self, rel: &str) -> String {
        repo_path::container_path(self.root, rel)
    }

    fn owner(&self, mode: u32) -> FileOwner {
        FileOwner {
            uid: self.uid as u32,
            gid: self.gid as u32,
            mode,
        }
    }
}

/// Resolves `{view}` of workspace `ws_id` for `user_id` and makes sure its container runs.
/// A missing or foreign workspace or workstream (or a workstream of another workspace) answers
/// `not_found`; a workstream that is not open answers `not_open`.
pub async fn resolve_view(
    st: &AppState,
    user_id: i64,
    ws_id: Uuid,
    view: &str,
) -> Result<ViewCtx, ApiError> {
    let ws = workspaces::repo::get_owned(&st.db, user_id, ws_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let user = workspaces::user_of(&ws)?;
    let (container, root) = if view == MAIN_VIEW {
        (
            workspaces::ensure_workspace_container(st, &ws).await?,
            WORKSPACE_REPO_DIR,
        )
    } else {
        let id = Uuid::parse_str(view).map_err(|_| ApiError::not_found())?;
        let s = workstreams::repo::get_owned(&st.db, user_id, id)
            .await?
            .filter(|s| s.workspace_id == ws.id)
            .ok_or_else(ApiError::not_found)?;
        if !s.is_open() {
            return Err(ApiError::not_open());
        }
        (
            workstreams::ensure_open_running(st, &ws, &s).await?,
            WORKSTREAM_WORKTREE_DIR,
        )
    };
    Ok(ViewCtx {
        container,
        root,
        user: user.user,
        uid: user.uid,
        gid: user.gid,
    })
}

// ---------------------------------------------------------------- exec helpers

/// Runs `argv` in the view's container as its user; the exit code is the caller's to check.
pub(crate) async fn run(
    ctx: &ViewCtx,
    st: &AppState,
    argv: &[String],
) -> Result<ExecOutput, ApiError> {
    Ok(exec::exec_capture(
        &st.docker,
        &ctx.container,
        &ctx.user,
        argv,
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?)
}

/// Runs `argv` and fails (500) on a non-zero exit.
pub(crate) async fn run_ok(
    ctx: &ViewCtx,
    st: &AppState,
    argv: &[String],
) -> Result<ExecOutput, ApiError> {
    Ok(run(ctx, st, argv).await?.check()?)
}

/// `sh -c <script> sh <args…>`: the args are `$1…`, never parsed by the shell.
pub(crate) fn sh_args(script: &str, args: &[&str]) -> Vec<String> {
    let mut argv = vec![
        "sh".to_string(),
        "-c".to_string(),
        script.to_string(),
        "sh".to_string(),
    ];
    argv.extend(args.iter().map(|s| (*s).to_string()));
    argv
}

/// A relative path as a shell operand that can never look like an option: `.` for the root,
/// `./<rel>` otherwise.
pub(crate) fn shell_operand(rel: &str) -> String {
    if rel.is_empty() {
        ".".to_string()
    } else {
        format!("./{rel}")
    }
}

/// `<parent>/<name>`, or `name` under the root.
pub(crate) fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// The last segment of a normalized path.
pub(crate) fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// The parent of a normalized path (`""` for a top-level one).
pub(crate) fn parent_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

// ---------------------------------------------------------------- listing

/// `Entry` of the API.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub name: String,
    /// Repo-relative path.
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Epoch seconds.
    pub mtime: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

/// The `find` of one directory in scripts (`$d` is the directory operand from [`shell_operand`]):
/// type, size, mtime and name of each entry, NUL-terminated, `.git` hidden.
pub(crate) const FIND_SH: &str =
    "find \"$d\" -mindepth 1 -maxdepth 1 -not -name .git -printf '%y\\t%s\\t%T@\\t%f\\0'";

/// Parses one NUL-terminated `find` record (`%y\t%s\t%T@\t%f`) of the directory `dir`.
pub(crate) fn parse_entry(dir: &str, record: &[u8]) -> Option<Entry> {
    let text = String::from_utf8_lossy(record);
    let mut fields = text.splitn(4, '\t');
    let kind = fields.next()?;
    let size = fields.next()?.parse::<u64>().unwrap_or(0);
    let mtime = fields
        .next()?
        .parse::<f64>()
        .map(|t| t.floor() as i64)
        .unwrap_or(0);
    let name = fields.next()?;
    if name.is_empty() || name == ".git" {
        return None;
    }
    let kind = match kind {
        "d" => EntryKind::Dir,
        "l" => EntryKind::Symlink,
        _ => EntryKind::File,
    };
    Some(Entry {
        name: name.to_string(),
        path: join_rel(dir, name),
        kind,
        size,
        mtime,
    })
}

/// Directories first, then by name, case-insensitive (ties by the exact name).
pub(crate) fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.kind == EntryKind::Dir;
        let b_dir = b.kind == EntryKind::Dir;
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// Parses the whole output of [`FIND_SH`] for `dir` and sorts it.
pub fn parse_listing(dir: &str, out: &[u8]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = out
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .filter_map(|r| parse_entry(dir, r))
        .collect();
    sort_entries(&mut entries);
    entries
}

/// `GET …/list?dir=`: one directory of the view (lazy tree, D12). `not_found` when it is missing
/// or not a directory.
pub async fn list_dir(st: &AppState, ctx: &ViewCtx, dir: &str) -> Result<Vec<Entry>, ApiError> {
    let dir = repo_path::normalize(dir)?;
    let script = format!(
        "cd \"$1\" || exit 2; d=$2; [ -d \"$d\" ] && [ ! -L \"$d\" ] || exit 3; exec {FIND_SH}"
    );
    let operand = shell_operand(&dir);
    let out = run(ctx, st, &sh_args(&script, &[ctx.root, &operand])).await?;
    match out.exit_code {
        0 => Ok(parse_listing(&dir, &out.stdout)),
        3 => Err(ApiError::not_found()),
        _ => Err(ApiError::internal(format!(
            "listing {dir:?} in {} failed: {}",
            ctx.container,
            out.stderr_str()
        ))),
    }
}

// ---------------------------------------------------------------- read

/// What the IDE does with a file (`X-WorkHub-Kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Text,
    Image,
    Binary,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Text => "text",
            FileKind::Image => "image",
            FileKind::Binary => "binary",
        }
    }
}

/// `true` for the image extensions of D12 (case-insensitive).
pub fn is_image_name(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// `true` when `bytes` may be edited as text: no NUL in the first 8000 bytes and valid UTF-8.
pub fn is_text_content(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    !head.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

/// D12 kind: an image by extension; otherwise text when at most [`MAX_EDITABLE_BYTES`] and
/// text content (`content` is the whole file then); everything else is binary.
pub fn detect_kind(name: &str, size: u64, content: Option<&[u8]>) -> FileKind {
    if is_image_name(name) {
        FileKind::Image
    } else if size <= MAX_EDITABLE_BYTES && content.is_some_and(is_text_content) {
        FileKind::Text
    } else {
        FileKind::Binary
    }
}

/// A file read for `GET …/file` (and a file download). The content lives in a temp file under
/// `<DATA_DIR>/tmp` that is deleted when this is dropped; stream it with
/// [`TempFileStream::open`] on `file.file`.
#[derive(Debug)]
pub struct FileContent {
    pub file: FetchedFile,
    pub name: String,
    pub size: u64,
    pub kind: FileKind,
    /// The git blob sha of the content (`ETag`).
    pub version: String,
}

/// Fetches a regular file through the archive endpoint; `not_found` when it is missing or is a
/// directory or a symlink.
async fn fetch_regular(st: &AppState, ctx: &ViewCtx, rel: &str) -> Result<FetchedFile, ApiError> {
    match archive::get_file(
        &st.docker,
        &st.config.tmp_dir(),
        &ctx.container,
        &ctx.abs(rel),
    )
    .await
    {
        Ok(Some(f)) => Ok(f),
        Ok(None) => Err(ApiError::not_found()),
        // `get_file` refuses an entry that is not a regular file (a directory or a symlink).
        Err(DockerError::Failed(msg)) if msg.ends_with("is not a regular file") => {
            Err(ApiError::not_found())
        }
        Err(e) => Err(e.into()),
    }
}

/// Hashes the fetched file as a git blob and tells its kind (blocking; run off the runtime).
fn hash_and_kind(path: &Path, name: &str, size: u64) -> std::io::Result<(String, FileKind)> {
    let mut f = std::fs::File::open(path)?;
    if size <= MAX_EDITABLE_BYTES {
        let mut all = Vec::with_capacity(size as usize);
        f.read_to_end(&mut all)?;
        let kind = detect_kind(name, all.len() as u64, Some(&all));
        return Ok((git::blob_sha(&all), kind));
    }
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {size}\0").as_bytes());
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let sha = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((sha, detect_kind(name, size, None)))
}

/// `GET …/file?path=`: the content, its D12 kind and its version.
pub async fn read_file(st: &AppState, ctx: &ViewCtx, path: &str) -> Result<FileContent, ApiError> {
    let rel = repo_path::normalize(path)?;
    if rel.is_empty() {
        return Err(ApiError::invalid_path());
    }
    let file = fetch_regular(st, ctx, &rel).await?;
    let name = base_name(&rel).to_string();
    let size = file.size;
    let local = file.path().to_path_buf();
    let n = name.clone();
    let (version, kind) = tokio::task::spawn_blocking(move || hash_and_kind(&local, &n, size))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    Ok(FileContent {
        file,
        name,
        size,
        kind,
        version,
    })
}

// ---------------------------------------------------------------- save

/// The version an `If-Match` header carries: `"<sha>"`, `W/"<sha>"` or a bare sha.
pub fn parse_if_match(header: &str) -> String {
    let v = header.trim();
    let v = v.strip_prefix("W/").unwrap_or(v);
    v.trim_matches('"').to_string()
}

/// `PUT …/file?path=` (D12 Save). `if_match` is the raw `If-Match` header; a missing one counts
/// as a mismatch. The body must be text (valid UTF-8 without NUL) or the answer is `not_text`.
/// Under the container lock: recompute the version on disk (`changed_on_disk {version}` on a
/// mismatch, `version: null` when the file is gone), write the body as the container user
/// keeping the file's mode, commit only that path ("Edit <path>"; nothing is committed when the
/// path is ignored or unchanged) and return the new version.
pub async fn save_file(
    st: &AppState,
    ctx: &ViewCtx,
    path: &str,
    if_match: Option<&str>,
    body: Bytes,
) -> Result<String, ApiError> {
    let rel = repo_path::normalize(path)?;
    if rel.is_empty() {
        return Err(ApiError::invalid_path());
    }
    if body.contains(&0) || std::str::from_utf8(&body).is_err() {
        return Err(ApiError::not_text());
    }
    let expected = if_match.map(parse_if_match);

    let _lock = st.locks.lock(ctx.lock_key()).await;
    // Mode and version on disk in one exec; exit 3 when it is not a regular file any more.
    let script = "cd \"$1\" || exit 2; p=$2; [ -f \"$p\" ] && [ ! -L \"$p\" ] || exit 3; \
                  stat -c %a -- \"$p\" && git -c core.quotepath=off hash-object --no-filters -- \"$p\"";
    let operand = shell_operand(&rel);
    let out = run(ctx, st, &sh_args(script, &[ctx.root, &operand])).await?;
    if out.exit_code == 3 {
        return Err(ApiError::changed_on_disk(String::new())
            .with_detail("version", serde_json::Value::Null));
    }
    let out = out.check()?;
    let text = out.stdout_str();
    let mut lines = text.lines().map(str::trim);
    let mode = lines
        .next()
        .and_then(|m| u32::from_str_radix(m, 8).ok())
        .unwrap_or(0o644);
    let current = lines.next().unwrap_or_default().to_string();
    if expected.as_deref() != Some(current.as_str()) {
        return Err(ApiError::changed_on_disk(current));
    }

    archive::put_files(
        &st.docker,
        &st.config.tmp_dir(),
        &ctx.container,
        &ctx.abs(parent_of(&rel)),
        vec![PutEntry {
            path: base_name(&rel).to_string(),
            source: PutSource::Bytes(body.clone()),
        }],
        ctx.owner(mode & 0o7777),
    )
    .await?;
    commit_paths(st, ctx, std::slice::from_ref(&rel), |_| {
        format!("Edit {rel}")
    })
    .await?;
    Ok(git::blob_sha(&body))
}

// ---------------------------------------------------------------- commits

/// The paths of `paths` that git ignores (`check-ignore`; tracked paths never count as ignored).
async fn ignored_paths(
    st: &AppState,
    ctx: &ViewCtx,
    paths: &[String],
) -> Result<Vec<String>, ApiError> {
    // `-z` works only with `--stdin`: the paths go in NUL-terminated, the ignored ones come out so.
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        input.push(0);
    }
    let out = exec::exec_capture(
        &st.docker,
        &ctx.container,
        &ctx.user,
        &git::git(ctx.root, &["check-ignore", "-z", "--stdin"]),
        Some(Bytes::from(input)),
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    match out.exit_code {
        0 => Ok(out
            .stdout
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect()),
        1 => Ok(Vec::new()),
        _ => Err(ApiError::internal(format!(
            "git check-ignore in {} failed: {}",
            ctx.container,
            out.stderr_str()
        ))),
    }
}

/// One commit of exactly `paths` (FR-15a): ignored paths are dropped, the rest are staged with
/// `add -A` (so deletions count) and committed with `commit -- <paths>`, leaving anything else
/// the agent has staged alone. Returns the committed paths; nothing is committed (empty result)
/// when every path is ignored or nothing changed. `message` gets the paths that are committed.
/// The caller holds the container lock.
pub(crate) async fn commit_paths(
    st: &AppState,
    ctx: &ViewCtx,
    paths: &[String],
    message: impl FnOnce(&[&str]) -> String,
) -> Result<Vec<String>, ApiError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let ignored = ignored_paths(st, ctx, paths).await?;
    let keep: Vec<&str> = paths
        .iter()
        .filter(|p| !ignored.contains(p))
        .map(String::as_str)
        .collect();
    if keep.is_empty() {
        return Ok(Vec::new());
    }
    let with = |head: &[&'static str]| {
        let mut args: Vec<&str> = head.to_vec();
        args.push("--");
        args.extend(keep.iter().copied());
        git::git(ctx.root, &args)
    };
    run_ok(ctx, st, &with(&["add", "-A"])).await?;
    let diff = run(ctx, st, &with(&["diff", "--cached", "--quiet"])).await?;
    match diff.exit_code {
        0 => return Ok(Vec::new()),
        1 => {}
        _ => {
            return Err(ApiError::internal(format!(
                "git diff --cached in {} failed: {}",
                ctx.container,
                diff.stderr_str()
            )));
        }
    }
    let message = message(&keep);
    let mut args: Vec<&str> = vec!["commit", "-q", "-m", &message, "--"];
    args.extend(keep.iter().copied());
    run_ok(ctx, st, &git::git(ctx.root, &args)).await?;
    Ok(keep.into_iter().map(str::to_string).collect())
}

// ---------------------------------------------------------------- streaming temp files

/// A temp file streamed as an HTTP body; the file is closed and then deleted when the stream is
/// dropped (after the response is sent or the client went away).
pub struct TempFileStream {
    // Declared first so the handle is closed before the temp file is deleted (Windows).
    inner: ReaderStream<tokio::fs::File>,
    _file: TempFile,
}

impl TempFileStream {
    pub async fn open(file: TempFile) -> std::io::Result<Self> {
        let handle = tokio::fs::File::open(file.path()).await?;
        Ok(TempFileStream {
            inner: ReaderStream::new(handle),
            _file: file,
        })
    }
}

impl Stream for TempFileStream {
    type Item = std::io::Result<Bytes>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.get_mut().inner).poll_next(cx)
    }
}
