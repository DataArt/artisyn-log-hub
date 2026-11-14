//! System routes (both public).

use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use crate::docker;
use crate::state::AppState;

/// `GET /health` → `{ok:true}`.
pub async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// `GET /api/v1/system/status` → `{docker:"ok"|"unreachable", defaultImage:"ok"|"building"|"failed"}`.
pub async fn status(State(st): State<AppState>) -> Json<Value> {
    let docker = docker::status(&st.docker).await;
    let image = st.image_status.read().await.as_api_str();
    Json(json!({
        "docker": docker.as_api_str(),
        "defaultImage": image,
    }))
}
