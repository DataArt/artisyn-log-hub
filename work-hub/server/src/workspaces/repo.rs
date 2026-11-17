//! `workspaces` table access. Every user-facing query is filtered by the owner (D4); rows in
//! `creating` are hidden from every list and lookup made for the API.

use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

/// One `workspaces` row (D18).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WorkspaceRow {
    pub id: Uuid,
    pub user_id: i64,
    pub name: String,
    pub working_branch: String,
    pub agent: String,
    pub state: String,
    pub container_user: Option<String>,
    pub container_uid: Option<i32>,
    pub container_gid: Option<i32>,
    pub home_dir: Option<String>,
    pub base_image: Option<String>,
    pub checkpoint_seq: i32,
    pub checkpoint_image: Option<String>,
    pub login_state: String,
    pub login_at: Option<OffsetDateTime>,
    pub configure_started_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    /// The workspace's folder in the file area, relative to the data dir (FR-5g).
    pub files_dir: Option<String>,
}

impl WorkspaceRow {
    pub fn is_ready(&self) -> bool {
        self.state == STATE_READY
    }

    pub fn logged_in(&self) -> bool {
        self.login_state == LOGIN_OK
    }
}

/// A workspace with the number of its open workstreams (the list and the single view).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WorkspaceWithCount {
    #[sqlx(flatten)]
    pub ws: WorkspaceRow,
    pub open_workstreams: i64,
}

pub const STATE_CREATING: &str = "creating";
pub const STATE_READY: &str = "ready";
pub const LOGIN_OK: &str = "ok";
pub const LOGIN_MISSING: &str = "missing";

/// The container user found by user discovery (D6), stored before `ready`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerUser {
    /// Name (or the numeric uid when the image has no passwd entry for it).
    pub user: String,
    pub uid: i32,
    pub gid: i32,
    pub home: String,
}

const COLUMNS: &str = "w.id, w.user_id, w.name, w.working_branch, w.agent, w.state, \
    w.container_user, w.container_uid, w.container_gid, w.home_dir, w.base_image, \
    w.checkpoint_seq, w.checkpoint_image, w.login_state, w.login_at, w.configure_started_at, \
    w.created_at, w.files_dir";

const OPEN_COUNT: &str = "(SELECT count(*) FROM workstreams s \
    WHERE s.workspace_id = w.id AND s.state = 'open') AS open_workstreams";

/// True when the user already has a workspace (in any state) with this name key.
pub async fn name_taken(db: &PgPool, user_id: i64, name_key: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM workspaces WHERE user_id = $1 AND name_key = $2")
            .bind(user_id)
            .bind(name_key)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// Inserts a row in `creating`. A duplicate name key is a unique violation
/// (`workspaces_user_name_unique`), see [`is_unique_violation`].
pub async fn insert_creating(
    db: &PgPool,
    id: Uuid,
    user_id: i64,
    name: &str,
    name_key: &str,
    agent: &str,
    files_dir: &str,
) -> Result<WorkspaceRow, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceRow>(&format!(
        "INSERT INTO workspaces AS w (id, user_id, name, name_key, agent, state, files_dir) \
         VALUES ($1, $2, $3, $4, $5, '{STATE_CREATING}', $6) RETURNING {COLUMNS}"
    ))
    .bind(id)
    .bind(user_id)
    .bind(name)
    .bind(name_key)
    .bind(agent)
    .bind(files_dir)
    .fetch_one(db)
    .await
}

/// True for a Postgres unique violation (SQLSTATE 23505).
pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("23505"))
}

/// Stores the container user and base image and sets `state='ready'`.
pub async fn mark_ready(
    db: &PgPool,
    id: Uuid,
    user: &ContainerUser,
    base_image: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "UPDATE workspaces SET container_user = $2, container_uid = $3, container_gid = $4, \
         home_dir = $5, base_image = $6, state = '{STATE_READY}' WHERE id = $1"
    ))
    .bind(id)
    .bind(&user.user)
    .bind(user.uid)
    .bind(user.gid)
    .bind(&user.home)
    .bind(base_image)
    .execute(db)
    .await?;
    Ok(())
}

/// Updates the container user and base image (the definition changed the image, D9 ensure).
pub async fn set_container_user(
    db: &PgPool,
    id: Uuid,
    user: &ContainerUser,
    base_image: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE workspaces SET container_user = $2, container_uid = $3, container_gid = $4, \
         home_dir = $5, base_image = $6 WHERE id = $1",
    )
    .bind(id)
    .bind(&user.user)
    .bind(user.uid)
    .bind(user.gid)
    .bind(&user.home)
    .bind(base_image)
    .execute(db)
    .await?;
    Ok(())
}

/// A ready workspace of `user_id`; `None` for a missing, foreign or still-creating one.
pub async fn get_owned(
    db: &PgPool,
    user_id: i64,
    id: Uuid,
) -> Result<Option<WorkspaceRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceRow>(&format!(
        "SELECT {COLUMNS} FROM workspaces w \
         WHERE w.id = $1 AND w.user_id = $2 AND w.state = '{STATE_READY}'"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// A ready workspace of `user_id` with its open-workstream count.
pub async fn get_owned_with_count(
    db: &PgPool,
    user_id: i64,
    id: Uuid,
) -> Result<Option<WorkspaceWithCount>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceWithCount>(&format!(
        "SELECT {COLUMNS}, {OPEN_COUNT} FROM workspaces w \
         WHERE w.id = $1 AND w.user_id = $2 AND w.state = '{STATE_READY}'"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// Any workspace by id, whatever its owner or state (background tasks only, never the API).
pub async fn get_by_id(db: &PgPool, id: Uuid) -> Result<Option<WorkspaceRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceRow>(&format!(
        "SELECT {COLUMNS} FROM workspaces w WHERE w.id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// The user's ready workspaces with their open-workstream counts, newest first.
pub async fn list_for_user(
    db: &PgPool,
    user_id: i64,
) -> Result<Vec<WorkspaceWithCount>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceWithCount>(&format!(
        "SELECT {COLUMNS}, {OPEN_COUNT} FROM workspaces w \
         WHERE w.user_id = $1 AND w.state = '{STATE_READY}' \
         ORDER BY w.created_at DESC, w.id"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await
}

/// Every workspace of the user in any state (account deletion).
pub async fn list_all_for_user(
    db: &PgPool,
    user_id: i64,
) -> Result<Vec<WorkspaceRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceRow>(&format!(
        "SELECT {COLUMNS} FROM workspaces w WHERE w.user_id = $1 ORDER BY w.created_at"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await
}

/// Rows stuck in `creating` for longer than `older_than_secs` (the reconciler cleans them up).
pub async fn list_stale_creating(
    db: &PgPool,
    older_than_secs: i64,
) -> Result<Vec<WorkspaceRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceRow>(&format!(
        "SELECT {COLUMNS} FROM workspaces w WHERE w.state = '{STATE_CREATING}' \
         AND w.created_at < now() - make_interval(secs => $1::double precision)"
    ))
    .bind(older_than_secs as f64)
    .fetch_all(db)
    .await
}

/// Copy sources for `login/copy`: the user's other ready workspaces with the same agent and a
/// login seen as ok (D7), most recent login first.
pub async fn login_sources(
    db: &PgPool,
    user_id: i64,
    exclude: Uuid,
    agent: &str,
) -> Result<Vec<WorkspaceRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceRow>(&format!(
        "SELECT {COLUMNS} FROM workspaces w \
         WHERE w.user_id = $1 AND w.id <> $2 AND w.agent = $3 \
           AND w.state = '{STATE_READY}' AND w.login_state = '{LOGIN_OK}' \
         ORDER BY w.login_at DESC NULLS LAST, w.name_key"
    ))
    .bind(user_id)
    .bind(exclude)
    .bind(agent)
    .fetch_all(db)
    .await
}

pub async fn update_branch(db: &PgPool, id: Uuid, branch: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE workspaces SET working_branch = $2 WHERE id = $1")
        .bind(id)
        .bind(branch)
        .execute(db)
        .await?;
    Ok(())
}

/// Updates the login cache. `login_at` is set when the login becomes ok, kept while it stays ok
/// and cleared when it is missing.
pub async fn set_login_state(db: &PgPool, id: Uuid, logged_in: bool) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "UPDATE workspaces SET \
           login_at = CASE WHEN NOT $2 THEN NULL \
                           WHEN login_state = '{LOGIN_OK}' AND login_at IS NOT NULL THEN login_at \
                           ELSE now() END, \
           login_state = CASE WHEN $2 THEN '{LOGIN_OK}' ELSE '{LOGIN_MISSING}' END \
         WHERE id = $1"
    ))
    .bind(id)
    .bind(logged_in)
    .execute(db)
    .await?;
    Ok(())
}

/// The login cache of every workspace of the user with this agent (the agent's token is one per
/// user, so they all log in and out together).
pub async fn set_login_state_for_user(
    db: &PgPool,
    user_id: i64,
    agent: &str,
    logged_in: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "UPDATE workspaces SET \
           login_at = CASE WHEN NOT $3 THEN NULL \
                           WHEN login_state = '{LOGIN_OK}' AND login_at IS NOT NULL THEN login_at \
                           ELSE now() END, \
           login_state = CASE WHEN $3 THEN '{LOGIN_OK}' ELSE '{LOGIN_MISSING}' END \
         WHERE user_id = $1 AND agent = $2"
    ))
    .bind(user_id)
    .bind(agent)
    .bind(logged_in)
    .execute(db)
    .await?;
    Ok(())
}

/// Sets (`Some`) or clears (`None`) `configure_started_at`.
pub async fn set_configure_started(
    db: &PgPool,
    id: Uuid,
    at: Option<OffsetDateTime>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE workspaces SET configure_started_at = $2 WHERE id = $1")
        .bind(id)
        .bind(at)
        .execute(db)
        .await?;
    Ok(())
}

/// Sets `configure_started_at = now()` only when it is not set yet. `false` when a configure
/// session is already running (two concurrent starts cannot both win).
pub async fn try_start_configure(db: &PgPool, id: Uuid) -> Result<bool, sqlx::Error> {
    let done = sqlx::query(
        "UPDATE workspaces SET configure_started_at = now() \
         WHERE id = $1 AND configure_started_at IS NULL",
    )
    .bind(id)
    .execute(db)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Workspaces with a configure session running (the configure watcher resumes them at startup).
pub async fn list_configuring(db: &PgPool) -> Result<Vec<WorkspaceRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkspaceRow>(&format!(
        "SELECT {COLUMNS} FROM workspaces w \
         WHERE w.state = '{STATE_READY}' AND w.configure_started_at IS NOT NULL"
    ))
    .fetch_all(db)
    .await
}

/// Stores the latest checkpoint image and its sequence number.
pub async fn set_checkpoint(
    db: &PgPool,
    id: Uuid,
    seq: i32,
    image: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE workspaces SET checkpoint_seq = $2, checkpoint_image = $3 WHERE id = $1")
        .bind(id)
        .bind(seq)
        .bind(image)
        .execute(db)
        .await?;
    Ok(())
}

/// Ids of every workstream of the workspace, any state.
pub async fn workstream_ids(db: &PgPool, workspace_id: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM workstreams WHERE workspace_id = $1")
        .bind(workspace_id)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Recording file names of the workspace's workstreams.
pub async fn recording_files(db: &PgPool, workspace_id: Uuid) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT r.file_name FROM terminal_recordings r \
         JOIN workstreams s ON s.id = r.workstream_id WHERE s.workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(f,)| f).collect())
}

/// Deletes the row (workstreams and recordings cascade).
pub async fn delete(db: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
