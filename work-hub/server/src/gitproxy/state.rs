//! Pushing the server's view to the sidecar (plan D4, D5): connection files, remote records,
//! capabilities and the live mirrors. Everything goes through `ctl_raw`, so these work while the
//! proxy is still `building` (the startup task calls them before it reports `ok`).

use bytes::Bytes;
use uuid::Uuid;

use super::ctl::ctl_raw_ok;
use super::repo;
use crate::connections::providers::{self, AuthMethod};
use crate::connections::repo as conn_repo;
use crate::error::ApiError;
use crate::secrets;
use crate::state::AppState;

/// Every item followed by a newline (the stdin of the list-taking control commands).
fn lines<I: IntoIterator<Item = String>>(items: I) -> Bytes {
    let mut out = String::new();
    for item in items {
        out.push_str(&item);
        out.push('\n');
    }
    Bytes::from(out)
}

/// `content` with exactly one trailing newline (key and known_hosts files need it).
fn with_newline(mut content: Vec<u8>) -> Vec<u8> {
    while content.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
        content.pop();
    }
    content.push(b'\n');
    content
}

/// `put conns/<id>/<file>` with the content on stdin.
async fn put(st: &AppState, conn_id: Uuid, file: &str, content: Vec<u8>) -> Result<(), ApiError> {
    let rel = format!("conns/{conn_id}/{file}");
    ctl_raw_ok(st, &["put", &rel], Some(Bytes::from(content))).await?;
    Ok(())
}

/// The full state push (D5): every connection's files, `prune-conns`, the routes,
/// `prune-mirrors` and finally `ready`.
pub async fn push_all(st: &AppState) -> Result<(), ApiError> {
    let ids = conn_repo::all_ids(&st.db).await?;
    for id in &ids {
        sync_connection(st, *id).await?;
    }
    ctl_raw_ok(
        st,
        &["prune-conns"],
        Some(lines(ids.iter().map(Uuid::to_string))),
    )
    .await?;
    sync_routes(st).await?;
    prune_mirrors(st).await?;
    ctl_raw_ok(st, &["ready"], None).await?;
    Ok(())
}

/// Writes the D4 files of one connection from its row and its vault secret: `key` and
/// `known_hosts` (when pinned) for SSH methods, `header` and `api_header` (when the descriptor
/// has an API test) for a PAT. A connection that no longer exists is dropped from the sidecar;
/// a missing secret or an unknown provider / method is logged and skipped.
pub async fn sync_connection(st: &AppState, conn_id: Uuid) -> Result<(), ApiError> {
    let Some(row) = conn_repo::get_by_id(&st.db, conn_id).await? else {
        return drop_connection(st, conn_id).await;
    };
    let Some(method) = AuthMethod::parse(&row.auth_method) else {
        tracing::warn!(
            "connection {conn_id}: unknown auth method {:?}, not synced to the git proxy",
            row.auth_method
        );
        return Ok(());
    };
    let Some(secret) = secrets::get(st, row.user_id, &row.secret_name).await? else {
        tracing::warn!("connection {conn_id}: its secret is missing from the vault");
        return Ok(());
    };
    if method.is_ssh() {
        put(st, conn_id, "key", with_newline(secret)).await?;
        if let Some(known_hosts) = row.known_hosts.as_deref().filter(|k| !k.trim().is_empty()) {
            put(
                st,
                conn_id,
                "known_hosts",
                with_newline(known_hosts.as_bytes().to_vec()),
            )
            .await?;
        }
        return Ok(());
    }
    let Some(provider) = providers::get(&row.provider) else {
        tracing::warn!(
            "connection {conn_id}: unknown provider {:?}, not synced to the git proxy",
            row.provider
        );
        return Ok(());
    };
    let pat = String::from_utf8_lossy(&secret).trim().to_string();
    let header = providers::git_header(provider, row.username.as_deref(), &pat);
    put(st, conn_id, "header", header.into_bytes()).await?;
    if let Some((_, api_header)) = providers::api_request(provider, &row.base_url, &pat) {
        put(
            st,
            conn_id,
            "api_header",
            with_newline(api_header.into_bytes()),
        )
        .await?;
    }
    Ok(())
}

/// Removes a connection's files from the sidecar (`drop-conn`).
pub async fn drop_connection(st: &AppState, conn_id: Uuid) -> Result<(), ApiError> {
    let id = conn_id.to_string();
    ctl_raw_ok(st, &["drop-conn", &id], None).await?;
    Ok(())
}

/// Rebuilds the sidecar's remote records and capabilities from the DB (all rows):
/// `replace-remotes`, then `replace-caps`.
pub async fn sync_routes(st: &AppState) -> Result<(), ApiError> {
    let rows = repo::route_rows(&st.db).await?;
    ctl_raw_ok(
        st,
        &["replace-remotes"],
        Some(lines(rows.remotes.iter().map(repo::RemoteRecord::line))),
    )
    .await?;
    ctl_raw_ok(
        st,
        &["replace-caps"],
        Some(lines(
            rows.capabilities.iter().map(repo::CapabilityLine::line),
        )),
    )
    .await?;
    Ok(())
}

/// Removes the mirrors of remotes that no longer exist (`prune-mirrors`).
pub async fn prune_mirrors(st: &AppState) -> Result<(), ApiError> {
    let ids = repo::remote_ids(&st.db).await?;
    ctl_raw_ok(
        st,
        &["prune-mirrors"],
        Some(lines(ids.iter().map(Uuid::to_string))),
    )
    .await?;
    Ok(())
}
