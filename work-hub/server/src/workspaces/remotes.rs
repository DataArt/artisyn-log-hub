//! Workspace remotes (FR-5, plan D11a): attach a connection-backed remote, change its connection
//! or push policy, detach it and test it. The repo in every running container of the workspace
//! points the remote at the git proxy (`http://wh-git/git/<remote id>.git`); the proxy holds the
//! real upstream URL and the credential.

use uuid::Uuid;

use super::WorkspaceRow;
use super::repo::{self, NewRemote, RemoteRebind, RemoteRow, RemoteUpdate};
use crate::auth::users::UserRow;
use crate::connections::check::{self, parse_ls_remote, test_result};
use crate::connections::repo::{self as conn_repo, ConnectionRow, KIND_GIT};
use crate::connections::service::field_error;
use crate::connections::{TestResult, fields, record_outcome};
use crate::docker::containers;
use crate::docker::names::{WORKSPACE_REPO_DIR, WORKSTREAM_WORKTREE_DIR};
use crate::error::ApiError;
use crate::gitproxy::{self, Outcome};
use crate::state::AppState;

/// Message of a duplicate remote name in a workspace.
const MSG_DUPLICATE_REMOTE: &str = "This workspace already has a remote with this name.";

/// `POST /workspaces/{id}/remotes` body (D11a).
#[derive(Debug, Clone)]
pub struct AttachInput {
    pub name: String,
    pub connection_id: Uuid,
    pub url: String,
    /// Default `true`.
    pub block_default_rewrite: bool,
    /// Default `false`.
    pub only_ws_branches: bool,
}

/// `PATCH /remotes/{id}` body (D11a); `None` keeps a field.
#[derive(Debug, Clone, Default)]
pub struct UpdateRemoteInput {
    pub connection_id: Option<Uuid>,
    pub block_default_rewrite: Option<bool>,
    pub only_ws_branches: Option<bool>,
}

async fn owned_workspace(
    st: &AppState,
    user: &UserRow,
    ws_id: Uuid,
) -> Result<WorkspaceRow, ApiError> {
    repo::get_owned(&st.db, user.id, ws_id)
        .await?
        .ok_or_else(ApiError::not_found)
}

async fn owned_remote(st: &AppState, user: &UserRow, id: Uuid) -> Result<RemoteRow, ApiError> {
    repo::get_remote_owned(&st.db, user.id, id)
        .await?
        .ok_or_else(ApiError::not_found)
}

/// A git connection of the user that is granted to the workspace: 404 for a missing or foreign
/// one, 400 `connection_not_granted` without a grant.
async fn granted_connection(
    st: &AppState,
    user: &UserRow,
    connection_id: Uuid,
    ws_id: Uuid,
) -> Result<ConnectionRow, ApiError> {
    let conn = conn_repo::get_owned(&st.db, user.id, connection_id)
        .await?
        .filter(|c| c.kind == KIND_GIT)
        .ok_or_else(ApiError::not_found)?;
    if !conn_repo::is_granted(&st.db, conn.id, ws_id).await? {
        return Err(ApiError::connection_not_granted());
    }
    Ok(conn)
}

/// The upstream URL of `url` for the connection (400 `invalid_remote_url`).
fn upstream_for(conn: &ConnectionRow, url: &str) -> Result<String, ApiError> {
    let (p, method) = check::provider_and_method(conn)?;
    let (_, resolved) = check::resolve_url(conn, p, method, url)?;
    Ok(resolved.upstream_url)
}

/// The remotes of an owned workspace, oldest first.
pub async fn list(st: &AppState, user: &UserRow, ws_id: Uuid) -> Result<Vec<RemoteRow>, ApiError> {
    let ws = owned_workspace(st, user, ws_id).await?;
    Ok(repo::list_remotes(&st.db, ws.id).await?)
}

/// Attaches a remote (D11a): name rule, grant check, URL resolve, row insert (`default_branch`
/// stays NULL until a Test, D1 item 11), then a tolerant route push and the git remote in every
/// running container of the workspace. Makes no network call.
pub async fn attach(
    st: &AppState,
    user: &UserRow,
    ws_id: Uuid,
    input: AttachInput,
) -> Result<RemoteRow, ApiError> {
    let ws = owned_workspace(st, user, ws_id).await?;
    let name = input.name.trim();
    fields::validate_remote_name(name).map_err(field_error)?;
    if repo::remote_by_name(&st.db, ws.id, name).await?.is_some() {
        return Err(ApiError::duplicate_name(MSG_DUPLICATE_REMOTE));
    }
    let conn = granted_connection(st, user, input.connection_id, ws.id).await?;
    let url = input.url.trim();
    let upstream = upstream_for(&conn, url)?;
    let row = match repo::insert_remote(
        &st.db,
        &NewRemote {
            id: Uuid::new_v4(),
            workspace_id: ws.id,
            name,
            connection_id: conn.id,
            connection_name: &conn.name,
            url,
            upstream_url: &upstream,
            default_branch: None,
            block_default_rewrite: input.block_default_rewrite,
            only_ws_branches: input.only_ws_branches,
        },
    )
    .await
    {
        Ok(row) => row,
        Err(e) if repo::is_unique_violation(&e) => {
            return Err(ApiError::duplicate_name(MSG_DUPLICATE_REMOTE));
        }
        Err(e) => return Err(e.into()),
    };
    push_routes(st, "attaching a remote").await;
    sync_running_containers(st, &ws).await;
    Ok(row)
}

/// Changes a remote (D11a): a rebind to another connection needs a grant and resolves the
/// pasted URL again for it (status back to `untested`); the policy flags go to the proxy with
/// the routes.
pub async fn update_remote(
    st: &AppState,
    user: &UserRow,
    id: Uuid,
    input: UpdateRemoteInput,
) -> Result<RemoteRow, ApiError> {
    let remote = owned_remote(st, user, id).await?;
    let rebind = match input.connection_id {
        Some(cid) => {
            let conn = granted_connection(st, user, cid, remote.workspace_id).await?;
            let upstream = upstream_for(&conn, &remote.url)?;
            Some((conn, upstream))
        }
        None => None,
    };
    let update = RemoteUpdate {
        connection: rebind.as_ref().map(|(conn, upstream)| RemoteRebind {
            connection_id: conn.id,
            connection_name: &conn.name,
            upstream_url: upstream,
        }),
        block_default_rewrite: input.block_default_rewrite,
        only_ws_branches: input.only_ws_branches,
    };
    let row = repo::update_remote(&st.db, remote.id, &update)
        .await?
        .ok_or_else(ApiError::not_found)?;
    push_routes(st, "updating a remote").await;
    Ok(row)
}

/// Detaches a remote: deletes the row, pushes the routes, drops its mirror and removes the git
/// remote from every running container of the workspace. Sidecar failures are logged.
pub async fn detach(st: &AppState, user: &UserRow, id: Uuid) -> Result<(), ApiError> {
    let remote = owned_remote(st, user, id).await?;
    repo::delete_remote(&st.db, remote.id).await?;
    push_routes(st, "detaching a remote").await;
    if let Err(e) = gitproxy::prune_mirrors(st).await {
        tracing::info!(
            "remote {}: git proxy mirror not pruned: {}",
            remote.id,
            e.message
        );
    }
    if let Some(ws) = repo::get_by_id(&st.db, remote.workspace_id).await? {
        sync_running_containers(st, &ws).await;
    }
    Ok(())
}

/// Tests a remote: `ls-remote` of its upstream in the sidecar (needs a ready proxy). Stores the
/// remote status and, on success, its `default_branch`; the outcome also becomes the status of
/// its connection.
pub async fn test_remote(st: &AppState, user: &UserRow, id: Uuid) -> Result<TestResult, ApiError> {
    let remote = owned_remote(st, user, id).await?;
    let conn = match remote.connection_id {
        Some(cid) => conn_repo::get_by_id(&st.db, cid).await?,
        None => None,
    };
    let Some(conn) = conn else {
        let outcome = Outcome::Failed(format!(
            "The connection {} was deleted. Rebind the remote to another connection.",
            remote.connection_name
        ));
        let result = test_result(&remote.connection_name, &outcome, None);
        repo::set_remote_status(
            &st.db,
            remote.id,
            outcome.as_status(),
            result.message.as_deref(),
            None,
        )
        .await?;
        return Ok(result);
    };
    check::require_ready(st).await?;
    let (_, method) = check::provider_and_method(&conn)?;
    if method.is_ssh()
        && conn
            .known_hosts
            .as_deref()
            .is_none_or(|k| k.trim().is_empty())
    {
        let outcome = Outcome::Failed(format!(
            "Test the connection {} first to pin the host key of its git host.",
            conn.name
        ));
        let result = test_result(&conn.name, &outcome, None);
        repo::set_remote_status(
            &st.db,
            remote.id,
            outcome.as_status(),
            result.message.as_deref(),
            None,
        )
        .await?;
        return Ok(result);
    }
    let (outcome, default_branch) =
        match check::ls_remote(st, conn.id, &remote.upstream_url).await? {
            Ok(out) => (Outcome::Ok, parse_ls_remote(&out).default_branch),
            Err(outcome) => (outcome, None),
        };
    let result = test_result(&conn.name, &outcome, None);
    repo::set_remote_status(
        &st.db,
        remote.id,
        outcome.as_status(),
        result.message.as_deref(),
        default_branch.as_deref(),
    )
    .await?;
    record_outcome(st, conn.id, &outcome, None).await;
    Ok(result)
}

/// A tolerant `sync_routes` (D1 item 10): a proxy that is not ready catches up with `push_all`.
async fn push_routes(st: &AppState, what: &str) {
    if let Err(e) = gitproxy::sync_routes(st).await {
        tracing::info!("git proxy routes not synced after {what}: {}", e.message);
    }
}

/// Makes the git remotes of the repo in every running container of the workspace match the DB
/// (`sync_repo_remotes`). Failures are logged, never returned.
async fn sync_running_containers(st: &AppState, ws: &WorkspaceRow) {
    let containers = match gitproxy::repo::containers_of(&st.db, ws.id).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("workspace {}: listing its containers failed: {e}", ws.id);
            return;
        }
    };
    for (container, workstream) in containers {
        match containers::inspect(&st.docker, &container).await {
            Ok(Some(info)) if info.running => {}
            Ok(_) => continue,
            Err(e) => {
                tracing::warn!("{container}: inspect failed: {e}");
                continue;
            }
        }
        let repo_dir = if workstream.is_some() {
            WORKSTREAM_WORKTREE_DIR
        } else {
            WORKSPACE_REPO_DIR
        };
        if let Err(e) = gitproxy::containers::sync_repo_remotes(st, ws, &container, repo_dir).await
        {
            tracing::warn!("{container}: syncing the git remotes failed: {}", e.message);
        }
    }
}
