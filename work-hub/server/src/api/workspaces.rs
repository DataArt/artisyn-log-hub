//! Workspaces routes (API changes → Workspaces). Every route needs the session cookie; a missing
//! or foreign workspace answers 404 (D4).

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::IdPath;
use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::workspaces::{self, WorkspaceRow, configure, login, repo};
use crate::workstreams::{self, WorkstreamSummary};

/// `Workspace` of the API.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub working_branch: String,
    pub open_workstreams: i64,
    pub agent: String,
    pub agent_name: String,
    /// `"ok" | "missing"`.
    pub login_state: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub login_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// `GET …/{id}`: the workspace with its branches, whether configure runs and its open workstreams.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDetail {
    #[serde(flatten)]
    pub workspace: Workspace,
    pub branches: Vec<String>,
    pub configure_active: bool,
    pub workstreams: Vec<WorkstreamSummary>,
}

/// The API shape of a row.
pub fn workspace(st: &AppState, ws: &WorkspaceRow, open_workstreams: i64) -> Workspace {
    let agent_name = st
        .agents
        .get(&ws.agent)
        .map(|a| a.display_name().to_string())
        .unwrap_or_else(|| ws.agent.clone());
    Workspace {
        id: ws.id,
        name: ws.name.clone(),
        working_branch: ws.working_branch.clone(),
        open_workstreams,
        agent: ws.agent.clone(),
        agent_name,
        login_state: ws.login_state.clone(),
        login_at: ws.login_at,
        created_at: ws.created_at,
    }
}

/// The user's ready workspace; 404 otherwise.
pub async fn owned(st: &AppState, user: &CurrentUser, id: Uuid) -> ApiResult<WorkspaceRow> {
    repo::get_owned(&st.db, user.id(), id)
        .await?
        .ok_or_else(ApiError::not_found)
}

/// The workspace in its API shape, read again (after a change).
async fn current_shape(st: &AppState, user: &CurrentUser, id: Uuid) -> ApiResult<Workspace> {
    let row = repo::get_owned_with_count(&st.db, user.id(), id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(workspace(st, &row.ws, row.open_workstreams))
}

/// A JSON body: 400 `invalid_body` when it does not parse.
fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(|e| {
        ApiError::bad_request("invalid_body", format!("The request is not valid: {e}."))
    })
}

#[derive(Debug, Deserialize)]
struct NameBody {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchBody {
    working_branch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyBody {
    from_workspace_id: Uuid,
}

/// `GET /api/v1/workspaces`.
pub async fn list(
    State(st): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<Workspace>>> {
    let rows = repo::list_for_user(&st.db, user.id()).await?;
    Ok(Json(
        rows.iter()
            .map(|r| workspace(&st, &r.ws, r.open_workstreams))
            .collect(),
    ))
}

/// `POST /api/v1/workspaces` `{name}` → 201 `Workspace`.
pub async fn create(
    State(st): State<AppState>,
    user: CurrentUser,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let NameBody { name } = parse_body(&body)?;
    let row = workspaces::create(&st, &user.user, &name).await?;
    Ok((StatusCode::CREATED, Json(workspace(&st, &row, 0))).into_response())
}

/// `GET /api/v1/workspaces/{id}`: runs the live login check.
pub async fn get(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<WorkspaceDetail>> {
    let ws = owned(&st, &user, id).await?;
    login::check_login(&st, &ws).await?;
    let branches = workspaces::branches(&st, &ws).await?;
    let streams = workstreams::repo::list_open_by_workspace(&st.db, ws.id).await?;
    let shape = current_shape(&st, &user, id).await?;
    let configure_active = repo::get_owned(&st.db, user.id(), id)
        .await?
        .is_some_and(|w| w.configure_started_at.is_some());
    Ok(Json(WorkspaceDetail {
        workspace: shape,
        branches,
        configure_active,
        workstreams: streams
            .iter()
            .map(|s| workstreams::summary(&st, s))
            .collect(),
    }))
}

/// `PATCH /api/v1/workspaces/{id}` `{workingBranch}` → `Workspace`.
pub async fn update(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Json<Workspace>> {
    let ws = owned(&st, &user, id).await?;
    let BranchBody { working_branch } = parse_body(&body)?;
    workspaces::set_working_branch(&st, &ws, &working_branch).await?;
    Ok(Json(current_shape(&st, &user, id).await?))
}

/// `DELETE /api/v1/workspaces/{id}` → 204.
pub async fn delete(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<StatusCode> {
    let ws = owned(&st, &user, id).await?;
    workspaces::delete(&st, &ws).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET …/login/sources` → `[{id, name, loginAt}]`.
pub async fn login_sources(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<Vec<login::LoginSource>>> {
    let ws = owned(&st, &user, id).await?;
    Ok(Json(login::login_sources(&st, user.id(), &ws).await?))
}

/// `POST …/login/copy` `{fromWorkspaceId}` → `{loggedIn}`.
pub async fn login_copy(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    let ws = owned(&st, &user, id).await?;
    let CopyBody { from_workspace_id } = parse_body(&body)?;
    let logged_in = login::copy_login(&st, user.id(), &ws, from_workspace_id).await?;
    Ok(Json(json!({ "loggedIn": logged_in })))
}

/// `POST …/login/start` → 204 (idempotent).
pub async fn login_start(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<StatusCode> {
    let ws = owned(&st, &user, id).await?;
    login::start_login(&st, &ws).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST …/login/cancel` → 204.
pub async fn login_cancel(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<StatusCode> {
    let ws = owned(&st, &user, id).await?;
    login::cancel_login(&st, &ws).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET …/login/link` → `{url}` (`null` until the login terminal shows a link).
pub async fn login_link(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<serde_json::Value>> {
    let ws = owned(&st, &user, id).await?;
    let url = login::login_link(&st, &ws).await?;
    Ok(Json(json!({ "url": url })))
}

/// `POST …/login/logout` → `{loggedIn}` (false after a successful logout).
pub async fn login_logout(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<serde_json::Value>> {
    let ws = owned(&st, &user, id).await?;
    let logged_in = login::logout(&st, &ws).await?;
    Ok(Json(json!({ "loggedIn": logged_in })))
}

/// `POST …/configure` → 204 · 409 `configure_running` / `login_required`.
pub async fn configure(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<StatusCode> {
    let ws = owned(&st, &user, id).await?;
    configure::start_configure(&st, &ws).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST …/configure/finish` → `{checkpointSeq}`.
pub async fn configure_finish(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<serde_json::Value>> {
    let ws = owned(&st, &user, id).await?;
    configure::finish_configure(&st, ws.id).await?;
    let ws = owned(&st, &user, id).await?;
    Ok(Json(json!({ "checkpointSeq": ws.checkpoint_seq })))
}

/// `GET …/workstreams` → `WorkstreamSummary[]` in every state.
pub async fn list_workstreams(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<WorkstreamSummary>>> {
    let ws = owned(&st, &user, id).await?;
    let rows = workstreams::repo::list_by_workspace(&st.db, ws.id).await?;
    let mut out: Vec<WorkstreamSummary> =
        rows.iter().map(|s| workstreams::summary(&st, s)).collect();
    // `?disk=1`: each workstream's folder size (walks the folders, so only History asks).
    if q.disk.as_deref() == Some("1") {
        let dirs: Vec<Option<std::path::PathBuf>> = rows
            .iter()
            .map(|s| {
                s.files_dir
                    .as_deref()
                    .map(|rel| crate::files::host_path(&st.config, rel))
            })
            .collect();
        let sizes = tokio::task::spawn_blocking(move || {
            dirs.into_iter()
                .map(|d| d.map(|p| crate::files::dir_size(&p)))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(ApiError::internal)?;
        for (summary, size) in out.iter_mut().zip(sizes) {
            summary.disk_bytes = size;
        }
    }
    Ok(Json(out))
}

/// `GET …/workstreams` query.
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    disk: Option<String>,
}

/// `POST …/workstreams` `{name}` → 201 `WorkstreamSummary`.
pub async fn open_workstream(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let ws = owned(&st, &user, id).await?;
    let NameBody { name } = parse_body(&body)?;
    let row = workstreams::open(&st, &ws, &name).await?;
    Ok((StatusCode::CREATED, Json(workstreams::summary(&st, &row))).into_response())
}
