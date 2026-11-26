//! `.claude/` discovery (FR-1): where Claude starts in a shared folder.
//!
//! The engine walks the folder (descending only where [`scan_descends`] allows) and passes every
//! directory it found as a path relative to the shared folder, `/`-separated. This module decides.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-claude-dir.md`.

/// Directory names the scan never enters.
pub const SKIPPED_DIRS: [&str; 2] = [".git", "node_modules"];

/// The marker directory.
pub const CLAUDE_DIR: &str = ".claude";

/// Whether the scan enters a directory with this name. `.claude` itself is not entered either:
/// a `.claude` nested inside another one is configuration, not a start folder.
pub fn scan_descends(dir_name: &str) -> bool {
    !SKIPPED_DIRS.contains(&dir_name) && dir_name != CLAUDE_DIR
}

/// The start-folder candidates: the parent (relative, `""` = the root) of every `.claude`
/// directory in `dirs`, skipping any path that goes through a skipped directory or through
/// another `.claude`. Sorted (byte order) and deduplicated.
pub fn candidates(dirs: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = dirs
        .iter()
        .filter_map(|raw| {
            let segments: Vec<&str> = raw
                .split(['/', '\\'])
                .filter(|s| !s.is_empty() && *s != ".")
                .collect();
            let (last, parents) = segments.split_last()?;
            if *last != CLAUDE_DIR || parents.iter().any(|s| !scan_descends(s)) {
                return None;
            }
            Some(parents.join("/"))
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Where Claude starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeStart {
    /// No `.claude` found: the shared folder's root.
    Root,
    /// This folder (relative, `""` = the root).
    Use(String),
    /// Several found and none remembered: ask the user once, offering these.
    Ask(Vec<String>),
}

/// Decides the start folder from the candidates and the answer remembered for this folder.
pub fn decide(candidates: &[String], remembered: Option<&str>) -> ClaudeStart {
    match candidates {
        [] => ClaudeStart::Root,
        [only] => ClaudeStart::Use(only.clone()),
        many => match remembered {
            Some(r) if many.iter().any(|c| c == r) => ClaudeStart::Use(r.to_string()),
            _ => ClaudeStart::Ask(many.to_vec()),
        },
    }
}
