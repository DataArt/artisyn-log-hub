//! The git repos of a shared folder as the folder cards show them ("repo-a: feature/q3"): the
//! folder itself and its direct subfolders that have a `.git`, with the branch read from
//! `HEAD`. Only files are read (no `git` process), so it is cheap enough for every refresh.

use std::path::{Path, PathBuf};

use agentbook_core::claude_dir::SKIPPED_DIRS;

/// One repo in a shared folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoView {
    /// The folder's name (the shared folder's own name when it is the repo).
    pub name: String,
    /// The branch, a short commit id when detached, `None` when `HEAD` is unreadable.
    pub branch: Option<String>,
}

/// At most this many repos are listed per folder.
const MAX_REPOS: usize = 50;

/// The `.git` folder of `dir` (also a worktree's or submodule's `gitdir:` file).
fn git_dir(dir: &Path) -> Option<PathBuf> {
    let dot_git = dir.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.trim().strip_prefix("gitdir:")?.trim();
    let target = Path::new(target);
    Some(if target.is_absolute() {
        target.to_path_buf()
    } else {
        dir.join(target)
    })
}

/// The branch named by a `HEAD` file's text.
pub fn branch_from_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        return Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string());
    }
    if head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(head[..7].to_string());
    }
    None
}

fn repo(dir: &Path, name: String) -> Option<RepoView> {
    let git = git_dir(dir)?;
    let branch = std::fs::read_to_string(git.join("HEAD"))
        .ok()
        .and_then(|h| branch_from_head(&h));
    Some(RepoView { name, branch })
}

/// The repos of the shared folder at `root`, the folder itself first, then by name.
pub fn scan(root: &Path) -> Vec<RepoView> {
    let mut out = Vec::new();
    let own_name = agentbook_core::paths::host_basename(&root.to_string_lossy());
    if let Some(r) = repo(root, own_name) {
        out.push(r);
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    let mut subs: Vec<RepoView> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
                return None;
            }
            repo(&e.path(), name)
        })
        .collect();
    subs.sort_by_key(|r| r.name.to_lowercase());
    out.extend(subs);
    out.truncate(MAX_REPOS);
    out
}
