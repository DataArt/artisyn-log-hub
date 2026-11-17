//! The configure session of a workspace (D11 "Configure session", FR-25). The agent runs its
//! `configure_command` in the `configure` tmux session of the workspace container and installs
//! tools there; when it ends (`POST …/configure/finish` or the watcher sees a dead pane) the
//! container is committed as the next checkpoint image `wh-ckpt-<uuid>:<seq+1>`, which later
//! workspace recreations and new workstreams start from. No rollback (FR-25c).

use uuid::Uuid;

use super::repo::{self, WorkspaceRow};
use super::{adapter, ensure_workspace_container, exec_user, login, take_checkpoint};
use crate::docker::names::WORKSPACE_REPO_DIR;
use crate::error::ApiError;
use crate::state::AppState;
use crate::terminal::hub::{self, HubEvent};
use crate::terminal::tmux::{self, Session};
use crate::terminal::watchers;

/// `POST …/configure`: 409 `configure_running` when a configure session is running, 409
/// `login_required` without an agent login; otherwise sets `configure_started_at`, creates the
/// `configure` session and starts its watcher.
pub async fn start_configure(st: &AppState, ws: &WorkspaceRow) -> Result<(), ApiError> {
    if ws.configure_started_at.is_some() {
        return Err(ApiError::configure_running());
    }
    let agent = adapter(st, ws)?;
    if !login::check_login(st, ws).await? {
        return Err(ApiError::login_required(agent.display_name()));
    }
    let container = ensure_workspace_container(st, ws).await?;
    if !repo::try_start_configure(&st.db, ws.id).await? {
        return Err(ApiError::configure_running());
    }
    let user = exec_user(ws)?;
    let argv = agent.configure_command();
    let token = login::agent_env(st, ws, &container).await?;
    let secret = token.as_ref().map(|(n, v)| (*n, v.as_str()));
    let started = async {
        let created = tmux::ensure_session(
            &st.docker,
            &container,
            user,
            Session::Configure,
            WORKSPACE_REPO_DIR,
            &argv,
            tmux::SessionOpts {
                record_to: None,
                secret,
            },
        )
        .await?;
        // A leftover finished session (e.g. from before a restart) gets the command again.
        if !created
            && tmux::pane_dead(&st.docker, &container, user, Session::Configure).await?
                == Some(true)
        {
            tmux::respawn(
                &st.docker,
                &container,
                user,
                Session::Configure,
                &argv,
                tmux::SessionOpts {
                    record_to: None,
                    secret,
                },
            )
            .await?;
        }
        Ok::<(), crate::docker::DockerError>(())
    }
    .await;
    if let Err(e) = started {
        if let Err(clear) = repo::set_configure_started(&st.db, ws.id, None).await {
            tracing::warn!(
                "workspace {}: clearing configure_started_at failed: {clear}",
                ws.id
            );
        }
        return Err(e.into());
    }
    watchers::spawn_configure_watcher(st.clone(), ws.id);
    Ok(())
}

/// Ends the configure session (the API's `finish` and the watcher): kills the session, commits
/// the container as `wh-ckpt-<uuid>:<seq+1>`, stores `checkpoint_image` / `checkpoint_seq`,
/// clears `configure_started_at` and sends `ended` to the live terminal. A workspace whose
/// configure session is not running is left alone. On a failed commit `configure_started_at`
/// stays set, so the watcher retries.
pub async fn finish_configure(st: &AppState, ws_id: Uuid) -> Result<(), ApiError> {
    let _guard = st.locks.lock(&format!("configure:{ws_id}")).await;
    let Some(ws) = repo::get_by_id(&st.db, ws_id).await? else {
        return Ok(());
    };
    if ws.configure_started_at.is_none() {
        return Ok(());
    }
    let container = ensure_workspace_container(st, &ws).await?;
    let key = hub::key(&container, Session::Configure);
    tmux::kill(&st.docker, &container, exec_user(&ws)?, Session::Configure).await?;

    let seq = ws.checkpoint_seq + 1;
    let image = match take_checkpoint(st, ws.id, &container, seq).await {
        Ok(image) => image,
        Err(e) => {
            st.terminals.notify(
                &key,
                HubEvent::Error(
                    "The container settings couldn't be saved. Work Hub will try again.".into(),
                ),
            );
            return Err(e.into());
        }
    };
    repo::set_checkpoint(&st.db, ws.id, seq, &image).await?;
    repo::set_configure_started(&st.db, ws.id, None).await?;
    tracing::info!(
        "workspace {}: configure finished, checkpoint {image}",
        ws.id
    );
    st.terminals
        .notify(&key, HubEvent::Ended { logged_in: None });
    Ok(())
}
