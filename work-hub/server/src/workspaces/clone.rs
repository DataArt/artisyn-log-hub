//! The clone path of workspace create (FR-4, plan D11): the pre-checks, the clone through the
//! git proxy with progress, and the registry of running clone operations that
//! `GET /clone-ops/{id}` and `POST /clone-ops/{id}/cancel` read.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::repo::{self as ws_repo, ContainerUser, NewRemote};
use super::{StepError, Undo, UndoStep};
use crate::auth::users::UserRow;
use crate::connections::check::{self, parse_ls_remote};
use crate::connections::repo::{self as conn_repo, ConnectionRow, KIND_GIT};
use crate::connections::{outcome_message, record_outcome};
use crate::docker::exec::{self, EXEC_TIMEOUT_DEFAULT, EXEC_TIMEOUT_STATUS, sh};
use crate::docker::names::WORKSPACE_REPO_DIR;
use crate::error::ApiError;
use crate::git;
use crate::gitproxy::{self, CREDENTIAL_HELPER, Outcome};
use crate::state::{AppState, CloneOp, CloneState};
use crate::terminal::tmux::shell_quote;

/// How long a clone may run (D2).
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// How long an ended clone op stays readable (D11).
const OP_KEEP: Duration = Duration::from_secs(10 * 60);
/// The pid file of the running clone in the workspace container (D2).
const CLONE_PID_FILE: &str = "/tmp/wh-clone.pid";
/// The name of the remote a clone creates.
const ORIGIN: &str = "origin";
/// Most stderr lines in a `clone_failed` message.
const MAX_ERROR_LINES: usize = 20;
/// Most characters of the progress tail kept between stderr chunks.
const PROGRESS_TAIL: usize = 4096;

/// The `source` of `POST /workspaces` (D11).
#[derive(Debug, Clone)]
pub struct CloneSource {
    pub connection_id: Uuid,
    pub url: String,
    pub branch: Option<String>,
}

/// A source that passed the pre-checks: its connection, the resolved upstream URL and what
/// `ls-remote` learned.
#[derive(Debug, Clone)]
pub struct PreparedClone {
    pub connection: ConnectionRow,
    pub url: String,
    pub upstream_url: String,
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    /// The host shown as `Fetching from <host>…` until git prints progress.
    pub host: String,
}

// ---------------------------------------------------------------- clone-op registry

fn lock_ops(st: &AppState) -> std::sync::MutexGuard<'_, std::collections::HashMap<Uuid, CloneOp>> {
    st.git_proxy
        .clone_ops
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Drops ops that ended more than 10 minutes ago.
fn purge(ops: &mut std::collections::HashMap<Uuid, CloneOp>) {
    ops.retain(|_, op| op.ended_at.is_none_or(|t| t.elapsed() < OP_KEEP));
}

/// Registers a clone op for `user_id` at the start of the create request; 400 `invalid_body`
/// when the id is already in use.
pub fn register(st: &AppState, op_id: Uuid, user_id: i64) -> Result<(), ApiError> {
    let mut ops = lock_ops(st);
    purge(&mut ops);
    if ops.contains_key(&op_id) {
        return Err(ApiError::bad_request("invalid_body", "opId is in use."));
    }
    ops.insert(
        op_id,
        CloneOp {
            user_id,
            state: CloneState::Running,
            line: String::new(),
            percent: None,
            cancelled: false,
            ended_at: None,
            container: None,
        },
    );
    Ok(())
}

/// The op of `user_id`; `None` for a missing, foreign or expired one.
pub fn progress(st: &AppState, op_id: Uuid, user_id: i64) -> Option<CloneOp> {
    let mut ops = lock_ops(st);
    purge(&mut ops);
    ops.get(&op_id).filter(|op| op.user_id == user_id).cloned()
}

/// Cancels a running op of `user_id` (D11): marks it cancelled and, once the clone runs, kills
/// it in the workspace container. 404 for a missing or foreign op; an ended op is left as it is.
pub async fn cancel(st: &AppState, op_id: Uuid, user_id: i64) -> Result<(), ApiError> {
    let container = {
        let mut ops = lock_ops(st);
        let op = ops
            .get_mut(&op_id)
            .filter(|op| op.user_id == user_id)
            .ok_or_else(ApiError::not_found)?;
        if op.state != CloneState::Running {
            return Ok(());
        }
        op.cancelled = true;
        op.container.clone()
    };
    if let Some(container) = container {
        kill_clone(st, &container).await;
    }
    Ok(())
}

/// `kill $(cat /tmp/wh-clone.pid)` in the container (as root); a clone not started yet has no
/// pid file, and the clone steps check the cancel flag before they start it.
async fn kill_clone(st: &AppState, container: &str) {
    let script = format!("test -s {CLONE_PID_FILE} && kill \"$(cat {CLONE_PID_FILE})\"");
    if let Err(e) = exec::exec_capture(
        &st.docker,
        container,
        "0",
        &sh(script),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await
    {
        tracing::info!("{container}: cancelling the clone failed: {e}");
    }
}

/// Ends an op with `state`; it stays readable for 10 minutes.
pub fn finish(st: &AppState, op_id: Uuid, state: CloneState) {
    let mut ops = lock_ops(st);
    if let Some(op) = ops.get_mut(&op_id) {
        op.state = state;
        op.ended_at = Some(Instant::now());
        if state == CloneState::Done {
            op.percent = Some(100);
        }
    }
}

fn is_cancelled(st: &AppState, op_id: Option<Uuid>) -> bool {
    op_id.is_some_and(|id| lock_ops(st).get(&id).is_some_and(|op| op.cancelled))
}

fn update_op(st: &AppState, op_id: Option<Uuid>, f: impl FnOnce(&mut CloneOp)) {
    if let Some(id) = op_id
        && let Some(op) = lock_ops(st).get_mut(&id)
    {
        f(op);
    }
}

// ---------------------------------------------------------------- progress parsing

/// The last complete progress line of git's stderr text (segments end with `\r` or `\n`; the
/// unterminated tail is skipped) and its last `(\d+)%`.
pub fn parse_progress(text: &str) -> Option<(String, Option<u8>)> {
    let mut segments: Vec<&str> = text.split(['\r', '\n']).collect();
    segments.pop();
    let line = segments
        .into_iter()
        .map(str::trim)
        .rfind(|s| !s.is_empty())?;
    Some((line.to_string(), last_percent(line)))
}

/// The last `(\d+)%` of a line (0–100).
pub fn last_percent(line: &str) -> Option<u8> {
    let bytes = line.as_bytes();
    let mut found = None;
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'%' {
            continue;
        }
        let start = bytes[..i]
            .iter()
            .rposition(|c| !c.is_ascii_digit())
            .map_or(0, |p| p + 1);
        if start < i
            && let Ok(n) = line[start..i].parse::<u32>()
            && n <= 100
        {
            found = Some(n as u8);
        }
    }
    found
}

/// True for git's progress lines (with or without the `remote: ` prefix).
pub fn is_progress_line(line: &str) -> bool {
    const PREFIXES: [&str; 10] = [
        "Cloning into",
        "Enumerating objects",
        "Counting objects",
        "Compressing objects",
        "Receiving objects",
        "Resolving deltas",
        "Updating files",
        "Checking out files",
        "Checking connectivity",
        "Total ",
    ];
    let l = line.trim();
    let l = l.strip_prefix("remote:").map_or(l, str::trim_start);
    PREFIXES.iter().any(|p| l.starts_with(p))
}

/// The last 20 stderr lines without progress lines (the `clone_failed` message).
pub fn error_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .split(['\r', '\n'])
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty() && !is_progress_line(l))
        .collect();
    let from = lines.len().saturating_sub(MAX_ERROR_LINES);
    lines[from..].join("\n")
}

/// The connection outcome of a failed clone: the proxy's own messages decide (a missing
/// capability is not the connection's fault).
fn clone_outcome(stderr: &str) -> Outcome {
    if stderr.contains("rejected by the host") {
        Outcome::Rejected
    } else if stderr.contains("the host key of the git host changed") {
        Outcome::HostKeyChanged
    } else {
        let tail = error_tail(stderr);
        Outcome::Failed(tail.lines().last().unwrap_or("").to_string())
    }
}

// ---------------------------------------------------------------- pre-checks

/// D11 pre-checks, before the workspace row is inserted: the connection is the user's and a git
/// connection (404 otherwise), the URL resolves for it, the proxy is ready, and `ls-remote` of the
/// upstream works (it gives the default branch). A rejected credential answers
/// `credential_rejected`, other failures `clone_failed`.
pub async fn precheck(
    st: &AppState,
    user: &UserRow,
    source: &CloneSource,
) -> Result<PreparedClone, ApiError> {
    let conn = conn_repo::get_owned(&st.db, user.id, source.connection_id)
        .await?
        .filter(|c| c.kind == KIND_GIT)
        .ok_or_else(ApiError::not_found)?;
    let (p, method) = check::provider_and_method(&conn)?;
    let url = source.url.trim().to_string();
    let (parsed, resolved) = check::resolve_url(&conn, p, method, &url)?;
    let branch = source
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    check::require_ready(st).await?;
    if method.is_ssh()
        && conn
            .known_hosts
            .as_deref()
            .is_none_or(|k| k.trim().is_empty())
    {
        return Err(ApiError::clone_failed(format!(
            "Test the connection {} first to pin the host key of its git host.",
            conn.name
        )));
    }
    let listing = match check::ls_remote(st, conn.id, &resolved.upstream_url).await? {
        Ok(out) => {
            record_outcome(st, conn.id, &Outcome::Ok, None).await;
            parse_ls_remote(&out)
        }
        Err(outcome) => {
            record_outcome(st, conn.id, &outcome, None).await;
            let message = outcome_message(&conn.name, &outcome).unwrap_or_default();
            return Err(match outcome {
                Outcome::Rejected => ApiError::credential_rejected(conn.id, message),
                _ => ApiError::clone_failed(message),
            });
        }
    };
    if let Some(b) = &branch
        && !listing.branches.iter().any(|x| x == b)
    {
        return Err(ApiError::clone_failed(format!(
            "The branch {b} doesn't exist in the repository."
        )));
    }
    Ok(PreparedClone {
        connection: conn,
        url,
        upstream_url: resolved.upstream_url,
        branch,
        default_branch: listing.default_branch,
        host: parsed.host,
    })
}

// ---------------------------------------------------------------- steps

fn sql(e: sqlx::Error) -> StepError {
    StepError::Clone(ApiError::internal(e))
}

/// D11 steps 1–6 in place of the initial commit: grant and `origin` remote rows, routes and the
/// container's capability, the clone with progress, the initial commit on `main` for an empty
/// remote, the working branch, the git identity and the proxy remotes.
pub(super) async fn clone_steps(
    st: &AppState,
    ws_id: Uuid,
    owner: &UserRow,
    user: &ContainerUser,
    source: &PreparedClone,
    op_id: Option<Uuid>,
    undo: &mut Undo,
) -> Result<(), StepError> {
    let container = crate::docker::names::workspace_container(ws_id);
    let conn = &source.connection;

    // 1. Grant and remote rows (they go with the workspace row by cascade).
    undo.push(UndoStep::GitRoutes);
    conn_repo::insert_grant(&st.db, conn.id, ws_id)
        .await
        .map_err(sql)?;
    let remote = ws_repo::insert_remote(
        &st.db,
        &NewRemote {
            id: Uuid::new_v4(),
            workspace_id: ws_id,
            name: ORIGIN,
            connection_id: conn.id,
            connection_name: &conn.name,
            url: &source.url,
            upstream_url: &source.upstream_url,
            default_branch: source.default_branch.as_deref(),
            block_default_rewrite: true,
            only_ws_branches: false,
        },
    )
    .await
    .map_err(sql)?;

    // 2. A fresh capability for the container, then the routes (the clone needs them).
    gitproxy::containers::container_started_as(
        st,
        ws_id,
        &container,
        &user.user,
        WORKSPACE_REPO_DIR,
        None,
    )
    .await;
    gitproxy::sync_routes(st).await.map_err(StepError::Clone)?;

    // 3. The clone.
    update_op(st, op_id, |op| {
        op.container = Some(container.clone());
        op.line = format!("Fetching from {}…", source.host);
    });
    if is_cancelled(st, op_id) {
        return Err(StepError::Clone(ApiError::clone_cancelled()));
    }
    run_clone(st, &container, &user.user, &remote.id, source, op_id).await?;

    // 6 (first half). The git identity, needed by the commit of an empty remote.
    for (key, value) in [("user.name", &owner.email), ("user.email", &owner.email)] {
        super::run_checked(
            st,
            &container,
            &user.user,
            &git::git(WORKSPACE_REPO_DIR, &["config", key, value]),
        )
        .await?;
    }

    // 4–5. The working branch.
    let head = exec::exec_capture(
        &st.docker,
        &container,
        &user.user,
        &git::git(WORKSPACE_REPO_DIR, &["rev-parse", "--verify", "-q", "HEAD"]),
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    let branch = if head.success() {
        let out = super::run_checked(
            st,
            &container,
            &user.user,
            &git::git(WORKSPACE_REPO_DIR, &["symbolic-ref", "--short", "HEAD"]),
        )
        .await?;
        out.stdout_str().trim().to_string()
    } else {
        // An empty remote: today's initial commit, without `git init`, on `main`.
        super::run_checked(
            st,
            &container,
            &user.user,
            &git::git(
                WORKSPACE_REPO_DIR,
                &["symbolic-ref", "HEAD", "refs/heads/main"],
            ),
        )
        .await?;
        super::initial_commit(st, &container, user).await?;
        "main".to_string()
    };
    if !branch.is_empty() {
        ws_repo::update_branch(&st.db, ws_id, &branch)
            .await
            .map_err(sql)?;
    }

    // 6. The proxy remotes and the credential helper.
    gitproxy::containers::sync_repo_remotes_as(
        st,
        ws_id,
        &container,
        &user.user,
        WORKSPACE_REPO_DIR,
    )
    .await
    .map_err(StepError::Clone)?;
    Ok(())
}

/// Runs `git clone` through the proxy as the container user, streaming its progress into the op.
async fn run_clone(
    st: &AppState,
    container: &str,
    user: &str,
    remote_id: &Uuid,
    source: &PreparedClone,
    op_id: Option<Uuid>,
) -> Result<(), StepError> {
    let mut cmd = format!(
        "echo $$ > {CLONE_PID_FILE}; exec git -c {helper} clone --progress",
        helper = shell_quote(&format!(
            "credential.http://{}.helper={CREDENTIAL_HELPER}",
            gitproxy::PROXY_HOST
        )),
    );
    if let Some(b) = &source.branch {
        cmd.push_str(&format!(" -b {}", shell_quote(b)));
    }
    cmd.push_str(&format!(
        " -o {ORIGIN} {} {}",
        shell_quote(&gitproxy::remote_url(*remote_id)),
        shell_quote(WORKSPACE_REPO_DIR)
    ));

    let ops = Arc::clone(&st.git_proxy);
    let tail = Mutex::new(String::new());
    let on_stderr = move |chunk: &[u8]| {
        let Some(id) = op_id else {
            return;
        };
        let mut tail = tail.lock().unwrap_or_else(|p| p.into_inner());
        tail.push_str(&String::from_utf8_lossy(chunk));
        if tail.len() > PROGRESS_TAIL {
            let mut cut = tail.len() - PROGRESS_TAIL;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
        if let Some((line, percent)) = parse_progress(&tail)
            && is_progress_line(&line)
        {
            let mut map = ops.clone_ops.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(op) = map.get_mut(&id) {
                op.line = line;
                if percent.is_some() {
                    op.percent = percent;
                }
            }
        }
    };
    let docker = st.docker.clone().with_timeout(CLONE_TIMEOUT);
    let out =
        exec::exec_progress(&docker, container, user, &sh(cmd), CLONE_TIMEOUT, on_stderr).await?;
    if is_cancelled(st, op_id) {
        return Err(StepError::Clone(ApiError::clone_cancelled()));
    }
    let conn_id = source.connection.id;
    if out.success() {
        record_outcome(st, conn_id, &Outcome::Ok, None).await;
        return Ok(());
    }
    let stderr = out.stderr_str();
    let outcome = clone_outcome(&stderr);
    record_outcome(st, conn_id, &outcome, None).await;
    let message = error_tail(&stderr);
    Err(StepError::Clone(
        if stderr.contains("rejected by the host") {
            ApiError::credential_rejected(conn_id, message)
        } else {
            ApiError::clone_failed(if message.is_empty() {
                format!("git clone exited with code {}.", out.exit_code)
            } else {
                message
            })
        },
    ))
}
