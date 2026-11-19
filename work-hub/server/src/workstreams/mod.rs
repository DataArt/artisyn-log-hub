//! Workstream service (D10): open with an undo list, keep an open workstream's container and its
//! `chat` session running, close (`close.rs`), discard, reopen, retry, and the reconciler
//! (`reconciler.rs`).
//!
//! A workstream is a copy of the workspace's two volumes in its own container `wh-st-<uuid>`:
//! the copied `/workspace/repo` is detached and the workstream's branch is checked out in the
//! worktree `/workspace/worktree`, where the agent's `chat` tmux session runs.

pub mod close;
pub mod reconciler;
pub mod repo;

use std::collections::{BTreeMap, HashSet};

use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;
use time::OffsetDateTime;
use tokio::sync::OwnedMutexGuard;
use uuid::Uuid;

use crate::agent::AgentAdapter;
use crate::docker::containers::{self, RunSpec};
use crate::docker::exec::{self, ByteStream, EXEC_TIMEOUT_DEFAULT, sh};
use crate::docker::names::{self, Labels, Role, WORKSPACE_REPO_DIR, WORKSTREAM_WORKTREE_DIR};
use crate::docker::{DockerError, volumes};
use crate::error::ApiError;
use crate::files;
use crate::git;
use crate::names as display_names;
use crate::state::AppState;
use crate::terminal::recording::{self, RecordingSource};
use crate::terminal::tmux::{self, Session};
use crate::workspaces::{self, ContainerUser, WorkspaceRow, login};

pub use repo::WorkstreamRow;

// ---------------------------------------------------------------- API shape

/// `WorkstreamSummary` of the API (`available` comes from the in-memory unavailable set).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamSummary {
    pub id: Uuid,
    pub name: String,
    pub state: String,
    pub base_branch: String,
    #[serde(with = "time::serde::rfc3339")]
    pub opened_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub closed_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub merged_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub discarded_at: Option<OffsetDateTime>,
    pub available: bool,
    /// Bytes its file-area folder takes on disk; only in the list asked with `?disk=1` (History).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_bytes: Option<u64>,
}

/// The API shape of a row.
pub fn summary(st: &AppState, s: &WorkstreamRow) -> WorkstreamSummary {
    WorkstreamSummary {
        id: s.id,
        name: s.name.clone(),
        state: s.state.clone(),
        base_branch: s.base_branch.clone(),
        opened_at: s.opened_at,
        closed_at: s.closed_at,
        merged_at: s.merged_at,
        discarded_at: s.discarded_at,
        available: is_available(st, s.id),
        disk_bytes: None,
    }
}

// ---------------------------------------------------------------- helpers

/// `wh-st-<uuid>`.
pub fn container_name(s: &WorkstreamRow) -> String {
    names::workstream_container(s.id)
}

/// `false` while the workstream's container could not be started (until a start works again).
pub fn is_available(st: &AppState, id: Uuid) -> bool {
    let set = st.unavailable.lock().unwrap_or_else(|e| e.into_inner());
    !set.contains(&id)
}

pub(crate) fn set_available(st: &AppState, id: Uuid, available: bool) {
    let mut set = st.unavailable.lock().unwrap_or_else(|e| e.into_inner());
    if available {
        set.remove(&id);
    } else {
        set.insert(id);
    }
}

/// Serialises the state changes of one workstream (close, discard, reopen, retry, reconciler).
pub(crate) async fn transition_lock(st: &AppState, id: Uuid) -> OwnedMutexGuard<()> {
    st.locks.lock(&format!("workstream:{id}")).await
}

fn labels(
    st: &AppState,
    ws: Uuid,
    s: Uuid,
    role: Role,
) -> std::collections::HashMap<String, String> {
    Labels::new(&st.config.instance, role)
        .workspace(ws)
        .workstream(s)
        .into_map()
}

fn run_spec(
    st: &AppState,
    ws: Uuid,
    s: Uuid,
    image: &str,
    env: &BTreeMap<String, String>,
    home: &str,
) -> RunSpec {
    RunSpec {
        name: names::workstream_container(s),
        image: image.to_string(),
        labels: labels(st, ws, s, Role::Workstream),
        env: env.clone(),
        repo_volume: names::workstream_repo_volume(s),
        home_volume: names::workstream_home_volume(s),
        home_dir: Some(home.to_string()),
    }
}

/// The image a workstream container starts from (the checkpoint, else the base image, D6) and
/// its env (`containerEnv` of the definition for the base image; a checkpoint carries its own).
async fn image_and_env(
    st: &AppState,
    ws: &WorkspaceRow,
) -> Result<(String, BTreeMap<String, String>), DockerError> {
    let agent = workspaces::adapter(st, ws).map_err(|e| DockerError::Failed(e.message))?;
    if let Some(ckpt) = &ws.checkpoint_image {
        return Ok((
            ckpt.clone(),
            crate::agent::with_agent_env(agent.as_ref(), &BTreeMap::new()),
        ));
    }
    let base = ws
        .base_image
        .clone()
        .ok_or_else(|| DockerError::Failed(format!("workspace {} has no base image", ws.id)))?;
    let env = workspaces::definition_env(st, &workspaces::container_name(ws)).await;
    Ok((base, crate::agent::with_agent_env(agent.as_ref(), &env)))
}

/// Where the workstream's chat log lives.
pub(crate) fn recording_source(
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<RecordingSource, ApiError> {
    let user = workspaces::user_of(ws)?;
    Ok(RecordingSource::new(s.id, &user.user, &user.home))
}

/// Syncs the recording when the workstream's container runs (before a stop or remove).
pub(crate) async fn sync_if_running(st: &AppState, ws: &WorkspaceRow, s: &WorkstreamRow) {
    let Ok(src) = recording_source(ws, s) else {
        return;
    };
    match containers::inspect(&st.docker, &src.container).await {
        Ok(Some(info)) if info.running => recording::sync_logged(st, &src).await,
        Ok(_) => {}
        Err(e) => tracing::warn!("cannot inspect {} before syncing: {e}", src.container),
    }
}

/// Runs `argv` and fails on a non-zero exit.
pub(crate) async fn run_checked(
    st: &AppState,
    container: &str,
    user: &str,
    argv: &[String],
) -> Result<exec::ExecOutput, DockerError> {
    exec::exec_capture(
        &st.docker,
        container,
        user,
        argv,
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?
    .check()
}

/// Collects a byte stream (a bundle) into memory.
pub(crate) async fn collect(mut stream: ByteStream) -> Result<Vec<u8>, DockerError> {
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
    }
    Ok(buf)
}

/// Writes `data` to `path` inside `container` as `user` (`cat > path` fed through stdin).
pub(crate) async fn write_file_via_exec(
    st: &AppState,
    container: &str,
    user: &str,
    path: &str,
    data: Vec<u8>,
) -> Result<(), DockerError> {
    let mut cmd = sh("cat > \"$1\"");
    cmd.push("sh".into());
    cmd.push(path.to_string());
    exec::exec_capture(
        &st.docker,
        container,
        user,
        &cmd,
        Some(Bytes::from(data)),
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?
    .check()?;
    Ok(())
}

/// `rm -f path` inside `container`; failures are only logged.
pub(crate) async fn remove_file_via_exec(st: &AppState, container: &str, user: &str, path: &str) {
    let argv = exec::argv(&["rm", "-f", path]);
    if let Err(e) = run_checked(st, container, user, &argv).await {
        tracing::warn!("{container}: cannot remove {path}: {e}");
    }
}

/// Removes the workstream's container and its two volumes (by name and by label), then its
/// file-area folder.
pub(crate) async fn remove_objects(
    st: &AppState,
    s: Uuid,
    files_dir: Option<&str>,
) -> Result<(), DockerError> {
    let filter = names::workstream_filter(&st.config.instance, s);
    let mut container_names = vec![names::workstream_container(s)];
    container_names.extend(
        containers::list_by_labels(&st.docker, &filter)
            .await?
            .into_iter()
            .map(|c| c.name)
            .filter(|n| !n.is_empty()),
    );
    let mut seen = HashSet::new();
    for c in container_names
        .into_iter()
        .filter(|c| seen.insert(c.clone()))
    {
        containers::remove(&st.docker, &c).await?;
    }
    let mut volume_names = vec![
        names::workstream_repo_volume(s),
        names::workstream_home_volume(s),
    ];
    volume_names.extend(volumes::list_by_labels(&st.docker, &filter).await?);
    let mut seen = HashSet::new();
    for v in volume_names.into_iter().filter(|v| seen.insert(v.clone())) {
        volumes::remove(&st.docker, &v).await?;
    }
    if let Some(rel) = files_dir {
        files::remove(st, helper_labels(st), rel).await?;
    }
    Ok(())
}

/// Labels of a helper container that only touches the file area.
fn helper_labels(st: &AppState) -> std::collections::HashMap<String, String> {
    Labels::new(&st.config.instance, Role::Helper).into_map()
}

/// Creates the workstream's two volumes bound to its file-area folders (existing ones are kept).
async fn create_volumes(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
    dir: &str,
) -> Result<(), DockerError> {
    for (v, sub) in [
        (names::workstream_repo_volume(s.id), files::WORKSPACE_SUB),
        (names::workstream_home_volume(s.id), files::HOME_SUB),
    ] {
        volumes::create(
            &st.docker,
            &v,
            labels(st, ws.id, s.id, Role::Workstream),
            &files::engine_path(&st.config, &format!("{dir}/{sub}")),
        )
        .await?;
    }
    Ok(())
}

/// The workspace and the workstream for the API: 404 for a missing, foreign or opening one.
pub async fn load_owned(
    st: &AppState,
    user_id: i64,
    id: Uuid,
) -> Result<(WorkspaceRow, WorkstreamRow), ApiError> {
    let s = repo::get_owned(&st.db, user_id, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let ws = workspaces::repo::get_owned(&st.db, user_id, s.workspace_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok((ws, s))
}

/// The current row (after taking the transition lock); 404 when it went away.
async fn reload(st: &AppState, id: Uuid) -> Result<WorkstreamRow, ApiError> {
    repo::get_by_id(&st.db, id)
        .await?
        .ok_or_else(ApiError::not_found)
}

// ---------------------------------------------------------------- open

#[derive(Debug, Clone, PartialEq, Eq)]
enum UndoStep {
    Row(Uuid),
    /// A file-area folder (relative to the data dir).
    Folder(String),
    Volume(String),
    Container(String),
}

/// What a failed open removes, in reverse order.
#[derive(Default)]
struct Undo(Vec<UndoStep>);

impl Undo {
    fn push(&mut self, step: UndoStep) {
        if !self.0.contains(&step) {
            self.0.push(step);
        }
    }

    async fn run(self, st: &AppState) {
        for step in self.0.into_iter().rev() {
            let result = match &step {
                UndoStep::Row(id) => repo::delete(&st.db, *id).await.map_err(|e| e.to_string()),
                UndoStep::Folder(rel) => files::remove(st, helper_labels(st), rel)
                    .await
                    .map_err(|e| e.to_string()),
                UndoStep::Volume(v) => volumes::remove(&st.docker, v)
                    .await
                    .map_err(|e| e.to_string()),
                UndoStep::Container(c) => containers::remove(&st.docker, c)
                    .await
                    .map_err(|e| e.to_string()),
            };
            if let Err(e) = result {
                tracing::warn!("undo {step:?} failed: {e}");
            }
        }
    }
}

/// D10 open: validate the name, live login check, compute the branch, insert the row
/// (`opening`), copy the workspace's volumes (holding the workspace lock), run `wh-st-<uuid>`,
/// detach the copied repo and add the worktree on the new branch, apply the profile patch, start
/// `chat` with the adapter's `start_command`, insert the recording row and set `open`. On failure
/// every step is undone and the user gets `open_failed` (`docker_unavailable` when Docker is
/// unreachable).
pub async fn open(
    st: &AppState,
    ws: &WorkspaceRow,
    raw_name: &str,
) -> Result<WorkstreamRow, ApiError> {
    // 1. The name.
    let name = display_names::validate_display_name(raw_name).map_err(ApiError::invalid_name)?;
    let key = display_names::name_key(&name);
    if repo::name_taken(&st.db, ws.id, &key).await? {
        return Err(ApiError::duplicate_name(
            display_names::MSG_DUPLICATE_WORKSTREAM,
        ));
    }
    let agent = workspaces::adapter(st, ws)?;

    // 2. Live login check (it also ensures the workspace container).
    if !login::check_login(st, ws).await? {
        return Err(ApiError::login_required(agent.display_name()));
    }
    let ws_container = workspaces::ensure_workspace_container(st, ws).await?;
    let user = workspaces::user_of(ws)?;

    // 3. The branch: the repo's ws/* branches plus every branch the DB knows.
    let mut taken: HashSet<String> = repo::taken_branches(&st.db, ws.id)
        .await?
        .into_iter()
        .collect();
    let refs = run_checked(
        st,
        &ws_container,
        &user.user,
        &git::for_each_branch(WORKSPACE_REPO_DIR, display_names::BRANCH_PREFIX),
    )
    .await?;
    taken.extend(git::parse_branches(&refs.stdout));
    let branch = display_names::derive_branch(&name, &taken);
    // The base's commit now: "bring into main" bundles from it, not from the workstream's own
    // copy of the base branch (the agent may move that one).
    let base_commit = run_checked(
        st,
        &ws_container,
        &user.user,
        &git::git(
            WORKSPACE_REPO_DIR,
            &[
                "rev-parse",
                "--verify",
                &format!("{}^{{commit}}", ws.working_branch),
            ],
        ),
    )
    .await?
    .stdout_str()
    .trim()
    .to_string();

    // 4. The row.
    let id = Uuid::new_v4();
    let ws_dir = ws.files_dir.as_deref().ok_or_else(|| {
        ApiError::internal(format!("workspace {} has no file-area folder", ws.id))
    })?;
    let files_dir = files::workstream_dir(ws_dir, &name, id);
    let new = repo::NewWorkstream {
        files_dir: &files_dir,
        base_commit: &base_commit,
        id,
        workspace_id: ws.id,
        name: &name,
        name_key: &key,
        branch: &branch,
        base_branch: &ws.working_branch,
        agent_session_id: Uuid::new_v4(),
    };
    let row = match repo::insert_opening(&st.db, &new).await {
        Ok(row) => row,
        Err(e) if workspaces::repo::is_unique_violation(&e) => {
            return Err(if repo::name_taken(&st.db, ws.id, &key).await? {
                ApiError::duplicate_name(display_names::MSG_DUPLICATE_WORKSTREAM)
            } else {
                tracing::warn!("workstream open: branch {branch} was taken concurrently: {e}");
                ApiError::open_failed()
            });
        }
        Err(e) => return Err(e.into()),
    };
    let mut undo = Undo::default();
    undo.push(UndoStep::Row(id));

    if let Err(e) = open_steps(
        st,
        ws,
        &row,
        &ws_container,
        &user,
        agent.as_ref(),
        &mut undo,
    )
    .await
    {
        undo.run(st).await;
        return Err(match e {
            DockerError::Unavailable(cause) => {
                tracing::warn!("workstream open: docker unavailable: {cause}");
                ApiError::docker_unavailable()
            }
            other => {
                tracing::error!("workstream open failed: {other}");
                ApiError::open_failed()
            }
        });
    }
    // 10 (end). Open.
    match repo::set_open(&st.db, id).await {
        Ok(Some(row)) => {
            files::write_workstream_meta(&st.config, &row);
            set_available(st, id, true);
            tracing::info!("workstream {id} ({branch}) opened in workspace {}", ws.id);
            Ok(row)
        }
        Ok(None) => Err(ApiError::open_failed()),
        Err(e) => {
            Undo(vec![
                UndoStep::Row(id),
                UndoStep::Folder(files_dir.clone()),
                UndoStep::Volume(names::workstream_repo_volume(id)),
                UndoStep::Volume(names::workstream_home_volume(id)),
                UndoStep::Container(names::workstream_container(id)),
            ])
            .run(st)
            .await;
            Err(ApiError::internal(e))
        }
    }
}

async fn open_steps(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
    ws_container: &str,
    user: &ContainerUser,
    agent: &dyn AgentAdapter,
    undo: &mut Undo,
) -> Result<(), DockerError> {
    let container = names::workstream_container(s.id);
    let repo_volume = names::workstream_repo_volume(s.id);
    let home_volume = names::workstream_home_volume(s.id);

    // 5. Copy the volumes while workspace writes wait (FR-5b). The new ones are folders of the
    // file area (FR-5g) bound into named volumes.
    let dir = s
        .files_dir
        .as_deref()
        .ok_or_else(|| DockerError::Failed(format!("workstream {} has no folder", s.id)))?;
    undo.push(UndoStep::Folder(dir.to_string()));
    files::prepare(&st.config, dir)?;
    undo.push(UndoStep::Volume(repo_volume.clone()));
    undo.push(UndoStep::Volume(home_volume.clone()));
    create_volumes(st, ws, s, dir).await?;
    {
        let _lock = st.locks.lock(ws_container).await;
        for (from, to) in [
            (names::workspace_repo_volume(ws.id), &repo_volume),
            (names::workspace_home_volume(ws.id), &home_volume),
        ] {
            volumes::copy_volume(
                &st.docker,
                &st.config.default_image,
                labels(st, ws.id, s.id, Role::Helper),
                &from,
                to,
            )
            .await?;
        }
    }

    // 6. The container.
    let (image, env) = image_and_env(st, ws).await?;
    undo.push(UndoStep::Container(container.clone()));
    containers::create_and_start(
        &st.docker,
        &run_spec(st, ws.id, s.id, &image, &env, &user.home),
    )
    .await?;

    // 7. Free the base branch in the copy and add the worktree on the new branch.
    run_checked(
        st,
        &container,
        &user.user,
        &git::switch_detach(WORKSPACE_REPO_DIR),
    )
    .await?;
    run_checked(
        st,
        &container,
        &user.user,
        &git::worktree_add_new_branch(
            WORKSPACE_REPO_DIR,
            &s.branch,
            WORKSTREAM_WORKTREE_DIR,
            &s.base_branch,
        ),
    )
    .await?;

    // 8. The agent starts without first-run dialogs in the worktree (D7).
    workspaces::apply_profile_patch(st, &container, ws, &[WORKSTREAM_WORKTREE_DIR])
        .await
        .map_err(|e| DockerError::Failed(format!("profile patch: {e}")))?;

    // 9. The chat (with the user's agent token, when the agent uses one).
    let token = login::agent_env(st, ws, &container)
        .await
        .map_err(|e| DockerError::Failed(e.message))?;
    tmux::ensure_session(
        &st.docker,
        &container,
        &user.user,
        Session::Chat,
        WORKSTREAM_WORKTREE_DIR,
        &agent.start_command(&s.agent_session_id.to_string()),
        tmux::SessionOpts {
            record_to: Some(&recording::chat_log_path(&user.home)),
            secret: token.as_ref().map(|(n, v)| (*n, v.as_str())),
        },
    )
    .await?;

    // 10. The recording row.
    repo::insert_recording(&st.db, s.id, &recording::file_name_for(s.id))
        .await
        .map_err(|e| DockerError::Failed(format!("database: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------- ensure running

/// [`ensure_workstream_running`] for a request on an open workstream (its files, its chat): under
/// the workstream's transition lock the row is reloaded and must still be open. A request that
/// read the row just before a close or discard would otherwise start the container that the
/// close has just stopped. Answers `not_open` when it is no longer open.
pub async fn ensure_open_running(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<String, ApiError> {
    let _t = transition_lock(st, s.id).await;
    let current = reload(st, s.id).await?;
    if !current.is_open() {
        return Err(ApiError::not_open());
    }
    ensure_workstream_running(st, ws, &current).await
}

/// Makes an open (or reopening) workstream usable: starts its container (recreating it from its
/// volumes when it was removed outside Work Hub), makes sure `chat` exists (created with the
/// adapter's `resume_command`) and respawns a dead `chat` pane. On failure the workstream is
/// marked unavailable (`available:false`) and the call answers `unavailable` (or
/// `docker_unavailable`); a later success clears the mark. Returns the container name.
pub async fn ensure_workstream_running(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<String, ApiError> {
    match ensure_inner(st, ws, s).await {
        Ok(name) => {
            set_available(st, s.id, true);
            Ok(name)
        }
        Err(e) => {
            set_available(st, s.id, false);
            tracing::warn!("workstream {}: container not available: {e}", s.id);
            Err(if e.is_unavailable() {
                ApiError::docker_unavailable()
            } else {
                ApiError::unavailable()
            })
        }
    }
}

async fn ensure_inner(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<String, DockerError> {
    let name = container_name(s);
    let user = workspaces::user_of(ws).map_err(|e| DockerError::Failed(e.message))?;
    let agent = workspaces::adapter(st, ws).map_err(|e| DockerError::Failed(e.message))?;
    // Not the git-write lock: callers may hold that one while they call this.
    let _guard = st.locks.lock(&format!("ensure:{name}")).await;

    match containers::inspect(&st.docker, &name).await? {
        Some(info) if info.running => {}
        Some(_) => containers::start(&st.docker, &name).await?,
        None => {
            // Removed outside Work Hub: the volumes hold everything, recreate the container.
            let filter = names::workstream_filter(&st.config.instance, s.id);
            let existing: HashSet<String> = volumes::list_by_labels(&st.docker, &filter)
                .await?
                .into_iter()
                .collect();
            let repo_volume = names::workstream_repo_volume(s.id);
            // The folders hold the data: volumes removed outside Work Hub are made again.
            if let Some(dir) = s.files_dir.as_deref()
                && files::exists(&st.config, dir)
            {
                create_volumes(st, ws, s, dir).await?;
            } else if !existing.contains(&repo_volume) {
                return Err(DockerError::Failed(format!(
                    "the container and the volume {repo_volume} of workstream {} are gone",
                    s.id
                )));
            }
            tracing::info!(
                "workstream {}: container {name} is missing, recreating it",
                s.id
            );
            let (image, env) = image_and_env(st, ws).await?;
            containers::create_and_start(
                &st.docker,
                &run_spec(st, ws.id, s.id, &image, &env, &user.home),
            )
            .await?;
        }
    }

    let resume = agent.resume_command(&s.agent_session_id.to_string());
    let log = recording::chat_log_path(&user.home);
    let pane = tmux::pane_dead(&st.docker, &name, &user.user, Session::Chat).await?;
    let token = if pane == Some(false) {
        None
    } else {
        login::agent_env(st, ws, &name)
            .await
            .map_err(|e| DockerError::Failed(e.message))?
    };
    let secret = token.as_ref().map(|(n, v)| (*n, v.as_str()));
    match pane {
        Some(false) => {}
        Some(true) => {
            tracing::info!("workstream {}: chat pane is dead, resuming it", s.id);
            tmux::respawn(
                &st.docker,
                &name,
                &user.user,
                Session::Chat,
                &resume,
                tmux::SessionOpts {
                    record_to: Some(&log),
                    secret,
                },
            )
            .await?;
        }
        None => {
            tmux::ensure_session(
                &st.docker,
                &name,
                &user.user,
                Session::Chat,
                WORKSTREAM_WORKTREE_DIR,
                &resume,
                tmux::SessionOpts {
                    record_to: Some(&log),
                    secret,
                },
            )
            .await?;
        }
    }
    Ok(name)
}

// ---------------------------------------------------------------- discard, reopen, retry

/// D10 discard (open or closed): sync when running, remove the container and volumes, delete
/// the branch from the workspace repo when it exists there, `state='discarded'`. A done or
/// already discarded workstream answers `cannot_discard`.
pub async fn discard(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<WorkstreamRow, ApiError> {
    let _t = transition_lock(st, s.id).await;
    let s = reload(st, s.id).await?;
    if !s.is_open() && !s.is_closed() {
        return Err(ApiError::cannot_discard());
    }
    sync_if_running(st, ws, &s).await;
    remove_objects(st, s.id, s.files_dir.as_deref()).await?;

    let ws_container = workspaces::ensure_workspace_container(st, ws).await?;
    let user = workspaces::exec_user(ws)?;
    {
        let _lock = st.locks.lock(&ws_container).await;
        let exists = exec::exec_capture(
            &st.docker,
            &ws_container,
            user,
            &git::branch_exists(WORKSPACE_REPO_DIR, &s.branch),
            None,
            EXEC_TIMEOUT_DEFAULT,
        )
        .await?;
        if exists.success() {
            let out = exec::exec_capture(
                &st.docker,
                &ws_container,
                user,
                &git::delete_branch(WORKSPACE_REPO_DIR, &s.branch),
                None,
                EXEC_TIMEOUT_DEFAULT,
            )
            .await?;
            if !out.success() {
                tracing::warn!(
                    "workstream {}: cannot delete branch {}: {}",
                    s.id,
                    s.branch,
                    out.stderr_str().trim()
                );
            }
        }
    }
    let row = repo::set_discarded(&st.db, s.id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    files::write_workstream_meta(&st.config, &row);
    set_available(st, s.id, true);
    tracing::info!("workstream {} discarded", s.id);
    Ok(row)
}

/// D10 reopen: only from `closed` (else `not_closed`); start the container, ensure `chat` with
/// the resume command, `state='open'`.
pub async fn reopen(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<WorkstreamRow, ApiError> {
    let _t = transition_lock(st, s.id).await;
    let s = reload(st, s.id).await?;
    if !s.is_closed() {
        return Err(ApiError::not_closed());
    }
    ensure_workstream_running(st, ws, &s).await?;
    let row = repo::set_open(&st.db, s.id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    files::write_workstream_meta(&st.config, &row);
    tracing::info!("workstream {} reopened", s.id);
    Ok(row)
}

/// `POST …/retry`: tries to start an open workstream's container again; `unavailable` (503)
/// when it still cannot, `not_open` for a workstream that is not open.
pub async fn retry(
    st: &AppState,
    ws: &WorkspaceRow,
    s: &WorkstreamRow,
) -> Result<WorkstreamRow, ApiError> {
    let _t = transition_lock(st, s.id).await;
    let s = reload(st, s.id).await?;
    if !s.is_open() {
        return Err(ApiError::not_open());
    }
    ensure_workstream_running(st, ws, &s).await?;
    Ok(s)
}
