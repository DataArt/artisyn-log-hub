//! Docker Engine API layer (D5, D6, D10). Everything Work Hub does with Docker goes through
//! these modules: names and labels, containers, execs, the archive endpoint, volumes and images.
//!
//! Errors are [`DockerError`]; a connection failure becomes [`DockerError::Unavailable`], which
//! maps to `docker_unavailable` (503) when it reaches the HTTP layer.

pub mod archive;
pub mod containers;
pub mod exec;
pub mod images;
pub mod names;
pub mod volumes;

use std::time::Duration;

use crate::error::ApiError;

/// Docker Engine client handle (cheap to clone).
pub type Docker = bollard::Docker;

/// How long the `/_ping` of [`status`] may take.
pub const PING_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
#[error("cannot set up the Docker client: {0}")]
pub struct DockerSetupError(#[from] bollard::errors::Error);

/// The Docker client for `DOCKER_HOST`, or bollard's platform default (unix socket / Windows
/// named pipe) when it is unset. bollard reads `DOCKER_HOST` itself, after `Config::from_env` has
/// loaded `.env` into the environment. Connecting is lazy: this never fails because Docker is
/// down, only on an unusable `DOCKER_HOST`.
pub fn connect() -> Result<Docker, DockerSetupError> {
    Ok(bollard::Docker::connect_with_defaults()?)
}

/// Docker Engine reachability for `GET /api/v1/system/status`. API: `"ok" | "unreachable"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerStatus {
    Ok,
    Unreachable,
}

impl DockerStatus {
    pub fn as_api_str(self) -> &'static str {
        match self {
            DockerStatus::Ok => "ok",
            DockerStatus::Unreachable => "unreachable",
        }
    }
}

/// Pings the Engine (`/_ping`, at most [`PING_TIMEOUT`]).
pub async fn status(docker: &Docker) -> DockerStatus {
    match tokio::time::timeout(PING_TIMEOUT, docker.ping()).await {
        Ok(Ok(_)) => DockerStatus::Ok,
        Ok(Err(e)) => {
            tracing::debug!("docker ping failed: {e}");
            DockerStatus::Unreachable
        }
        Err(_) => DockerStatus::Unreachable,
    }
}

/// A failed Docker operation.
#[derive(Debug, thiserror::Error)]
pub enum DockerError {
    /// The Engine could not be reached (socket missing, connection refused, request timed out).
    #[error("Docker is unreachable: {0}")]
    Unavailable(String),
    /// The Engine answered 404: no such container, image, volume, exec or path.
    #[error("not found: {0}")]
    NotFound(String),
    /// The Engine answered 409 (e.g. the container is not running, the name is taken).
    #[error("conflict: {0}")]
    Conflict(String),
    /// A command or operation did not finish within its timeout.
    #[error("{0} timed out")]
    Timeout(String),
    /// A command in a container exited non-zero (used by streams and helper runs).
    #[error("command exited with code {code}: {stderr}")]
    Exit { code: i64, stderr: String },
    /// Any other Engine or local I/O failure.
    #[error("{0}")]
    Failed(String),
}

pub type DockerResult<T> = Result<T, DockerError>;

impl DockerError {
    pub fn is_not_found(&self) -> bool {
        matches!(self, DockerError::NotFound(_))
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self, DockerError::Unavailable(_))
    }
}

impl From<bollard::errors::Error> for DockerError {
    fn from(e: bollard::errors::Error) -> Self {
        use bollard::errors::Error as E;
        match e {
            E::DockerResponseServerError {
                status_code: 404,
                message,
            } => DockerError::NotFound(message),
            E::DockerResponseServerError {
                status_code: 409,
                message,
            } => DockerError::Conflict(message),
            E::DockerResponseServerError {
                status_code,
                message,
            } => DockerError::Failed(format!("Docker answered {status_code}: {message}")),
            E::DockerContainerWaitError { error, code } => DockerError::Exit {
                code,
                stderr: error,
            },
            e if is_connection_error(&e) => DockerError::Unavailable(e.to_string()),
            e => DockerError::Failed(e.to_string()),
        }
    }
}

impl From<std::io::Error> for DockerError {
    fn from(e: std::io::Error) -> Self {
        DockerError::Failed(format!("local I/O error: {e}"))
    }
}

/// True for errors that mean "we could not talk to the Engine at all" rather than "the Engine
/// refused the request".
pub fn is_connection_error(e: &bollard::errors::Error) -> bool {
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

impl From<DockerError> for ApiError {
    fn from(e: DockerError) -> Self {
        match e {
            DockerError::Unavailable(cause) => {
                tracing::warn!("docker unavailable: {cause}");
                ApiError::docker_unavailable()
            }
            other => ApiError::internal(format!("docker: {other}")),
        }
    }
}

/// Maps a bollard error straight to the API error (`docker_unavailable` for connection errors).
pub fn map_err(e: bollard::errors::Error) -> ApiError {
    DockerError::from(e).into()
}
