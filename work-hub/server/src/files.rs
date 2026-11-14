//! File area (FR-5g): every repo and home volume is an ordinary host folder under
//! `WORK_HUB_DATA_DIR`, bind-mounted through a named volume, so a user's files stay readable with
//! ordinary tools when the server or the Docker Engine is down. Layout (relative to the data dir):
//!
//! | Folder | What |
//! |---|---|
//! | `users/<email>/<workspace slug>-<id6>/` | a workspace: `workspace/repo/` (git), `home/`, `workspace.json` |
//! | `<workspace folder>/workstreams/<workstream slug>-<id6>/` | a workstream: `workspace/{repo,worktree}/`, `home/`, `workstream.json` |
//!
//! The server creates the folders itself; their contents are written by the containers (as the
//! container user) and removed by a root helper container, so a server that is not root can
//! still delete files the container user owns.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::json;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::config::Config;
use crate::docker::containers::{self, HelperSpec};
use crate::docker::exec::{HELPER_RUN_TIMEOUT, sh};
use crate::docker::{DockerError, DockerResult};
use crate::names;
use crate::state::AppState;
use crate::workspaces::WorkspaceRow;
use crate::workstreams::repo::WorkstreamRow;

/// Top folder of the file area.
pub const USERS_DIR: &str = "users";
/// The repo volume's folder (mounted at `/workspace`, git checkout in `workspace/repo`) inside a workspace or workstream folder.
pub const WORKSPACE_SUB: &str = "workspace";
/// The home (profile) volume's folder inside a workspace or workstream folder.
pub const HOME_SUB: &str = "home";
/// Metadata files beside `repo/` and `home/`.
pub const WORKSPACE_META: &str = "workspace.json";
pub const WORKSTREAM_META: &str = "workstream.json";

/// The user's folder name: the email, with any character outside `[A-Za-z0-9._@+-]` replaced by
/// `_` (lowercase; never `.` or `..`).
pub fn email_folder(email: &str) -> String {
    let s: String = email
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '+' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() || s.chars().all(|c| c == '.') {
        "_".to_string()
    } else {
        s
    }
}

/// `<slug of the name>-<first 6 hex digits of the id>`.
fn leaf(name: &str, id: Uuid) -> String {
    let hex = id.simple().to_string();
    format!("{}-{}", names::branch_slug(name), &hex[..6])
}

/// `users/<email>/<slug>-<id6>`.
pub fn workspace_dir(email: &str, name: &str, id: Uuid) -> String {
    format!("{USERS_DIR}/{}/{}", email_folder(email), leaf(name, id))
}

/// `<workspace folder>/workstreams/<slug>-<id6>`.
pub fn workstream_dir(workspace_dir: &str, name: &str, id: Uuid) -> String {
    format!("{workspace_dir}/workstreams/{}", leaf(name, id))
}

/// A relative folder the server may create or delete: under `users/`, plain `/`-separated
/// segments, no `.`/`..`, backslash or NUL.
fn is_safe_rel(rel: &str) -> bool {
    let mut parts = rel.split('/');
    parts.next() == Some(USERS_DIR)
        && rel.split('/').count() >= 3
        && rel.split('/').all(|p| {
            !p.is_empty() && p != "." && p != ".." && !p.contains('\\') && !p.contains('\0')
        })
}

/// The folder on this machine.
pub fn host_path(cfg: &Config, rel: &str) -> PathBuf {
    rel.split('/').fold(cfg.data_dir.clone(), |p, s| p.join(s))
}

/// The folder as the Docker Engine sees it (a bind source).
pub fn engine_path(cfg: &Config, rel: &str) -> String {
    format!("{}/{rel}", cfg.engine_data_dir)
}

fn unsafe_rel(rel: &str) -> DockerError {
    DockerError::Failed(format!("refusing the file-area path {rel:?}"))
}

/// Creates `<rel>/workspace` and `<rel>/home` (existing ones are kept).
pub fn prepare(cfg: &Config, rel: &str) -> DockerResult<()> {
    if !is_safe_rel(rel) {
        return Err(unsafe_rel(rel));
    }
    let base = host_path(cfg, rel);
    for sub in [WORKSPACE_SUB, HOME_SUB] {
        std::fs::create_dir_all(base.join(sub))
            .map_err(|e| DockerError::Failed(format!("creating {}: {e}", base.display())))?;
    }
    Ok(())
}

/// True when the folder exists on this machine.
pub fn exists(cfg: &Config, rel: &str) -> bool {
    is_safe_rel(rel) && host_path(cfg, rel).is_dir()
}

/// Deletes the folder `rel` with everything in it: a root helper container from the default
/// image mounts its parent and runs `rm -rf`; what is left (e.g. the folder itself on a host
/// where the helper cannot delete it) is removed by the server. Missing is fine.
pub async fn remove(st: &AppState, labels: HashMap<String, String>, rel: &str) -> DockerResult<()> {
    if !is_safe_rel(rel) {
        return Err(unsafe_rel(rel));
    }
    let host = host_path(&st.config, rel);
    if !host.exists() {
        return Ok(());
    }
    let (parent, leaf) = rel.rsplit_once('/').ok_or_else(|| unsafe_rel(rel))?;
    let mut cmd = sh("rm -rf -- \"/parent/$1\"");
    cmd.push("sh".into());
    cmd.push(leaf.to_string());
    let spec = HelperSpec {
        image: st.config.default_image.clone(),
        user: Some("0".into()),
        cmd,
        volumes: vec![],
        binds: vec![(
            engine_path(&st.config, parent),
            "/parent".to_string(),
            false,
        )],
        labels,
    };
    containers::run_helper(&st.docker, &spec, HELPER_RUN_TIMEOUT)
        .await?
        .check()?;
    match tokio::fs::remove_dir_all(&host).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(DockerError::Failed(format!(
            "removing {}: {e}",
            host.display()
        ))),
    }
}

/// Bytes the files under `path` take (symlinks not followed; unreadable entries are skipped,
/// e.g. a 0700 home of another uid when the server is not root).
pub fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// Deletes `paths` (relative, plain segments) inside the folder `rel` with a root helper
/// container, e.g. the agent's restorable caches in a closed workstream's home. Missing is fine.
pub async fn prune(
    st: &AppState,
    labels: HashMap<String, String>,
    rel: &str,
    paths: &[&str],
) -> DockerResult<()> {
    if !is_safe_rel(rel) {
        return Err(unsafe_rel(rel));
    }
    let safe = |p: &str| {
        !p.is_empty()
            && !p.starts_with('/')
            && p.split('/').all(|s| {
                !s.is_empty() && s != "." && s != ".." && !s.contains('\\') && !s.contains('\0')
            })
    };
    if let Some(bad) = paths.iter().find(|p| !safe(p)) {
        return Err(unsafe_rel(bad));
    }
    if paths.is_empty() || !host_path(&st.config, rel).is_dir() {
        return Ok(());
    }
    let mut cmd = sh("cd /target && rm -rf -- \"$@\"");
    cmd.push("sh".into());
    cmd.extend(paths.iter().map(|p| (*p).to_string()));
    let spec = HelperSpec {
        image: st.config.default_image.clone(),
        user: Some("0".into()),
        cmd,
        volumes: vec![],
        binds: vec![(engine_path(&st.config, rel), "/target".to_string(), false)],
        labels,
    };
    containers::run_helper(&st.docker, &spec, HELPER_RUN_TIMEOUT)
        .await?
        .check()?;
    Ok(())
}

/// Empties `<rel>/<sub>` (deletes and recreates it).
pub async fn reset_sub(
    st: &AppState,
    labels: HashMap<String, String>,
    rel: &str,
    sub: &str,
) -> DockerResult<()> {
    let path = format!("{rel}/{sub}");
    remove(st, labels, &path).await?;
    std::fs::create_dir_all(host_path(&st.config, &path))
        .map_err(|e| DockerError::Failed(format!("creating {path}: {e}")))?;
    Ok(())
}

fn ts(t: Option<time::OffsetDateTime>) -> serde_json::Value {
    t.and_then(|t| t.format(&Rfc3339).ok())
        .map_or(serde_json::Value::Null, serde_json::Value::String)
}

fn write_json(cfg: &Config, rel: &str, file: &str, value: serde_json::Value) {
    if !is_safe_rel(rel) {
        return;
    }
    let path = host_path(cfg, rel).join(file);
    let text = serde_json::to_string_pretty(&value).unwrap_or_default() + "\n";
    if let Err(e) = std::fs::write(&path, text) {
        tracing::warn!("cannot write {}: {e}", path.display());
    }
}

/// Writes `workspace.json` (name, owner, working branch, dates); failures are only logged.
pub fn write_workspace_meta(cfg: &Config, ws: &WorkspaceRow, owner_email: &str) {
    let Some(rel) = ws.files_dir.as_deref() else {
        return;
    };
    write_json(
        cfg,
        rel,
        WORKSPACE_META,
        json!({
            "id": ws.id,
            "name": ws.name,
            "owner": owner_email,
            "workingBranch": ws.working_branch,
            "createdAt": ts(Some(ws.created_at)),
            "repo": "workspace/repo",
            "home": HOME_SUB,
        }),
    );
}

/// Writes `workstream.json` (name, branches, state, dates); failures are only logged.
pub fn write_workstream_meta(cfg: &Config, s: &WorkstreamRow) {
    let Some(rel) = s.files_dir.as_deref() else {
        return;
    };
    write_json(
        cfg,
        rel,
        WORKSTREAM_META,
        json!({
            "id": s.id,
            "workspaceId": s.workspace_id,
            "name": s.name,
            "branch": s.branch,
            "baseBranch": s.base_branch,
            "state": s.state,
            "openedAt": ts(Some(s.opened_at)),
            "closedAt": ts(s.closed_at),
            "mergedAt": ts(s.merged_at),
            "discardedAt": ts(s.discarded_at),
            "files": "workspace/worktree",
            "home": HOME_SUB,
        }),
    );
}
