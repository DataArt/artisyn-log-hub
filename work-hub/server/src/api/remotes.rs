//! Workspace remotes and clone-op routes (API changes → Remotes, clone ops). A missing, foreign
//! or malformed id answers 404 (D4).

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::IdPath;
use super::connections::{TestResult, parse_body, parse_body_or_default, provider_name};
use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::workspaces::clone;
use crate::workspaces::remotes::{self, AttachInput, UpdateRemoteInput};
use crate::workspaces::repo::RemoteRow;

/// `Remote` of the API. `url` is the URL as pasted; the upstream URL stays on the server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub url: String,
    pub connection_id: Option<Uuid>,
    pub connection_name: String,
    pub provider: Option<String>,
    pub provider_name: Option<String>,
    pub block_default_rewrite: bool,
    pub only_ws_branches: bool,
    pub default_branch: Option<String>,
    pub status: String,
    pub status_detail: Option<String>,
}

impl Remote {
    pub fn of(r: RemoteRow) -> Self {
        Self {
            provider_name: r.provider.as_deref().map(provider_name),
            id: r.id,
            workspace_id: r.workspace_id,
            name: r.name,
            url: r.url,
            connection_id: r.connection_id,
            connection_name: r.connection_name,
            provider: r.provider,
            block_default_rewrite: r.block_default_rewrite,
            only_ws_branches: r.only_ws_branches,
            default_branch: r.default_branch,
            status: r.status,
            status_detail: r.status_detail,
        }
    }
}

/// `CloneOp` of the API.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneOp {
    pub state: &'static str,
    pub line: String,
    pub percent: Option<u8>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachBody {
    name: String,
    connection_id: Uuid,
    url: String,
    #[serde(default = "default_true")]
    block_default_rewrite: bool,
    #[serde(default)]
    only_ws_branches: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    #[serde(default)]
    connection_id: Option<Uuid>,
    #[serde(default)]
    block_default_rewrite: Option<bool>,
    #[serde(default)]
    only_ws_branches: Option<bool>,
}

/// `GET /api/v1/workspaces/{id}/remotes` → `Remote[]`.
pub async fn list(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(ws_id): IdPath,
) -> ApiResult<Json<Vec<Remote>>> {
    let rows = remotes::list(&st, &user.user, ws_id).await?;
    Ok(Json(rows.into_iter().map(Remote::of).collect()))
}

/// `POST /api/v1/workspaces/{id}/remotes` → 201 `Remote`.
pub async fn attach(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(ws_id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let b: AttachBody = parse_body(&body)?;
    let row = remotes::attach(
        &st,
        &user.user,
        ws_id,
        AttachInput {
            name: b.name,
            connection_id: b.connection_id,
            url: b.url,
            block_default_rewrite: b.block_default_rewrite,
            only_ws_branches: b.only_ws_branches,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(Remote::of(row))).into_response())
}

/// `PATCH /api/v1/remotes/{id}` `{connectionId?, blockDefaultRewrite?, onlyWsBranches?}` →
/// `Remote`.
pub async fn update(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Json<Remote>> {
    let b: UpdateBody = parse_body_or_default(&body)?;
    let row = remotes::update_remote(
        &st,
        &user.user,
        id,
        UpdateRemoteInput {
            connection_id: b.connection_id,
            block_default_rewrite: b.block_default_rewrite,
            only_ws_branches: b.only_ws_branches,
        },
    )
    .await?;
    Ok(Json(Remote::of(row)))
}

/// `DELETE /api/v1/remotes/{id}` → 204.
pub async fn delete(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<StatusCode> {
    remotes::detach(&st, &user.user, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/remotes/{id}/test` `{}` → `TestResult`.
pub async fn test(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<TestResult>> {
    let result = remotes::test_remote(&st, &user.user, id).await?;
    Ok(Json(TestResult::of(result)))
}

/// `GET /api/v1/clone-ops/{id}` → `CloneOp` (only the user who started it; else 404).
pub async fn clone_op(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<CloneOp>> {
    let op = clone::progress(&st, id, user.id()).ok_or_else(ApiError::not_found)?;
    Ok(Json(CloneOp {
        state: op.state.as_api_str(),
        line: op.line,
        percent: op.percent,
    }))
}

/// `POST /api/v1/clone-ops/{id}/cancel` `{}` → 204.
pub async fn clone_cancel(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<StatusCode> {
    clone::cancel(&st, id, user.id()).await?;
    Ok(StatusCode::NO_CONTENT)
}
