//! Workspace and workstream containers joining the git proxy (plan D5, D6): network, capability
//! and the repo's proxy remotes. Called after every start or create of such a container
//! ([`container_started`]) and after its removal ([`drop_container`]).

use bytes::Bytes;
use uuid::Uuid;

use super::{CAPABILITY_FILE, CREDENTIAL_HELPER, PROXY_HOST, remote_url, repo, sync_routes};
use crate::auth::tokens;
use crate::docker::exec::{self, EXEC_TIMEOUT_DEFAULT, EXEC_TIMEOUT_STATUS, sh};
use crate::docker::names::{self, Labels, Role};
use crate::docker::networks;
use crate::error::ApiError;
use crate::state::AppState;
use crate::terminal::tmux::shell_quote;
use crate::workspaces::{WorkspaceRow, exec_user, repo as ws_repo};

/// Hooks a freshly started (or created) workspace or workstream container up to the git proxy
/// (D5). Never fails the caller: every failure is logged as a warning.
pub async fn container_started(
    st: &AppState,
    ws: &WorkspaceRow,
    container: &str,
    repo_dir: &str,
    workstream: Option<Uuid>,
) {
    let user = match exec_user(ws) {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!("{container}: git proxy hook skipped: {}", e.message);
            return;
        }
    };
    container_started_as(st, ws.id, container, user, repo_dir, workstream).await;
}

/// [`container_started`] for a workspace whose row does not carry its container user yet (the
/// create steps): the exec user is given explicitly.
pub(crate) async fn container_started_as(
    st: &AppState,
    workspace_id: Uuid,
    container: &str,
    user: &str,
    repo_dir: &str,
    workstream: Option<Uuid>,
) {
    // 1. The internal network (created here too, so a container started before the sidecar
    // is still on it once the proxy comes up).
    let instance = &st.config.instance;
    let network = names::git_network(instance);
    let labels = Labels::new(instance, Role::GitProxy).into_map();
    let joined = match networks::ensure(&st.docker, &network, labels).await {
        Ok(()) => networks::connect(&st.docker, &network, container, None).await,
        Err(e) => Err(e),
    };
    if let Err(e) = joined {
        tracing::warn!("{container}: joining the git proxy network failed: {e}");
    }

    // 2–4. A new capability: its hash in the DB, the token in the container's tmpfs.
    let token = tokens::new_token();
    if let Err(e) = repo::upsert_capability(
        &st.db,
        container,
        workspace_id,
        workstream,
        &tokens::token_hash(&token),
    )
    .await
    {
        tracing::warn!("{container}: storing the git capability failed: {e}");
        return;
    }
    if let Err(e) = write_capability(st, container, user, &token).await {
        tracing::warn!(
            "{container}: writing the git capability failed: {}",
            e.message
        );
    }

    // 5. The repo's proxy remotes, when there is a repo.
    if has_git_dir(st, container, user, repo_dir).await
        && let Err(e) = sync_repo_remotes_as(st, workspace_id, container, user, repo_dir).await
    {
        tracing::warn!("{container}: syncing the git remotes failed: {}", e.message);
    }

    // 6. The sidecar's routes (tolerant: the proxy may still be building).
    if let Err(e) = sync_routes(st).await {
        tracing::info!("{container}: git proxy routes not synced: {}", e.message);
    }
}

/// `umask 077; cat > /tmp/wh-git-capability` with the token on stdin, as the container user. The
/// file is in a tmpfs, so `docker cp` cannot write it (D1 item 8).
async fn write_capability(
    st: &AppState,
    container: &str,
    user: &str,
    token: &str,
) -> Result<(), ApiError> {
    let script = format!("umask 077; cat > {CAPABILITY_FILE}");
    exec::exec_capture(
        &st.docker,
        container,
        user,
        &sh(script),
        Some(Bytes::from(token.to_string())),
        EXEC_TIMEOUT_STATUS,
    )
    .await?
    .check()?;
    Ok(())
}

/// True when `<repo_dir>/.git` exists (a directory in a repo, a file in a worktree).
async fn has_git_dir(st: &AppState, container: &str, user: &str, repo_dir: &str) -> bool {
    let script = format!("test -e {}", shell_quote(&format!("{repo_dir}/.git")));
    match exec::exec_capture(
        &st.docker,
        container,
        user,
        &sh(script),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await
    {
        Ok(out) => out.success(),
        Err(e) => {
            tracing::warn!("{container}: checking {repo_dir}/.git failed: {e}");
            false
        }
    }
}

/// Makes the repo's git remotes match the workspace's remotes (D5): every DB remote points at
/// its proxy URL, proxy remotes no longer in the DB are removed and the credential helper is set.
pub async fn sync_repo_remotes(
    st: &AppState,
    ws: &WorkspaceRow,
    container: &str,
    repo_dir: &str,
) -> Result<(), ApiError> {
    let user = exec_user(ws)?;
    sync_repo_remotes_as(st, ws.id, container, user, repo_dir).await
}

pub(crate) async fn sync_repo_remotes_as(
    st: &AppState,
    workspace_id: Uuid,
    container: &str,
    user: &str,
    repo_dir: &str,
) -> Result<(), ApiError> {
    let remotes = ws_repo::list_remotes(&st.db, workspace_id).await?;
    let script = remotes_script(
        repo_dir,
        &remotes
            .iter()
            .map(|r| (r.name.clone(), remote_url(r.id)))
            .collect::<Vec<_>>(),
    );
    let out = exec::exec_capture(
        &st.docker,
        container,
        user,
        &sh(script),
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    if !out.success() {
        return Err(ApiError::internal(format!(
            "syncing the git remotes in {container} exited with code {}: {}",
            out.exit_code,
            out.stderr_str().trim()
        )));
    }
    Ok(())
}

/// The `sh` script of [`sync_repo_remotes`]: `add` or `set-url` per remote, removal of the other
/// proxy remotes, then the credential helper of `http://wh-git`.
fn remotes_script(repo_dir: &str, remotes: &[(String, String)]) -> String {
    let mut script = format!("set -e; cd {}; ", shell_quote(repo_dir));
    let mut keep = String::from(" ");
    for (name, url) in remotes {
        let (n, u) = (shell_quote(name), shell_quote(url));
        script.push_str(&format!(
            "if git remote get-url {n} >/dev/null 2>&1; then git remote set-url {n} {u}; \
             else git remote add {n} {u}; fi; "
        ));
        keep.push_str(name);
        keep.push(' ');
    }
    let prefix = format!("http://{PROXY_HOST}/git/");
    script.push_str(&format!(
        "keep={keep}; for r in $(git remote); do \
           u=$(git remote get-url \"$r\" 2>/dev/null || true); \
           case \"$u\" in {prefix}*) case \"$keep\" in *\" $r \"*) ;; \
             *) git remote remove \"$r\";; esac;; esac; \
         done; ",
        keep = shell_quote(&keep),
        prefix = shell_quote(&prefix),
    ));
    script.push_str(&format!(
        "git config --local --replace-all {key} {helper}",
        key = shell_quote(&format!("credential.http://{PROXY_HOST}.helper")),
        helper = shell_quote(CREDENTIAL_HELPER),
    ));
    script
}

/// Revokes the capability of a removed container and pushes the routes (D5). Never fails the
/// caller: failures are logged.
pub async fn drop_container(st: &AppState, container: &str) {
    if let Err(e) = repo::delete_capability(&st.db, container).await {
        tracing::warn!("{container}: deleting the git capability failed: {e}");
        return;
    }
    if let Err(e) = sync_routes(st).await {
        tracing::info!("{container}: git proxy routes not synced: {}", e.message);
    }
}
