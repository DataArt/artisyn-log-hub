//! First-launch downloads (FR-10). Three items, each listed with name, version, size and
//! progress before and during the download:
//!
//! - **Node.js** — the official win-x64 zip (Windows) or darwin tarball (macOS) from nodejs.org/dist
//!   (the devcontainer CLI's runtime);
//! - **Dev Container CLI** — the `@devcontainers/cli` npm tarball (no runtime dependencies);
//! - **Standard Equipment** — the Linux Node archive for the engine's architecture, downloaded on
//!   the host like the other two and sent in the build context, plus the pinned Ubuntu base pulled
//!   by digest and the `agentbook-std:<v>` image built through the engine.
//!
//! Host files are fetched with the OS proxy settings, written to `<name>.part`, checked against
//! the sha256 constants in `agentbook_core::pins` and only then renamed; archives are extracted
//! into a temp folder that is renamed into place, so nothing half-downloaded or half-extracted is
//! ever used. A second launch finds every item and downloads nothing. The items are independent:
//! folders without a devcontainer work when only the CLI or Node is missing.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agentbook_core::pins::{
    ArchiveKind, DEVCONTAINERS_CLI_SHA256, DEVCONTAINERS_CLI_SIZE, DEVCONTAINERS_CLI_VERSION,
    NODE_LINUX_X64_SIZE, NODE_VERSION, NODE_WIN_X64_SIZE, NodeHostArchive, node_host_archive,
    node_linux_archive, node_linux_size,
};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::action::Action;
use crate::assets::standard;
use crate::docker::images;
use crate::engine::{Ctx, EngineError, EngineResult};
use crate::snapshot::{Dependency, DependencyId, DependencyState};

const NODE_NAME: &str = "Node.js";
const CLI_NAME: &str = "Dev Container CLI";
const STD_NAME: &str = "Standard Equipment";

/// The production download sources.
const NODE_BASE: &str = "https://nodejs.org/dist";
const NPM_BASE: &str = "https://registry.npmjs.org";

/// The three items, before anything is known about them.
pub(crate) fn initial_list() -> Vec<Dependency> {
    let item = |id, name: &str, version: String, size| Dependency {
        id,
        name: name.to_string(),
        version,
        size,
        done: 0,
        state: DependencyState::Missing,
        detail: String::new(),
    };
    vec![
        item(
            DependencyId::Node,
            NODE_NAME,
            NODE_VERSION.to_string(),
            host_node_archive().map_or(NODE_WIN_X64_SIZE, |a| a.size),
        ),
        item(
            DependencyId::DevcontainersCli,
            CLI_NAME,
            DEVCONTAINERS_CLI_VERSION.to_string(),
            DEVCONTAINERS_CLI_SIZE,
        ),
        item(
            DependencyId::StandardEquipment,
            STD_NAME,
            standard::version(),
            NODE_LINUX_X64_SIZE,
        ),
    ]
}

fn set(ctx: &Ctx, id: DependencyId, f: impl FnOnce(&mut Dependency)) {
    ctx.update_snapshot(|s| {
        if let Some(d) = s.dependencies.iter_mut().find(|d| d.id == id) {
            f(d);
        }
    });
}

/// `(node base, npm base)`: the scenario stand's file server or the real hosts.
fn sources(ctx: &Ctx) -> (String, String) {
    match ctx.test.as_ref().and_then(|t| t.download_base.as_deref()) {
        Some(base) => {
            let base = base.trim_end_matches('/');
            (format!("{base}/nodejs/dist"), format!("{base}/npm"))
        }
        None => (NODE_BASE.to_string(), NPM_BASE.to_string()),
    }
}

/// The host Node executable inside the extracted runtime.
pub(crate) fn node_exe(ctx: &Ctx) -> PathBuf {
    if ctx.platform.is_windows() {
        ctx.layout.node_dir().join("node.exe")
    } else {
        ctx.layout.node_dir().join("bin").join("node")
    }
}

/// The CLI's entry script inside the extracted package.
pub(crate) fn cli_script(ctx: &Ctx) -> PathBuf {
    ctx.layout.cli_dir().join("devcontainer.js")
}

/// Whether the devcontainer tools (Node and the CLI) are both in place.
pub(crate) fn devcontainer_tools_ready(ctx: &Ctx) -> bool {
    node_exe(ctx).is_file() && cli_script(ctx).is_file()
}

/// The plain message when project Equipment is asked for before the tools were downloaded.
pub const TOOLS_MISSING_MESSAGE: &str = "The devcontainer tools are not downloaded yet. Download \
     the dependencies (Retry on the first-launch screen) and try again.";

/// Marks each item Ready or Missing from what is on disk and in Docker, without downloading.
pub(crate) async fn refresh_status(ctx: &Arc<Ctx>) {
    let node = node_exe(ctx).is_file();
    let cli = cli_script(ctx).is_file();
    let std_ready = match ctx.docker().await {
        Ok(d) => images::exists(&d, &standard::image_tag())
            .await
            .unwrap_or(false),
        Err(_) => false,
    };
    for (id, ready) in [
        (DependencyId::Node, node),
        (DependencyId::DevcontainersCli, cli),
        (DependencyId::StandardEquipment, std_ready),
    ] {
        set(ctx, id, |d| {
            if !matches!(d.state, DependencyState::Downloading) {
                d.state = if ready {
                    DependencyState::Ready
                } else {
                    DependencyState::Missing
                };
                if ready {
                    d.done = d.size;
                }
            }
        });
    }
    ctx.update_snapshot(|s| s.dependencies_checked = true);
}

/// Why a download failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// Network, HTTP status, a cut connection or a local write error.
    Failed(String),
    /// The file arrived whole but did not match its checksum.
    Mismatch { expected: String, actual: String },
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(m) => f.write_str(m),
            Self::Mismatch { expected, actual } => {
                write!(f, "checksum mismatch: expected {expected}, got {actual}")
            }
        }
    }
}

impl std::error::Error for DownloadError {}

/// Downloads `url` to `dest`: written to `dest.part`, checked against `sha256`, then renamed.
/// On any failure the part file is deleted and `dest` is left as it was (absent). `progress`
/// gets the bytes written so far.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
    mut progress: impl FnMut(u64) + Send,
) -> Result<(), DownloadError> {
    let part = part_path(dest);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            DownloadError::Failed(format!("cannot create {}: {e}", parent.display()))
        })?;
    }
    let _ = tokio::fs::remove_file(&part).await;
    let result = fetch_to(client, url, &part, &mut progress).await;
    let actual = match result {
        Ok(hash) => hash,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
    };
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(DownloadError::Mismatch {
            expected: sha256.to_string(),
            actual,
        });
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| {
        DownloadError::Failed(format!(
            "cannot move the file into place ({}): {e}",
            dest.display()
        ))
    })
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// Streams the body into `part`, hashing it; returns the lowercase hex sha256.
async fn fetch_to(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    progress: &mut (impl FnMut(u64) + Send),
) -> Result<String, DownloadError> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| DownloadError::Failed(describe_reqwest(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(DownloadError::Failed(format!(
            "the server answered {status}"
        )));
    }
    let expected_len = resp.content_length();
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|e| DownloadError::Failed(format!("cannot write {}: {e}", part.display())))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            DownloadError::Failed(format!(
                "the download was interrupted ({})",
                describe_reqwest(&e)
            ))
        })?;
        file.write_all(&chunk)
            .await
            .map_err(|e| DownloadError::Failed(format!("cannot write {}: {e}", part.display())))?;
        hasher.update(&chunk);
        written += chunk.len() as u64;
        progress(written);
    }
    file.flush()
        .await
        .map_err(|e| DownloadError::Failed(format!("cannot write {}: {e}", part.display())))?;
    drop(file);
    if let Some(len) = expected_len
        && written != len
    {
        return Err(DownloadError::Failed(format!(
            "the download was interrupted ({written} of {len} bytes)"
        )));
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn describe_reqwest(e: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        text.push_str(": ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    text
}

/// The plain message for a failed item.
fn failure_message(name: &str, version: &str, e: &DownloadError) -> String {
    match e {
        DownloadError::Mismatch { .. } => format!(
            "The downloaded {name} {version} did not match its checksum and was not used. Press \
             Retry."
        ),
        DownloadError::Failed(why) => format!(
            "Could not download {name} {version}: {why}. Check the network connection and press \
             Retry."
        ),
    }
}

/// Downloads every missing item (and Retry). Items are independent: one failing does not stop
/// the others. Fails with the first item's message when any failed.
pub(crate) async fn download_all(ctx: &Arc<Ctx>, action: &Action) -> EngineResult<()> {
    refresh_status(ctx).await;
    let mut failures: Vec<String> = Vec::new();
    action.step(1, 3, "Downloading Node.js");
    if let Err(e) = ensure_node(ctx, action).await {
        failures.push(e.0);
    }
    action.step(2, 3, "Downloading the Dev Container CLI");
    if let Err(e) = ensure_cli(ctx, action).await {
        failures.push(e.0);
    }
    action.step(3, 3, "Getting the standard Equipment");
    if let Err(e) = ensure_standard(ctx, action).await {
        failures.push(e.0);
    }
    match failures.into_iter().next() {
        None => Ok(()),
        Some(first) => Err(EngineError(first)),
    }
}

fn is_ready(ctx: &Ctx, id: DependencyId) -> bool {
    ctx.read_snapshot(|s| {
        s.dependency(id)
            .is_some_and(|d| d.state == DependencyState::Ready)
    })
}

/// Downloads one host file with progress on item `id`; marks it Failed on error.
/// The item a host file belongs to: id, name and version.
struct Item<'a> {
    id: DependencyId,
    name: &'a str,
    version: &'a str,
}

async fn fetch_item(
    ctx: &Arc<Ctx>,
    action: &Action,
    item: Item<'_>,
    url: &str,
    dest: &Path,
    sha256: &str,
) -> EngineResult<()> {
    let Item { id, name, version } = item;
    action.line(&format!("downloading {url}"));
    set(ctx, id, |d| {
        d.state = DependencyState::Downloading;
        d.done = 0;
        d.detail = "Downloading".into();
    });
    let progress_ctx = ctx.clone();
    let result = download_verified(&ctx.http, url, dest, sha256, move |done| {
        set(&progress_ctx, id, |d| d.done = done);
    })
    .await;
    if let Err(e) = result {
        action.line(&format!("{name}: {e}"));
        let message = failure_message(name, version, &e);
        set(ctx, id, |d| {
            d.state = DependencyState::Failed(message.clone());
            d.detail.clear();
        });
        return Err(EngineError(message));
    }
    action.line(&format!("{name}: checksum ok"));
    Ok(())
}

fn mark_failed(ctx: &Ctx, id: DependencyId, message: &str) -> EngineError {
    let m = message.to_string();
    set(ctx, id, |d| {
        d.state = DependencyState::Failed(m);
        d.detail.clear();
    });
    EngineError(message.to_string())
}

fn mark_ready(ctx: &Ctx, id: DependencyId) {
    set(ctx, id, |d| {
        d.state = DependencyState::Ready;
        d.done = d.size;
        d.detail.clear();
    });
}

/// Extracts into `<final>.tmp` with `extract`, then renames it to `final_dir`.
async fn extract_into_place(
    final_dir: PathBuf,
    extract: impl FnOnce(&Path) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut tmp_name = final_dir
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default();
        tmp_name.push(".tmp");
        let tmp = final_dir.with_file_name(tmp_name);
        if tmp.exists() {
            std::fs::remove_dir_all(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        }
        std::fs::create_dir_all(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        if let Err(e) = extract(&tmp) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir)
                .map_err(|e| format!("{}: {e}", final_dir.display()))?;
        }
        std::fs::rename(&tmp, &final_dir).map_err(|e| format!("{}: {e}", final_dir.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The pinned Node archive for the OS and CPU this binary was built for.
pub fn host_node_archive() -> Option<NodeHostArchive> {
    node_host_archive(std::env::consts::OS, std::env::consts::ARCH)
}

/// Copies only the Node executable out of the archive: `node.exe` (zip) or `bin/node` (tar.gz,
/// with its mode, so it stays executable), matching [`node_exe`].
fn extract_node(src: &Path, pin: &NodeHostArchive, tmp: &Path) -> Result<(), String> {
    let file = std::fs::File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let inner = pin.inner.as_str();
    match pin.kind {
        ArchiveKind::Zip => {
            let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            let mut entry = zip.by_name(inner).map_err(|e| format!("{inner}: {e}"))?;
            let mut out = std::fs::File::create(tmp.join("node.exe")).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            Ok(())
        }
        ArchiveKind::TarGz => {
            let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
            for entry in archive.entries().map_err(|e| e.to_string())? {
                let mut entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path().map_err(|e| e.to_string())?.into_owned();
                if path.to_string_lossy().replace('\\', "/") != inner {
                    continue;
                }
                let bin = tmp.join("bin");
                std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
                entry
                    .unpack(bin.join("node"))
                    .map_err(|e| format!("{inner}: {e}"))?;
                return Ok(());
            }
            Err(format!("{inner} is not in the archive"))
        }
    }
}

async fn ensure_node(ctx: &Arc<Ctx>, action: &Action) -> EngineResult<()> {
    let id = DependencyId::Node;
    if is_ready(ctx, id) {
        action.line("Node.js is already downloaded");
        return Ok(());
    }
    let Some(pin) = host_node_archive() else {
        return Err(mark_failed(
            ctx,
            id,
            &format!(
                "Downloading Node.js is not supported on {} {} in this version.",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        ));
    };
    let (node_base, _) = sources(ctx);
    let url = format!("{node_base}/{NODE_VERSION}/{}", pin.file);
    let archive = ctx.layout.deps_dir().join(&pin.file);
    fetch_item(
        ctx,
        action,
        Item {
            id,
            name: NODE_NAME,
            version: NODE_VERSION,
        },
        &url,
        &archive,
        pin.sha256,
    )
    .await?;
    set(ctx, id, |d| d.detail = "Unpacking".into());
    let src = archive.clone();
    let extracted = extract_into_place(ctx.layout.node_dir(), move |tmp| {
        extract_node(&src, &pin, tmp)
    })
    .await;
    let _ = tokio::fs::remove_file(&archive).await;
    if let Err(e) = extracted {
        action.line(&format!("unpacking Node.js failed: {e}"));
        return Err(mark_failed(
            ctx,
            id,
            &format!("Could not unpack Node.js {NODE_VERSION}: {e}. Press Retry."),
        ));
    }
    mark_ready(ctx, id);
    Ok(())
}

async fn ensure_cli(ctx: &Arc<Ctx>, action: &Action) -> EngineResult<()> {
    let id = DependencyId::DevcontainersCli;
    if is_ready(ctx, id) {
        action.line("the Dev Container CLI is already downloaded");
        return Ok(());
    }
    let (_, npm_base) = sources(ctx);
    let file = format!("cli-{DEVCONTAINERS_CLI_VERSION}.tgz");
    let url = format!("{npm_base}/@devcontainers/cli/-/{file}");
    let archive = ctx.layout.deps_dir().join(&file);
    fetch_item(
        ctx,
        action,
        Item {
            id,
            name: CLI_NAME,
            version: DEVCONTAINERS_CLI_VERSION,
        },
        &url,
        &archive,
        DEVCONTAINERS_CLI_SHA256,
    )
    .await?;
    set(ctx, id, |d| d.detail = "Unpacking".into());
    let src = archive.clone();
    let extracted = extract_into_place(ctx.layout.cli_dir(), move |tmp| {
        let file = std::fs::File::open(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry.path().map_err(|e| e.to_string())?.into_owned();
            // npm tarballs put everything under `package/`; only plain relative paths are kept.
            let rel: PathBuf = path
                .components()
                .skip(1)
                .filter_map(|c| match c {
                    std::path::Component::Normal(p) => Some(p.to_os_string()),
                    _ => None,
                })
                .collect();
            if rel.as_os_str().is_empty()
                || rel.components().count() + 1 != path.components().count()
            {
                continue;
            }
            let dest = tmp.join(&rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
            std::fs::write(&dest, data).map_err(|e| format!("{}: {e}", dest.display()))?;
        }
        if !tmp.join("devcontainer.js").is_file() {
            return Err("the package has no devcontainer.js".into());
        }
        Ok(())
    })
    .await;
    let _ = tokio::fs::remove_file(&archive).await;
    if let Err(e) = extracted {
        action.line(&format!("unpacking the Dev Container CLI failed: {e}"));
        return Err(mark_failed(
            ctx,
            id,
            &format!(
                "Could not unpack the Dev Container CLI {DEVCONTAINERS_CLI_VERSION}: {e}. Press \
                 Retry."
            ),
        ));
    }
    mark_ready(ctx, id);
    Ok(())
}

/// The standard Equipment: Linux Node archive (host download), the pinned base (pull) and the
/// `agentbook-std:<v>` build.
async fn ensure_standard(ctx: &Arc<Ctx>, action: &Action) -> EngineResult<()> {
    let id = DependencyId::StandardEquipment;
    if is_ready(ctx, id) {
        action.line("the standard Equipment is already built");
        return Ok(());
    }
    let docker = match ctx.docker().await {
        Ok(d) => d,
        Err(e) => return Err(mark_failed(ctx, id, &e.0)),
    };
    let info = match crate::docker::engine_info(&docker).await {
        Ok(i) => i,
        Err(e) => return Err(mark_failed(ctx, id, &e.plain_message())),
    };
    let Some((file, sha)) = node_linux_archive(&info.arch) else {
        return Err(mark_failed(
            ctx,
            id,
            &format!(
                "The standard Equipment supports Docker engines on x64 and arm64; this one is {}.",
                info.arch
            ),
        ));
    };
    if let Some(size) = node_linux_size(&info.arch) {
        set(ctx, id, |d| d.size = size);
    }
    let archive = ctx.layout.linux_node_archive(&file);
    if !archive.is_file() {
        let (node_base, _) = sources(ctx);
        let url = format!("{node_base}/{NODE_VERSION}/{file}");
        let version = standard::version();
        let item = Item {
            id,
            name: STD_NAME,
            version: &version,
        };
        fetch_item(ctx, action, item, &url, &archive, sha).await?;
    } else {
        action.line(&format!("{file} is already downloaded"));
    }
    set(ctx, id, |d| {
        d.state = DependencyState::Downloading;
        d.done = d.size;
        d.detail = "Getting the base image".into();
    });
    let base = standard::base_image();
    let base_ref = pull_reference(base);
    let pulled = match images::exists(&docker, base).await {
        Ok(true) => Ok(()),
        _ => images::pull(&docker, &base_ref, |l| action.line(l)).await,
    };
    if let Err(e) = pulled {
        return Err(mark_failed(
            ctx,
            id,
            &format!(
                "Could not get the standard Equipment's base image: {}. Check the network \
                 connection and press Retry.",
                e.plain_message()
            ),
        ));
    }
    set(ctx, id, |d| {
        d.detail = "Building the standard Equipment".into()
    });
    let node_bytes = match tokio::fs::read(&archive).await {
        Ok(b) => b,
        Err(e) => {
            return Err(mark_failed(
                ctx,
                id,
                &format!("Cannot read {}: {e}. Press Retry.", archive.display()),
            ));
        }
    };
    let context = images::context_tar(&[
        (
            standard::DOCKERFILE.name.to_string(),
            standard::DOCKERFILE.bytes(),
            0o644,
        ),
        (standard::NODE_ARCHIVE.to_string(), node_bytes, 0o644),
    ])
    .map_err(EngineError::from)?;
    let mut args = vec![
        (
            standard::ARG_NODE_VERSION.to_string(),
            NODE_VERSION.to_string(),
        ),
        (standard::ARG_NODE_SHA256.to_string(), sha.to_string()),
    ];
    args.extend(ctx.platform.system_proxy().build_args());
    let spec = images::BuildSpec {
        tag: standard::image_tag(),
        context,
        build_args: args,
        labels: ctx.base_labels().into_iter().collect(),
    };
    if let Err(e) = images::build(&docker, spec, |l| action.line(l)).await {
        return Err(mark_failed(
            ctx,
            id,
            &format!(
                "Could not build the standard Equipment: {}. See the log and press Retry.",
                e.plain_message()
            ),
        ));
    }
    mark_ready(ctx, id);
    Ok(())
}

/// `ubuntu:24.04@sha256:…` → `ubuntu@sha256:…` (a pull by digest takes no tag).
fn pull_reference(image: &str) -> String {
    match image.split_once('@') {
        Some((name, digest)) => {
            let repo = match name.rsplit_once(':') {
                Some((repo, tag)) if !tag.contains('/') => repo,
                _ => name,
            };
            format!("{repo}@{digest}")
        }
        None => image.to_string(),
    }
}
