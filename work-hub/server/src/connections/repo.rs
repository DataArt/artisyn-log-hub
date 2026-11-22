//! `connections` and `connection_grants` table access. Every query made for the API is filtered
//! by the owner; the `set_*` helpers take an id the caller already resolved with [`get_owned`]
//! (or a background task's id).

use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

/// One `connections` row (all columns).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ConnectionRow {
    pub id: Uuid,
    pub user_id: i64,
    pub name: String,
    pub name_key: String,
    pub kind: String,
    pub provider: String,
    pub base_url: String,
    pub auth_method: String,
    pub username: Option<String>,
    pub secret_name: String,
    pub secret_hint: Option<String>,
    pub secret_updated_at: OffsetDateTime,
    pub public_key: Option<String>,
    pub key_fingerprint: Option<String>,
    pub known_hosts: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub expose_env: Option<String>,
    pub status: String,
    pub status_detail: Option<String>,
    pub status_user: Option<String>,
    pub status_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
}

pub const KIND_GIT: &str = "git";
pub const STATUS_UNTESTED: &str = "untested";
pub const STATUS_OK: &str = "ok";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_HOST_KEY: &str = "host_key";
pub const STATUS_FAILED: &str = "failed";

const COLUMNS: &str = "c.id, c.user_id, c.name, c.name_key, c.kind, c.provider, c.base_url, \
    c.auth_method, c.username, c.secret_name, c.secret_hint, c.secret_updated_at, c.public_key, \
    c.key_fingerprint, c.known_hosts, c.host_key_fingerprint, c.expose_env, c.status, \
    c.status_detail, c.status_user, c.status_at, c.created_at";

/// The values of a new row (D14: the secret is already in the vault as `secret_name`).
#[derive(Debug, Clone)]
pub struct NewConnection<'a> {
    pub id: Uuid,
    pub user_id: i64,
    pub name: &'a str,
    pub name_key: &'a str,
    pub kind: &'a str,
    pub provider: &'a str,
    pub base_url: &'a str,
    pub auth_method: &'a str,
    pub username: Option<&'a str>,
    pub secret_name: &'a str,
    pub secret_hint: Option<&'a str>,
    pub public_key: Option<&'a str>,
    pub key_fingerprint: Option<&'a str>,
    pub expose_env: Option<&'a str>,
}

/// The editable plain fields; `None` keeps a field, `Some(None)` clears a nullable one.
#[derive(Debug, Clone, Default)]
pub struct ConnectionUpdate<'a> {
    /// `(name, name_key)`.
    pub name: Option<(&'a str, &'a str)>,
    pub username: Option<Option<&'a str>>,
    pub expose_env: Option<Option<&'a str>>,
}

/// A workspace a connection is granted to.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GrantRow {
    pub workspace_id: Uuid,
    pub workspace_name: String,
}

/// A remote that uses a connection.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UsedByRow {
    pub workspace_id: Uuid,
    pub workspace_name: String,
    pub remote_name: String,
}

/// Inserts a row with status `untested`. A duplicate name key is a unique violation
/// (`workspaces::repo::is_unique_violation`).
pub async fn insert(db: &PgPool, c: &NewConnection<'_>) -> Result<ConnectionRow, sqlx::Error> {
    sqlx::query_as::<_, ConnectionRow>(&format!(
        "INSERT INTO connections AS c (id, user_id, name, name_key, kind, provider, base_url, \
           auth_method, username, secret_name, secret_hint, public_key, key_fingerprint, expose_env) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING {COLUMNS}"
    ))
    .bind(c.id)
    .bind(c.user_id)
    .bind(c.name)
    .bind(c.name_key)
    .bind(c.kind)
    .bind(c.provider)
    .bind(c.base_url)
    .bind(c.auth_method)
    .bind(c.username)
    .bind(c.secret_name)
    .bind(c.secret_hint)
    .bind(c.public_key)
    .bind(c.key_fingerprint)
    .bind(c.expose_env)
    .fetch_one(db)
    .await
}

/// A connection of `user_id`; `None` for a missing or foreign one.
pub async fn get_owned(
    db: &PgPool,
    user_id: i64,
    id: Uuid,
) -> Result<Option<ConnectionRow>, sqlx::Error> {
    sqlx::query_as::<_, ConnectionRow>(&format!(
        "SELECT {COLUMNS} FROM connections c WHERE c.id = $1 AND c.user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// Any connection by id, whatever its owner (background work such as the sidecar sync, never
/// the API).
pub async fn get_by_id(db: &PgPool, id: Uuid) -> Result<Option<ConnectionRow>, sqlx::Error> {
    sqlx::query_as::<_, ConnectionRow>(&format!(
        "SELECT {COLUMNS} FROM connections c WHERE c.id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// The user's connections, by name.
pub async fn list_for_user(db: &PgPool, user_id: i64) -> Result<Vec<ConnectionRow>, sqlx::Error> {
    sqlx::query_as::<_, ConnectionRow>(&format!(
        "SELECT {COLUMNS} FROM connections c WHERE c.user_id = $1 ORDER BY c.name_key, c.id"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await
}

/// Updates the plain fields of an owned connection; `None` when it is missing or foreign.
pub async fn update_fields(
    db: &PgPool,
    user_id: i64,
    id: Uuid,
    u: &ConnectionUpdate<'_>,
) -> Result<Option<ConnectionRow>, sqlx::Error> {
    let (name, name_key) = match u.name {
        Some((n, k)) => (Some(n), Some(k)),
        None => (None, None),
    };
    sqlx::query_as::<_, ConnectionRow>(&format!(
        "UPDATE connections AS c SET \
           name = COALESCE($3, c.name), \
           name_key = COALESCE($4, c.name_key), \
           username = CASE WHEN $5 THEN $6 ELSE c.username END, \
           expose_env = CASE WHEN $7 THEN $8 ELSE c.expose_env END \
         WHERE c.id = $1 AND c.user_id = $2 RETURNING {COLUMNS}"
    ))
    .bind(id)
    .bind(user_id)
    .bind(name)
    .bind(name_key)
    .bind(u.username.is_some())
    .bind(u.username.flatten())
    .bind(u.expose_env.is_some())
    .bind(u.expose_env.flatten())
    .fetch_optional(db)
    .await
}

/// Stores the public metadata of a new secret (D14 edit / regenerate): `secret_updated_at = now()`
/// and the status back to `untested`.
pub async fn set_secret_meta(
    db: &PgPool,
    id: Uuid,
    secret_hint: Option<&str>,
    public_key: Option<&str>,
    key_fingerprint: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "UPDATE connections SET secret_hint = $2, public_key = $3, key_fingerprint = $4, \
           secret_updated_at = now(), status = '{STATUS_UNTESTED}', status_detail = NULL, \
           status_user = NULL, status_at = NULL \
         WHERE id = $1"
    ))
    .bind(id)
    .bind(secret_hint)
    .bind(public_key)
    .bind(key_fingerprint)
    .execute(db)
    .await?;
    Ok(())
}

/// Stores the outcome of a server-driven operation (D1 item 9); `status_at = now()`.
pub async fn set_status(
    db: &PgPool,
    id: Uuid,
    status: &str,
    detail: Option<&str>,
    status_user: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE connections SET status = $2, status_detail = $3, status_user = $4, \
           status_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(detail)
    .bind(status_user)
    .execute(db)
    .await?;
    Ok(())
}

/// Pins the SSH host key (D14 Test with `acceptHostKey`).
pub async fn set_host_key(
    db: &PgPool,
    id: Uuid,
    known_hosts: &str,
    fingerprint: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE connections SET known_hosts = $2, host_key_fingerprint = $3 WHERE id = $1")
        .bind(id)
        .bind(known_hosts)
        .bind(fingerprint)
        .execute(db)
        .await?;
    Ok(())
}

/// Deletes an owned connection (grants cascade, remotes keep `connection_name` with a NULL
/// `connection_id`). `false` when it was missing or foreign.
pub async fn delete(db: &PgPool, user_id: i64, id: Uuid) -> Result<bool, sqlx::Error> {
    let done = sqlx::query("DELETE FROM connections WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(done.rows_affected() == 1)
}

/// Deletes every connection of the user and returns their ids (account deletion).
pub async fn delete_all_for_user(db: &PgPool, user_id: i64) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> =
        sqlx::query_as("DELETE FROM connections WHERE user_id = $1 RETURNING id")
            .bind(user_id)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// The ready workspaces a connection is granted to, by name.
pub async fn grants_of(db: &PgPool, connection_id: Uuid) -> Result<Vec<GrantRow>, sqlx::Error> {
    sqlx::query_as::<_, GrantRow>(
        "SELECT w.id AS workspace_id, w.name AS workspace_name \
         FROM connection_grants g JOIN workspaces w ON w.id = g.workspace_id \
         WHERE g.connection_id = $1 AND w.state = 'ready' \
         ORDER BY w.name_key, w.id",
    )
    .bind(connection_id)
    .fetch_all(db)
    .await
}

/// True when the connection is granted to the workspace (any workspace state: a clone grants
/// it while the workspace is still being created).
pub async fn is_granted(
    db: &PgPool,
    connection_id: Uuid,
    workspace_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM connection_grants WHERE connection_id = $1 AND workspace_id = $2",
    )
    .bind(connection_id)
    .bind(workspace_id)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// Adds one grant; an existing grant is kept.
pub async fn insert_grant(
    db: &PgPool,
    connection_id: Uuid,
    workspace_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO connection_grants (connection_id, workspace_id) VALUES ($1, $2) \
         ON CONFLICT DO NOTHING",
    )
    .bind(connection_id)
    .bind(workspace_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Replaces the grants of an owned connection with `workspace_ids` in one transaction. Only the
/// user's ready workspaces are granted (the caller answers 404 for foreign ids first); grants to
/// a workspace still being created are kept. Returns the number of grants written.
pub async fn replace_grants(
    db: &PgPool,
    user_id: i64,
    connection_id: Uuid,
    workspace_ids: &[Uuid],
) -> Result<u64, sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query(
        "DELETE FROM connection_grants g USING workspaces w, connections c \
         WHERE g.workspace_id = w.id AND g.connection_id = c.id \
           AND g.connection_id = $1 AND c.user_id = $2 AND w.state = 'ready'",
    )
    .bind(connection_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    let done = sqlx::query(
        "INSERT INTO connection_grants (connection_id, workspace_id) \
         SELECT c.id, w.id FROM connections c, workspaces w \
         WHERE c.id = $1 AND c.user_id = $2 AND w.user_id = $2 AND w.state = 'ready' \
           AND w.id = ANY($3) \
         ON CONFLICT DO NOTHING",
    )
    .bind(connection_id)
    .bind(user_id)
    .bind(workspace_ids)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(done.rows_affected())
}

/// The remotes (of ready workspaces) that use a connection, by workspace and remote name.
pub async fn used_by(db: &PgPool, connection_id: Uuid) -> Result<Vec<UsedByRow>, sqlx::Error> {
    sqlx::query_as::<_, UsedByRow>(
        "SELECT w.id AS workspace_id, w.name AS workspace_name, r.name AS remote_name \
         FROM workspace_remotes r JOIN workspaces w ON w.id = r.workspace_id \
         WHERE r.connection_id = $1 AND w.state = 'ready' \
         ORDER BY w.name_key, w.id, r.name",
    )
    .bind(connection_id)
    .fetch_all(db)
    .await
}

/// The PAT connections exposed as an env variable and granted to the workspace (D10).
pub async fn exposed_for_workspace(
    db: &PgPool,
    workspace_id: Uuid,
) -> Result<Vec<ConnectionRow>, sqlx::Error> {
    sqlx::query_as::<_, ConnectionRow>(&format!(
        "SELECT {COLUMNS} FROM connections c \
         JOIN connection_grants g ON g.connection_id = c.id \
         WHERE g.workspace_id = $1 AND c.auth_method = 'pat' AND c.expose_env IS NOT NULL \
         ORDER BY c.expose_env, c.id"
    ))
    .bind(workspace_id)
    .fetch_all(db)
    .await
}

/// Ids of every connection (the sidecar's `push_all` / `prune-conns`).
pub async fn all_ids(db: &PgPool) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM connections ORDER BY id")
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}
