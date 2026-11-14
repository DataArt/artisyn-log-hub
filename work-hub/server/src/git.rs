//! git argv builders and output parsers. Commands run in a container through
//! `docker::exec::exec_capture`; every argv starts with `git -c core.quotepath=off -C <dir>` (D5).

use std::collections::HashSet;

use sha1::{Digest, Sha1};

/// `git -c core.quotepath=off -C <dir> <args…>`.
pub fn git(dir: &str, args: &[&str]) -> Vec<String> {
    let mut argv: Vec<String> = ["git", "-c", "core.quotepath=off", "-C", dir]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    argv.extend(args.iter().map(|s| (*s).to_string()));
    argv
}

// ---------------------------------------------------------------- status

/// `status --porcelain=v1 -z --untracked-files=all`.
pub fn status_porcelain(dir: &str) -> Vec<String> {
    git(
        dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
}

/// One entry of `status --porcelain=v1 -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Index status (`X`).
    pub index: char,
    /// Work-tree status (`Y`).
    pub worktree: char,
    pub path: String,
    /// The source path of a rename or copy.
    pub orig_path: Option<String>,
}

/// Parses `status --porcelain=v1 -z`: `XY <path>\0`, and for a rename or copy one more
/// `<orig path>\0` field.
pub fn parse_status_z(out: &[u8]) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let index = field[0] as char;
        let worktree = field[1] as char;
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        let orig_path = if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            fields
                .next()
                .map(|f| String::from_utf8_lossy(f).into_owned())
        } else {
            None
        };
        entries.push(StatusEntry {
            index,
            worktree,
            path,
            orig_path,
        });
    }
    entries
}

/// Every path git reports as not committed (sources of renames included), sorted and unique.
pub fn uncommitted_paths(entries: &[StatusEntry]) -> Vec<String> {
    let mut paths: Vec<String> = entries
        .iter()
        .flat_map(|e| std::iter::once(e.path.clone()).chain(e.orig_path.clone()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    paths.sort();
    paths
}

// ---------------------------------------------------------------- refs

/// `for-each-ref --format=%(refname) refs/heads/<prefix>`; `prefix` such as `""` (all branches)
/// or `"ws/"`.
pub fn for_each_branch(dir: &str, prefix: &str) -> Vec<String> {
    let pattern = format!("refs/heads/{prefix}");
    git(dir, &["for-each-ref", "--format=%(refname)", &pattern])
}

/// Branch names from [`for_each_branch`] output (`refs/heads/` stripped), in git's order.
pub fn parse_branches(out: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|l| l.trim().strip_prefix("refs/heads/"))
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .collect()
}

/// `show-ref --verify --quiet refs/heads/<branch>`: exit 0 when the branch exists.
pub fn branch_exists(dir: &str, branch: &str) -> Vec<String> {
    let r = format!("refs/heads/{branch}");
    git(dir, &["show-ref", "--verify", "--quiet", &r])
}

/// `symbolic-ref --quiet --short HEAD`: the checked-out branch (exit ≠ 0 when detached).
pub fn current_branch(dir: &str) -> Vec<String> {
    git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
}

/// `branch -D <branch>`.
pub fn delete_branch(dir: &str, branch: &str) -> Vec<String> {
    git(dir, &["branch", "-D", branch])
}

// ---------------------------------------------------------------- bundles

/// `bundle create - <revs>` to stdout, e.g. `revs = "main..ws/fix"` or `"main"`.
pub fn bundle_create(dir: &str, revs: &str) -> Vec<String> {
    git(dir, &["bundle", "create", "-", revs])
}

/// `true` when `bundle create` refused because there is nothing in the range.
pub fn is_empty_bundle(exit_code: i64, stderr: &str) -> bool {
    exit_code != 0 && stderr.contains("empty bundle")
}

/// `fetch <source> <refspec>`, e.g. `+ws/fix:refs/heads/ws/fix` from a bundle file.
pub fn fetch(dir: &str, source: &str, refspec: &str) -> Vec<String> {
    git(dir, &["fetch", source, refspec])
}

/// `+<src>:refs/heads/<dst>`: a forced fetch into a local branch.
pub fn force_refspec(src: &str, dst: &str) -> String {
    format!("+{src}:refs/heads/{dst}")
}

// ---------------------------------------------------------------- merge

/// `merge --no-ff --no-edit -m <message> <branch>`.
pub fn merge(dir: &str, branch: &str, message: &str) -> Vec<String> {
    git(
        dir,
        &["merge", "--no-ff", "--no-edit", "-m", message, branch],
    )
}

/// `rev-parse -q --verify MERGE_HEAD`: exit 0 while a merge is in progress.
pub fn merge_head(dir: &str) -> Vec<String> {
    git(dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
}

/// `merge --abort`.
pub fn merge_abort(dir: &str) -> Vec<String> {
    git(dir, &["merge", "--abort"])
}

/// What a merge ended with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    Merged,
    /// Stopped on conflicts: `MERGE_HEAD` exists and the merge must be aborted.
    Conflict,
    /// Failed before merging (e.g. local changes in the way); nothing to abort.
    Failed,
}

/// A merge exit ≠ 0 is a conflict when `MERGE_HEAD` exists afterwards ([`merge_head`] exit 0).
pub fn classify_merge(merge_exit: i64, merge_head_exit: Option<i64>) -> MergeOutcome {
    if merge_exit == 0 {
        MergeOutcome::Merged
    } else if merge_head_exit == Some(0) {
        MergeOutcome::Conflict
    } else {
        MergeOutcome::Failed
    }
}

// ---------------------------------------------------------------- worktrees and switching

/// `switch --detach` (frees the branch so a worktree can check it out).
pub fn switch_detach(dir: &str) -> Vec<String> {
    git(dir, &["switch", "--detach"])
}

/// `switch <branch>`.
pub fn switch(dir: &str, branch: &str) -> Vec<String> {
    git(dir, &["switch", branch])
}

/// `worktree add -b <branch> <path> <base>`: a new branch from `base` checked out at `path`.
pub fn worktree_add_new_branch(dir: &str, branch: &str, path: &str, base: &str) -> Vec<String> {
    git(dir, &["worktree", "add", "-b", branch, path, base])
}

/// `worktree add <path> <branch>`: an existing branch checked out at `path`.
pub fn worktree_add(dir: &str, path: &str, branch: &str) -> Vec<String> {
    git(dir, &["worktree", "add", path, branch])
}

/// `worktree remove --force <path>`.
pub fn worktree_remove(dir: &str, path: &str) -> Vec<String> {
    git(dir, &["worktree", "remove", "--force", path])
}

// ---------------------------------------------------------------- versions

/// `hash-object --no-filters -- <paths…>`: one blob sha per line.
pub fn hash_object(dir: &str, paths: &[&str]) -> Vec<String> {
    let mut args = vec!["hash-object", "--no-filters", "--"];
    args.extend_from_slice(paths);
    git(dir, &args)
}

/// The sha lines of [`hash_object`] output.
pub fn parse_hash_object(out: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(out)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// The git blob sha of `bytes`: `sha1("blob <len>\0" + bytes)` in lowercase hex (D12 version).
pub fn blob_sha(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
