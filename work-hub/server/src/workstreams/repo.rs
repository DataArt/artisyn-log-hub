//! `workstreams` and `terminal_recordings` table access. User-facing lookups go through the
//! owner of the workspace (D4); rows in `opening` are hidden from every list and lookup made for
//! the API.

use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

/// One `workstreams` row (D18).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WorkstreamRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub branch: String,
    pub base_branch: String,
    pub state: String,
    pub agent_session_id: Uuid,
    pub opened_at: OffsetDateTime,
    pub closed_at: Option<OffsetDateTime>,
    pub merged_at: Option<OffsetDateTime>,
    pub discarded_at: Option<OffsetDateTime>,
    /// The workstream's folder in the file area, relative to the data dir (FR-5g).
    pub files_dir: Option<String>,
    /// The base branch's commit in the workspace repo when it was opened (start of the range
    /// brought into main); `None` for workstreams opened before migration 0003.
    pub base_commit: Option<String>,
}

impl WorkstreamRow {
    pub fn is_open(&self) -> bool {
        self.state == STATE_OPEN
    }

    pub fn is_closed(&self) -> bool {
        self.state == STATE_CLOSED
    }
}

pub const STATE_OPENING: &str = "opening";
pub const STATE_OPEN: &str = "open";
pub const STATE_CLOSED: &str = "closed";
pub const STATE_DONE: &str = "done";
pub const STATE_DISCARDED: &str = "discarded";

const COLUMNS: &str = "s.id, s.workspace_id, s.name, s.branch, s.base_branch, s.state, \
    s.agent_session_id, s.opened_at, s.closed_at, s.merged_at, s.discarded_at, s.files_dir, \
    s.base_commit";

/// What [`insert_opening`] stores.
#[derive(Debug, Clone)]
pub struct NewWorkstream<'a> {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: &'a str,
    pub name_key: &'a str,
    pub branch: &'a str,
    pub base_branch: &'a str,
    pub agent_session_id: Uuid,
    pub files_dir: &'a str,
    pub base_commit: &'a str,
}

/// True when a not discarded workstream of the workspace (any other state, `opening`
/// included) has this name key.
pub async fn name_taken(
    db: &PgPool,
    workspace_id: Uuid,
    name_key: &str,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(&format!(
        "SELECT 1 FROM workstreams \
         WHERE workspace_id = $1 AND name_key = $2 AND state <> '{STATE_DISCARDED}'"
    ))
    .bind(workspace_id)
    .bind(name_key)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// Every branch the workspace's workstreams have used, discarded ones included (D8 taken set).
pub async fn taken_branches(db: &PgPool, workspace_id: Uuid) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT branch FROM workstreams WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(b,)| b).collect())
}

/// Inserts a row in `opening`. A duplicate name key or branch is a unique violation
/// (see `workspaces::repo::is_unique_violation`).
pub async fn insert_opening(
    db: &PgPool,
    new: &NewWorkstream<'_>,
) -> Result<WorkstreamRow, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "INSERT INTO workstreams AS s \
           (id, workspace_id, name, name_key, branch, base_branch, state, agent_session_id, \
            files_dir, base_commit) \
         VALUES ($1, $2, $3, $4, $5, $6, '{STATE_OPENING}', $7, $8, $9) RETURNING {COLUMNS}"
    ))
    .bind(new.id)
    .bind(new.workspace_id)
    .bind(new.name)
    .bind(new.name_key)
    .bind(new.branch)
    .bind(new.base_branch)
    .bind(new.agent_session_id)
    .bind(new.files_dir)
    .bind(new.base_commit)
    .fetch_one(db)
    .await
}

/// Inserts the recording row of a workstream (an existing one is kept).
pub async fn insert_recording(
    db: &PgPool,
    workstream_id: Uuid,
    file_name: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO terminal_recordings (workstream_id, file_name) VALUES ($1, $2) \
         ON CONFLICT (workstream_id) DO NOTHING",
    )
    .bind(workstream_id)
    .bind(file_name)
    .execute(db)
    .await?;
    Ok(())
}

async fn update_returning(
    db: &PgPool,
    id: Uuid,
    set: &str,
) -> Result<Option<WorkstreamRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "UPDATE workstreams AS s SET {set} WHERE s.id = $1 RETURNING {COLUMNS}"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// `state='open'` (after opening, and on reopen: `closed_at` is cleared).
pub async fn set_open(db: &PgPool, id: Uuid) -> Result<Option<WorkstreamRow>, sqlx::Error> {
    update_returning(db, id, &format!("state = '{STATE_OPEN}', closed_at = NULL")).await
}

/// `state='closed'`, `closed_at = now()`, and `merged_at = now()` when `merged`.
pub async fn set_closed(
    db: &PgPool,
    id: Uuid,
    merged: bool,
) -> Result<Option<WorkstreamRow>, sqlx::Error> {
    let merged_at = if merged { ", merged_at = now()" } else { "" };
    update_returning(
        db,
        id,
        &format!("state = '{STATE_CLOSED}', closed_at = now(){merged_at}"),
    )
    .await
}

/// `state='done'` (merged elsewhere), `closed_at = now()`.
pub async fn set_done(db: &PgPool, id: Uuid) -> Result<Option<WorkstreamRow>, sqlx::Error> {
    update_returning(
        db,
        id,
        &format!("state = '{STATE_DONE}', closed_at = now()"),
    )
    .await
}

/// `state='discarded'`, `discarded_at = now()`; `closed_at` is set when it was still open.
pub async fn set_discarded(db: &PgPool, id: Uuid) -> Result<Option<WorkstreamRow>, sqlx::Error> {
    update_returning(
        db,
        id,
        &format!(
            "state = '{STATE_DISCARDED}', discarded_at = now(), \
             closed_at = COALESCE(closed_at, now())"
        ),
    )
    .await
}

/// The workspace's workstreams in every visible state (not `opening`), newest first.
pub async fn list_by_workspace(
    db: &PgPool,
    workspace_id: Uuid,
) -> Result<Vec<WorkstreamRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "SELECT {COLUMNS} FROM workstreams s \
         WHERE s.workspace_id = $1 AND s.state <> '{STATE_OPENING}' \
         ORDER BY s.opened_at DESC, s.id"
    ))
    .bind(workspace_id)
    .fetch_all(db)
    .await
}

/// The workspace's open workstreams, oldest first (the workspace page's switcher).
pub async fn list_open_by_workspace(
    db: &PgPool,
    workspace_id: Uuid,
) -> Result<Vec<WorkstreamRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "SELECT {COLUMNS} FROM workstreams s \
         WHERE s.workspace_id = $1 AND s.state = '{STATE_OPEN}' \
         ORDER BY s.opened_at, s.id"
    ))
    .bind(workspace_id)
    .fetch_all(db)
    .await
}

/// A visible workstream whose workspace is a ready workspace of `user_id`; `None` for a
/// missing, foreign or still-opening one (the API answers 404).
pub async fn get_owned(
    db: &PgPool,
    user_id: i64,
    id: Uuid,
) -> Result<Option<WorkstreamRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "SELECT {COLUMNS} FROM workstreams s JOIN workspaces w ON w.id = s.workspace_id \
         WHERE s.id = $1 AND w.user_id = $2 AND w.state = 'ready' \
           AND s.state <> '{STATE_OPENING}'"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// Any workstream by id, whatever its owner or state (background tasks only, never the API).
pub async fn get_by_id(db: &PgPool, id: Uuid) -> Result<Option<WorkstreamRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "SELECT {COLUMNS} FROM workstreams s WHERE s.id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// Every open workstream of a ready workspace (the reconciler).
pub async fn list_all_open(db: &PgPool) -> Result<Vec<WorkstreamRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "SELECT {COLUMNS} FROM workstreams s JOIN workspaces w ON w.id = s.workspace_id \
         WHERE s.state = '{STATE_OPEN}' AND w.state = 'ready' ORDER BY s.opened_at"
    ))
    .fetch_all(db)
    .await
}

/// Rows stuck in `opening` for longer than `older_than_secs` (the reconciler cleans them up).
pub async fn list_stale_opening(
    db: &PgPool,
    older_than_secs: i64,
) -> Result<Vec<WorkstreamRow>, sqlx::Error> {
    sqlx::query_as::<_, WorkstreamRow>(&format!(
        "SELECT {COLUMNS} FROM workstreams s WHERE s.state = '{STATE_OPENING}' \
         AND s.created_at < now() - make_interval(secs => $1::double precision)"
    ))
    .bind(older_than_secs as f64)
    .fetch_all(db)
    .await
}

/// Deletes the row (its recording rows cascade).
pub async fn delete(db: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM workstreams WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
