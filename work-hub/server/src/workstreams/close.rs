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
//!
//! With `push` (plan D12) the closed work also goes to the workspace's push remote (`origin`,
//! else the oldest remote) through the git proxy: "close for now" pushes the workstream branch
//! from the workstream container before it stops, "bring into main" pushes the base branch from
//! the workspace container after the merge. A failed push never fails the close.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    WorkstreamRow, collect, ensure_workstream_running, reload, remove_file_via_exec,
    remove_objects, repo, run_checked, set_available, sync_if_running, transition_lock,
    write_file_via_exec,
};
use crate::connections::check::{self as conn_check, parse_ls_remote};
use crate::connections::repo as conn_repo;
use crate::connections::{providers, record_outcome, remote_url};
use crate::docker::exec::{self, EXEC_TIMEOUT_DEFAULT};
use crate::docker::names::{WORKSPACE_REPO_DIR, WORKSTREAM_WORKTREE_DIR};
use crate::docker::{DockerError, containers};
use crate::error::ApiError;
use crate::git::{self, MergeOutcome};
use crate::gitproxy::{self, CREDENTIAL_HELPER, Outcome};
use crate::state::AppState;
use crate::terminal::tmux::{self, Session};
use crate::timing::AGENT_BUSY_WINDOW;
use crate::workspaces::repo::{self as ws_repo, RemoteRow};
use crate::workspaces::{self, WorkspaceRow};

/// How long a close push may run (D2).
const PUSH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Most characters of a push failure message (D12).
const MAX_PUSH_MESSAGE_CHARS: usize = 2000;
/// The git remote a clone creates and the preferred push remote (D12).
const ORIGIN: &str = "origin";

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
    /// Where "push" would go; `None` when the workspace has no remote (D12).
    pub push_remote: Option<PushRemote>,
    /// The workstream's own branch, which "Close for now" pushes (the close dialog names it).
    pub branch: String,
}

/// The push remote shown by the close dialog (API `PushRemote`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushRemote {
    pub name: String,
    pub connection_name: String,
    pub provider_name: Option<String>,
    pub default_branch: Option<String>,
}

impl PushRemote {
    fn of(r: &RemoteRow) -> Self {
        Self {
            name: r.name.clone(),
            connection_name: r.connection_name.clone(),
            provider_name: r
                .provider
                .as_deref()
                .and_then(providers::get)
                .map(|p| p.display_name.to_string()),
            default_branch: r.default_branch.clone(),
        }
    }
}

/// Who refused a close push (D12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectedBy {
    /// The Work Hub push policy of the remote.
    Policy,
    /// The credential or the capability.
    Credential,
    /// The git host or anything else.
    Host,
}

/// The outcome of a close push (API `PushResult`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub remote: String,
    pub branch: String,
    pub ok: bool,
    pub rejected_by: Option<RejectedBy>,
    pub message: Option<String>,
    /// The "open a pull/merge request" page, when the pushed branch is not the remote default.
    pub pr_url: Option<String>,
    pub pr_label: Option<String>,
}

/// The push remote of a workspace (D12): `origin` when it exists, else the oldest remote.
/// A DB failure is logged and answers `None`.
pub async fn push_remote(st: &AppState, ws: &WorkspaceRow) -> Option<RemoteRow> {
    match ws_repo::list_remotes(&st.db, ws.id).await {
        Ok(rows) => pick_push_remote(rows),
        Err(e) => {
            tracing::warn!("workspace {}: listing its remotes failed: {e}", ws.id);
            None
        }
    }
}

/// `origin`, else the first of the (oldest-first) rows.
fn pick_push_remote(rows: Vec<RemoteRow>) -> Option<RemoteRow> {
    let origin = rows.iter().position(|r| r.name == ORIGIN);
    let mut rows = rows;
    match origin {
        Some(i) => Some(rows.swap_remove(i)),
        None => rows.into_iter().next(),
    }
}

/// D12 classification of a failed push by its stderr.
fn rejected_by(stderr: &str) -> RejectedBy {
    if stderr.contains("Work Hub push policy") {
        RejectedBy::Policy
    } else if stderr.contains("rejected by the host")
        || stderr.contains("Authentication failed")
        || stderr.contains("unknown or revoked capability")
    {
        RejectedBy::Credential
    } else {
        RejectedBy::Host
    }
}

/// The stderr lines with `remote: ` stripped, at most [`MAX_PUSH_MESSAGE_CHARS`].
fn push_message(stderr: &str) -> String {
    let text = stderr
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .map(|l| l.strip_prefix("remote: ").unwrap_or(l).trim_end())
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    text.chars().take(MAX_PUSH_MESSAGE_CHARS).collect()
}

/// What a push says about its connection (D1 item 9). `None` leaves the status alone: a policy
/// refusal, a missing grant or a deleted connection say nothing about the credential.
fn push_outcome(ok: bool, stderr: &str) -> Option<Outcome> {
    if ok {
        return Some(Outcome::Ok);
    }
    if stderr.contains("Work Hub push policy")
        || stderr.contains("has no grant")
        || stderr.contains("was deleted")
        || stderr.contains("unknown or revoked capability")
    {
        return None;
    }
    if stderr.contains("rejected by the host") {
        return Some(Outcome::Rejected);
    }
    if stderr.contains("host key of the git host changed") {
        return Some(Outcome::HostKeyChanged);
    }
    // The host authenticated the proxy and then refused the update (e.g. not a fast-forward).
    if stderr.contains("the git host rejected the push") {
        return Some(Outcome::Ok);
    }
    Some(gitproxy::classify(stderr))
}

/// Pushes `branch` of the repo at `repo_dir` in `container` to `remote` through the git proxy
/// (D12): as the workspace user, [`PUSH_TIMEOUT`]. The outcome becomes the status of the remote
/// and its connection; a successful push of a branch other than the remote default carries the
/// pull/merge request page. Never fails: errors become a failed [`PushResult`].
pub async fn push_branch(
    st: &AppState,
    ws: &WorkspaceRow,
    container: &str,
    repo_dir: &str,
    remote: &RemoteRow,
    branch: &str,
) -> PushResult {
    let mut result = PushResult {
        remote: remote.name.clone(),
        branch: branch.to_string(),
        ok: false,
        rejected_by: None,
        message: None,
        pr_url: None,
        pr_label: None,
    };
    let user = match workspaces::exec_user(ws) {
        Ok(u) => u,
        Err(e) => {
            result.rejected_by = Some(RejectedBy::Host);
            result.message = Some(e.message);
            return result;
        }
    };
    let helper = format!(
        "credential.http://{}.helper={CREDENTIAL_HELPER}",
        gitproxy::PROXY_HOST
    );
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let argv = exec::argv(&[
        "env",
        "GIT_TERMINAL_PROMPT=0",
        "git",
        "-c",
        &helper,
        "-C",
        repo_dir,
        "push",
        &remote.name,
        &refspec,
    ]);
    let (ok, stderr) =
        match exec::exec_capture(&st.docker, container, user, &argv, None, PUSH_TIMEOUT).await {
            Ok(out) => (out.success(), out.stderr_str()),
            Err(e) => (false, e.to_string()),
        };
    result.ok = ok;
    if !ok {
        result.rejected_by = Some(rejected_by(&stderr));
        let message = push_message(&stderr);
        result.message = (!message.is_empty()).then_some(message);
        tracing::info!(
            "workspace {}: pushing {branch} to {} failed",
            ws.id,
            remote.name
        );
    }

    let conn = match remote.connection_id {
        Some(cid) => match conn_repo::get_by_id(&st.db, cid).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("connection {cid}: load failed: {e}");
                None
            }
        },
        None => None,
    };
    let outcome = push_outcome(ok, &stderr);
    let mut default_branch = remote.default_branch.clone();
    if let (Some(outcome), Some(conn)) = (&outcome, &conn) {
        // D1 item 11: a close-push learns the default branch the attach left unknown.
        if ok
            && default_branch.is_none()
            && let Ok(Ok(out)) = conn_check::ls_remote(st, conn.id, &remote.upstream_url).await
        {
            default_branch = parse_ls_remote(&out).default_branch;
        }
        let detail = crate::connections::outcome_message(&conn.name, outcome);
        if let Err(e) = ws_repo::set_remote_status(
            &st.db,
            remote.id,
            outcome.as_status(),
            detail.as_deref(),
            default_branch.as_deref(),
        )
        .await
        {
            tracing::warn!("remote {}: status not stored: {e}", remote.id);
        }
        record_outcome(st, conn.id, outcome, None).await;
    }

    if ok
        && let Some(conn) = &conn
        && default_branch.as_deref().is_some_and(|d| d != branch)
        && let Ok((p, method)) = conn_check::provider_and_method(conn)
        && let Ok((_, resolved)) = conn_check::resolve_url(conn, p, method, &remote.url)
    {
        let target = default_branch.as_deref().unwrap_or_default();
        result.pr_url = remote_url::pr_url(p, &conn.base_url, &resolved.vars, target, branch);
        if result.pr_url.is_some() {
            result.pr_label = p.pr_label.map(str::to_string);
        }
    }
    result
}

/// The push of a close: `None` without `push` or without a remote.
async fn push_if_asked(
    st: &AppState,
    ws: &WorkspaceRow,
    push: bool,
    container: &str,
    repo_dir: &str,
    branch: &str,
    workstream: Uuid,
) -> Option<PushResult> {
    if !push {
        return None;
    }
    let Some(remote) = push_remote(st, ws).await else {
        tracing::info!("workstream {workstream}: no remote to push to");
        return None;
    };
    Some(push_branch(st, ws, container, repo_dir, &remote, branch).await)
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
    let push_remote = push_remote(st, ws).await.as_ref().map(PushRemote::of);
    Ok(CloseCheck {
        uncommitted,
        agent_busy,
        push_remote,
        branch: s.branch.clone(),
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
///
/// With `push` (D12) "close for now" pushes the workstream branch before the container stops and
/// "bring into main" pushes the base branch after the merge; "merged elsewhere" never pushes.
/// The push result is `None` without `push` or without a remote; a failed push is a result, never
/// an error.
pub async fn close(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
    mode: CloseMode,
    force: bool,
    commit: bool,
    push: bool,
) -> Result<(WorkstreamRow, Option<PushResult>), ApiError> {
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

    let mut pushed = None;
    let row = match mode {
        CloseMode::BringIntoMain => {
            sync_if_running(st, ws, &s).await;
            let merged = bring_into_main(st, ws, &s, &container).await?;
            if push {
                match workspaces::ensure_workspace_container(st, ws).await {
                    Ok(ws_container) => {
                        pushed = push_if_asked(
                            st,
                            ws,
                            push,
                            &ws_container,
                            WORKSPACE_REPO_DIR,
                            &s.base_branch,
                            s.id,
                        )
                        .await;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "workstream {}: no workspace container to push from: {}",
                            s.id,
                            e.message
                        );
                        pushed = push_remote(st, ws).await.map(|r| PushResult {
                            remote: r.name,
                            branch: s.base_branch.clone(),
                            ok: false,
                            rejected_by: Some(RejectedBy::Host),
                            message: Some(e.message),
                            pr_url: None,
                            pr_label: None,
                        });
                    }
                }
            }
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
            pushed = push_if_asked(
                st,
                ws,
                push,
                &container,
                WORKSTREAM_WORKTREE_DIR,
                &s.branch,
                s.id,
            )
            .await;
            containers::stop(&st.docker, &container).await?;
            prune_home(st, ws, &s).await;
            repo::set_closed(&st.db, s.id, false).await?
        }
    };
    set_available(st, s.id, true);
    tracing::info!("workstream {} closed ({mode:?})", s.id);
    let row = row.ok_or_else(ApiError::not_found)?;
    crate::files::write_workstream_meta(&st.config, &row);
    Ok((row, pushed))
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
