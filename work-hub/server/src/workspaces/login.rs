//! Agent login of a workspace (D7): the live status check that refreshes the `login_state`
//! cache, copying a login from another workspace, the list of copy sources, and starting /
//! cancelling the interactive `login` tmux session (D11; its watcher is `terminal::watchers`).
//!
//! An agent with a token (`AgentAdapter::token_env`, Claude) has one login per user: the
//! long-lived token printed by its login command is kept in the secret store (`secrets`) and
//! passed to every agent process as an env variable; nothing of it is written into a container.
//! Copying a login is then unnecessary (every workspace of the user sees the token).

use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use super::repo::{self, WorkspaceRow};
use super::{adapter, ensure_workspace_container, exec_user, read_profile, user_of, write_profile};
use crate::agent::AgentAdapter;
use crate::docker::archive::{self, FileOwner, PutEntry, PutSource};
use crate::docker::exec::{self, EXEC_TIMEOUT_STATUS};
use crate::docker::names::WORKSPACE_REPO_DIR;
use crate::docker::{Docker, DockerError};
use crate::error::ApiError;
use crate::state::AppState;
use crate::terminal::tmux::{self, Session};
use crate::terminal::watchers;

/// One entry of `GET …/login/sources`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginSource {
    pub id: Uuid,
    pub name: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub login_at: Option<OffsetDateTime>,
}

/// Runs the adapter's `status_command` in `container`. A command that fails or times out counts
/// as "not logged in"; an unreachable Docker is an error.
pub async fn live_status(
    docker: &Docker,
    container: &str,
    user: &str,
    agent: &dyn AgentAdapter,
) -> Result<bool, DockerError> {
    match exec::exec_capture(
        docker,
        container,
        user,
        &agent.status_command(),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await
    {
        Ok(out) => Ok(agent.parse_status(out.exit_code, &out.stdout_str())),
        Err(DockerError::Unavailable(e)) => Err(DockerError::Unavailable(e)),
        Err(e) => {
            tracing::info!("{container}: agent status check failed: {e}");
            Ok(false)
        }
    }
}

/// Where the login session's output is collected while it runs: the container's `/tmp` (a
/// tmpfs: memory, never the host disk), read once the session ended to take the printed token.
const LOGIN_OUTPUT: &str = "/tmp/wh-login.raw";

/// The user's agent token as `(env name, value)` when the agent uses one and it is stored.
pub async fn agent_token(
    st: &AppState,
    ws: &WorkspaceRow,
) -> Result<Option<(&'static str, String)>, ApiError> {
    let agent = adapter(st, ws)?;
    let Some(env) = agent.token_env() else {
        return Ok(None);
    };
    let value = crate::secrets::get(st, ws.user_id, &crate::agent::token_secret(agent.as_ref()))
        .await?
        .and_then(|v| String::from_utf8(v).ok())
        .filter(|v| !v.trim().is_empty());
    Ok(value.map(|v| (env, v.trim().to_string())))
}

/// What an agent process in `container` (running as the workspace's user) starts with: the
/// user's token for its env, and — when there is one — the old login files removed from the
/// home, since a stale one would win over the token.
pub async fn agent_env(
    st: &AppState,
    ws: &WorkspaceRow,
    container: &str,
) -> Result<Option<(&'static str, String)>, ApiError> {
    let token = agent_token(st, ws).await?;
    if token.is_some() {
        let agent = adapter(st, ws)?;
        let home = user_of(ws)?.home;
        for file in agent.login_files() {
            let path = format!("{home}/{file}");
            crate::workstreams::remove_file_via_exec(st, container, exec_user(ws)?, &path).await;
        }
    }
    Ok(token)
}

/// The live login check (D7): ensures the container, runs the status command and updates the
/// cache. Returns whether the agent is logged in. With a token agent: whether the user's token
/// is stored.
pub async fn check_login(st: &AppState, ws: &WorkspaceRow) -> Result<bool, ApiError> {
    let agent = adapter(st, ws)?;
    if agent.token_env().is_some() {
        let logged_in = agent_token(st, ws).await?.is_some();
        if logged_in != ws.logged_in() || (logged_in && ws.login_at.is_none()) {
            repo::set_login_state(&st.db, ws.id, logged_in).await?;
        }
        return Ok(logged_in);
    }
    let container = ensure_workspace_container(st, ws).await?;
    let logged_in = live_status(&st.docker, &container, exec_user(ws)?, agent.as_ref()).await?;
    if logged_in != ws.logged_in() || (logged_in && ws.login_at.is_none()) {
        repo::set_login_state(&st.db, ws.id, logged_in).await?;
    }
    Ok(logged_in)
}

/// `POST …/login/logout`: runs the adapter's `logout_command` in the workspace container, then the
/// live check (which refreshes `login_state`). Open workstreams keep the copy of the login they
/// got when they were opened. Returns whether the workspace is still logged in.
pub async fn logout(st: &AppState, ws: &WorkspaceRow) -> Result<bool, ApiError> {
    let agent = adapter(st, ws)?;
    if agent.token_env().is_some() {
        // One token per user: logging out removes it for all of the user's workspaces.
        crate::secrets::delete(st, ws.user_id, &crate::agent::token_secret(agent.as_ref())).await?;
        repo::set_login_state_for_user(&st.db, ws.user_id, agent.id(), false).await?;
        return Ok(false);
    }
    let container = ensure_workspace_container(st, ws).await?;
    let out = crate::docker::exec::exec_capture(
        &st.docker,
        &container,
        exec_user(ws)?,
        &agent.logout_command(),
        None,
        crate::docker::exec::EXEC_TIMEOUT_STATUS,
    )
    .await?;
    if !out.success() {
        tracing::warn!(
            "workspace {}: logout exited {}: {}",
            ws.id,
            out.exit_code,
            out.stderr_str().trim()
        );
    }
    check_login(st, ws).await
}

/// The user's other workspaces whose login can be copied into `ws`.
pub async fn login_sources(
    st: &AppState,
    user_id: i64,
    ws: &WorkspaceRow,
) -> Result<Vec<LoginSource>, ApiError> {
    if adapter(st, ws)?.token_env().is_some() {
        return Ok(Vec::new());
    }
    Ok(repo::login_sources(&st.db, user_id, ws.id, &ws.agent)
        .await?
        .into_iter()
        .map(|w| LoginSource {
            id: w.id,
            name: w.name,
            login_at: w.login_at,
        })
        .collect())
}

/// `POST …/login/copy`: copies the adapter's `login_files` (mode 0600, owned by the target's
/// container user) and the `copy_extra_keys` of the profile from `from_id` into `to`, then runs
/// the live check. `invalid_login_source` when the source is not the user's, has another agent or
/// is not logged in.
pub async fn copy_login(
    st: &AppState,
    user_id: i64,
    to: &WorkspaceRow,
    from_id: Uuid,
) -> Result<bool, ApiError> {
    if adapter(st, to)?.token_env().is_some() {
        // Nothing to copy: the user's token already serves every workspace.
        return check_login(st, to).await;
    }
    let from = match repo::get_owned(&st.db, user_id, from_id).await? {
        Some(w) if w.id != to.id && w.agent == to.agent && w.logged_in() => w,
        _ => return Err(ApiError::invalid_login_source()),
    };
    let agent = adapter(st, to)?;
    let from_container = ensure_workspace_container(st, &from).await?;
    let to_container = ensure_workspace_container(st, to).await?;
    let from_user = user_of(&from)?;
    let to_user = user_of(to)?;
    let tmp = st.config.tmp_dir();

    // The login files.
    let mut entries = Vec::new();
    for rel in agent.login_files() {
        let path = format!("{}/{rel}", from_user.home.trim_end_matches('/'));
        if let Some(file) = archive::get_file(&st.docker, &tmp, &from_container, &path).await? {
            entries.push(PutEntry {
                path: (*rel).to_string(),
                source: PutSource::Bytes(file.read_all().await?.into()),
            });
        }
    }
    if entries.is_empty() {
        return Err(ApiError::invalid_login_source());
    }
    archive::put_files(
        &st.docker,
        &tmp,
        &to_container,
        &to_user.home,
        entries,
        FileOwner {
            uid: to_user.uid as u32,
            gid: to_user.gid as u32,
            mode: 0o600,
        },
    )
    .await?;

    // The extra profile keys (the adapter's `copy_extra_keys`).
    if !agent.copy_extra_keys().is_empty() {
        let source = read_profile(st, &from_container, &from_user.home, agent.as_ref()).await?;
        let mut target = read_profile(st, &to_container, &to_user.home, agent.as_ref()).await?;
        let mut changed = false;
        if let (Some(src), Some(dst)) = (source.as_object(), target.as_object_mut()) {
            for key in agent.copy_extra_keys() {
                if let Some(v) = src.get(*key) {
                    dst.insert((*key).to_string(), v.clone());
                    changed = true;
                }
            }
        }
        if changed {
            write_profile(st, &to_container, &to_user, agent.as_ref(), &target).await?;
        }
    }

    let logged_in = live_status(&st.docker, &to_container, exec_user(to)?, agent.as_ref()).await?;
    repo::set_login_state(&st.db, to.id, logged_in).await?;
    Ok(logged_in)
}

// ---------------------------------------------------------------- login session (D11)

/// `POST …/login/start`: creates the `login` tmux session with the adapter's `login_command`
/// in the workspace container and starts its watcher. Idempotent: with a session already running
/// it only makes sure the watcher runs, and the UI reattaches.
pub async fn start_login(st: &AppState, ws: &WorkspaceRow) -> Result<(), ApiError> {
    let container = ensure_workspace_container(st, ws).await?;
    let agent = adapter(st, ws)?;
    let user = exec_user(ws)?;
    // A token agent's login output is collected in the container's tmpfs, to take the token.
    let collect = agent.token_env().map(|_| LOGIN_OUTPUT);
    if collect.is_some() && !tmux::has_session(&st.docker, &container, user, Session::Login).await?
    {
        crate::workstreams::remove_file_via_exec(st, &container, user, LOGIN_OUTPUT).await;
    }
    tmux::ensure_session(
        &st.docker,
        &container,
        user,
        Session::Login,
        WORKSPACE_REPO_DIR,
        &agent.login_command(),
        collect,
        None,
    )
    .await?;
    watchers::spawn_login_watcher(st.clone(), ws.id);
    Ok(())
}

/// After a token agent's login session ended: takes the token from its collected output and
/// stores it for the user (all of the user's workspaces with the agent are then logged in). The
/// collected output is deleted either way. Returns whether the user now has a token.
pub async fn take_login_token(
    st: &AppState,
    ws: &WorkspaceRow,
    container: &str,
) -> Result<bool, ApiError> {
    let agent = adapter(st, ws)?;
    let user = exec_user(ws)?;
    let out = exec::exec_capture(
        &st.docker,
        container,
        user,
        &exec::argv(&["cat", LOGIN_OUTPUT]),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await?;
    crate::workstreams::remove_file_via_exec(st, container, user, LOGIN_OUTPUT).await;
    let name = crate::agent::token_secret(agent.as_ref());
    let token = out
        .success()
        .then(|| agent.token_from_login_output(&String::from_utf8_lossy(&out.stdout)))
        .flatten();
    if let Some(token) = token {
        crate::secrets::put(st, ws.user_id, &name, token.as_bytes()).await?;
        repo::set_login_state_for_user(&st.db, ws.user_id, agent.id(), true).await?;
        return Ok(true);
    }
    let has = crate::secrets::exists(st, ws.user_id, &name).await?;
    repo::set_login_state(&st.db, ws.id, has).await?;
    Ok(has)
}

/// `POST …/login/cancel`: kills the `login` session (its watcher then stops).
pub async fn cancel_login(st: &AppState, ws: &WorkspaceRow) -> Result<(), ApiError> {
    let container = ensure_workspace_container(st, ws).await?;
    tmux::kill(&st.docker, &container, exec_user(ws)?, Session::Login).await?;
    Ok(())
}
