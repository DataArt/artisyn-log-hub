//! The web UI (D15): `web/dist` embedded in the binary with rust-embed, or read from
//! `WORK_HUB_STATIC_DIR` when it is set. Responses are compressed with brotli or gzip when the
//! client accepts it. A path that is not a file gets `index.html` (the SPA uses a hash router, so
//! this is mostly `/`); a missing file with an extension is a 404. `/api/*` and `/health` never
//! fall back to the UI: an unknown API path answers the JSON 404.
//!
//! A build without the web (`web/dist` missing: Rust-only checks, CI `work-hub-fast`) compiles
//! and serves a one-line "Web UI not built" page.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::handler::Handler;
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use tower_http::compression::CompressionLayer;

use crate::config::Config;
use crate::error::ApiError;

#[derive(RustEmbed)]
#[folder = "../web/dist/"]
#[allow_missing = true]
struct WebDist;

/// The page served when the binary was built without the web UI.
const NOT_BUILT_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Work Hub</title></head><body><p>Web UI not built. Run <code>npm run build</code> in work-hub/ and rebuild the server.</p></body></html>";

/// Where the UI files come from.
#[derive(Debug, Clone)]
enum Source {
    Embedded,
    Dir(PathBuf),
}

/// The router with only the UI fallback (compressed), to be merged under the API routes.
pub fn router(config: &Config) -> Router {
    let source = match &config.static_dir {
        Some(dir) => {
            tracing::info!("serving the web UI from {}", dir.display());
            Source::Dir(dir.clone())
        }
        None => Source::Embedded,
    };
    Router::new().fallback_service(
        serve
            .layer(CompressionLayer::new().br(true).gzip(true))
            .with_state(Arc::new(source)),
    )
}

/// The request path as a relative file path inside the UI root; `None` when it tries to leave
/// the root (`..`, absolute or drive components).
fn relative_path(uri_path: &str) -> Option<String> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'))?;
    let mut parts: Vec<&str> = Vec::new();
    for c in Path::new(&decoded).components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if decoded.contains('\\') {
        return None;
    }
    Some(parts.join("/"))
}

/// `%XX` decoding of a URL path; `None` for an invalid escape or non-UTF-8 result.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One file of the UI.
async fn load(source: &Source, rel: &str) -> Option<Vec<u8>> {
    if rel.is_empty() {
        return None;
    }
    match source {
        Source::Embedded => WebDist::get(rel).map(|f| f.data.into_owned()),
        Source::Dir(dir) => {
            let path = dir.join(rel);
            match tokio::fs::metadata(&path).await {
                Ok(m) if m.is_file() => tokio::fs::read(&path).await.ok(),
                _ => None,
            }
        }
    }
}

fn file_response(rel: &str, data: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(rel).first_or_octet_stream();
    // Vite fingerprints everything under assets/; index.html must always be revalidated.
    let cache = if rel.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut res = Body::from(data).into_response();
    let headers = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(mime.essence_str()) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

fn not_built() -> Response {
    let mut res = Body::from(NOT_BUILT_PAGE).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

/// The fallback handler.
async fn serve(State(source): State<Arc<Source>>, method: Method, uri: Uri) -> Response {
    let path = uri.path();
    if path == "/api" || path.starts_with("/api/") || path == "/health" {
        return ApiError::not_found().into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(rel) = relative_path(path) else {
        return ApiError::not_found().into_response();
    };
    if let Some(data) = load(&source, &rel).await {
        return file_response(&rel, data);
    }
    let last = rel.rsplit('/').next().unwrap_or("");
    if last.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    match load(&source, "index.html").await {
        Some(data) => file_response("index.html", data),
        None => not_built(),
    }
}
