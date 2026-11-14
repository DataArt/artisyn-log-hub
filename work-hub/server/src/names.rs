//! Display names and branch names (D8, algorithm `workhub-names`).

use std::collections::HashSet;

pub const MSG_EMPTY: &str = "Enter a name.";
pub const MSG_TOO_LONG: &str = "Use at most 100 characters.";
pub const MSG_CONTROL: &str = "A name cannot contain line breaks or control characters.";
pub const MSG_DUPLICATE_WORKSPACE: &str = "You already have a workspace with this name.";
pub const MSG_DUPLICATE_WORKSTREAM: &str =
    "This workspace already has a workstream with this name.";

/// Most Unicode scalar values in a display name.
pub const MAX_NAME_CHARS: usize = 100;
/// Most chars in a branch slug (before a `-<n>` clash suffix).
pub const MAX_SLUG_CHARS: usize = 50;
/// Prefix of every branch Work Hub creates.
pub const BRANCH_PREFIX: &str = "ws/";
/// Slug used when the name has nothing left after slugging.
pub const EMPTY_SLUG: &str = "work";

/// Validates a workspace or workstream name. `Ok` holds the trimmed name, `Err` the message.
pub fn validate_display_name(raw: &str) -> Result<String, &'static str> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(MSG_EMPTY);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(MSG_TOO_LONG);
    }
    if name.chars().any(is_forbidden_char) {
        return Err(MSG_CONTROL);
    }
    Ok(name.to_string())
}

/// Control characters plus the Unicode line and paragraph separators.
fn is_forbidden_char(c: char) -> bool {
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

/// Uniqueness key of a display name: the trimmed name in lowercase.
pub fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The slug part of a branch: deunicode, lowercase, runs outside `[a-z0-9]` → `-`, trim `-`,
/// cut at 50 chars, trim `-` again, empty → `work`.
pub fn branch_slug(name: &str) -> String {
    let ascii = deunicode::deunicode(name).to_lowercase();
    let mut slug = String::with_capacity(ascii.len());
    let mut in_run = false;
    for c in ascii.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    let cut: String = slug
        .trim_matches('-')
        .chars()
        .take(MAX_SLUG_CHARS)
        .collect();
    let cut = cut.trim_matches('-');
    if cut.is_empty() {
        EMPTY_SLUG.to_string()
    } else {
        cut.to_string()
    }
}

/// `ws/<slug>`, with `-2`, `-3`, … appended while the branch is in `taken` (full branch names
/// such as `ws/fix-login`: the repo's `refs/heads/ws/*` plus every DB branch of the workspace).
pub fn derive_branch(name: &str, taken: &HashSet<String>) -> String {
    let base = format!("{BRANCH_PREFIX}{}", branch_slug(name));
    if !taken.contains(&base) {
        return base;
    }
    (2u32..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or(base)
}
