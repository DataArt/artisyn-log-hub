//! Networks: the git proxy's internal bridge network `wh-net-<instance>` (D2). The sidecar joins
//! it with the alias `wh-git`; workspace and workstream containers stay on the default `bridge`
//! and are additionally connected to it.

use std::collections::HashMap;

use bollard::models::{EndpointSettings, NetworkConnectRequest, NetworkCreateRequest};

use super::{Docker, DockerError, DockerResult};

/// Creates the internal bridge network `name` (`internal: true`: no route out of it) with these
/// labels. An existing network with the name is kept as is.
pub async fn ensure(
    docker: &Docker,
    name: &str,
    labels: HashMap<String, String>,
) -> DockerResult<()> {
    match docker.inspect_network(name, None).await {
        Ok(_) => return Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => {}
            other => return Err(other),
        },
    }
    let request = NetworkCreateRequest {
        name: name.to_string(),
        driver: Some("bridge".into()),
        internal: Some(true),
        attachable: Some(true),
        labels: Some(labels),
        ..Default::default()
    };
    match docker.create_network(request).await {
        Ok(_) => Ok(()),
        Err(e) => match DockerError::from(e) {
            // Created concurrently between the inspect and the create.
            DockerError::Conflict(_) => Ok(()),
            other => Err(other),
        },
    }
}

/// True for the Engine's answers to connecting a container that already is on the network
/// (403 "endpoint with name … already exists in network …" on older Engines, 409 on newer).
fn is_already_connected(e: &DockerError) -> bool {
    match e {
        DockerError::Conflict(msg) | DockerError::Failed(msg) => {
            msg.contains("already exists") || msg.contains("already attached")
        }
        _ => false,
    }
}

/// Connects `container` (created or running) to `network`, reachable there as `alias` when given.
/// A container that already is on the network is fine.
pub async fn connect(
    docker: &Docker,
    network: &str,
    container: &str,
    alias: Option<&str>,
) -> DockerResult<()> {
    let request = NetworkConnectRequest {
        container: container.to_string(),
        endpoint_config: alias.map(|a| EndpointSettings {
            aliases: Some(vec![a.to_string()]),
            ..Default::default()
        }),
    };
    match docker.connect_network(network, request).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let e = DockerError::from(e);
            if is_already_connected(&e) {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/// Removes a network. Missing is fine. A network that still has containers connected is
/// [`DockerError::Conflict`] or [`DockerError::Failed`]: remove or disconnect them first.
pub async fn remove(docker: &Docker, name: &str) -> DockerResult<()> {
    match docker.remove_network(name).await {
        Ok(()) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            other => Err(other),
        },
    }
}
