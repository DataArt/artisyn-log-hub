//! The three terminal WebSockets (D11): `…/workstreams/{id}/chat/ws`, `…/workspaces/{id}/login/ws`
//! and `…/workspaces/{id}/configure/ws`.
//!
//! Order of checks: the session cookie (401), ownership (404), the `Origin` (403), the
//! workstream being open (`not_open`, 409), and only then the upgrade. The upgrade headers are
//! checked last, so a plain request gets the same answers as a WebSocket one.

use axum::extract::State;
use axum::extract::ws::{
    Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::IdPath;
use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::terminal::bridge::{self, BridgeTarget};
use crate::terminal::tmux::{self, Session};
use crate::workspaces::{self, WorkspaceRow};
use crate::workstreams;

type Upgrade = Result<WebSocketUpgrade, WebSocketUpgradeRejection>;

/// 403 `forbidden` for a WebSocket whose `Origin` is not Work Hub's own (cross-site WebSocket
/// hijacking: browsers send the cookie with any cross-origin WebSocket).
fn check_origin(st: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    if bridge::origin_allowed(headers, &st.config) {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "This connection is not allowed from this page.",
        ))
    }
}

/// `GET /api/v1/workstreams/{id}/chat/ws`: the agent chat of an open workstream. The container is
/// started and `chat` created (or respawned) before the attach.
pub async fn chat(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    headers: HeaderMap,
    ws: Upgrade,
) -> Response {
    let target = match chat_target(&st, &user, id, &headers).await {
        Ok(t) => t,
        Err(e) => return e.into_response(),
    };
    match ws {
        Ok(ws) => ws.on_upgrade(move |socket| bridge::run(st, socket, target)),
        Err(rejection) => rejection.into_response(),
    }
}

async fn chat_target(
    st: &AppState,
    user: &CurrentUser,
    id: uuid::Uuid,
    headers: &HeaderMap,
) -> ApiResult<BridgeTarget> {
    let (ws, s) = workstreams::load_owned(st, user.id(), id).await?;
    check_origin(st, headers)?;
    if !s.is_open() {
        return Err(ApiError::not_open());
    }
    let container = workstreams::ensure_open_running(st, &ws, &s).await?;
    Ok(BridgeTarget {
        container,
        user: workspaces::exec_user(&ws)?.to_string(),
        session: Session::Chat,
        recording: Some(workstreams::recording_source(&ws, &s)?),
    })
}

/// `GET /api/v1/workspaces/{id}/login/ws`: the `login` session started by `POST …/login/start`.
pub async fn login(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    headers: HeaderMap,
    ws: Upgrade,
) -> Response {
    service_socket(st, user, id, headers, ws, Session::Login).await
}

/// `GET /api/v1/workspaces/{id}/configure/ws`: the `configure` session started by
/// `POST …/configure`.
pub async fn configure(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    headers: HeaderMap,
    ws: Upgrade,
) -> Response {
    service_socket(st, user, id, headers, ws, Session::Configure).await
}

/// A workspace service session. When the session is not running (it already finished, or was
/// never started) the socket gets `ended` right away instead of a failed attach.
async fn service_socket(
    st: AppState,
    user: CurrentUser,
    id: uuid::Uuid,
    headers: HeaderMap,
    ws: Upgrade,
    session: Session,
) -> Response {
    let (row, target, running) = match service_target(&st, &user, id, &headers, session).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    if running {
        return ws.on_upgrade(move |socket| bridge::run(st, socket, target));
    }
    let logged_in = (session == Session::Login).then(|| row.logged_in());
    ws.on_upgrade(move |socket| send_ended(socket, logged_in))
}

async fn service_target(
    st: &AppState,
    user: &CurrentUser,
    id: uuid::Uuid,
    headers: &HeaderMap,
    session: Session,
) -> ApiResult<(WorkspaceRow, BridgeTarget, bool)> {
    let row = super::workspaces::owned(st, user, id).await?;
    check_origin(st, headers)?;
    let container = workspaces::ensure_workspace_container(st, &row).await?;
    let exec_user = workspaces::exec_user(&row)?.to_string();
    let running = tmux::has_session(&st.docker, &container, &exec_user, session).await?;
    let target = BridgeTarget {
        container,
        user: exec_user,
        session,
        recording: None,
    };
    Ok((row, target, running))
}

async fn send_ended(mut socket: WebSocket, logged_in: Option<bool>) {
    let frame = match logged_in {
        Some(v) => json!({"type": "ended", "loggedIn": v}),
        None => json!({"type": "ended"}),
    };
    let _ = socket.send(Message::Text(frame.to_string().into())).await;
    let _ = socket.send(Message::Close(None)).await;
}
