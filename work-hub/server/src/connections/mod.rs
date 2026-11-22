//! Connections to git hosts (later also APIs): descriptors, the credential vault entries and
//! their grants to workspaces.

pub mod check;
pub mod fields;
pub mod providers;
pub mod remote_url;
pub mod repo;
pub mod service;
pub mod template;

pub use check::{
    Branches, HostKey, TestKind, TestResult, branches, outcome_message, record_outcome, test,
};
pub use service::{
    CreateInput, UpdateInput, create, delete, regenerate_key, secret_name, set_grants, update,
};

use uuid::Uuid;

use crate::error::ApiError;
use crate::gitproxy;
use crate::state::AppState;
use crate::workspaces::WorkspaceRow;

/// The `(env name, value)` pairs of the PAT connections granted to `ws` with `expose_env` set
/// (D10), in name order. A connection whose secret is missing from the vault is skipped.
pub async fn exposed_env(
    st: &AppState,
    ws: &WorkspaceRow,
) -> Result<Vec<(String, String)>, ApiError> {
    let mut out = Vec::new();
    for row in repo::exposed_for_workspace(&st.db, ws.id).await? {
        let Some(name) = row.expose_env.clone() else {
            continue;
        };
        let value = crate::secrets::get(st, row.user_id, &row.secret_name)
            .await?
            .and_then(|v| String::from_utf8(v).ok())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        match value {
            Some(v) => out.push((name, v)),
            None => tracing::warn!(
                "connection {}: its secret is missing from the vault",
                row.id
            ),
        }
    }
    Ok(out)
}

/// Account deletion (D6): deletes every connection of the user, then drops their files from the
/// git proxy and pushes the routes. Sidecar failures are logged, never returned. The vault
/// entries go with the caller's `secrets::delete_all`.
pub async fn delete_all_for_user(st: &AppState, user_id: i64) -> Result<(), ApiError> {
    let ids: Vec<Uuid> = repo::delete_all_for_user(&st.db, user_id).await?;
    for id in &ids {
        if let Err(e) = gitproxy::drop_connection(st, *id).await {
            tracing::info!(
                "connection {id}: not dropped from the git proxy: {}",
                e.message
            );
        }
    }
    if !ids.is_empty()
        && let Err(e) = gitproxy::sync_routes(st).await
    {
        tracing::info!(
            "git proxy routes not synced after deleting connections: {}",
            e.message
        );
    }
    Ok(())
}
