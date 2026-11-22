//! The git proxy sidecar: the only place that talks to git hosts. The server drives it with
//! `docker exec` and keeps its routing state (remotes, capabilities) in sync with the DB.
//!
//! [`spawn`] is the startup task (plan D5): it brings the sidecar up (network, image, volume,
//! container), pushes the state and then checks every 30 s that the sidecar still holds it.

pub mod containers;
pub mod ctl;
pub mod repo;
pub mod state;

use std::collections::BTreeMap;
use std::time::Duration;

use uuid::Uuid;

pub use ctl::ctl;
pub use state::{drop_connection, prune_mirrors, push_all, sync_connection, sync_routes};

use crate::docker::containers::{self as dcontainers, GIT_PROXY_ALIAS, GitProxySpec};
use crate::docker::exec;
use crate::docker::names::{self, Labels, Role};
use crate::docker::{self, DockerError, DockerStatus, images, networks, volumes};
use crate::state::{AppState, ProxyStatus};

/// The sidecar's host name on the internal network (D2).
pub const PROXY_HOST: &str = "wh-git";
/// The capability file in workspace and workstream containers (D2).
pub const CAPABILITY_FILE: &str = "/tmp/wh-git-capability";
/// The git credential helper of `credential.http://wh-git.helper` (D2): answers `get` with the
/// container's capability, ignores `store` / `erase`.
pub const CREDENTIAL_HELPER: &str = r#"!f() { test "$1" = get && printf 'username=wh\npassword=%s\n' "$(cat /tmp/wh-git-capability)"; }; f"#;

/// How often the startup task checks the sidecar (and retries after a failure).
const CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// How often the startup task pings Docker while it is unreachable.
const DOCKER_RETRY: Duration = Duration::from_secs(5);
/// How long a freshly started sidecar may take to prepare `/run/wh`.
const START_WAIT: Duration = Duration::from_secs(20);
/// Proxy env passed through from the server to the sidecar when set (D2).
const PASSTHROUGH_ENV: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

/// The proxy remote URL of a workspace remote, `http://wh-git/git/<remote id>.git`.
pub fn remote_url(remote_id: Uuid) -> String {
    format!("http://{PROXY_HOST}/git/{remote_id}.git")
}

/// The outcome of a server-driven operation against a git host (D1 item 9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    /// The host rejected the credential.
    Rejected,
    /// The pinned SSH host key no longer matches.
    HostKeyChanged,
    /// Anything else, with the last line of the output.
    Failed(String),
}

impl Outcome {
    /// The `connections.status` / `workspace_remotes.status` value of this outcome.
    pub fn as_status(&self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Rejected => "rejected",
            Outcome::HostKeyChanged => "host_key",
            Outcome::Failed(_) => "failed",
        }
    }
}

/// Classifies the output of a **failed** git / ssh / curl run against the real host by the D1
/// item 7 substrings. It never answers [`Outcome::Ok`]: the caller knows success from the exit
/// code.
pub fn classify(output: &str) -> Outcome {
    if output.contains("Host key verification failed")
        || output.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        return Outcome::HostKeyChanged;
    }
    const REJECTED: [&str; 5] = [
        "Permission denied",
        " 401",
        " 403",
        "Authentication failed",
        "could not read Username",
    ];
    if REJECTED.iter().any(|s| output.contains(s)) {
        return Outcome::Rejected;
    }
    let last = output
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    Outcome::Failed(last)
}

/// Starts the git proxy startup task (D5). The status stays `building` until the first full
/// state push; `failed` when the image build or the container start fails (retried every 30 s).
pub fn spawn(st: AppState) {
    tokio::spawn(async move { run(st).await });
}

async fn set_status(st: &AppState, status: ProxyStatus) {
    let mut cur = st.git_proxy.status.write().await;
    if *cur != status {
        match &status {
            ProxyStatus::Failed(e) => tracing::warn!("git proxy failed: {e}"),
            other => tracing::info!("git proxy {}", other.as_api_str()),
        }
        *cur = status;
    }
}

async fn run(st: AppState) {
    let mut ready = false;
    loop {
        if ready {
            if !is_ready(&st).await {
                tracing::info!("git proxy lost its state; bringing it up again");
                set_status(&st, ProxyStatus::Building).await;
                ready = false;
                continue;
            }
        } else {
            wait_for_docker(&st).await;
            match bring_up(&st).await {
                Ok(()) => {
                    set_status(&st, ProxyStatus::Ok).await;
                    ready = true;
                }
                Err(e) => set_status(&st, ProxyStatus::Failed(e)).await,
            }
        }
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

async fn wait_for_docker(st: &AppState) {
    while docker::status(&st.docker).await != DockerStatus::Ok {
        tokio::time::sleep(DOCKER_RETRY).await;
    }
}

/// `is-ready` answered 0. An unreachable or missing sidecar is not ready.
async fn is_ready(st: &AppState) -> bool {
    match ctl::ctl_raw(st, &["is-ready"], None, ctl::CTL_TIMEOUT).await {
        Ok(out) => out.success(),
        Err(e) => {
            tracing::debug!("git proxy is-ready failed: {e}");
            false
        }
    }
}

/// Network, image, volume, container, then the full state push.
async fn bring_up(st: &AppState) -> Result<(), String> {
    let instance = &st.config.instance;
    let labels = Labels::new(instance, Role::GitProxy).into_map();
    let network = names::git_network(instance);
    let volume = names::git_cache_volume(instance);
    let docker_err = |what: &str, e: DockerError| format!("{what}: {e}");

    networks::ensure(&st.docker, &network, labels.clone())
        .await
        .map_err(|e| docker_err("creating the network", e))?;
    images::ensure_git_proxy_image(&st.docker, &st.config.git_proxy_image)
        .await
        .map_err(|e| docker_err("building the git proxy image", e))?;
    volumes::ensure_named(&st.docker, &volume, labels.clone())
        .await
        .map_err(|e| docker_err("creating the mirror volume", e))?;
    let spec = GitProxySpec {
        name: names::git_proxy_container(instance),
        image: st.config.git_proxy_image.clone(),
        labels,
        cache_volume: volume,
        network,
        env: passthrough_env(),
    };
    ensure_container(st, &spec)
        .await
        .map_err(|e| docker_err("starting the git proxy", e))?;
    wait_started(st, &spec.name).await?;
    push_all(st)
        .await
        .map_err(|e| format!("pushing the git proxy state: {}", e.message))
}

/// `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (either case) of the server env, when set.
fn passthrough_env() -> BTreeMap<String, String> {
    PASSTHROUGH_ENV
        .iter()
        .filter_map(|k| {
            std::env::var(k)
                .ok()
                .filter(|v| !v.is_empty())
                .map(|v| (k.to_string(), v))
        })
        .collect()
}

/// Creates the sidecar when it is missing, recreates it when its image differs, starts it when
/// it is stopped (recreating it when that start fails, e.g. after its network was recreated)
/// and makes sure it is on the internal network with its alias.
async fn ensure_container(st: &AppState, spec: &GitProxySpec) -> Result<(), DockerError> {
    match dcontainers::inspect(&st.docker, &spec.name).await? {
        None => dcontainers::create_git_proxy(&st.docker, spec).await,
        Some(info) if info.image != spec.image => {
            tracing::info!("recreating {} on the image {}", spec.name, spec.image);
            dcontainers::remove(&st.docker, &spec.name).await?;
            dcontainers::create_git_proxy(&st.docker, spec).await
        }
        Some(info) if !info.running => {
            if let Err(e) = dcontainers::start(&st.docker, &spec.name).await {
                tracing::info!("starting {} failed ({e}); recreating it", spec.name);
                dcontainers::remove(&st.docker, &spec.name).await?;
                return dcontainers::create_git_proxy(&st.docker, spec).await;
            }
            networks::connect(&st.docker, &spec.network, &spec.name, Some(GIT_PROXY_ALIAS)).await
        }
        Some(_) => {
            networks::connect(&st.docker, &spec.network, &spec.name, Some(GIT_PROXY_ALIAS)).await
        }
    }
}

/// Waits until the sidecar's entry script has prepared `/run/wh` for the `lighttpd` user.
async fn wait_started(st: &AppState, container: &str) -> Result<(), String> {
    let argv: Vec<String> = ["sh", "-c", "test -d /run/wh/home -a -w /run/wh/home"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let deadline = tokio::time::Instant::now() + START_WAIT;
    loop {
        let res = exec::exec_capture(
            &st.docker,
            container,
            ctl::CTL_USER,
            &argv,
            None,
            exec::EXEC_TIMEOUT_STATUS,
        )
        .await;
        match res {
            Ok(out) if out.success() => return Ok(()),
            Ok(_) | Err(DockerError::Conflict(_)) => {}
            Err(e) => return Err(format!("checking the git proxy: {e}")),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "the git proxy did not start within {} s",
                START_WAIT.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
