//! Files in and out of containers through the Engine's archive endpoint (`docker cp`), which
//! works on volume-mounted paths too (volume-copy PoC). Temp files go to `<DATA_DIR>/tmp` and are
//! deleted after use (D4).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use bollard::query_parameters::{
    DownloadFromContainerOptionsBuilder, UploadToContainerOptionsBuilder,
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt, TryStreamExt};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use super::{Docker, DockerError, DockerResult};

/// A temp file under `<DATA_DIR>/tmp`, deleted when dropped.
#[derive(Debug)]
pub struct TempFile {
    path: PathBuf,
}

impl TempFile {
    /// A fresh unique path `<tmp_dir>/wh-<uuid><suffix>` (the directory is created; the file is
    /// not).
    pub fn new_in(tmp_dir: &Path, suffix: &str) -> DockerResult<Self> {
        std::fs::create_dir_all(tmp_dir)?;
        Ok(TempFile {
            path: tmp_dir.join(format!("wh-{}{suffix}", Uuid::new_v4())),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.path)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!("cannot delete temp file {}: {e}", self.path.display());
        }
    }
}

/// A regular file fetched by [`get_file`].
#[derive(Debug)]
pub struct FetchedFile {
    /// The extracted content (deleted when this is dropped).
    pub file: TempFile,
    pub size: u64,
    /// Unix mode bits from the archive.
    pub mode: u32,
}

impl FetchedFile {
    pub fn path(&self) -> &Path {
        self.file.path()
    }

    /// Reads the whole content (for small files such as the agent profile).
    pub async fn read_all(&self) -> DockerResult<Vec<u8>> {
        Ok(tokio::fs::read(self.file.path()).await?)
    }
}

/// The raw tar stream of `path` (a file or a directory, whose entries are prefixed with its base
/// name), as the archive endpoint sends it.
pub fn tar_stream(
    docker: &Docker,
    container: &str,
    path: &str,
) -> impl Stream<Item = DockerResult<Bytes>> + Send + use<> {
    let options = DownloadFromContainerOptionsBuilder::default()
        .path(path)
        .build();
    docker
        .download_from_container(container, Some(options))
        .map_err(DockerError::from)
}

/// Fetches the regular file `path` from `container`: the archive is written to a temp file in
/// `tmp_dir`, its single entry extracted to another temp file and the archive deleted.
/// `Ok(None)` when the path does not exist; a directory or symlink is [`DockerError::Failed`].
pub async fn get_file(
    docker: &Docker,
    tmp_dir: &Path,
    container: &str,
    path: &str,
) -> DockerResult<Option<FetchedFile>> {
    let tar = TempFile::new_in(tmp_dir, ".tar")?;
    {
        let mut out = tokio::fs::File::create(tar.path()).await?;
        let mut stream = std::pin::pin!(tar_stream(docker, container, path));
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => out.write_all(&bytes).await?,
                Err(DockerError::NotFound(_)) => return Ok(None),
                Err(e) => return Err(e),
            }
        }
        out.flush().await?;
    }
    let dest = TempFile::new_in(tmp_dir, ".file")?;
    let tar_path = tar.path().to_path_buf();
    let dest_path = dest.path().to_path_buf();
    let wanted = path.to_string();
    let (size, mode) =
        tokio::task::spawn_blocking(move || extract_single(&tar_path, &dest_path, &wanted))
            .await
            .map_err(|e| DockerError::Failed(format!("extract task failed: {e}")))??;
    drop(tar);
    Ok(Some(FetchedFile {
        file: dest,
        size,
        mode,
    }))
}

fn extract_single(tar_path: &Path, dest: &Path, wanted: &str) -> DockerResult<(u64, u32)> {
    let file = std::fs::File::open(tar_path)?;
    let mut archive = tar::Archive::new(std::io::BufReader::new(file));
    let mut entries = archive.entries()?;
    let Some(entry) = entries.next() else {
        return Err(DockerError::Failed(format!(
            "the archive of {wanted} is empty"
        )));
    };
    let mut entry = entry?;
    let header = entry.header();
    if !header.entry_type().is_file() {
        return Err(DockerError::Failed(format!(
            "{wanted} is not a regular file"
        )));
    }
    let mode = header.mode().unwrap_or(0o644);
    let mut out = std::fs::File::create(dest)?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = entry.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        size += n as u64;
    }
    out.flush()?;
    Ok((size, mode))
}

/// The content of one file written by [`put_files`].
#[derive(Debug, Clone)]
pub enum PutSource {
    Bytes(Bytes),
    /// A local file (e.g. an upload spooled to `<DATA_DIR>/tmp`).
    File(PathBuf),
}

/// One file written by [`put_files`].
#[derive(Debug, Clone)]
pub struct PutEntry {
    /// `/`-separated path relative to the target directory (already validated by the caller).
    pub path: String,
    pub source: PutSource,
}

/// Owner and mode of the files written by [`put_files`].
#[derive(Debug, Clone, Copy)]
pub struct FileOwner {
    pub uid: u32,
    pub gid: u32,
    /// Mode of the files (directories created on the way get 0755).
    pub mode: u32,
}

/// Writes `entries` under the existing directory `dir` of `container`, each file owned by
/// `owner.uid:owner.gid` with `owner.mode`. Missing parent directories inside `dir` are created
/// with the same owner and mode 0755. The tar is built in a temp file in `tmp_dir` and streamed
/// to the archive endpoint, which keeps the owners from the tar headers.
pub async fn put_files(
    docker: &Docker,
    tmp_dir: &Path,
    container: &str,
    dir: &str,
    entries: Vec<PutEntry>,
    owner: FileOwner,
) -> DockerResult<()> {
    let tar = TempFile::new_in(tmp_dir, ".tar")?;
    let tar_path = tar.path().to_path_buf();
    let FileOwner { uid, gid, mode } = owner;
    tokio::task::spawn_blocking(move || build_tar(&tar_path, &entries, uid, gid, mode))
        .await
        .map_err(|e| DockerError::Failed(format!("tar task failed: {e}")))??;

    let file = tokio::fs::File::open(tar.path()).await?;
    let body = bollard::body_try_stream(tokio_util::io::ReaderStream::new(file));
    let options = UploadToContainerOptionsBuilder::default().path(dir).build();
    docker
        .upload_to_container(container, Some(options), body)
        .await?;
    drop(tar);
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn header(kind: tar::EntryType, size: u64, uid: u32, gid: u32, mode: u32) -> tar::Header {
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(kind);
    h.set_size(size);
    h.set_uid(u64::from(uid));
    h.set_gid(u64::from(gid));
    h.set_mode(mode);
    h.set_mtime(now_secs());
    h
}

fn build_tar(
    tar_path: &Path,
    entries: &[PutEntry],
    uid: u32,
    gid: u32,
    mode: u32,
) -> DockerResult<()> {
    let out = std::io::BufWriter::new(std::fs::File::create(tar_path)?);
    let mut builder = tar::Builder::new(out);
    let mut dirs_done = std::collections::HashSet::new();
    for entry in entries {
        let rel = entry.path.trim_matches('/');
        if rel.is_empty() {
            return Err(DockerError::Failed("empty path in put_files".into()));
        }
        // Parent directories first, each once.
        let parts: Vec<&str> = rel.split('/').collect();
        for i in 1..parts.len() {
            let parent = parts[..i].join("/");
            if dirs_done.insert(parent.clone()) {
                let mut h = header(tar::EntryType::Directory, 0, uid, gid, 0o755);
                builder.append_data(&mut h, format!("{parent}/"), std::io::empty())?;
            }
        }
        match &entry.source {
            PutSource::Bytes(data) => {
                let mut h = header(tar::EntryType::Regular, data.len() as u64, uid, gid, mode);
                builder.append_data(&mut h, rel, &data[..])?;
            }
            PutSource::File(src) => {
                let f = std::fs::File::open(src)?;
                let len = f.metadata()?.len();
                let mut h = header(tar::EntryType::Regular, len, uid, gid, mode);
                builder.append_data(&mut h, rel, f)?;
            }
        }
    }
    builder.into_inner()?.flush()?;
    Ok(())
}
