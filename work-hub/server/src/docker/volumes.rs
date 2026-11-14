//! Named volumes: each workspace and workstream container has a repo volume (`/workspace`) and a
//! home volume. Opening a workstream copies the workspace's two volumes with a helper container
//! (D10 step 5, the volume-copy PoC recipe).

use std::collections::HashMap;

use bollard::models::VolumeCreateRequest;
use bollard::query_parameters::{ListVolumesOptionsBuilder, RemoveVolumeOptionsBuilder};

use super::containers::{self, HelperSpec};
use super::exec::{VOLUME_COPY_TIMEOUT, sh};
use super::{Docker, DockerError, DockerResult};

/// Creates a named volume with these labels whose data is the host folder `device` (the
/// engine's view of a file-area folder, FR-5g; it must exist). An existing volume with the name
/// is returned as is.
pub async fn create(
    docker: &Docker,
    name: &str,
    labels: HashMap<String, String>,
    device: &str,
) -> DockerResult<()> {
    docker
        .create_volume(VolumeCreateRequest {
            name: Some(name.to_string()),
            driver: Some("local".into()),
            driver_opts: Some(HashMap::from([
                ("type".to_string(), "none".to_string()),
                ("o".to_string(), "bind".to_string()),
                ("device".to_string(), device.to_string()),
            ])),
            labels: Some(labels),
            ..Default::default()
        })
        .await?;
    Ok(())
}

/// Removes a volume. Missing is fine. A volume still used by a container is
/// [`DockerError::Conflict`]: remove the container first.
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

/// Names of the volumes matching a label filter (`names::label_filter` and friends).
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

/// Copies every file of volume `from` into volume `to` (which must already exist — create it
/// with [`create`] so it carries its labels), keeping owners, modes and symlinks. One helper
/// container from `image`, run as root, `from` mounted read-only:
/// `cd /from && tar cf - . | tar xpf - -C /to`. At most [`VOLUME_COPY_TIMEOUT`].
///
/// `helper_labels` labels the helper container (role `helper`).
pub async fn copy_volume(
    docker: &Docker,
    image: &str,
    helper_labels: HashMap<String, String>,
    from: &str,
    to: &str,
) -> DockerResult<()> {
    let spec = HelperSpec {
        image: image.to_string(),
        user: Some("0".into()),
        // `sh` may be dash (no pipefail): a failing `tar cf` is flagged through a marker file.
        cmd: sh(
            "cd /from && { tar cf - . || touch /tmp/wh-copy-failed; } | tar xpf - -C /to \
                 && [ ! -e /tmp/wh-copy-failed ]",
        ),
        volumes: vec![
            (from.to_string(), "/from".to_string(), true),
            (to.to_string(), "/to".to_string(), false),
        ],
        binds: vec![],
        labels: helper_labels,
    };
    // The wait for the helper is one long request: lift the client's 2-minute request timeout.
    let docker = docker.clone().with_timeout(VOLUME_COPY_TIMEOUT);
    containers::run_helper(&docker, &spec, VOLUME_COPY_TIMEOUT)
        .await?
        .check()
        .map_err(|e| match e {
            DockerError::Exit { code, stderr } => DockerError::Exit {
                code,
                stderr: format!("copying volume {from} to {to} failed: {stderr}"),
            },
            other => other,
        })?;
    Ok(())
}
