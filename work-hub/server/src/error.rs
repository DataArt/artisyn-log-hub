//! API errors (D4): every error body is `{error: <code>, message: <sentence for the UI>, ...details}`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// Extra fields flattened into the body (`version`, `paths`).
    pub details: Option<Map<String, Value>>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.status.as_u16(),
            self.code,
            self.message
        )
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = Map::new();
        if let Some(details) = self.details {
            body.extend(details);
        }
        body.insert("error".into(), Value::from(self.code));
        body.insert("message".into(), Value::from(self.message));
        (self.status, Json(Value::Object(body))).into_response()
    }
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    /// Adds one detail field to the body.
    pub fn with_detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details
            .get_or_insert_with(Map::new)
            .insert(key.to_string(), value.into());
        self
    }

    /// 500 for unexpected failures; the cause goes to the log, not to the user.
    pub fn internal(cause: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {cause}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Something went wrong on the server. Try again.",
        )
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "Please sign in.")
    }

    /// 403 `forbidden`: the signed-in user is not an admin (FR-12).
    pub fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Only a Work Hub administrator can see this.",
        )
    }

    pub fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "This item doesn't exist or isn't yours.",
        )
    }

    /// 400; the message is the failed name rule from `workhub-names` (D8).
    pub fn invalid_name(message: impl Into<String>) -> Self {
        Self::bad_request("invalid_name", message)
    }

    /// 400; "You already have a workspace with this name." or "This workspace already has a
    /// workstream with this name." (D8).
    pub fn duplicate_name(message: impl Into<String>) -> Self {
        Self::bad_request("duplicate_name", message)
    }

    pub fn unknown_branch() -> Self {
        Self::bad_request(
            "unknown_branch",
            "That branch doesn't exist in this workspace.",
        )
    }

    pub fn invalid_login_source() -> Self {
        Self::bad_request(
            "invalid_login_source",
            "That workspace has no login to copy.",
        )
    }

    pub fn working_tree_busy() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "working_tree_busy",
            "The working branch can't be switched right now: some files are not saved yet.",
        )
    }

    pub fn not_closed() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "not_closed",
            "Only a closed workstream can be reopened.",
        )
    }

    pub fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "Work Hub couldn't start this workstream's container. Try again later.",
        )
    }

    pub fn docker_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "docker_unavailable",
            "Work Hub can't reach Docker on this computer. Start Docker and try again.",
        )
    }

    pub fn image_not_ready() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "image_not_ready",
            "Work Hub is still preparing its container image. Try again in a few minutes.",
        )
    }

    pub fn git_proxy_not_ready() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "git_proxy_not_ready",
            "Work Hub is still starting its git proxy. Try again in a minute.",
        )
    }

    /// 400; a connection field (or the uploaded key) is not acceptable.
    pub fn invalid_connection(message: impl Into<String>) -> Self {
        Self::bad_request("invalid_connection", message)
    }

    /// 400; the exposed env variable name is not allowed or clashes with another one.
    pub fn invalid_env_name(message: impl Into<String>) -> Self {
        Self::bad_request("invalid_env_name", message)
    }

    /// 400; only a token connection can expose its secret as an env variable.
    pub fn expose_not_allowed(message: impl Into<String>) -> Self {
        Self::bad_request("expose_not_allowed", message)
    }

    /// 400; the remote name breaks the `workhub-connection-fields` remote name rule.
    pub fn invalid_remote_name(message: impl Into<String>) -> Self {
        Self::bad_request("invalid_remote_name", message)
    }

    /// 409 with the `workspaces` (`[{id, name}]`) whose remotes use the connection.
    pub fn connection_in_use(workspaces: Vec<(uuid::Uuid, String)>) -> Self {
        let list: Vec<Value> = workspaces
            .into_iter()
            .map(|(id, name)| serde_json::json!({ "id": id.to_string(), "name": name }))
            .collect();
        Self::new(
            StatusCode::CONFLICT,
            "connection_in_use",
            "Workspace remotes still use this connection.",
        )
        .with_detail("workspaces", list)
    }

    pub fn not_generated_key() -> Self {
        Self::bad_request(
            "not_generated_key",
            "Only a key generated by Work Hub can be regenerated.",
        )
    }

    /// 400; the message is the failed rule of `workhub-remote-url`.
    pub fn invalid_remote_url(message: impl Into<String>) -> Self {
        Self::bad_request("invalid_remote_url", message)
    }

    /// 400 with the `connectionId` whose credential the git host rejected.
    pub fn credential_rejected(connection_id: uuid::Uuid, message: impl Into<String>) -> Self {
        Self::bad_request("credential_rejected", message)
            .with_detail("connectionId", connection_id.to_string())
    }

    /// 400; the git host answered with an error other than a rejected credential.
    pub fn remote_error(message: impl Into<String>) -> Self {
        Self::bad_request("remote_error", message)
    }

    /// 400; the connection of a remote is not granted to its workspace.
    pub fn connection_not_granted() -> Self {
        Self::bad_request(
            "connection_not_granted",
            "This connection is not granted to the workspace. Grant it in Connections first.",
        )
    }

    /// 400; the clone of a new workspace failed (`message`: the last lines of git's output).
    pub fn clone_failed(message: impl Into<String>) -> Self {
        Self::bad_request("clone_failed", message)
    }

    /// 409; the user cancelled the clone of a new workspace.
    pub fn clone_cancelled() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "clone_cancelled",
            "The clone was cancelled. Nothing was kept.",
        )
    }

    pub fn host_key_mismatch() -> Self {
        Self::bad_request(
            "host_key_mismatch",
            "The host key changed while you were checking it. Test again and compare the new fingerprint.",
        )
    }

    pub fn create_failed() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "create_failed",
            "The workspace couldn't be created. Nothing was kept. Try again.",
        )
    }

    pub fn open_failed() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "open_failed",
            "The workstream couldn't be opened. Nothing was kept. Try again.",
        )
    }

    /// `agent_name` is the adapter's display name.
    pub fn login_required(agent_name: &str) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "login_required",
            format!("This workspace needs a {agent_name} login first."),
        )
    }

    pub fn configure_running() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "configure_running",
            "The container is already being configured.",
        )
    }

    /// 409 with the current `version` of the file on disk.
    pub fn changed_on_disk(version: impl Into<String>) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "changed_on_disk",
            "This file was changed by the agent.",
        )
        .with_detail("version", version.into())
    }

    /// 409 with the `paths` that already exist.
    pub fn target_exists(paths: Vec<String>) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "target_exists",
            "Some files with these names already exist.",
        )
        .with_detail("paths", paths)
    }

    /// 409 with the uncommitted `paths`.
    pub fn uncommitted(paths: Vec<String>) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "uncommitted",
            "The agent has not saved these files yet.",
        )
        .with_detail("paths", paths)
    }

    /// 409; `base` is the branch the workstream was opened from (D10).
    pub fn merge_conflict(base: &str) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "merge_conflict",
            format!(
                "Main has changed since this workstream started. Ask the agent in the chat: \u{201c}Combine the latest {base} into this work\u{201d}, then close again."
            ),
        )
    }

    pub fn not_open() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "not_open",
            "This workstream is not open.",
        )
    }

    pub fn not_text() -> Self {
        Self::bad_request("not_text", "This file can't be edited here.")
    }

    pub fn invalid_path() -> Self {
        Self::bad_request("invalid_path", "That file path is not allowed.")
    }

    pub fn cannot_discard() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "cannot_discard",
            "This workstream can't be discarded.",
        )
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::internal(e)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
