//! Files routes (D12; prefix `/api/v1/workspaces/{id}/views/{view}/fs`). `{view}` is `main` or
//! an open workstream of the workspace; a workstream that is not open answers `not_open`.

use std::collections::HashMap;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::multipart::Field;
use axum::extract::{FromRequestParts, Multipart, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::docker::archive::TempFile;
use crate::error::{ApiError, ApiResult};
use crate::fs::transfer::{self, DownloadBody, UploadFile};
use crate::fs::{self as files, FileKind, TempFileStream, ViewCtx};
use crate::state::AppState;

/// `X-WorkHub-Kind` of `GET …/file`.
pub const KIND_HEADER: &str = "x-workhub-kind";

/// The `{id}` and `{view}` path parameters. A malformed workspace id answers 404.
#[derive(Debug, Clone)]
pub struct ViewPath {
    pub workspace: Uuid,
    pub view: String,
}

impl<S: Send + Sync> FromRequestParts<S> for ViewPath {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let params =
            axum::extract::Path::<HashMap<String, String>>::from_request_parts(parts, state)
                .await
                .map_err(|_| ApiError::not_found())?;
        let workspace = params
            .get("id")
            .and_then(|v| Uuid::parse_str(v).ok())
            .ok_or_else(ApiError::not_found)?;
        let view = params
            .get("view")
            .cloned()
            .ok_or_else(ApiError::not_found)?;
        Ok(ViewPath { workspace, view })
    }
}

async fn view(st: &AppState, user: &CurrentUser, p: &ViewPath) -> ApiResult<ViewCtx> {
    files::resolve_view(st, user.id(), p.workspace, &p.view).await
}

/// A JSON body: 400 `invalid_body` when it does not parse.
fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(|e| {
        ApiError::bad_request("invalid_body", format!("The request is not valid: {e}."))
    })
}

#[derive(Debug, Deserialize)]
pub struct DirQuery {
    #[serde(default)]
    dir: String,
}

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Deserialize)]
pub struct UploadQuery {
    #[serde(default)]
    dir: String,
    #[serde(default)]
    overwrite: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PollBody {
    #[serde(default)]
    dirs: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveBody {
    from: String,
    to_dir: String,
    #[serde(default)]
    overwrite: bool,
}

/// `1` / `true` turn a query flag on.
fn flag(v: Option<&str>) -> bool {
    matches!(v, Some("1") | Some("true"))
}

/// `GET …/list?dir=` → `{entries}`; 404 when the dir is missing.
pub async fn list(
    State(st): State<AppState>,
    user: CurrentUser,
    p: ViewPath,
    Query(q): Query<DirQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let ctx = view(&st, &user, &p).await?;
    let entries = files::list_dir(&st, &ctx, &q.dir).await?;
    Ok(Json(json!({ "entries": entries })))
}

/// `POST …/poll` `{dirs, files}` → `{dirs:{dir: Entry[]|null}, files:{path: version|null}}`.
pub async fn poll(
    State(st): State<AppState>,
    user: CurrentUser,
    p: ViewPath,
    body: Bytes,
) -> ApiResult<Json<files::poll::PollResult>> {
    let ctx = view(&st, &user, &p).await?;
    let PollBody { dirs, files: paths } = parse_body(&body)?;
    Ok(Json(files::poll::poll(&st, &ctx, &dirs, &paths).await?))
}

/// The `Content-Type` of a file read for the IDE. Text is always `text/plain` (HTML and SVG are
/// shown as code, never rendered, D12); images by their extension; everything else is opaque.
fn content_type(kind: FileKind, name: &str) -> HeaderValue {
    let mime = match kind {
        FileKind::Text => "text/plain; charset=utf-8".to_string(),
        FileKind::Image => mime_guess::from_path(name)
            .first()
            .filter(|m| m.type_() == mime_guess::mime::IMAGE && m.subtype() != "svg")
            .map(|m| m.essence_str().to_string())
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        _ => "application/octet-stream".to_string(),
    };
    HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream"))
}

/// A temp file as a streamed body.
async fn temp_body(file: TempFile) -> ApiResult<Body> {
    let stream = TempFileStream::open(file)
        .await
        .map_err(ApiError::internal)?;
    Ok(Body::from_stream(stream))
}

/// `GET …/file?path=`: raw bytes with `ETag: "<version>"` and `X-WorkHub-Kind`.
pub async fn read(
    State(st): State<AppState>,
    user: CurrentUser,
    p: ViewPath,
    Query(q): Query<PathQuery>,
) -> ApiResult<Response> {
    let ctx = view(&st, &user, &p).await?;
    let content = files::read_file(&st, &ctx, &q.path).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        content_type(content.kind, &content.name),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(content.size));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", content.version)).map_err(ApiError::internal)?,
    );
    headers.insert(KIND_HEADER, HeaderValue::from_static(content.kind.as_str()));
    let body = temp_body(content.file.file).await?;
    Ok((StatusCode::OK, headers, body).into_response())
}

/// `PUT …/file?path=` with `If-Match` → `{version}` · 409 `changed_on_disk {version}` · 400
/// `not_text`. No body limit on this route.
pub async fn save(
    State(st): State<AppState>,
    user: CurrentUser,
    p: ViewPath,
    Query(q): Query<PathQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    let ctx = view(&st, &user, &p).await?;
    let if_match = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok());
    let version = files::save_file(&st, &ctx, &q.path, if_match, body).await?;
    Ok(Json(json!({ "version": version })))
}

/// Spools one multipart part to a temp file in `<DATA_DIR>/tmp`.
async fn spool(st: &AppState, mut field: Field<'_>) -> ApiResult<TempFile> {
    let tmp = TempFile::new_in(&st.config.tmp_dir(), ".upload").map_err(ApiError::internal)?;
    let mut out = tokio::fs::File::create(tmp.path())
        .await
        .map_err(ApiError::internal)?;
    while let Some(chunk) = field.next().await {
        let chunk = chunk.map_err(|e| {
            ApiError::bad_request("invalid_body", format!("The upload was interrupted: {e}."))
        })?;
        out.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    out.flush().await.map_err(ApiError::internal)?;
    drop(out);
    Ok(tmp)
}

/// `POST …/upload?dir=&overwrite=0|1`, multipart `files` (filename = relative path) → `{paths}`
/// · 409 `target_exists {paths}`. No body limit on this route.
pub async fn upload(
    State(st): State<AppState>,
    user: CurrentUser,
    p: ViewPath,
    Query(q): Query<UploadQuery>,
    mut multipart: Multipart,
) -> ApiResult<Json<serde_json::Value>> {
    let ctx = view(&st, &user, &p).await?;
    let mut uploads: Vec<UploadFile> = Vec::new();
    loop {
        let field = multipart.next_field().await.map_err(|e| {
            ApiError::bad_request("invalid_body", format!("The upload is not valid: {e}."))
        })?;
        let Some(field) = field else { break };
        if field.name() != Some("files") {
            continue;
        }
        let Some(name) = field.file_name().map(str::to_string) else {
            continue;
        };
        let file = spool(&st, field).await?;
        uploads.push(UploadFile { name, file });
    }
    if uploads.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_body",
            "The upload has no files.",
        ));
    }
    let paths = transfer::upload(&st, &ctx, &q.dir, flag(q.overwrite.as_deref()), uploads).await?;
    Ok(Json(json!({ "paths": paths })))
}

/// `POST …/move` `{from, toDir, overwrite}` → `{path}` · 409 `target_exists` · 400 `invalid_path`.
pub async fn move_path(
    State(st): State<AppState>,
    user: CurrentUser,
    p: ViewPath,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    let ctx = view(&st, &user, &p).await?;
    let MoveBody {
        from,
        to_dir,
        overwrite,
    } = parse_body(&body)?;
    let path = transfer::move_path(&st, &ctx, &from, &to_dir, overwrite).await?;
    Ok(Json(json!({ "path": path })))
}

/// Characters kept as is in an RFC 5987 `filename*` value (`attr-char`).
fn is_attr_char(b: u8) -> bool {
    b.is_ascii_alphanumeric()
        || matches!(
            b,
            b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
        )
}

/// `attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>` (RFC 6266 with
/// the RFC 5987 encoding, so non-ASCII names survive).
pub fn content_disposition(name: &str) -> String {
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if is_attr_char(b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

/// `GET …/download?path=`: an attachment (a folder as `<name>.zip`).
pub async fn download(
    State(st): State<AppState>,
    user: CurrentUser,
    p: ViewPath,
    Query(q): Query<PathQuery>,
) -> ApiResult<Response> {
    let ctx = view(&st, &user, &p).await?;
    let dl = transfer::download(&st, &ctx, &q.path).await?;
    let (file, size, mime) = match dl.body {
        DownloadBody::File(content) => {
            (content.file.file, content.size, "application/octet-stream")
        }
        DownloadBody::Zip { file, size } => (file, size, "application/zip"),
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&dl.name)).map_err(ApiError::internal)?,
    );
    let body = temp_body(file).await?;
    Ok((StatusCode::OK, headers, body).into_response())
}
