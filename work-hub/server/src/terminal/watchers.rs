//! Watchers of the service sessions (D11).
//!
//! - **Login** (every [`LOGIN_WATCH_INTERVAL`]): when the `login` pane is dead it runs the agent's
//!   status check, updates `login_state` / `login_at`, kills the session and sends
//!   `ended{loggedIn}` to the live terminal. A missing session (cancelled) ends the watcher.
//! - **Configure** (every [`CONFIGURE_WATCH_INTERVAL`]): when the `configure` pane is dead or the
//!   session is gone it finishes the configure session (`workspaces::configure`). It stops when
//!   `configure_started_at` is cleared. At startup the watchers of every workspace with
//!   `configure_started_at` set are resumed.
//!
//! At most one watcher runs per `(container, session)` (the hub's watcher slots).

use uuid::Uuid;

use super::hub::{self, HubEvent};
use super::tmux::{self, Session};
use crate::docker::{DockerError, names};
use crate::state::AppState;
use crate::timing::{CONFIGURE_WATCH_INTERVAL, LOGIN_WATCH_INTERVAL};
use crate::workspaces::{configure, login, repo};

/// Whether a watcher keeps going after one check.
enum Next {
    Continue,
    Stop,
}

/// Starts the login watcher of a workspace unless one is running.
pub fn spawn_login_watcher(st: AppState, ws_id: Uuid) {
    let key = hub::key(&names::workspace_container(ws_id), Session::Login);
    if !st.terminals.start_watching(&key) {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(LOGIN_WATCH_INTERVAL).await;
            match check_login_session(&st, ws_id).await {
                Ok(Next::Continue) => {}
                Ok(Next::Stop) => break,
                Err(e) if e.is_not_found() => break, // the container is gone
                Err(e) => tracing::debug!("login watcher of {ws_id}: {e}"),
            }
        }
        st.terminals.stop_watching(&key);
    });
}

async fn check_login_session(st: &AppState, ws_id: Uuid) -> Result<Next, DockerError> {
    let Some(ws) = repo::get_by_id(&st.db, ws_id)
        .await
        .map_err(|e| DockerError::Failed(e.to_string()))?
    else {
        return Ok(Next::Stop);
    };
    let (Some(user), Some(agent)) = (ws.container_user.as_deref(), st.agents.get(&ws.agent)) else {
        return Ok(Next::Stop);
    };
    let container = names::workspace_container(ws.id);
    match tmux::pane_dead(&st.docker, &container, user, Session::Login).await? {
        None => Ok(Next::Stop),
        Some(false) => Ok(Next::Continue),
        Some(true) => {
            let logged_in = if agent.token_env().is_some() {
                // The login printed a token: store it for the user (secret store).
                login::take_login_token(st, &ws, &container)
                    .await
                    .map_err(|e| DockerError::Failed(e.message))?
            } else {
                let logged_in =
                    login::live_status(&st.docker, &container, user, agent.as_ref()).await?;
                repo::set_login_state(&st.db, ws.id, logged_in)
                    .await
                    .map_err(|e| DockerError::Failed(e.to_string()))?;
                logged_in
            };
            tmux::kill(&st.docker, &container, user, Session::Login).await?;
            tracing::info!(
                "workspace {}: login session ended, logged in: {logged_in}",
                ws.id
            );
            st.terminals.notify(
                &hub::key(&container, Session::Login),
                HubEvent::Ended {
                    logged_in: Some(logged_in),
                },
            );
            Ok(Next::Stop)
        }
    }
}

/// Starts the configure watcher of a workspace unless one is running.
pub fn spawn_configure_watcher(st: AppState, ws_id: Uuid) {
    let key = hub::key(&names::workspace_container(ws_id), Session::Configure);
    if !st.terminals.start_watching(&key) {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CONFIGURE_WATCH_INTERVAL).await;
            match check_configure_session(&st, ws_id).await {
                Ok(Next::Continue) => {}
                Ok(Next::Stop) => break,
                Err(e) => tracing::warn!("configure watcher of {ws_id}: {e}"),
            }
        }
        st.terminals.stop_watching(&key);
    });
}

async fn check_configure_session(st: &AppState, ws_id: Uuid) -> Result<Next, String> {
    let Some(ws) = repo::get_by_id(&st.db, ws_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(Next::Stop);
    };
    if ws.configure_started_at.is_none() {
        return Ok(Next::Stop);
    }
    let Some(user) = ws.container_user.as_deref() else {
        return Ok(Next::Stop);
    };
    let container = names::workspace_container(ws.id);
    let dead = match tmux::pane_dead(&st.docker, &container, user, Session::Configure).await {
        Ok(d) => d,
        // Missing or stopped container: the finish below brings it back (ensure) and commits.
        Err(DockerError::NotFound(_)) | Err(DockerError::Conflict(_)) => None,
        Err(e) => return Err(e.to_string()),
    };
    match dead {
        Some(false) => Ok(Next::Continue),
        Some(true) | None => {
            configure::finish_configure(st, ws.id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Next::Stop)
        }
    }
}

/// Resumes the configure watchers of every workspace with `configure_started_at` set (startup).
pub async fn resume_configure_watchers(st: &AppState) {
    match repo::list_configuring(&st.db).await {
        Ok(list) => {
            for ws in list {
                tracing::info!("workspace {}: resuming the configure watcher", ws.id);
                spawn_configure_watcher(st.clone(), ws.id);
            }
        }
        Err(e) => tracing::warn!("cannot resume configure watchers: {e}"),
    }
}
