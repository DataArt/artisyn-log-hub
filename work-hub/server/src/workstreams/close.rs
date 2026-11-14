//! Closing a workstream (D10): the close check and the three closes.
//!
//! - **Bring into main:** sync the recording; `git bundle create - <base>..<branch>` in the
//!   workstream (an empty bundle means nothing to merge); under the workspace lock pipe it to
//!   `/tmp/wh-<uuid>.bundle` in the workspace container, fetch it into `refs/heads/<branch>` and
//!   merge `--no-ff` into `<base>`, in `/workspace/repo` when `<base>` is checked out there, else
//!   in a temporary worktree `/tmp/wh-merge-<uuid>`. On a conflict the merge is aborted, `<base>`
//!   is brought into the workstream (a bundle the other way) and the call answers
//!   `merge_conflict`; the workstream stays open. On success the container stops and the
//!   workstream is `closed` with `merged_at`.
//! - **Already merged elsewhere:** sync, remove the container and volumes, `done`.
//! - **Close for now:** sync, stop, `closed`.

use serde::{Deserialize, Serialize};

use super::{
    WorkstreamRow, collect, ensure_workstream_running, reload, remove_file_via_exec,
    remove_objects, repo, run_checked, set_available, sync_if_running, transition_lock,
    write_file_via_exec,
};
use crate::docker::exec::{self, EXEC_TIMEOUT_DEFAULT};
use crate::docker::names::{WORKSPACE_REPO_DIR, WORKSTREAM_WORKTREE_DIR};
use crate::docker::{DockerError, containers};
use crate::error::ApiError;
use crate::git::{self, MergeOutcome};
use crate::state::AppState;
use crate::terminal::tmux::{self, Session};
use crate::timing::AGENT_BUSY_WINDOW;
use crate::workspaces::{self, WorkspaceRow};

/// `mode` of `POST …/close`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseMode {
    BringIntoMain,
    MergedElsewhere,
    ForNow,
}

/// `POST …/close/check`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseCheck {
    /// Paths git reports as not committed in the worktree.
    pub uncommitted: Vec<String>,
    /// The chat window had output within [`AGENT_BUSY_WINDOW`].
    pub agent_busy: bool,
}

/// The uncommitted paths of the worktree (`status --porcelain=v1 -z --untracked-files=all`).
async fn uncommitted(st: &AppState, container: &str, user: &str) -> Result<Vec<String>, ApiError> {
    let out = run_checked(
        st,
        container,
        user,
        &git::status_porcelain(WORKSTREAM_WORKTREE_DIR),
    )
    .await?;
    Ok(git::uncommitted_paths(&git::parse_status_z(&out.stdout)))
}

/// D10 close check: the uncommitted paths and whether the agent is busy. `not_open` unless the
/// workstream is open.
pub async fn close_check(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<CloseCheck, ApiError> {
    if !s.is_open() {
        return Err(ApiError::not_open());
    }
    let container = ensure_workstream_running(st, ws, s).await?;
    let user = workspaces::exec_user(ws)?;
    let uncommitted = uncommitted(st, &container, user).await?;
    let agent = workspaces::adapter(st, ws)?;
    let markers = agent.busy_markers();
    // The transcript says it best (a turn ended / was interrupted); the screen is the fallback.
    let home = &workspaces::user_of(ws)?.home;
    let from_transcript = match agent.transcript_file(
        home,
        WORKSTREAM_WORKTREE_DIR,
        &s.agent_session_id.to_string(),
    ) {
        Some(path) => {
            let out = exec::exec_capture(
                &st.docker,
                &container,
                user,
                &exec::argv(&["tail", "-c", "262144", &path]),
                None,
                EXEC_TIMEOUT_DEFAULT,
            )
            .await?;
            if out.success() {
                agent.turn_running(&out.stdout_str())
            } else {
                None
            }
        }
        None => None,
    };
    let agent_busy = if let Some(running) = from_transcript {
        running
    } else if markers.is_empty() {
        tmux::window_activity(&st.docker, &container, user, Session::Chat)
            .await?
            .is_some_and(|a| a.within(AGENT_BUSY_WINDOW))
    } else {
        // Working = the agent's "still answering" text is on the chat screen now.
        tmux::capture_screen(&st.docker, &container, user, Session::Chat)
            .await?
            .is_some_and(|screen| {
                let screen = screen.to_lowercase();
                markers.iter().any(|m| screen.contains(&m.to_lowercase()))
            })
    };
    Ok(CloseCheck {
        uncommitted,
        agent_busy,
    })
}

/// After the container of a closed workstream stopped: deletes what the agent can download or
/// rebuild again from its home (adapter's `disposable_home_paths`), so a closed workstream keeps
/// only its files, branch, login and chat transcripts. Failures are only logged.
async fn prune_home(st: &AppState, ws: &WorkspaceRow, s: &WorkstreamRow) {
    let Some(dir) = s.files_dir.as_deref() else {
        return;
    };
    let agent = match workspaces::adapter(st, ws) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("workstream {}: cannot prune the home: {}", s.id, e.message);
            return;
        }
    };
    let labels =
        crate::docker::names::Labels::new(&st.config.instance, crate::docker::names::Role::Helper)
            .workspace(ws.id)
            .workstream(s.id)
            .into_map();
    let home = format!("{dir}/{}", crate::files::HOME_SUB);
    if let Err(e) = crate::files::prune(st, labels, &home, agent.disposable_home_paths()).await {
        tracing::warn!("workstream {}: cannot prune the home: {e}", s.id);
    }
}

/// "Commit all": `git add -A` (honours `.gitignore`) and one commit in the worktree, so the
/// files the agent left uncommitted go along with "Bring into main". Nothing to commit is fine.
async fn commit_all(
    st: &AppState,
    container: &str,
    user: &str,
    s: &WorkstreamRow,
) -> Result<(), ApiError> {
    run_checked(
        st,
        container,
        user,
        &git::git(WORKSTREAM_WORKTREE_DIR, &["add", "-A"]),
    )
    .await?;
    let staged = exec::exec_capture(
        &st.docker,
        container,
        user,
        &git::git(WORKSTREAM_WORKTREE_DIR, &["diff", "--cached", "--quiet"]),
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    if staged.success() {
        return Ok(());
    }
    let message = format!("Save the work of {}", s.name);
    run_checked(
        st,
        container,
        user,
        &git::git(WORKSTREAM_WORKTREE_DIR, &["commit", "-q", "-m", &message]),
    )
    .await?;
    tracing::info!(
        "workstream {}: committed the uncommitted files before closing",
        s.id
    );
    Ok(())
}

/// D10 close. Without `force`, uncommitted files answer `uncommitted {paths}` for the modes that
/// would leave them behind (bring into main: they are not merged; merged elsewhere: they are
/// deleted). "Close for now" keeps every file, so it never asks.
pub async fn close(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
    mode: CloseMode,
    force: bool,
    commit: bool,
) -> Result<WorkstreamRow, ApiError> {
    let _t = transition_lock(st, s.id).await;
    let s = reload(st, s.id).await?;
    if !s.is_open() {
        return Err(ApiError::not_open());
    }
    let container = ensure_workstream_running(st, ws, &s).await?;
    let user = workspaces::exec_user(ws)?;
    if commit {
        commit_all(st, &container, user, &s).await?;
    }
    if !force && mode != CloseMode::ForNow {
        let paths = uncommitted(st, &container, user).await?;
        if !paths.is_empty() {
            return Err(ApiError::uncommitted(paths));
        }
    }

    let row = match mode {
        CloseMode::BringIntoMain => {
            sync_if_running(st, ws, &s).await;
            let merged = bring_into_main(st, ws, &s, &container).await?;
            containers::stop(&st.docker, &container).await?;
            prune_home(st, ws, &s).await;
            repo::set_closed(&st.db, s.id, merged).await?
        }
        CloseMode::MergedElsewhere => {
            sync_if_running(st, ws, &s).await;
            remove_objects(st, s.id, s.files_dir.as_deref()).await?;
            repo::set_done(&st.db, s.id).await?
        }
        CloseMode::ForNow => {
            sync_if_running(st, ws, &s).await;
            containers::stop(&st.docker, &container).await?;
            prune_home(st, ws, &s).await;
            repo::set_closed(&st.db, s.id, false).await?
        }
    };
    set_available(st, s.id, true);
    tracing::info!("workstream {} closed ({mode:?})", s.id);
    let row = row.ok_or_else(ApiError::not_found)?;
    crate::files::write_workstream_meta(&st.config, &row);
    Ok(row)
}

/// Brings the workstream's branch into its base branch in the workspace repo (nothing to merge
/// also counts as brought in). `merge_conflict` after bringing the base into the workstream.
async fn bring_into_main(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
    container: &str,
) -> Result<bool, ApiError> {
    let user = workspaces::exec_user(ws)?;
    // From the commit it started from (recorded at open), never from the workstream's own copy
    // of the base branch, which the agent may have moved. Older workstreams bundle the whole
    // branch; the fetch skips what the workspace already has.
    let range = match s.base_commit.as_deref() {
        Some(base) if !base.is_empty() => format!("{base}..{}", s.branch),
        _ => s.branch.clone(),
    };
    let stream = exec::exec_stream_stdout(
        &st.docker,
        container,
        user,
        &git::bundle_create(WORKSTREAM_WORKTREE_DIR, &range),
    )
    .await?;
    let bundle = match collect(stream).await {
        Ok(b) => b,
        Err(DockerError::Exit { code, stderr }) if git::is_empty_bundle(code, &stderr) => {
            tracing::info!(
                "workstream {}: nothing to bring into {}",
                s.id,
                s.base_branch
            );
            return Ok(false);
        }
        Err(e) => return Err(e.into()),
    };

    let ws_container = workspaces::ensure_workspace_container(st, ws).await?;
    let _lock = st.locks.lock(&ws_container).await;
    match merge_into_base(st, ws, s, &ws_container, bundle).await? {
        MergeOutcome::Merged => Ok(true),
        MergeOutcome::Conflict => {
            bring_base_into_workstream(st, ws, s, &ws_container, container).await?;
            Err(ApiError::merge_conflict(&s.base_branch))
        }
        MergeOutcome::Failed => Err(ApiError::internal(format!(
            "workstream {}: the merge of {} into {} failed before merging",
            s.id, s.branch, s.base_branch
        ))),
    }
}

/// Steps 3 and 4 of "bring into main", under the workspace lock.
async fn merge_into_base(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
    ws_container: &str,
    bundle: Vec<u8>,
) -> Result<MergeOutcome, ApiError> {
    let user = workspaces::exec_user(ws)?;
    let bundle_path = format!("/tmp/wh-{}.bundle", s.id);
    write_file_via_exec(st, ws_container, user, &bundle_path, bundle).await?;
    let result = fetch_and_merge(st, ws_container, user, s, &bundle_path).await;
    remove_file_via_exec(st, ws_container, user, &bundle_path).await;
    result
}

async fn fetch_and_merge(
    st: &AppState,
    ws_container: &str,
    user: &str,
    s: &WorkstreamRow,
    bundle_path: &str,
) -> Result<MergeOutcome, ApiError> {
    run_checked(
        st,
        ws_container,
        user,
        &git::fetch(
            WORKSPACE_REPO_DIR,
            bundle_path,
            &git::force_refspec(&s.branch, &s.branch),
        ),
    )
    .await?;

    // In place when the base is checked out in /workspace/repo, else in a temporary worktree.
    let current = exec::exec_capture(
        &st.docker,
        ws_container,
        user,
        &git::current_branch(WORKSPACE_REPO_DIR),
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    let in_place = current.success() && current.stdout_str().trim() == s.base_branch;
    let dir = if in_place {
        WORKSPACE_REPO_DIR.to_string()
    } else {
        let tmp = format!("/tmp/wh-merge-{}", s.id);
        // A leftover of an interrupted close would block the add.
        let _ = exec::exec_capture(
            &st.docker,
            ws_container,
            user,
            &git::worktree_remove(WORKSPACE_REPO_DIR, &tmp),
            None,
            EXEC_TIMEOUT_DEFAULT,
        )
        .await;
        let _ = exec::exec_capture(
            &st.docker,
            ws_container,
            user,
            &git::git(WORKSPACE_REPO_DIR, &["worktree", "prune"]),
            None,
            EXEC_TIMEOUT_DEFAULT,
        )
        .await;
        run_checked(
            st,
            ws_container,
            user,
            &git::worktree_add(WORKSPACE_REPO_DIR, &tmp, &s.base_branch),
        )
        .await?;
        tmp
    };

    let outcome = merge_in(st, ws_container, user, s, &dir).await;
    if !in_place {
        let out = exec::exec_capture(
            &st.docker,
            ws_container,
            user,
            &git::worktree_remove(WORKSPACE_REPO_DIR, &dir),
            None,
            EXEC_TIMEOUT_DEFAULT,
        )
        .await;
        match out {
            Ok(o) if o.success() => {}
            Ok(o) => tracing::warn!("cannot remove the merge worktree {dir}: {}", o.stderr_str()),
            Err(e) => tracing::warn!("cannot remove the merge worktree {dir}: {e}"),
        }
    }
    outcome
}

/// `merge --no-ff` in `dir`; a conflict is aborted before returning.
async fn merge_in(
    st: &AppState,
    ws_container: &str,
    user: &str,
    s: &WorkstreamRow,
    dir: &str,
) -> Result<MergeOutcome, ApiError> {
    let message = format!("Bring {} into {}", s.name, s.base_branch);
    let out = exec::exec_capture(
        &st.docker,
        ws_container,
        user,
        &git::merge(dir, &s.branch, &message),
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    if out.success() {
        return Ok(MergeOutcome::Merged);
    }
    let head = exec::exec_capture(
        &st.docker,
        ws_container,
        user,
        &git::merge_head(dir),
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    let outcome = git::classify_merge(out.exit_code, Some(head.exit_code));
    match outcome {
        MergeOutcome::Conflict => {
            tracing::info!(
                "workstream {}: merging {} into {} conflicts; aborting",
                s.id,
                s.branch,
                s.base_branch
            );
            run_checked(st, ws_container, user, &git::merge_abort(dir)).await?;
        }
        MergeOutcome::Failed => tracing::warn!(
            "workstream {}: merge of {} into {} failed: {} {}",
            s.id,
            s.branch,
            s.base_branch,
            out.stdout_str().trim(),
            out.stderr_str().trim()
        ),
        MergeOutcome::Merged => {}
    }
    Ok(outcome)
}

/// The conflict path: `git bundle create - <base>` in the workspace, fetched into the
/// workstream as `+<base>:<base>`, so the agent can combine the latest base into its branch.
async fn bring_base_into_workstream(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
    ws_container: &str,
    container: &str,
) -> Result<(), ApiError> {
    let user = workspaces::exec_user(ws)?;
    let stream = exec::exec_stream_stdout(
        &st.docker,
        ws_container,
        user,
        &git::bundle_create(WORKSPACE_REPO_DIR, &s.base_branch),
    )
    .await?;
    let bundle = collect(stream).await?;
    let path = format!("/tmp/wh-{}-base.bundle", s.id);
    write_file_via_exec(st, container, user, &path, bundle).await?;
    let fetched = run_checked(
        st,
        container,
        user,
        &git::fetch(
            WORKSTREAM_WORKTREE_DIR,
            &path,
            &git::force_refspec(&s.base_branch, &s.base_branch),
        ),
    )
    .await;
    remove_file_via_exec(st, container, user, &path).await;
    fetched?;
    Ok(())
}
