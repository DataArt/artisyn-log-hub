//! Effective `core.autocrlf` (FR-3): the value the tool writes into the laptop's global git
//! config so git inside sees the shared working tree the way the host's git does.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-autocrlf.md`.

/// A host git config value as git reads it: `true`/`yes`/`on`/`1` → `true`,
/// `false`/`no`/`off`/`0` → `false`, `input` → `input` (case-insensitive, trimmed). Anything else,
/// the empty value included, counts as not set.
pub fn normalize(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some("true"),
        "false" | "no" | "off" | "0" => Some("false"),
        "input" => Some("input"),
        _ => None,
    }
}

/// The effective value.
///
/// 1. The host has no git: `true` on Windows, `input` elsewhere (macOS).
/// 2. Else the host's global value, when set and valid.
/// 3. Else the host's system value, when set and valid.
/// 4. Else git's own default, `false`.
pub fn effective(
    global: Option<&str>,
    system: Option<&str>,
    host_has_git: bool,
    windows: bool,
) -> &'static str {
    if !host_has_git {
        return if windows { "true" } else { "input" };
    }
    global
        .and_then(normalize)
        .or_else(|| system.and_then(normalize))
        .unwrap_or("false")
}
