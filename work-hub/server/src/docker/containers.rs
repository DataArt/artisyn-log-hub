//! Containers (D5 "Container config"): every Work Hub container runs `sleep infinity` with
//! `Init: true`, a tmpfs `/tmp` (so tmux sockets and bundles never enter a checkpoint), the env
//! from `containerEnv` plus `TERM` / `LANG`, the default bridge network, no published ports and
//! restart policy `no`. The repo volume is mounted at `/workspace`, the home volume at the home
//! directory.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use bollard::container::LogOutput;
use bollard::models::{
    ContainerCreateBody, ContainerStateStatusEnum, HostConfig, Mount, MountType, RestartPolicy,
    RestartPolicyNameEnum,
};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, ListContainersOptionsBuilder, LogsOptionsBuilder,
    RemoveContainerOptionsBuilder, StopContainerOptionsBuilder, WaitContainerOptionsBuilder,
};
use futures_util::StreamExt;

use super::exec::{ExecOutput, STOP_TIMEOUT};
use super::names::{self, REPO_MOUNT};
use super::{Docker, DockerError, DockerResult};

/// What [`create_and_start`] runs.
#[derive(Debug, Clone)]
pub struct RunSpec {
    /// Container name (`wh-ws-<uuid>` / `wh-st-<uuid>`).
    pub name: String,
    pub image: String,
    pub labels: HashMap<String, String>,
    /// `containerEnv` of the devcontainer definition.
    pub env: BTreeMap<String, String>,
    /// Mounted at `/workspace`.
    pub repo_volume: String,
    /// Mounted at `home_dir`.
    pub home_volume: String,
    /// The container user's home (`None` while it is not known yet: the home volume is then not
    /// mounted, e.g. for the first container of a new workspace before user discovery).
    pub home_dir: Option<String>,
}

fn volume_mount(source: &str, target: &str, read_only: bool) -> Mount {
    Mount {
        target: Some(target.to_string()),
        source: Some(source.to_string()),
        typ: Some(MountType::VOLUME),
        read_only: Some(read_only),
        ..Default::default()
    }
}

/// The env of every container: `containerEnv`, then `TERM=xterm-256color` and `LANG=C.UTF-8`
/// (these two win, the terminals depend on them).
fn container_env(env: &BTreeMap<String, String>) -> Vec<String> {
    let mut out: Vec<String> = env
        .iter()
        .filter(|(k, _)| k.as_str() != "TERM" && k.as_str() != "LANG")
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    out.push("TERM=xterm-256color".into());
    out.push("LANG=C.UTF-8".into());
    out
}

fn base_host_config(mounts: Vec<Mount>) -> HostConfig {
    HostConfig {
        init: Some(true),
        tmpfs: Some(HashMap::from([("/tmp".to_string(), String::new())])),
        mounts: Some(mounts),
        network_mode: Some("bridge".into()),
        restart_policy: Some(RestartPolicy {
            name: Some(RestartPolicyNameEnum::NO),
            maximum_retry_count: None,
        }),
        ..Default::default()
    }
}

/// Creates and starts a container per the D5 config. Returns its id. When the start fails the
/// created container is removed again, so a failure leaves nothing behind.
pub async fn create_and_start(docker: &Docker, spec: &RunSpec) -> DockerResult<String> {
    let mut mounts = vec![volume_mount(&spec.repo_volume, REPO_MOUNT, false)];
    if let Some(home) = &spec.home_dir {
        mounts.push(volume_mount(&spec.home_volume, home, false));
    }
    let body = ContainerCreateBody {
        image: Some(spec.image.clone()),
        cmd: Some(vec!["sleep".into(), "infinity".into()]),
        env: Some(container_env(&spec.env)),
        labels: Some(spec.labels.clone()),
        host_config: Some(base_host_config(mounts)),
        ..Default::default()
    };
    let options = CreateContainerOptionsBuilder::default()
        .name(&spec.name)
        .build();
    let created = docker.create_container(Some(options), body).await?;
    if let Err(e) = docker.start_container(&spec.name, None).await {
        let e = DockerError::from(e);
        if let Err(cleanup) = remove(docker, &spec.name).await {
            tracing::warn!(
                "removing {} after a failed start failed: {cleanup}",
                spec.name
            );
        }
        return Err(e);
    }
    Ok(created.id)
}

/// What [`inspect`] reports.
#[derive(Debug, Clone)]
pub struct ContainerInfo {
    pub id: String,
    pub running: bool,
    /// `created`, `running`, `exited`, … (empty when unknown).
    pub status: String,
    /// The image reference the container was created from.
    pub image: String,
    pub labels: HashMap<String, String>,
}

/// `None` when the container does not exist.
pub async fn inspect(docker: &Docker, name: &str) -> DockerResult<Option<ContainerInfo>> {
    let resp = match docker.inspect_container(name, None).await {
        Ok(r) => r,
        Err(e) => {
            let e = DockerError::from(e);
            return if e.is_not_found() { Ok(None) } else { Err(e) };
        }
    };
    let state = resp.state.unwrap_or_default();
    let config = resp.config.unwrap_or_default();
    Ok(Some(ContainerInfo {
        id: resp.id.unwrap_or_default(),
        running: state.running.unwrap_or(false),
        status: state
            .status
            .filter(|s| *s != ContainerStateStatusEnum::EMPTY)
            .map(|s| s.to_string())
            .unwrap_or_default(),
        image: config.image.unwrap_or_default(),
        labels: config.labels.unwrap_or_default(),
    }))
}

/// Starts a stopped container (already running is fine). A missing container is
/// [`DockerError::NotFound`].
pub async fn start(docker: &Docker, name: &str) -> DockerResult<()> {
    docker.start_container(name, None).await?;
    Ok(())
}

/// Stops a container, giving it [`STOP_TIMEOUT`] before the kill. Already stopped or missing is
/// fine.
pub async fn stop(docker: &Docker, name: &str) -> DockerResult<()> {
    let options = StopContainerOptionsBuilder::default()
        .t(STOP_TIMEOUT.as_secs() as i32)
        .build();
    match docker.stop_container(name, Some(options)).await {
        Ok(()) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            other => Err(other),
        },
    }
}

/// Removes a container with force (a running one is killed). Missing is fine. Named volumes are
/// kept: remove them with `volumes::remove`.
pub async fn remove(docker: &Docker, name: &str) -> DockerResult<()> {
    let options = RemoveContainerOptionsBuilder::default().force(true).build();
    match docker.remove_container(name, Some(options)).await {
        Ok(()) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            // "removal of container … is already in progress"
            DockerError::Conflict(msg) if msg.contains("already in progress") => Ok(()),
            other => Err(other),
        },
    }
}

/// One container found by [`list_by_labels`].
#[derive(Debug, Clone)]
pub struct ContainerListItem {
    pub id: String,
    /// The name without the leading `/`.
    pub name: String,
    /// `running`, `exited`, …
    pub state: String,
    pub labels: HashMap<String, String>,
}

/// Every container (running or not) matching a label filter from [`names::label_filter`] and
/// friends.
pub async fn list_by_labels(
    docker: &Docker,
    filter: &HashMap<String, Vec<String>>,
) -> DockerResult<Vec<ContainerListItem>> {
    let options = ListContainersOptionsBuilder::default()
        .all(true)
        .filters(filter)
        .build();
    let list = docker.list_containers(Some(options)).await?;
    Ok(list
        .into_iter()
        .map(|c| ContainerListItem {
            id: c.id.unwrap_or_default(),
            name: c
                .names
                .unwrap_or_default()
                .into_iter()
                .next()
                .map(|n| n.trim_start_matches('/').to_string())
                .unwrap_or_default(),
            state: c.state.map(|s| s.to_string()).unwrap_or_default(),
            labels: c.labels.unwrap_or_default(),
        })
        .collect())
}

/// A short-lived helper container (`wh-helper-<uuid>`, role `helper`).
#[derive(Debug, Clone)]
pub struct HelperSpec {
    pub image: String,
    /// `None` = the image's user; `Some("0")` = root.
    pub user: Option<String>,
    pub cmd: Vec<String>,
    /// `(volume, target, read_only)`.
    pub volumes: Vec<(String, String, bool)>,
    /// `(path as the engine sees it, target, read_only)` bind mounts.
    pub binds: Vec<(String, String, bool)>,
    pub labels: HashMap<String, String>,
}

/// Runs a helper container to completion and returns its exit code and output
/// (`docker run --rm`). The server removes it itself once it has exited instead of using
/// `AutoRemove`, because the output and the exit code must be read first; it is removed on every
/// path, timeouts and errors included. A leftover after a crash carries role `helper` and the
/// instance label.
pub async fn run_helper(
    docker: &Docker,
    spec: &HelperSpec,
    timeout: Duration,
) -> DockerResult<ExecOutput> {
    let name = names::helper_container();
    let mounts = spec
        .volumes
        .iter()
        .map(|(v, t, ro)| volume_mount(v, t, *ro))
        .chain(spec.binds.iter().map(|(p, t, ro)| Mount {
            target: Some(t.clone()),
            source: Some(p.clone()),
            typ: Some(MountType::BIND),
            read_only: Some(*ro),
            ..Default::default()
        }))
        .collect();
    let body = ContainerCreateBody {
        image: Some(spec.image.clone()),
        user: spec.user.clone(),
        cmd: Some(spec.cmd.clone()),
        // An empty entrypoint: run `cmd` as given, whatever the image's ENTRYPOINT is.
        entrypoint: Some(vec![]),
        env: Some(vec!["LANG=C.UTF-8".into()]),
        labels: Some(spec.labels.clone()),
        host_config: Some(HostConfig {
            init: Some(true),
            mounts: Some(mounts),
            network_mode: Some("bridge".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let options = CreateContainerOptionsBuilder::default().name(&name).build();
    docker.create_container(Some(options), body).await?;

    let result = tokio::time::timeout(timeout, run_to_exit(docker, &name)).await;
    if let Err(e) = remove(docker, &name).await {
        tracing::warn!("removing helper {name} failed: {e}");
    }
    match result {
        Ok(r) => r,
        Err(_) => Err(DockerError::Timeout(format!(
            "helper container `{}`",
            spec.cmd.join(" ")
        ))),
    }
}

async fn run_to_exit(docker: &Docker, name: &str) -> DockerResult<ExecOutput> {
    docker.start_container(name, None).await?;
    let wait_options = WaitContainerOptionsBuilder::default()
        .condition("not-running")
        .build();
    let mut wait = docker.wait_container(name, Some(wait_options));
    let mut exit_code = 0;
    while let Some(item) = wait.next().await {
        match item {
            Ok(resp) => exit_code = resp.status_code,
            Err(bollard::errors::Error::DockerContainerWaitError { code, .. }) => exit_code = code,
            Err(e) => return Err(e.into()),
        }
    }
    let log_options = LogsOptionsBuilder::default()
        .stdout(true)
        .stderr(true)
        .build();
    let mut logs = docker.logs(name, Some(log_options));
    let mut out = ExecOutput {
        exit_code,
        ..Default::default()
    };
    while let Some(chunk) = logs.next().await {
        match chunk? {
            LogOutput::StdErr { message } => out.stderr.extend_from_slice(&message),
            LogOutput::StdOut { message } | LogOutput::Console { message } => {
                out.stdout.extend_from_slice(&message)
            }
            LogOutput::StdIn { .. } => {}
        }
    }
    Ok(out)
}
