//! Auth (D3): a Rust re-implementation of Log Hub's auth contract. The behaviour ports follow
//! their Log Hub algorithm docs (`docs/knowledgebase/algorithms/`): password policy, login
//! backoff, local-request detection and startup config.

pub mod azure;
pub mod backoff;
pub mod extract;
pub mod js;
pub mod local_request;
pub mod mailer;
pub mod password_hash;
pub mod password_policy;
pub mod rate_limit;
pub mod routes;
pub mod sessions;
pub mod startup;
pub mod tokens;
pub mod users;

/// What `delete-account` removes before the user row (D3): all of the user's workspaces (D9).
/// `AppState` holds it as `Arc<dyn AccountCleanup>`.
#[async_trait::async_trait]
pub trait AccountCleanup: Send + Sync {
    async fn delete_user_data(&self, user_id: i64) -> Result<(), crate::error::ApiError>;
}

/// The cleanup used until the workspace service implements [`AccountCleanup`].
pub struct NoopAccountCleanup;

#[async_trait::async_trait]
impl AccountCleanup for NoopAccountCleanup {
    async fn delete_user_data(&self, _user_id: i64) -> Result<(), crate::error::ApiError> {
        Ok(())
    }
}

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

pub use extract::{CurrentUser, MeUser, Peer, require_mode};
pub use startup::AuthSettings;

/// `AUTH_MODE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    None,
    Password,
    PasswordConfirm,
    AzureOauth,
}

impl AuthMode {
    /// Exact, case-sensitive match of one of the four names.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "none" => Some(AuthMode::None),
            "password" => Some(AuthMode::Password),
            "password-confirm" => Some(AuthMode::PasswordConfirm),
            "azure-oauth" => Some(AuthMode::AzureOauth),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::None => "none",
            AuthMode::Password => "password",
            AuthMode::PasswordConfirm => "password-confirm",
            AuthMode::AzureOauth => "azure-oauth",
        }
    }
}

/// 429 with `Retry-After` (login backoff, auth rate limit). Body as Log Hub's:
/// `{statusCode: 429, message: "Too Many Requests"}`, plus `error` and `retryAfterSeconds`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooManyRequests {
    pub retry_after_secs: u64,
}

impl IntoResponse for TooManyRequests {
    fn into_response(self) -> Response {
        let body = json!({
            "statusCode": 429,
            "error": "too_many_requests",
            "message": "Too Many Requests",
            "retryAfterSeconds": self.retry_after_secs,
        });
        let mut res = (StatusCode::TOO_MANY_REQUESTS, Json(body)).into_response();
        if let Ok(v) = HeaderValue::from_str(&self.retry_after_secs.to_string()) {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        res
    }
}
