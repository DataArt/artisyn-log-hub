//! Named volumes: each laptop's home volume `agentbook-home-<id>`.

use std::collections::HashMap;

use bollard::models::VolumeCreateRequest;
use bollard::query_parameters::{ListVolumesOptionsBuilder, RemoveVolumeOptionsBuilder};

use super::{Docker, DockerError, DockerResult};

/// Creates a local volume with these labels unless one with the name exists (kept as is).
pub async fn ensure(
    docker: &Docker,
    name: &str,
    labels: HashMap<String, String>,
) -> DockerResult<()> {
    match docker.inspect_volume(name).await {
        Ok(_) => return Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => {}
            other => return Err(other),
        },
    }
    docker
        .create_volume(VolumeCreateRequest {
            name: Some(name.to_string()),
            driver: Some("local".into()),
            labels: Some(labels),
            ..Default::default()
        })
        .await?;
    Ok(())
}

pub async fn exists(docker: &Docker, name: &str) -> DockerResult<bool> {
    match docker.inspect_volume(name).await {
        Ok(_) => Ok(true),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(false),
            other => Err(other),
        },
    }
}

/// Removes a volume by exact name. Missing is fine.
pub async fn remove(docker: &Docker, name: &str) -> DockerResult<()> {
    let options = RemoveVolumeOptionsBuilder::default().force(true).build();
    match docker.remove_volume(name, Some(options)).await {
        Ok(()) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            other => Err(other),
        },
    }
}

/// Names of the volumes matching a label filter.
pub async fn list_by_labels(
    docker: &Docker,
    filter: &HashMap<String, Vec<String>>,
) -> DockerResult<Vec<String>> {
    let options = ListVolumesOptionsBuilder::default().filters(filter).build();
    let resp = docker.list_volumes(Some(options)).await?;
    Ok(resp
        .volumes
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.name)
        .collect())
}
