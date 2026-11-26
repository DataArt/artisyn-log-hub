//! Images: pulling the standard Equipment's pinned base, building from an in-memory tar context
//! (standard Equipment, laptop layer) with the log streamed line by line, inspecting labels and
//! removing by exact tag.

use std::collections::HashMap;

use bollard::query_parameters::{
    BuildImageOptionsBuilder, CreateImageOptionsBuilder, ListImagesOptionsBuilder,
    RemoveImageOptionsBuilder,
};
use bytes::Bytes;
use futures_util::StreamExt;

use super::{BUILD_TIMEOUT, Docker, DockerError, DockerResult};

/// What [`inspect`] reports.
#[derive(Debug, Clone, Default)]
pub struct ImageInfo {
    pub id: String,
    pub labels: HashMap<String, String>,
}

/// `None` when the image does not exist.
pub async fn inspect(docker: &Docker, image: &str) -> DockerResult<Option<ImageInfo>> {
    match docker.inspect_image(image).await {
        Ok(resp) => Ok(Some(ImageInfo {
            id: resp.id.unwrap_or_default(),
            labels: resp.config.and_then(|c| c.labels).unwrap_or_default(),
        })),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(None),
            other => Err(other),
        },
    }
}

pub async fn exists(docker: &Docker, image: &str) -> DockerResult<bool> {
    Ok(inspect(docker, image).await?.is_some())
}

/// Pulls `reference` (`name[:tag][@sha256:…]`); `on_line` gets each status line.
pub async fn pull(
    docker: &Docker,
    reference: &str,
    mut on_line: impl FnMut(&str) + Send,
) -> DockerResult<()> {
    let options = CreateImageOptionsBuilder::default()
        .from_image(reference)
        .build();
    let docker = docker.clone().with_timeout(BUILD_TIMEOUT);
    let mut stream = docker.create_image(Some(options), None, None);
    while let Some(item) = stream.next().await {
        match item {
            Ok(info) => {
                if let Some(status) = info.status.as_deref() {
                    let line = match info.id.as_deref() {
                        Some(id) => format!("{id}: {status}"),
                        None => status.to_string(),
                    };
                    on_line(&line);
                }
            }
            Err(bollard::errors::Error::DockerStreamError { error }) => {
                on_line(&error);
                return Err(DockerError::Failed(format!("pulling {reference}: {error}")));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// What [`build`] builds.
#[derive(Debug, Clone, Default)]
pub struct BuildSpec {
    pub tag: String,
    /// An uncompressed tar holding the Dockerfile at its root.
    pub context: Vec<u8>,
    pub build_args: Vec<(String, String)>,
    pub labels: HashMap<String, String>,
}

/// Builds an image with the classic builder, at most [`BUILD_TIMEOUT`]. Every output line goes
/// to `on_line`; a failed build is [`DockerError::Failed`] naming the image (the caller keeps
/// the log tail).
pub async fn build(
    docker: &Docker,
    spec: BuildSpec,
    mut on_line: impl FnMut(&str) + Send,
) -> DockerResult<()> {
    let args: HashMap<String, String> = spec.build_args.iter().cloned().collect();
    let options = BuildImageOptionsBuilder::default()
        .dockerfile("Dockerfile")
        .t(&spec.tag)
        .rm(true)
        .forcerm(true)
        .buildargs(&args)
        .labels(&spec.labels)
        .build();
    let docker = docker.clone().with_timeout(BUILD_TIMEOUT);
    let tag = spec.tag.clone();
    let body = futures_util::stream::once(async move {
        Ok::<Bytes, std::io::Error>(Bytes::from(spec.context))
    });
    let run = async {
        let mut stream = docker.build_image(options, None, Some(bollard::body_try_stream(body)));
        let mut pending = String::new();
        while let Some(item) = stream.next().await {
            match item {
                Ok(info) => {
                    if let Some(s) = info.stream.as_deref() {
                        pending.push_str(s);
                        while let Some(pos) = pending.find('\n') {
                            let line: String = pending.drain(..=pos).collect();
                            on_line(line.trim_end());
                        }
                    }
                    if let Some(s) = info.status.as_deref() {
                        on_line(s);
                    }
                    if let Some(detail) = info.error_detail.and_then(|d| d.message) {
                        on_line(&detail);
                        return Err(DockerError::Failed(format!("building {tag} failed")));
                    }
                }
                Err(bollard::errors::Error::DockerStreamError { error }) => {
                    if !pending.trim().is_empty() {
                        on_line(pending.trim_end());
                    }
                    on_line(&error);
                    return Err(DockerError::Failed(format!("building {tag} failed")));
                }
                Err(e) => return Err(e.into()),
            }
        }
        if !pending.trim().is_empty() {
            on_line(pending.trim_end());
        }
        Ok(())
    };
    match tokio::time::timeout(BUILD_TIMEOUT, run).await {
        Ok(r) => r,
        Err(_) => Err(DockerError::Timeout(format!("building {}", spec.tag))),
    }
}

/// One tagged image of [`list_by_labels`].
#[derive(Debug, Clone)]
pub struct ImageListItem {
    pub id: String,
    pub tags: Vec<String>,
    pub labels: HashMap<String, String>,
}

/// Images matching a label filter.
pub async fn list_by_labels(
    docker: &Docker,
    filter: &HashMap<String, Vec<String>>,
) -> DockerResult<Vec<ImageListItem>> {
    let options = ListImagesOptionsBuilder::default().filters(filter).build();
    let images = docker.list_images(Some(options)).await?;
    Ok(images
        .into_iter()
        .map(|i| ImageListItem {
            id: i.id,
            tags: i
                .repo_tags
                .into_iter()
                .filter(|t| t != "<none>:<none>")
                .collect(),
            labels: i.labels,
        })
        .collect())
}

/// Removes one exact tag (never by id or pattern). Missing is fine; an image another one is
/// built on only loses the tag.
pub async fn remove_tag(docker: &Docker, tag: &str) -> DockerResult<()> {
    let options = RemoveImageOptionsBuilder::default()
        .force(false)
        .noprune(false)
        .build();
    match docker.remove_image(tag, Some(options), None).await {
        Ok(_) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            other => Err(other),
        },
    }
}

/// An uncompressed tar of `(name, bytes, mode)` files at the context root.
pub fn context_tar(files: &[(String, Vec<u8>, u32)]) -> DockerResult<Vec<u8>> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, data, mode) in files {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(data.len() as u64);
        header.set_mode(*mode);
        header.set_mtime(0);
        builder.append_data(&mut header, name, data.as_slice())?;
    }
    Ok(builder.into_inner()?)
}
