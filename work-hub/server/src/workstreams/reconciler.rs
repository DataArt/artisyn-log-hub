//! The reconciler (D10): runs at startup and every [`RECONCILE_INTERVAL`].
//!
//! - Every `open` workstream gets its container running with a live `chat` (created with the
//!   adapter's `resume_command`, a dead pane respawned). A failure marks it unavailable in memory
//!   (`available:false`) until a later start works (`POST …/retry` or a later round).
//! - Rows stuck in `creating` (workspaces) or `opening` (workstreams) for longer than
//!   [`STALE_TRANSIENT_AGE`] are deleted after their labelled Docker objects are removed.
//!
//! The DB schema is per instance, so every row seen here belongs to this instance.

use std::collections::HashMap;
use std::collections::hash_map::Entry;

use uuid::Uuid;

use super::{ensure_workstream_running, remove_objects, repo, transition_lock};
use crate::state::AppState;
use crate::timing::{RECONCILE_INTERVAL, STALE_TRANSIENT_AGE};
use crate::workspaces::{self, WorkspaceRow};

/// Starts the reconciler task: one round at once, then one every [`RECONCILE_INTERVAL`].
pub fn spawn(st: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECONCILE_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            run_once(&st).await;
        }
    });
}

/// One round: stale transient rows first, then the open workstreams.
pub async fn run_once(st: &AppState) {
    cleanup_stale(st).await;
    ensure_open(st).await;
}

async fn ensure_open(st: &AppState) {
    let open = match repo::list_all_open(&st.db).await {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!("reconciler: cannot list open workstreams: {e}");
            return;
        }
    };
    let mut workspaces_by_id: HashMap<Uuid, Option<WorkspaceRow>> = HashMap::new();
    for s in open {
        if let Entry::Vacant(slot) = workspaces_by_id.entry(s.workspace_id) {
            match workspaces::repo::get_by_id(&st.db, s.workspace_id).await {
                Ok(ws) => {
                    slot.insert(ws);
                }
                Err(e) => {
                    tracing::warn!("reconciler: cannot load workspace {}: {e}", s.workspace_id);
                    continue;
                }
            }
        }
        let Some(Some(ws)) = workspaces_by_id.get(&s.workspace_id) else {
            continue;
        };
        // Wait for a close / discard of this workstream, then look again.
        let _t = transition_lock(st, s.id).await;
        let current = match repo::get_by_id(&st.db, s.id).await {
            Ok(Some(row)) if row.is_open() => row,
            Ok(_) => continue,
            Err(e) => {
                tracing::warn!("reconciler: cannot reload workstream {}: {e}", s.id);
                continue;
            }
        };
        if let Err(e) = ensure_workstream_running(st, ws, &current).await
            && e.code == "docker_unavailable"
        {
            tracing::warn!("reconciler: Docker is unreachable; trying again next round");
            return;
        }
    }
}

async fn cleanup_stale(st: &AppState) {
    let age = STALE_TRANSIENT_AGE.as_secs() as i64;

    match repo::list_stale_opening(&st.db, age).await {
        Ok(list) => {
            for s in list {
                tracing::info!("reconciler: removing workstream {} stuck in opening", s.id);
                if let Err(e) = remove_objects(st, s.id, s.files_dir.as_deref()).await {
                    tracing::warn!("reconciler: cannot remove objects of {}: {e}", s.id);
                    if e.is_unavailable() {
                        return;
                    }
                    continue;
                }
                if let Err(e) = repo::delete(&st.db, s.id).await {
                    tracing::warn!("reconciler: cannot delete workstream {}: {e}", s.id);
                }
            }
        }
        Err(e) => tracing::warn!("reconciler: cannot list stale workstreams: {e}"),
    }

    match workspaces::repo::list_stale_creating(&st.db, age).await {
        Ok(list) => {
            for ws in list {
                tracing::info!("reconciler: removing workspace {} stuck in creating", ws.id);
                // Removes every object labelled with the workspace, then the row.
                if let Err(e) = workspaces::delete(st, &ws).await {
                    tracing::warn!("reconciler: cannot remove workspace {}: {e}", ws.id);
                    if e.code == "docker_unavailable" {
                        return;
                    }
                }
            }
        }
        Err(e) => tracing::warn!("reconciler: cannot list stale workspaces: {e}"),
    }
}
