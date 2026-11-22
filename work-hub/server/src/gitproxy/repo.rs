//! `git_capabilities` table access and the rows the sidecar's routing state is built from (D4).

use sqlx::PgPool;
use uuid::Uuid;

/// One remote record of `replace-remotes` (D4).
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct RemoteRecord {
    pub remote_id: Uuid,
    pub connection_id: Option<Uuid>,
    pub connection_name: String,
    pub upstream_url: String,
    pub block_default_rewrite: bool,
    pub only_ws_branches: bool,
}

impl RemoteRecord {
    /// The D4 line (without the trailing newline): `<remote id>\t<connection id or ->\t<name>\t
    /// <upstream url>\t<1|0>\t<1|0>`; tabs and newlines in the name become spaces.
    pub fn line(&self) -> String {
        let conn = self
            .connection_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "-".to_string());
        let name: String = self
            .connection_name
            .chars()
            .map(|c| {
                if matches!(c, '\t' | '\n' | '\r') {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        format!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            self.remote_id,
            conn,
            name,
            self.upstream_url,
            u8::from(self.block_default_rewrite),
            u8::from(self.only_ws_branches)
        )
    }
}

/// One capability line of `replace-caps` (D4): the token hash and the remotes it opens.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct CapabilityLine {
    pub token_hash: String,
    pub remote_ids: Vec<Uuid>,
}

impl CapabilityLine {
    /// `<token_hash>\t<rid> <rid> …` (without the trailing newline).
    pub fn line(&self) -> String {
        let ids: Vec<String> = self.remote_ids.iter().map(Uuid::to_string).collect();
        format!("{}\t{}", self.token_hash, ids.join(" "))
    }
}

/// Everything `sync_routes` pushes to the sidecar.
#[derive(Debug, Clone, Default)]
pub struct RouteRows {
    pub remotes: Vec<RemoteRecord>,
    pub capabilities: Vec<CapabilityLine>,
}

/// Creates or replaces the capability of a container (each start issues a new token).
pub async fn upsert_capability(
    db: &PgPool,
    container: &str,
    workspace_id: Uuid,
    workstream_id: Option<Uuid>,
    token_hash: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO git_capabilities (container, workspace_id, workstream_id, token_hash) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (container) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, \
           workstream_id = EXCLUDED.workstream_id, token_hash = EXCLUDED.token_hash, \
           created_at = now()",
    )
    .bind(container)
    .bind(workspace_id)
    .bind(workstream_id)
    .bind(token_hash)
    .execute(db)
    .await?;
    Ok(())
}

/// Revokes the capability of a container (no-op when it has none).
pub async fn delete_capability(db: &PgPool, container: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM git_capabilities WHERE container = $1")
        .bind(container)
        .execute(db)
        .await?;
    Ok(())
}

/// The containers of a workspace that hold a capability, with their workstream (`None` for the
/// workspace container): the containers whose repo carries the proxy remotes.
pub async fn containers_of(
    db: &PgPool,
    workspace_id: Uuid,
) -> Result<Vec<(String, Option<Uuid>)>, sqlx::Error> {
    sqlx::query_as(
        "SELECT container, workstream_id FROM git_capabilities WHERE workspace_id = $1 \
         ORDER BY container",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
}

/// Ids of every workspace remote (the live mirrors of `prune-mirrors`).
pub async fn remote_ids(db: &PgPool) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM workspace_remotes ORDER BY id")
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// All remote records and capability lines. A capability opens the remotes of its workspace
/// whose connection is granted to that workspace or was deleted (`connection_id IS NULL`, so the
/// proxy answers "was deleted" rather than "no grant"); a capability with no such remote is still
/// listed, with no ids.
pub async fn route_rows(db: &PgPool) -> Result<RouteRows, sqlx::Error> {
    let remotes = sqlx::query_as::<_, RemoteRecord>(
        "SELECT r.id AS remote_id, r.connection_id, r.connection_name, r.upstream_url, \
           r.block_default_rewrite, r.only_ws_branches \
         FROM workspace_remotes r ORDER BY r.id",
    )
    .fetch_all(db)
    .await?;
    let capabilities = sqlx::query_as::<_, CapabilityLine>(
        "SELECT k.token_hash, \
           COALESCE(array_agg(r.id ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), \
                    '{}'::uuid[]) AS remote_ids \
         FROM git_capabilities k \
         LEFT JOIN workspace_remotes r ON r.workspace_id = k.workspace_id \
           AND (r.connection_id IS NULL OR EXISTS ( \
             SELECT 1 FROM connection_grants g \
             WHERE g.connection_id = r.connection_id AND g.workspace_id = k.workspace_id)) \
         GROUP BY k.token_hash ORDER BY k.token_hash",
    )
    .fetch_all(db)
    .await?;
    Ok(RouteRows {
        remotes,
        capabilities,
    })
}
