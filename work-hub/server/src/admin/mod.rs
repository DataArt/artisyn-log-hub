//! Admin resource overview (FR-12, plan D15): every user, their workspaces, open / total
//! workstreams and the disk space each workspace takes. Read-only; measured on every request (no
//! caching). Never contains connections, secrets or file contents (NFR Security).

pub mod disk;

use std::collections::HashMap;

use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::AppState;

/// `GET /api/v1/admin/overview`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    #[serde(with = "time::serde::rfc3339")]
    pub generated_at: OffsetDateTime,
    pub instance: InstanceDisk,
    pub users: Vec<UserUsage>,
    /// Every user's total plus the git cache.
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceDisk {
    /// The git proxy's mirror volume `wh-gitcache-<instance>`; `null` when unknown.
    pub git_cache_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserUsage {
    pub id: i64,
    pub email: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub workspaces: Vec<WorkspaceUsage>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUsage {
    pub id: Uuid,
    pub name: String,
    pub working_branch: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub workstreams_open: i64,
    /// Every workstream that is not still `opening` (as History lists them).
    pub workstreams_total: i64,
    pub disk: WorkspaceDisk,
}

/// A size that cannot be measured is `null` and counts as 0 in `total_bytes`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDisk {
    /// The workspace's file-area folder (its workstreams' folders are inside it).
    pub files_bytes: Option<u64>,
    /// Writable layers of its workspace, workstream and helper containers.
    pub containers_bytes: Option<u64>,
    /// Docker-managed data of its volumes (the bind-mounted ones are the files above).
    pub volumes_bytes: Option<u64>,
    /// Its built and checkpoint images (unique layers).
    pub images_bytes: Option<u64>,
    pub total_bytes: u64,
}

#[derive(sqlx::FromRow)]
struct UserLine {
    id: i64,
    email: String,
    created_at: OffsetDateTime,
}

#[derive(sqlx::FromRow)]
struct WorkspaceLine {
    id: Uuid,
    user_id: i64,
    name: String,
    working_branch: String,
    created_at: OffsetDateTime,
    files_dir: Option<String>,
    workstreams_open: i64,
    workstreams_total: i64,
}

/// Builds the overview: two queries, a walk of every workspace folder (blocking pool) and two
/// Docker calls (container list with sizes, `system df`), the walk and the calls concurrently.
pub async fn overview(st: &AppState) -> Result<Overview, ApiError> {
    let users = sqlx::query_as::<_, UserLine>(
        "SELECT id, email, created_at FROM users ORDER BY lower(email), id",
    )
    .fetch_all(&st.db)
    .await?;
    let workspaces = sqlx::query_as::<_, WorkspaceLine>(
        "SELECT w.id, w.user_id, w.name, w.working_branch, w.created_at, w.files_dir, \
           (SELECT count(*) FROM workstreams s \
             WHERE s.workspace_id = w.id AND s.state = 'open') AS workstreams_open, \
           (SELECT count(*) FROM workstreams s \
             WHERE s.workspace_id = w.id AND s.state <> 'opening') AS workstreams_total \
         FROM workspaces w WHERE w.state = 'ready' ORDER BY w.created_at, w.id",
    )
    .fetch_all(&st.db)
    .await?;

    let dirs: Vec<Option<std::path::PathBuf>> = workspaces
        .iter()
        .map(|w| {
            w.files_dir
                .as_deref()
                .map(|rel| crate::files::host_path(&st.config, rel))
        })
        .collect();
    let files = tokio::task::spawn_blocking(move || {
        dirs.into_iter()
            .map(|d| d.map(|p| crate::files::dir_size(&p)))
            .collect::<Vec<Option<u64>>>()
    });
    let instance = st.config.instance.as_str();
    let (files, containers, df) = tokio::join!(
        files,
        disk::containers(&st.docker, instance),
        disk::system_df(&st.docker, instance),
    );
    let files = files.map_err(ApiError::internal)?;

    let pick = |map: &Option<disk::PerWorkspace>, id: Uuid| -> Option<u64> {
        map.as_ref()
            .map(|m| m.get(&id.to_string()).copied().unwrap_or(0))
    };
    let mut by_user: HashMap<i64, Vec<WorkspaceUsage>> = HashMap::new();
    for (w, files_bytes) in workspaces.into_iter().zip(files) {
        let containers_bytes = pick(&containers, w.id);
        let volumes_bytes = pick(&df.volumes, w.id);
        let images_bytes = pick(&df.images, w.id);
        let total_bytes = [files_bytes, containers_bytes, volumes_bytes, images_bytes]
            .into_iter()
            .map(|v| v.unwrap_or(0))
            .sum();
        by_user.entry(w.user_id).or_default().push(WorkspaceUsage {
            id: w.id,
            name: w.name,
            working_branch: w.working_branch,
            created_at: w.created_at,
            workstreams_open: w.workstreams_open,
            workstreams_total: w.workstreams_total,
            disk: WorkspaceDisk {
                files_bytes,
                containers_bytes,
                volumes_bytes,
                images_bytes,
                total_bytes,
            },
        });
    }

    let users: Vec<UserUsage> = users
        .into_iter()
        .map(|u| {
            let workspaces = by_user.remove(&u.id).unwrap_or_default();
            let total_bytes = workspaces.iter().map(|w| w.disk.total_bytes).sum();
            UserUsage {
                id: u.id,
                email: u.email,
                created_at: u.created_at,
                workspaces,
                total_bytes,
            }
        })
        .collect();
    let total_bytes = users.iter().map(|u| u.total_bytes).sum::<u64>() + df.git_cache.unwrap_or(0);
    Ok(Overview {
        generated_at: OffsetDateTime::now_utc(),
        instance: InstanceDisk {
            git_cache_bytes: df.git_cache,
        },
        users,
        total_bytes,
    })
}
