//! Images: the default devcontainer image (built from the embedded `work-hub/image/` when it is
//! missing, D6), devcontainer builds (`wh-img-<uuid>:1`) and checkpoints (`docker commit` →
//! `wh-ckpt-<uuid>:<seq>`).

use std::collections::HashMap;
use std::time::Duration;

use bollard::models::ContainerConfig;
use bollard::query_parameters::{
    BuildImageOptionsBuilder, CommitContainerOptionsBuilder, ListImagesOptionsBuilder,
    RemoveImageOptionsBuilder,
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use rust_embed::RustEmbed;
use tokio::sync::RwLock;

use super::exec::IMAGE_BUILD_TIMEOUT;
use super::{Docker, DockerError, DockerResult};
use crate::state::ImageStatus;

/// The build context of the default image: `work-hub/image/` (Dockerfile, tmux.conf).
#[derive(RustEmbed)]
#[folder = "../image/"]
struct DefaultImageContext;

/// How long [`ensure_default_image`] waits between attempts while Docker is unreachable.
const DOCKER_RETRY: Duration = Duration::from_secs(5);
/// Build output lines kept for the error message of a failed build.
const BUILD_LOG_KEEP: usize = 30;

/// True when the image exists locally.
pub async fn exists(docker: &Docker, image: &str) -> DockerResult<bool> {
    match docker.inspect_image(image).await {
        Ok(_) => Ok(true),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(false),
            other => Err(other),
        },
    }
}

/// `docker commit <container> <repo>:<tag>` with these labels added to the image (the rest of the
/// container's config is kept). Returns the image id.
pub async fn commit(
    docker: &Docker,
    container: &str,
    repo: &str,
    tag: &str,
    labels: HashMap<String, String>,
) -> DockerResult<String> {
    let options = CommitContainerOptionsBuilder::default()
        .container(container)
        .repo(repo)
        .tag(tag)
        .pause(true)
        .build();
    let config = ContainerConfig {
        labels: Some(labels),
        ..Default::default()
    };
    // Committing a large container can take longer than the client's 2-minute default.
    let docker = docker.clone().with_timeout(IMAGE_BUILD_TIMEOUT);
    let resp = docker.commit_container(options, config).await?;
    Ok(resp.id)
}

/// Builds `tag` from a tar build context (`dockerfile` is its path inside the tar) with the
/// classic builder, at most [`IMAGE_BUILD_TIMEOUT`]. A failed build is [`DockerError::Failed`]
/// with the last lines of its output.
pub async fn build_from_tar<S>(
    docker: &Docker,
    tar: S,
    dockerfile: &str,
    tag: &str,
    labels: HashMap<String, String>,
) -> DockerResult<()>
where
    S: Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
{
    let options = BuildImageOptionsBuilder::default()
        .dockerfile(dockerfile)
        .t(tag)
        .rm(true)
        .forcerm(true)
        .labels(&labels)
        .build();
    let docker = docker.clone().with_timeout(IMAGE_BUILD_TIMEOUT);
    let build = async {
        let mut log: Vec<String> = Vec::new();
        let mut keep = |line: &str| {
            let line = line.trim_end();
            if !line.is_empty() {
                tracing::debug!(target: "work_hub_server::docker::build", "{tag}: {line}");
                log.push(line.to_string());
                if log.len() > BUILD_LOG_KEEP {
                    log.remove(0);
                }
            }
        };
        let mut stream = docker.build_image(options, None, Some(bollard::body_try_stream(tar)));
        while let Some(item) = stream.next().await {
            match item {
                Ok(info) => {
                    if let Some(s) = info.stream.as_deref() {
                        keep(s);
                    }
                    if let Some(s) = info.status.as_deref() {
                        keep(s);
                    }
                }
                Err(bollard::errors::Error::DockerStreamError { error }) => {
                    keep(&error);
                    return Err(DockerError::Failed(format!(
                        "building {tag} failed:\n{}",
                        log.join("\n")
                    )));
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    };
    match tokio::time::timeout(IMAGE_BUILD_TIMEOUT, build).await {
        Ok(r) => r,
        Err(_) => Err(DockerError::Timeout(format!("building {tag}"))),
    }
}

/// The embedded `work-hub/image/` as an uncompressed tar.
fn default_image_context_tar() -> DockerResult<Vec<u8>> {
    let mut builder = tar::Builder::new(Vec::new());
    for name in DefaultImageContext::iter() {
        let Some(file) = DefaultImageContext::get(&name) else {
            continue;
        };
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(file.data.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(0);
        builder.append_data(&mut header, name.as_ref(), file.data.as_ref())?;
    }
    Ok(builder.into_inner()?)
}

/// Makes sure the default image `tag` (`WORK_HUB_DEFAULT_IMAGE`) exists, building it from the
/// embedded `work-hub/image/` when missing, and keeps `status` up to date for
/// `/api/v1/system/status`: `building` until it is known to exist or has been built, then `ok`,
/// or `failed` when the build fails. While Docker is unreachable it waits and retries.
pub async fn ensure_default_image(docker: &Docker, tag: &str, status: &RwLock<ImageStatus>) {
    *status.write().await = ImageStatus::Building;
    loop {
        match exists(docker, tag).await {
            Ok(true) => {
                tracing::info!("default image {tag} is present");
                *status.write().await = ImageStatus::Ok;
                return;
            }
            Ok(false) => break,
            Err(DockerError::Unavailable(e)) => {
                tracing::debug!("default image check: Docker unreachable ({e}), retrying");
                tokio::time::sleep(DOCKER_RETRY).await;
            }
            Err(e) => {
                tracing::error!("default image check failed: {e}");
                *status.write().await = ImageStatus::Failed(e.to_string());
                return;
            }
        }
    }

    tracing::info!("building the default image {tag} (this can take several minutes)");
    let result = match default_image_context_tar() {
        Ok(tar) => {
            let body = futures_util::stream::once(async move { Ok(Bytes::from(tar)) });
            build_from_tar(docker, body, "Dockerfile", tag, HashMap::new()).await
        }
        Err(e) => Err(e),
    };
    match result {
        Ok(()) => {
            tracing::info!("default image {tag} built");
            *status.write().await = ImageStatus::Ok;
        }
        Err(e) => {
            tracing::error!("building the default image {tag} failed: {e}");
            *status.write().await = ImageStatus::Failed(e.to_string());
        }
    }
}

/// `repo:tag` references (or ids, for untagged images) of the images matching a label filter.
pub async fn list_by_labels(
    docker: &Docker,
    filter: &HashMap<String, Vec<String>>,
) -> DockerResult<Vec<String>> {
    let options = ListImagesOptionsBuilder::default().filters(filter).build();
    let images = docker.list_images(Some(options)).await?;
    let mut out = Vec::new();
    for image in images {
        let tags: Vec<String> = image
            .repo_tags
            .into_iter()
            .filter(|t| t != "<none>:<none>")
            .collect();
        if tags.is_empty() {
            out.push(image.id);
        } else {
            out.extend(tags);
        }
    }
    Ok(out)
}

/// Removes an image reference (force: also when a stopped container still uses it). Missing is
/// fine.
pub async fn remove(docker: &Docker, image: &str) -> DockerResult<()> {
    let options = RemoveImageOptionsBuilder::default().force(true).build();
    match docker.remove_image(image, Some(options), None).await {
        Ok(_) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            other => Err(other),
        },
    }
}
