//! Workstreams routes (API changes → Workstreams). A missing or foreign workstream answers 404.

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::IdPath;
use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::terminal::recording::{self, RecordingMeta, TermSize};
use crate::terminal::tmux::{INITIAL_COLS, INITIAL_ROWS};
use crate::workstreams::close::{self, CloseCheck, CloseMode};
use crate::workstreams::{self, WorkstreamSummary};

#[derive(Debug, Deserialize)]
struct CloseBody {
    mode: CloseMode,
    #[serde(default)]
    force: bool,
    /// Commit every uncommitted file (outside `.gitignore`) in the workstream first (owner,
    /// 2026-11-14). Optional: older clients do not send it.
    #[serde(default)]
    commit: bool,
}

/// `POST …/close/check` → `{uncommitted, agentBusy}`.
pub async fn close_check(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<CloseCheck>> {
    let (ws, s) = workstreams::load_owned(&st, user.id(), id).await?;
    Ok(Json(close::close_check(&st, &ws, &s).await?))
}

/// `POST …/close` `{mode, force, commit?}` → `WorkstreamSummary` · 409 `uncommitted {paths}` /
/// `merge_conflict`.
pub async fn close(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: Bytes,
) -> ApiResult<Json<WorkstreamSummary>> {
    let (ws, s) = workstreams::load_owned(&st, user.id(), id).await?;
    let CloseBody {
        mode,
        force,
        commit,
    } = serde_json::from_slice(&body).map_err(|e| {
        ApiError::bad_request("invalid_body", format!("The request is not valid: {e}."))
    })?;
    let row = close::close(&st, &ws, &s, mode, force, commit).await?;
    Ok(Json(workstreams::summary(&st, &row)))
}

/// `POST …/discard` → `WorkstreamSummary`.
pub async fn discard(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<WorkstreamSummary>> {
    let (ws, s) = workstreams::load_owned(&st, user.id(), id).await?;
    let row = workstreams::discard(&st, &ws, &s).await?;
    Ok(Json(workstreams::summary(&st, &row)))
}

/// `POST …/reopen` → `WorkstreamSummary` · 409 `not_closed`.
pub async fn reopen(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<WorkstreamSummary>> {
    let (ws, s) = workstreams::load_owned(&st, user.id(), id).await?;
    let row = workstreams::reopen(&st, &ws, &s).await?;
    Ok(Json(workstreams::summary(&st, &row)))
}

/// `POST …/retry` → `WorkstreamSummary` · 503 `unavailable`.
pub async fn retry(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<WorkstreamSummary>> {
    let (ws, s) = workstreams::load_owned(&st, user.id(), id).await?;
    let row = workstreams::retry(&st, &ws, &s).await?;
    Ok(Json(workstreams::summary(&st, &row)))
}

/// `GET …/recording`: the stored chat recording (`application/octet-stream`), synced first when
/// the container runs. Empty without a recording.
pub async fn recording(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Response> {
    let (ws, s) = workstreams::load_owned(&st, user.id(), id).await?;
    if s.is_open() {
        workstreams::sync_if_running(&st, &ws, &s).await;
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let file = match recording::recording_file(&st, s.id).await? {
        Some(path) => match tokio::fs::File::open(&path).await {
            Ok(f) => Some(f),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(ApiError::internal(e)),
        },
        None => None,
    };
    let body = match file {
        Some(f) => {
            let len = f.metadata().await.map_err(ApiError::internal)?.len();
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
            // Only the bytes present now: the periodic sync may append while this is sent.
            use tokio::io::AsyncReadExt;
            Body::from_stream(tokio_util::io::ReaderStream::new(f.take(len)))
        }
        None => {
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(0u64));
            Body::empty()
        }
    };
    Ok((StatusCode::OK, headers, body).into_response())
}

/// `GET …/recording/meta` → `{totalBytes, initial:{cols, rows}, resizes:[{offset, cols, rows}]}`.
pub async fn recording_meta(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<RecordingMeta>> {
    let (_ws, s) = workstreams::load_owned(&st, user.id(), id).await?;
    let meta = recording::read_meta(&st, s.id)
        .await?
        .unwrap_or(RecordingMeta {
            total_bytes: 0,
            initial: TermSize {
                cols: i32::from(INITIAL_COLS),
                rows: i32::from(INITIAL_ROWS),
            },
            resizes: Vec::new(),
        });
    Ok(Json(meta))
}
