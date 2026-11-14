//! Workspace service (D9): create with an undo list, ensure the container, working branch,
//! branches, delete, and the account-deletion hook (D3).

pub mod configure;
pub mod login;
pub mod repo;

use std::collections::{BTreeMap, HashSet};

use bytes::Bytes;
use futures_util::StreamExt;
use uuid::Uuid;

use crate::agent::{AgentAdapter, merge_json};
use crate::auth::AccountCleanup;
use crate::auth::users::{self, UserRow};
use crate::devcontainer::{self, ContainerSpec, ImageSource};
use crate::docker::archive::{self, FileOwner, PutEntry, PutSource};
use crate::docker::containers::{self, HelperSpec, RunSpec};
use crate::docker::exec::{
    self, EXEC_TIMEOUT_DEFAULT, HELPER_RUN_TIMEOUT, IMAGE_BUILD_TIMEOUT, argv, sh,
};
use crate::docker::names::{self, Labels, Role, WORKSPACE_REPO_DIR};
use crate::docker::{DockerError, images, volumes};
use crate::error::ApiError;
use crate::files;
use crate::git;
use crate::names as display_names;
use crate::state::{AppState, ImageStatus};

pub use repo::{ContainerUser, WorkspaceRow, WorkspaceWithCount};

/// The agent of every new workspace in the alpha (the id lives with the adapters).
pub use crate::agent::DEFAULT_AGENT;

/// The definition file inside the repo.
pub const DEVCONTAINER_FILE: &str = ".devcontainer/devcontainer.json";

/// The initial commit's `.gitignore` (D8).
pub const DEFAULT_GITIGNORE: &str = "node_modules/\ndist/\nbuild/\nout/\ntarget/\n.venv/\n__pycache__/\n*.pyc\n.cache/\n.DS_Store\n*.log\n";

/// The initial commit's devcontainer definition (D6).
pub const DEFAULT_DEVCONTAINER: &str =
    "{\n  \"name\": \"Work Hub default\",\n  \"image\": \"artisyn-work-hub-default\"\n}\n";

/// Commit message of the initial commit.
const INITIAL_COMMIT_MESSAGE: &str = "Start workspace";

// ---------------------------------------------------------------- errors of the internal steps

/// A failed step of create / recreate.
#[derive(Debug)]
enum StepError {
    Docker(DockerError),
    /// The devcontainer definition cannot be applied; a sentence for the user.
    Definition(String),
}

impl From<DockerError> for StepError {
    fn from(e: DockerError) -> Self {
        StepError::Docker(e)
    }
}

impl From<sqlx::Error> for StepError {
    fn from(e: sqlx::Error) -> Self {
        StepError::Docker(DockerError::Failed(format!("database: {e}")))
    }
}

impl std::fmt::Display for StepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StepError::Docker(e) => write!(f, "{e}"),
            StepError::Definition(m) => write!(f, "{m}"),
        }
    }
}

/// D9 ensure: every Docker failure is `docker_unavailable` (the cause goes to the log).
fn ensure_error(ws: Uuid, e: StepError) -> ApiError {
    match e {
        StepError::Definition(reason) => {
            tracing::warn!("workspace {ws}: cannot apply the devcontainer definition: {reason}");
            ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                format!("The workspace container couldn't be created: {reason}"),
            )
        }
        StepError::Docker(e) => {
            tracing::warn!("workspace {ws}: container not available: {e}");
            ApiError::docker_unavailable()
        }
    }
}

fn create_error(e: StepError) -> ApiError {
    match e {
        StepError::Docker(DockerError::Unavailable(cause)) => {
            tracing::warn!("workspace create: docker unavailable: {cause}");
            ApiError::docker_unavailable()
        }
        StepError::Definition(reason) => {
            tracing::warn!("workspace create failed: {reason}");
            let mut err = ApiError::create_failed();
            err.message = format!("The workspace couldn't be created: {reason} Nothing was kept.");
            err
        }
        StepError::Docker(e) => {
            tracing::error!("workspace create failed: {e}");
            ApiError::create_failed()
        }
    }
}

// ---------------------------------------------------------------- helpers

/// `wh-ws-<uuid>`.
pub fn container_name(ws: &WorkspaceRow) -> String {
    names::workspace_container(ws.id)
}

/// The user every exec in the workspace runs as (D5).
pub fn exec_user(ws: &WorkspaceRow) -> Result<&str, ApiError> {
    ws.container_user
        .as_deref()
        .ok_or_else(|| ApiError::internal(format!("workspace {} has no container user", ws.id)))
}

/// The workspace's agent adapter.
pub fn adapter(
    st: &AppState,
    ws: &WorkspaceRow,
) -> Result<std::sync::Arc<dyn AgentAdapter>, ApiError> {
    st.agents
        .get(&ws.agent)
        .ok_or_else(|| ApiError::internal(format!("unknown agent {:?}", ws.agent)))
}

fn workspace_labels(
    st: &AppState,
    ws: Uuid,
    role: Role,
) -> std::collections::HashMap<String, String> {
    Labels::new(&st.config.instance, role)
        .workspace(ws)
        .into_map()
}

/// Labels of a helper container that only touches the file area.
fn helper_labels(st: &AppState) -> std::collections::HashMap<String, String> {
    Labels::new(&st.config.instance, Role::Helper).into_map()
}

/// Makes sure both volumes of an existing workspace exist, bound to its file-area folders
/// (they may have been removed outside Work Hub; the folders keep the data).
async fn ensure_volumes(st: &AppState, ws: &WorkspaceRow) -> Result<(), DockerError> {
    let Some(dir) = ws.files_dir.as_deref() else {
        return Ok(());
    };
    files::prepare(&st.config, dir)?;
    for (v, sub) in [
        (names::workspace_repo_volume(ws.id), files::WORKSPACE_SUB),
        (names::workspace_home_volume(ws.id), files::HOME_SUB),
    ] {
        volumes::create(
            &st.docker,
            &v,
            workspace_labels(st, ws.id, Role::Workspace),
            &files::engine_path(&st.config, &format!("{dir}/{sub}")),
        )
        .await?;
    }
    Ok(())
}

fn container_user_of(ws: &WorkspaceRow) -> Option<ContainerUser> {
    Some(ContainerUser {
        user: ws.container_user.clone()?,
        uid: ws.container_uid?,
        gid: ws.container_gid?,
        home: ws.home_dir.clone()?,
    })
}

/// Runs `argv` and fails on a non-zero exit.
async fn run_checked(
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

/// Parses the output of the discovery command: name, uid, gid and home, one per line.
fn parse_user_discovery(out: &str) -> Option<ContainerUser> {
    let mut lines = out.lines().map(str::trim);
    let name = lines.next()?.to_string();
    let uid: i32 = lines.next()?.parse().ok()?;
    let gid: i32 = lines.next()?.parse().ok()?;
    let home = lines.next().unwrap_or("").to_string();
    let user = if name.is_empty() {
        uid.to_string()
    } else {
        name
    };
    let home = if home.starts_with('/') {
        home
    } else if uid == 0 {
        "/root".to_string()
    } else {
        format!("/home/{user}")
    };
    Some(ContainerUser {
        user,
        uid,
        gid,
        home,
    })
}

/// D6 user discovery: `docker run --rm <image> sh -c 'id -un; id -u; id -g; echo $HOME'`.
async fn discover_user(st: &AppState, ws: Uuid, image: &str) -> Result<ContainerUser, StepError> {
    let spec = HelperSpec {
        image: image.to_string(),
        user: None,
        cmd: sh(
            "printf '%s\\n%s\\n%s\\n%s\\n' \"$(id -un 2>/dev/null)\" \"$(id -u)\" \"$(id -g)\" \"$HOME\"",
        ),
        volumes: vec![],
        binds: vec![],
        labels: workspace_labels(st, ws, Role::Helper),
    };
    let out = containers::run_helper(&st.docker, &spec, HELPER_RUN_TIMEOUT)
        .await?
        .check()?;
    parse_user_discovery(&out.stdout_str()).ok_or_else(|| {
        StepError::Definition(format!(
            "Work Hub couldn't find out the user of the image {image}."
        ))
    })
}

/// Creates `/workspace/repo` and the home directory (as root) and gives them to the user.
/// `recursive` also re-owns everything already in `/workspace` (an image with another uid).
async fn prepare_dirs(
    st: &AppState,
    container: &str,
    user: &ContainerUser,
    recursive: bool,
) -> Result<(), DockerError> {
    let owner = format!("{}:{}", user.uid, user.gid);
    let script = if recursive {
        "mkdir -p /workspace/repo \"$1\" && chown -R \"$2\" /workspace && chown \"$2\" \"$1\" \
         && chmod 700 \"$1\""
    } else {
        "mkdir -p /workspace/repo \"$1\" && chown \"$2\" /workspace /workspace/repo \"$1\" \
         && chmod 700 \"$1\""
    };
    let mut cmd = sh(script);
    cmd.push("sh".into());
    cmd.push(user.home.clone());
    cmd.push(owner);
    run_checked(st, container, "0", &cmd).await?;
    Ok(())
}

/// The run spec of the workspace container (the definition's env over the agent's).
fn workspace_run_spec(
    st: &AppState,
    agent: &dyn AgentAdapter,
    ws: Uuid,
    image: &str,
    env: &BTreeMap<String, String>,
    home: &str,
) -> RunSpec {
    RunSpec {
        name: names::workspace_container(ws),
        image: image.to_string(),
        labels: workspace_labels(st, ws, Role::Workspace),
        env: crate::agent::with_agent_env(agent, env),
        repo_volume: names::workspace_repo_volume(ws),
        home_volume: names::workspace_home_volume(ws),
        home_dir: Some(home.to_string()),
    }
}

/// Reads and parses `.devcontainer/devcontainer.json` from the container's repo. A missing file
/// means the default definition.
async fn read_definition(st: &AppState, container: &str) -> Result<ContainerSpec, StepError> {
    let path = format!("{WORKSPACE_REPO_DIR}/{DEVCONTAINER_FILE}");
    let out = exec::exec_capture(
        &st.docker,
        container,
        "0",
        &argv(&["cat", &path]),
        None,
        EXEC_TIMEOUT_DEFAULT,
    )
    .await?;
    if !out.success() {
        return Ok(ContainerSpec {
            source: ImageSource::Default,
            container_env: BTreeMap::new(),
            post_create: None,
        });
    }
    devcontainer::parse(&out.stdout_str())
        .map_err(|e| StepError::Definition(format!("{DEVCONTAINER_FILE} is not valid: {e}")))
}

/// `containerEnv` of the definition in the workspace container's repo, for a container that is
/// started from the base image (a checkpoint image already carries its env). An unreadable or
/// invalid definition gives no env (the cause goes to the log).
pub(crate) async fn definition_env(st: &AppState, container: &str) -> BTreeMap<String, String> {
    match read_definition(st, container).await {
        Ok(spec) => spec.container_env,
        Err(e) => {
            tracing::warn!("{container}: cannot read the devcontainer definition: {e}");
            BTreeMap::new()
        }
    }
}

/// Lexically resolves the `/`-separated `rel` against the absolute `base`; `None` when it leaves
/// `/workspace/repo`.
fn resolve_in_repo(base: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        base.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    let path = format!("/{}", parts.join("/"));
    if path == WORKSPACE_REPO_DIR || path.starts_with(&format!("{WORKSPACE_REPO_DIR}/")) {
        Some(path)
    } else {
        None
    }
}

/// The image a definition runs on: the default image, a named local image (no pull, NFR-2) or
/// `wh-img-<uuid>:1` built from a tar of the build context read from `container`.
async fn resolve_image(
    st: &AppState,
    ws: Uuid,
    spec: &ContainerSpec,
    container: &str,
) -> Result<String, StepError> {
    match &spec.source {
        ImageSource::Default => Ok(st.config.default_image.clone()),
        ImageSource::Image(name) => {
            if images::exists(&st.docker, name).await? {
                Ok(name.clone())
            } else {
                Err(StepError::Definition(format!(
                    "the image {name} named in {DEVCONTAINER_FILE} doesn't exist on this computer (Work Hub never downloads images)."
                )))
            }
        }
        ImageSource::Build {
            dockerfile,
            context,
        } => {
            let base = format!("{WORKSPACE_REPO_DIR}/.devcontainer");
            let outside = || {
                StepError::Definition(format!(
                    "the build paths in {DEVCONTAINER_FILE} must stay inside the repository."
                ))
            };
            let ctx = resolve_in_repo(&base, context).ok_or_else(outside)?;
            let file = resolve_in_repo(&base, dockerfile).ok_or_else(outside)?;
            let rel = file
                .strip_prefix(&format!("{ctx}/"))
                .ok_or_else(|| {
                    StepError::Definition(format!(
                        "the Dockerfile in {DEVCONTAINER_FILE} must be inside its build context."
                    ))
                })?
                .to_string();
            let tar = exec::exec_stream_stdout(
                &st.docker,
                container,
                "0",
                &argv(&["tar", "cf", "-", "-C", &ctx, "."]),
            )
            .await?
            .map(|r| r.map_err(|e| std::io::Error::other(e.to_string())));
            let tag = names::built_image(ws);
            images::build_from_tar(
                &st.docker,
                tar,
                &rel,
                &tag,
                workspace_labels(st, ws, Role::Built),
            )
            .await
            .map_err(|e| match e {
                DockerError::Unavailable(m) => StepError::Docker(DockerError::Unavailable(m)),
                other => StepError::Definition(format!(
                    "the image of {DEVCONTAINER_FILE} couldn't be built: {other}"
                )),
            })?;
            Ok(tag)
        }
    }
}

/// Runs `postCreateCommand` in `/workspace/repo` as the container user.
async fn run_post_create(
    st: &AppState,
    container: &str,
    user: &str,
    cmd: &[String],
) -> Result<(), StepError> {
    let mut full = sh("cd /workspace/repo && exec \"$@\"");
    full.push("sh".into());
    full.extend(cmd.iter().cloned());
    let docker = st.docker.clone().with_timeout(IMAGE_BUILD_TIMEOUT);
    let out =
        exec::exec_capture(&docker, container, user, &full, None, IMAGE_BUILD_TIMEOUT).await?;
    if !out.success() {
        let stderr = out.stderr_str();
        let tail: String = stderr
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(StepError::Definition(format!(
            "postCreateCommand exited with code {}: {tail}",
            out.exit_code
        )));
    }
    Ok(())
}

/// `docker commit` of the workspace container as `wh-ckpt-<uuid>:<seq>`.
pub(crate) async fn take_checkpoint(
    st: &AppState,
    ws: Uuid,
    container: &str,
    seq: i32,
) -> Result<String, DockerError> {
    let image = names::checkpoint_image(ws, seq);
    images::commit(
        &st.docker,
        container,
        &names::checkpoint_repo(ws),
        &seq.to_string(),
        workspace_labels(st, ws, Role::Checkpoint),
    )
    .await?;
    Ok(image)
}

/// Waits until the default image is usable for a new workspace.
async fn require_default_image(st: &AppState) -> Result<(), ApiError> {
    let status = st.image_status.read().await.clone();
    match status {
        ImageStatus::Ok => Ok(()),
        ImageStatus::Building => {
            if images::exists(&st.docker, &st.config.default_image).await? {
                Ok(())
            } else {
                Err(ApiError::image_not_ready())
            }
        }
        ImageStatus::Failed(e) => {
            tracing::error!("cannot create a workspace: the default image failed to build: {e}");
            Err(ApiError::create_failed())
        }
    }
}

// ---------------------------------------------------------------- undo list

#[derive(Debug, Clone, PartialEq, Eq)]
enum UndoStep {
    Row(Uuid),
    /// A file-area folder (relative to the data dir).
    Folder(String),
    Volume(String),
    Container(String),
    Image(String),
}

/// What a failed create removes, in reverse order.
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
                UndoStep::Image(i) => images::remove(&st.docker, i)
                    .await
                    .map_err(|e| e.to_string()),
            };
            if let Err(e) = result {
                tracing::warn!("undo {step:?} failed: {e}");
            }
        }
    }
}

// ---------------------------------------------------------------- create

/// D9 create: validate the name, insert the row (`creating`), create the volumes, run the
/// container from the default image, make the initial commit, apply the devcontainer (D6:
/// other image, `containerEnv`, `postCreateCommand` and its checkpoint), apply the agent profile
/// patch and set `ready`. On failure every step is undone and the user gets `create_failed`
/// (`docker_unavailable` when Docker is unreachable).
pub async fn create(
    st: &AppState,
    user: &UserRow,
    raw_name: &str,
) -> Result<WorkspaceRow, ApiError> {
    let name = display_names::validate_display_name(raw_name).map_err(ApiError::invalid_name)?;
    let key = display_names::name_key(&name);
    if repo::name_taken(&st.db, user.id, &key).await? {
        return Err(ApiError::duplicate_name(
            display_names::MSG_DUPLICATE_WORKSPACE,
        ));
    }
    let agent = st
        .agents
        .get(DEFAULT_AGENT)
        .ok_or_else(|| ApiError::internal("the default agent is not registered"))?;
    require_default_image(st).await?;

    let id = Uuid::new_v4();
    let files_dir = files::workspace_dir(&user.email, &name, id);
    match repo::insert_creating(&st.db, id, user.id, &name, &key, agent.id(), &files_dir).await {
        Ok(_) => {}
        Err(e) if repo::is_unique_violation(&e) => {
            return Err(ApiError::duplicate_name(
                display_names::MSG_DUPLICATE_WORKSPACE,
            ));
        }
        Err(e) => return Err(e.into()),
    }
    let mut undo = Undo::default();
    undo.push(UndoStep::Row(id));

    match create_steps(st, id, user, agent.as_ref(), &files_dir, &mut undo).await {
        Ok(()) => {}
        Err(e) => {
            undo.run(st).await;
            return Err(create_error(e));
        }
    }
    match repo::get_by_id(&st.db, id).await {
        Ok(Some(row)) => {
            files::write_workspace_meta(&st.config, &row, &user.email);
            Ok(row)
        }
        Ok(None) => Err(ApiError::create_failed()),
        Err(e) => {
            Undo(vec![
                UndoStep::Row(id),
                UndoStep::Folder(files_dir.clone()),
                UndoStep::Volume(names::workspace_repo_volume(id)),
                UndoStep::Volume(names::workspace_home_volume(id)),
                UndoStep::Container(names::workspace_container(id)),
            ])
            .run(st)
            .await;
            Err(ApiError::internal(e))
        }
    }
}

async fn create_steps(
    st: &AppState,
    id: Uuid,
    owner: &UserRow,
    agent: &dyn AgentAdapter,
    files_dir: &str,
    undo: &mut Undo,
) -> Result<(), StepError> {
    let default_image = st.config.default_image.clone();
    let container = names::workspace_container(id);
    let repo_volume = names::workspace_repo_volume(id);
    let home_volume = names::workspace_home_volume(id);

    // 3. Volumes: folders of the file area (FR-5g) bound into named volumes.
    undo.push(UndoStep::Folder(files_dir.to_string()));
    files::prepare(&st.config, files_dir)?;
    for (v, sub) in [
        (&repo_volume, files::WORKSPACE_SUB),
        (&home_volume, files::HOME_SUB),
    ] {
        undo.push(UndoStep::Volume(v.clone()));
        volumes::create(
            &st.docker,
            v,
            workspace_labels(st, id, Role::Workspace),
            &files::engine_path(&st.config, &format!("{files_dir}/{sub}")),
        )
        .await?;
    }

    // 4. The container from the default image (its user first, for the home mount).
    let mut user = discover_user(st, id, &default_image).await?;
    undo.push(UndoStep::Container(container.clone()));
    containers::create_and_start(
        &st.docker,
        &workspace_run_spec(st, agent, id, &default_image, &BTreeMap::new(), &user.home),
    )
    .await?;
    prepare_dirs(st, &container, &user, false).await?;

    // 5. The initial commit.
    run_checked(
        st,
        &container,
        &user.user,
        &argv(&["git", "init", "-b", "main", WORKSPACE_REPO_DIR]),
    )
    .await?;
    for (key, value) in [("user.name", &owner.email), ("user.email", &owner.email)] {
        run_checked(
            st,
            &container,
            &user.user,
            &git::git(WORKSPACE_REPO_DIR, &["config", key, value]),
        )
        .await?;
    }
    archive::put_files(
        &st.docker,
        &st.config.tmp_dir(),
        &container,
        WORKSPACE_REPO_DIR,
        vec![
            PutEntry {
                path: ".gitignore".into(),
                source: PutSource::Bytes(Bytes::from_static(DEFAULT_GITIGNORE.as_bytes())),
            },
            PutEntry {
                path: DEVCONTAINER_FILE.into(),
                source: PutSource::Bytes(Bytes::from_static(DEFAULT_DEVCONTAINER.as_bytes())),
            },
        ],
        FileOwner {
            uid: user.uid as u32,
            gid: user.gid as u32,
            mode: 0o644,
        },
    )
    .await?;
    run_checked(
        st,
        &container,
        &user.user,
        &git::git(WORKSPACE_REPO_DIR, &["add", "-A"]),
    )
    .await?;
    run_checked(
        st,
        &container,
        &user.user,
        &git::git(
            WORKSPACE_REPO_DIR,
            &["commit", "-q", "-m", INITIAL_COMMIT_MESSAGE],
        ),
    )
    .await?;

    // 6. Apply the devcontainer.
    let spec = read_definition(st, &container).await?;
    let image = resolve_image(st, id, &spec, &container).await?;
    if image != default_image {
        undo.push(UndoStep::Image(image.clone()));
    }
    if image != default_image || !spec.container_env.is_empty() {
        containers::remove(&st.docker, &container).await?;
        if image != default_image {
            let new_user = discover_user(st, id, &image).await?;
            // A fresh home volume, so it is filled from the new image's home.
            volumes::remove(&st.docker, &home_volume).await?;
            files::reset_sub(st, helper_labels(st), files_dir, files::HOME_SUB).await?;
            volumes::create(
                &st.docker,
                &home_volume,
                workspace_labels(st, id, Role::Workspace),
                &files::engine_path(&st.config, &format!("{files_dir}/{}", files::HOME_SUB)),
            )
            .await?;
            let recursive = new_user.uid != user.uid || new_user.gid != user.gid;
            user = new_user;
            containers::create_and_start(
                &st.docker,
                &workspace_run_spec(st, agent, id, &image, &spec.container_env, &user.home),
            )
            .await?;
            prepare_dirs(st, &container, &user, recursive).await?;
        } else {
            containers::create_and_start(
                &st.docker,
                &workspace_run_spec(st, agent, id, &image, &spec.container_env, &user.home),
            )
            .await?;
        }
    }
    if let Some(cmd) = &spec.post_create {
        run_post_create(st, &container, &user.user, cmd).await?;
        let ckpt = names::checkpoint_image(id, 1);
        undo.push(UndoStep::Image(ckpt.clone()));
        take_checkpoint(st, id, &container, 1).await?;
        repo::set_checkpoint(&st.db, id, 1, &ckpt).await?;
    }

    // The agent starts without first-run dialogs in the working-branch checkout (D7).
    profile_patch_in(st, &container, &user, agent, &[WORKSPACE_REPO_DIR]).await?;

    // 7. Ready.
    repo::mark_ready(&st.db, id, &user, &image).await?;
    Ok(())
}

// ---------------------------------------------------------------- ensure

/// D9 ensure, called by every action that needs the workspace container: recreate it when it is
/// missing (from `checkpoint_image`, else from the definition), start it when it is stopped.
/// Returns the container name. Docker failures answer `docker_unavailable`.
pub async fn ensure_workspace_container(
    st: &AppState,
    ws: &WorkspaceRow,
) -> Result<String, ApiError> {
    let name = container_name(ws);
    // Not the git-write lock: callers may hold that one while they call this.
    let _guard = st.locks.lock(&format!("ensure:{name}")).await;
    let info = containers::inspect(&st.docker, &name)
        .await
        .map_err(|e| ensure_error(ws.id, e.into()))?;
    match info {
        Some(info) if info.running => Ok(name),
        Some(_) => {
            containers::start(&st.docker, &name)
                .await
                .map_err(|e| ensure_error(ws.id, e.into()))?;
            Ok(name)
        }
        None => {
            if let Err(e) = recreate(st, ws, &name).await {
                // Leave nothing half-made: the next call starts over.
                if let Err(cleanup) = containers::remove(&st.docker, &name).await {
                    tracing::warn!("removing {name} after a failed recreate failed: {cleanup}");
                }
                return Err(ensure_error(ws.id, e));
            }
            Ok(name)
        }
    }
}

async fn recreate(st: &AppState, ws: &WorkspaceRow, name: &str) -> Result<(), StepError> {
    let agent = adapter(st, ws).map_err(|e| StepError::Docker(DockerError::Failed(e.message)))?;
    let agent = agent.as_ref();
    let mut user = container_user_of(ws).ok_or_else(|| {
        StepError::Docker(DockerError::Failed(format!(
            "workspace {} has no container user",
            ws.id
        )))
    })?;
    tracing::info!(
        "workspace {}: container {name} is missing, recreating it",
        ws.id
    );
    ensure_volumes(st, ws).await?;

    if let Some(ckpt) = &ws.checkpoint_image {
        containers::create_and_start(
            &st.docker,
            &workspace_run_spec(st, agent, ws.id, ckpt, &BTreeMap::new(), &user.home),
        )
        .await?;
        return Ok(());
    }

    // No checkpoint: the definition decides (D6). Start from the base image to read it.
    let base = match &ws.base_image {
        Some(b) if images::exists(&st.docker, b).await? => b.clone(),
        _ => st.config.default_image.clone(),
    };
    containers::create_and_start(
        &st.docker,
        &workspace_run_spec(st, agent, ws.id, &base, &BTreeMap::new(), &user.home),
    )
    .await?;
    let spec = read_definition(st, name).await?;
    let image = resolve_image(st, ws.id, &spec, name).await?;
    if image != base || !spec.container_env.is_empty() {
        containers::remove(&st.docker, name).await?;
        if Some(&image) != ws.base_image.as_ref() {
            let new_user = discover_user(st, ws.id, &image).await?;
            let recursive = new_user.uid != user.uid || new_user.gid != user.gid;
            user = new_user;
            containers::create_and_start(
                &st.docker,
                &workspace_run_spec(st, agent, ws.id, &image, &spec.container_env, &user.home),
            )
            .await?;
            prepare_dirs(st, name, &user, recursive).await?;
            repo::set_container_user(&st.db, ws.id, &user, &image).await?;
        } else {
            containers::create_and_start(
                &st.docker,
                &workspace_run_spec(st, agent, ws.id, &image, &spec.container_env, &user.home),
            )
            .await?;
        }
    }
    if let Some(cmd) = &spec.post_create {
        run_post_create(st, name, &user.user, cmd).await?;
        let seq = ws.checkpoint_seq + 1;
        let ckpt = take_checkpoint(st, ws.id, name, seq).await?;
        repo::set_checkpoint(&st.db, ws.id, seq, &ckpt).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------- settings

/// Branches of the workspace repo (`refs/heads`), in git's order.
pub async fn branches(st: &AppState, ws: &WorkspaceRow) -> Result<Vec<String>, ApiError> {
    let container = ensure_workspace_container(st, ws).await?;
    let out = run_checked(
        st,
        &container,
        exec_user(ws)?,
        &git::for_each_branch(WORKSPACE_REPO_DIR, ""),
    )
    .await?;
    Ok(git::parse_branches(&out.stdout))
}

/// `PATCH workingBranch`: `git switch <branch>` under the workspace lock; `unknown_branch` for a
/// branch that does not exist, `working_tree_busy` when git refuses.
pub async fn set_working_branch(
    st: &AppState,
    ws: &WorkspaceRow,
    branch: &str,
) -> Result<WorkspaceRow, ApiError> {
    if !branches(st, ws).await?.iter().any(|b| b == branch) {
        return Err(ApiError::unknown_branch());
    }
    let container = ensure_workspace_container(st, ws).await?;
    {
        let _lock = st.locks.lock(&container).await;
        let out = exec::exec_capture(
            &st.docker,
            &container,
            exec_user(ws)?,
            &git::switch(WORKSPACE_REPO_DIR, branch),
            None,
            EXEC_TIMEOUT_DEFAULT,
        )
        .await?;
        if !out.success() {
            tracing::info!(
                "workspace {}: git switch {branch} refused: {}",
                ws.id,
                out.stderr_str().trim()
            );
            return Err(ApiError::working_tree_busy());
        }
        repo::update_branch(&st.db, ws.id, branch).await?;
    }
    let row = repo::get_by_id(&st.db, ws.id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if let Some(owner) = users::find_by_id(&st.db, row.user_id).await? {
        files::write_workspace_meta(&st.config, &row, &owner.email);
    }
    Ok(row)
}

// ---------------------------------------------------------------- delete

/// D9 delete: the workstream containers and volumes, the workspace container and volumes, the
/// images `wh-ckpt-<uuid>:*` and `wh-img-<uuid>:*`, the recording files and the row. Objects are
/// found by their labels and, for robustness, by their names.
pub async fn delete(st: &AppState, ws: &WorkspaceRow) -> Result<(), ApiError> {
    let filter = names::workspace_filter(&st.config.instance, ws.id);
    let stream_ids = repo::workstream_ids(&st.db, ws.id).await?;
    let recordings = repo::recording_files(&st.db, ws.id).await?;

    // Containers: workstreams first, then the workspace's own.
    let mut container_names: Vec<String> = stream_ids
        .iter()
        .map(|s| names::workstream_container(*s))
        .collect();
    let mut labelled = containers::list_by_labels(&st.docker, &filter).await?;
    labelled
        .sort_by_key(|c| c.labels.get(names::LABEL_ROLE).map(String::as_str) != Some("workstream"));
    container_names.extend(
        labelled
            .into_iter()
            .map(|c| c.name)
            .filter(|n| !n.is_empty()),
    );
    container_names.push(names::workspace_container(ws.id));
    let mut seen = HashSet::new();
    for c in container_names
        .into_iter()
        .filter(|c| seen.insert(c.clone()))
    {
        containers::remove(&st.docker, &c).await?;
    }

    // Volumes.
    let mut volume_names: Vec<String> = stream_ids
        .iter()
        .flat_map(|s| {
            [
                names::workstream_repo_volume(*s),
                names::workstream_home_volume(*s),
            ]
        })
        .collect();
    volume_names.extend(volumes::list_by_labels(&st.docker, &filter).await?);
    volume_names.push(names::workspace_repo_volume(ws.id));
    volume_names.push(names::workspace_home_volume(ws.id));
    let mut seen = HashSet::new();
    for v in volume_names.into_iter().filter(|v| seen.insert(v.clone())) {
        volumes::remove(&st.docker, &v).await?;
    }

    // Images: checkpoints newest first, then the built image.
    let mut image_refs: Vec<String> = (1..=ws.checkpoint_seq)
        .rev()
        .map(|seq| names::checkpoint_image(ws.id, seq))
        .collect();
    image_refs.extend(images::list_by_labels(&st.docker, &filter).await?);
    image_refs.push(names::built_image(ws.id));
    let mut seen = HashSet::new();
    // Labelled images carry this workspace's label, so a named base image is never among them.
    for i in image_refs.into_iter().filter(|i| seen.insert(i.clone())) {
        images::remove(&st.docker, &i).await?;
    }

    // The file-area folder (its workstreams' folders are inside it).
    if let Some(rel) = ws.files_dir.as_deref() {
        files::remove(st, helper_labels(st), rel).await?;
    }

    // Recording files.
    let dir = st.config.recordings_dir();
    let mut files: Vec<String> = recordings;
    files.extend(stream_ids.iter().map(|s| format!("{s}.raw")));
    let mut seen = HashSet::new();
    for f in files.into_iter().filter(|f| seen.insert(f.clone())) {
        if f.is_empty() || f.contains('/') || f.contains('\\') || f.starts_with('.') {
            continue;
        }
        match tokio::fs::remove_file(dir.join(&f)).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("cannot delete recording {f}: {e}"),
        }
    }

    repo::delete(&st.db, ws.id).await?;
    tracing::info!("workspace {} deleted", ws.id);
    Ok(())
}

/// `delete-account` (D3): deletes every workspace of the user, whatever its state.
pub struct WorkspaceAccountCleanup {
    st: AppState,
}

impl WorkspaceAccountCleanup {
    /// `st` must not itself hold this cleanup (the caller passes a state with the no-op one).
    pub fn new(st: AppState) -> Self {
        WorkspaceAccountCleanup { st }
    }
}

#[async_trait::async_trait]
impl AccountCleanup for WorkspaceAccountCleanup {
    async fn delete_user_data(&self, user_id: i64) -> Result<(), ApiError> {
        for ws in repo::list_all_for_user(&self.st.db, user_id).await? {
            delete(&self.st, &ws).await?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- agent profile

/// D7 profile patch: reads the agent's profile file (the adapter's `profile_file`) from the
/// container, deep-merges the adapter's patch for `workdirs` and writes it back as the container
/// user with mode 0600.
pub async fn apply_profile_patch(
    st: &AppState,
    container: &str,
    ws: &WorkspaceRow,
    workdirs: &[&str],
) -> Result<(), ApiError> {
    let agent = adapter(st, ws)?;
    let user = container_user_of(ws)
        .ok_or_else(|| ApiError::internal(format!("workspace {} has no container user", ws.id)))?;
    profile_patch_in(st, container, &user, agent.as_ref(), workdirs)
        .await
        .map_err(ApiError::from)
}

async fn profile_patch_in(
    st: &AppState,
    container: &str,
    user: &ContainerUser,
    agent: &dyn AgentAdapter,
    workdirs: &[&str],
) -> Result<(), DockerError> {
    let mut profile = read_profile(st, container, &user.home, agent).await?;
    merge_json(&mut profile, &agent.profile_patch(workdirs));
    write_profile(st, container, user, agent, &profile).await
}

/// The agent profile as JSON; missing or unreadable → `{}`.
pub(crate) async fn read_profile(
    st: &AppState,
    container: &str,
    home: &str,
    agent: &dyn AgentAdapter,
) -> Result<serde_json::Value, DockerError> {
    let path = format!("{}/{}", home.trim_end_matches('/'), agent.profile_file());
    let empty = serde_json::Value::Object(serde_json::Map::new());
    let Some(file) = archive::get_file(&st.docker, &st.config.tmp_dir(), container, &path).await?
    else {
        return Ok(empty);
    };
    let bytes = file.read_all().await?;
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(v) if v.is_object() => Ok(v),
        _ => {
            tracing::warn!("{container}:{path} is not a JSON object; starting a new one");
            Ok(empty)
        }
    }
}

/// Writes the agent profile (pretty JSON, owned by the container user, 0600).
pub(crate) async fn write_profile(
    st: &AppState,
    container: &str,
    user: &ContainerUser,
    agent: &dyn AgentAdapter,
    profile: &serde_json::Value,
) -> Result<(), DockerError> {
    let mut data = serde_json::to_vec_pretty(profile)
        .map_err(|e| DockerError::Failed(format!("profile JSON: {e}")))?;
    data.push(b'\n');
    archive::put_files(
        &st.docker,
        &st.config.tmp_dir(),
        container,
        &user.home,
        vec![PutEntry {
            path: agent.profile_file().to_string(),
            source: PutSource::Bytes(Bytes::from(data)),
        }],
        FileOwner {
            uid: user.uid as u32,
            gid: user.gid as u32,
            mode: 0o600,
        },
    )
    .await
}

pub(crate) fn user_of(ws: &WorkspaceRow) -> Result<ContainerUser, ApiError> {
    container_user_of(ws)
        .ok_or_else(|| ApiError::internal(format!("workspace {} has no container user", ws.id)))
}
