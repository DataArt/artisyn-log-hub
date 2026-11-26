//! Docker Engine API (bollard), after Work Hub's `docker/` module: the client for the endpoint the
//! platform resolved (`DOCKER_HOST`, then the current context, then the default pipe or socket;
//! bollard's own defaults ignore contexts), the error mapping with the FR-9 plain messages, and
//! the image, container and volume calls the engine makes.

pub mod bridge;
pub mod containers;
pub mod images;
pub mod volumes;

use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use agentbook_platform::{DockerEndpoint, DockerEndpointError, EndpointKind};

/// Docker Engine client handle (cheap to clone).
pub type Docker = bollard::Docker;

/// The FR-9 message when no engine answers.
pub const NO_ENGINE_MESSAGE: &str = "No Docker-compatible engine found. Start Docker Desktop / \
     Rancher Desktop (or the Docker Engine in your WSL distro) or ask your administrator.";

/// The message for an endpoint on another computer, which cannot see this computer's folders.
pub const NOT_LOCAL_MESSAGE: &str = "AgentBook needs a Docker engine on this computer.";

/// Per-request timeout of the client (seconds); long calls lift it with `with_timeout`.
const CLIENT_TIMEOUT_SECS: u64 = 120;
/// How long a `/_ping` may take.
pub const PING_TIMEOUT: Duration = Duration::from_secs(5);
/// Building an image (standard Equipment, laptop layer).
pub const BUILD_TIMEOUT: Duration = Duration::from_secs(3600);
/// Graceful stop before the engine kills the container.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// A failed Docker operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockerError {
    /// The engine could not be reached (pipe missing, connection refused, timeout).
    Unavailable(String),
    /// The engine answered 404.
    NotFound(String),
    /// The engine answered 409.
    Conflict(String),
    /// A call did not finish in time.
    Timeout(String),
    /// A command in a container exited non-zero.
    Exit { code: i64, stderr: String },
    /// Any other engine or local failure.
    Failed(String),
}

pub type DockerResult<T> = Result<T, DockerError>;

impl DockerError {
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::NotFound(_))
    }

    /// The text for the user: the FR-9 message when the engine is gone, else what Docker said.
    pub fn plain_message(&self) -> String {
        match self {
            Self::Unavailable(_) => NO_ENGINE_MESSAGE.to_string(),
            other => other.to_string(),
        }
    }
}

impl fmt::Display for DockerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(m) => write!(f, "Docker is unreachable: {m}"),
            Self::NotFound(m) => write!(f, "not found: {m}"),
            Self::Conflict(m) => write!(f, "conflict: {m}"),
            Self::Timeout(m) => write!(f, "{m} timed out"),
            Self::Exit { code, stderr } => {
                write!(f, "command exited with code {code}")?;
                if !stderr.trim().is_empty() {
                    write!(f, ": {}", stderr.trim())?;
                }
                Ok(())
            }
            Self::Failed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for DockerError {}

impl From<bollard::errors::Error> for DockerError {
    fn from(e: bollard::errors::Error) -> Self {
        use bollard::errors::Error as E;
        match e {
            E::DockerResponseServerError {
                status_code: 404,
                message,
            } => Self::NotFound(message),
            E::DockerResponseServerError {
                status_code: 409,
                message,
            } => Self::Conflict(message),
            E::DockerResponseServerError {
                status_code,
                message,
            } => Self::Failed(format!("Docker answered {status_code}: {message}")),
            E::DockerContainerWaitError { error, code } => Self::Exit {
                code,
                stderr: error,
            },
            e if is_connection_error(&e) => Self::Unavailable(e.to_string()),
            e => Self::Failed(e.to_string()),
        }
    }
}

impl From<std::io::Error> for DockerError {
    fn from(e: std::io::Error) -> Self {
        Self::Failed(format!("local I/O error: {e}"))
    }
}

/// Errors that mean "could not talk to the engine at all".
fn is_connection_error(e: &bollard::errors::Error) -> bool {
    use bollard::errors::Error as E;
    matches!(
        e,
        E::HyperLegacyError { .. }
            | E::HyperResponseError { .. }
            | E::IOError { .. }
            | E::SocketNotFoundError(_)
            | E::RequestTimeoutError
            | E::UnsupportedURISchemeError { .. }
    )
}

/// The plain message for an endpoint resolution failure (FR-9).
pub fn endpoint_message(e: &DockerEndpointError) -> String {
    match e {
        DockerEndpointError::NotLocal { url, .. } => {
            format!("{NOT_LOCAL_MESSAGE} Docker is set to {url}.")
        }
        DockerEndpointError::Unsupported { url, .. } => {
            format!("AgentBook cannot talk to the Docker engine at {url}. {NO_ENGINE_MESSAGE}")
        }
        DockerEndpointError::NotRunning { .. } => NO_ENGINE_MESSAGE.to_string(),
    }
}

/// A client for the resolved endpoint. Connecting is lazy: this fails only on an unusable
/// address, never because the engine is down. A `wsl` endpoint needs a [`bridge::Bridge`]:
/// connect to its URL with [`connect_url`].
pub fn connect(endpoint: &DockerEndpoint) -> DockerResult<Docker> {
    let docker = match endpoint.kind {
        EndpointKind::Wsl => {
            return Err(DockerError::Failed(
                "a Docker engine inside WSL is reached through the bridge".into(),
            ));
        }
        EndpointKind::Pipe | EndpointKind::Unix => bollard::Docker::connect_with_local(
            &endpoint.address,
            CLIENT_TIMEOUT_SECS,
            bollard::API_DEFAULT_VERSION,
        ),
        EndpointKind::Tcp => bollard::Docker::connect_with_http(
            &endpoint.address,
            CLIENT_TIMEOUT_SECS,
            bollard::API_DEFAULT_VERSION,
        ),
    };
    docker.map_err(DockerError::from)
}

/// A client for a `tcp://` URL on this computer (a bridge).
pub fn connect_url(url: &str) -> DockerResult<Docker> {
    bollard::Docker::connect_with_http(url, CLIENT_TIMEOUT_SECS, bollard::API_DEFAULT_VERSION)
        .map_err(DockerError::from)
}

/// A host path as the engine sees it, for a bind mount: unchanged, except for a Docker engine
/// inside WSL (`D:\x` → `/mnt/d/x`, see `agentbook_core::paths::wsl_path`). The plain message
/// when that engine cannot see the folder (a network share, another distro).
pub fn engine_path(endpoint: &DockerEndpoint, host: &str) -> Result<String, String> {
    if endpoint.kind != EndpointKind::Wsl {
        return Ok(host.to_string());
    }
    let root = endpoint.wsl_mount_root.as_deref().unwrap_or("/mnt/");
    agentbook_core::paths::wsl_path(host, &endpoint.address, root).ok_or_else(|| {
        format!(
            "The Docker engine in WSL ({}) cannot see {host}. Give the laptop a folder on a \
             local drive or inside that distro.",
            endpoint.address
        )
    })
}

/// `DOCKER_HOST` for programs the engine starts (the devcontainer CLI and `docker`), so they talk
/// to the same engine: `npipe:////./pipe/<name>`, `unix://<path>` or the TCP URL.
pub fn docker_host_value(endpoint: &DockerEndpoint) -> String {
    match endpoint.kind {
        EndpointKind::Pipe => format!("npipe://{}", endpoint.address.replace('\\', "/")),
        EndpointKind::Unix => format!("unix://{}", endpoint.address),
        EndpointKind::Tcp => endpoint.address.clone(),
        EndpointKind::Wsl => format!("wsl://{}", endpoint.address),
    }
}

/// What the engine says about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EngineInfo {
    /// `29.1.3`.
    pub version: String,
    /// `amd64` / `arm64`.
    pub arch: String,
    /// The engine's API version (`1.52`). The product name of the engine (its platform) is
    /// deliberately not read: the UI never shows which Docker product someone runs.
    pub api_version: String,
}

/// Pings the engine and reads its version, at most [`PING_TIMEOUT`].
pub async fn engine_info(docker: &Docker) -> DockerResult<EngineInfo> {
    let run = async {
        docker.ping().await?;
        let v = docker.version().await?;
        Ok::<_, DockerError>(EngineInfo {
            version: v.version.unwrap_or_default(),
            arch: v.arch.unwrap_or_default(),
            api_version: v.api_version.unwrap_or_default(),
        })
    };
    match tokio::time::timeout(PING_TIMEOUT, run).await {
        Ok(r) => r,
        Err(_) => Err(DockerError::Unavailable("ping timed out".into())),
    }
}

/// A `label=k=v` filter over every pair.
pub fn label_filter(pairs: &[(&str, &str)]) -> HashMap<String, Vec<String>> {
    HashMap::from([(
        "label".to_string(),
        pairs
            .iter()
            .map(|(k, v)| {
                if v.is_empty() {
                    (*k).to_string()
                } else {
                    format!("{k}={v}")
                }
            })
            .collect(),
    )])
}

/// Keeps the last lines of a long output (build logs) for an error message.
#[derive(Debug, Clone, Default)]
pub struct LogTail {
    lines: Vec<String>,
    keep: usize,
}

impl LogTail {
    pub fn new(keep: usize) -> Self {
        Self {
            lines: Vec::new(),
            keep,
        }
    }

    pub fn push(&mut self, line: &str) {
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        self.lines.push(line.to_string());
        if self.lines.len() > self.keep {
            let drop = self.lines.len() - self.keep;
            self.lines.drain(..drop);
        }
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    pub fn joined(&self) -> String {
        self.lines.join("\n")
    }
}
