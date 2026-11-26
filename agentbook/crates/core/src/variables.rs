//! Variables (FR-12): which names start Hidden, valid names, credential-store names, the
//! effective value of each variable for one laptop, and the session env file that delivers them.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-variables.md`.

use crate::state::{VarSetting, VarValue};

/// A name containing one of these (case-insensitive) starts Hidden.
pub const HIDDEN_SUBSTRINGS: [&str; 4] = ["TOKEN", "SECRET", "PASSWORD", "KEY"];

/// A name with one of these as a whole word (between non-alphanumeric characters or the ends)
/// starts Hidden. `PAT` is a word, not a substring, so `PATH`, `PATCH` and `COMPAT` stay plain.
pub const HIDDEN_WORDS: [&str; 1] = ["PAT"];

/// Prefix of every credential-store entry of the installed tool.
pub const CREDENTIAL_PREFIX: &str = "AgentBook/";

/// Whether a variable with this name starts Hidden in the Variables dialog.
pub fn starts_hidden(name: &str) -> bool {
    let upper = name.to_uppercase();
    HIDDEN_SUBSTRINGS.iter().any(|w| upper.contains(w))
        || upper
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| HIDDEN_WORDS.contains(&word))
}

/// `[A-Za-z_][A-Za-z0-9_]*`: the names the env file can carry and the dialog accepts.
pub fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The credential-store entry of a Hidden value: `<prefix><folderId>/<NAME>` folder-wide,
/// `<prefix><folderId>/<laptopId>/<NAME>` for "Only for one laptop". `prefix` is
/// [`CREDENTIAL_PREFIX`], or the scenario stand's own prefix.
pub fn credential_target(
    prefix: &str,
    folder_id: &str,
    laptop_id: Option<&str>,
    name: &str,
) -> String {
    match laptop_id {
        Some(lid) => format!("{prefix}{folder_id}/{lid}/{name}"),
        None => format!("{prefix}{folder_id}/{name}"),
    }
}

/// Where a variable's effective value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarSource {
    /// The devcontainer's `containerEnv` / `remoteEnv`.
    Project,
    /// The folder-wide setting.
    Folder,
    /// The "Only for one laptop" setting.
    Laptop,
}

impl VarSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Folder => "folder",
            Self::Laptop => "laptop",
        }
    }
}

/// One variable as a laptop sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveVar {
    pub name: String,
    /// `Hidden`: the engine reads the value from the credential store entry of `source`.
    pub value: VarValue,
    pub source: VarSource,
    /// `false` for a project default built from `${containerEnv:…}` (e.g. a `PATH` addition):
    /// delivered, but not listed in the Variables dialog.
    pub editable: bool,
    /// The effective value is an empty plain value: the card shows "needs a value".
    pub needs_value: bool,
}

/// Replaces every `${containerEnv:NAME}` / `${containerEnv:NAME:default}` in `value` with the
/// container's value of `NAME`, else the default, else nothing. Other `${…}` stay as they are.
pub fn resolve_container_env_refs(value: &str, container_env: &[(String, String)]) -> String {
    const OPEN: &str = "${containerEnv:";
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let Some(end) = after.find('}') else {
            break;
        };
        out.push_str(&rest[..start]);
        let inner = &after[..end];
        let (name, default) = match inner.split_once(':') {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        let found = container_env
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str());
        out.push_str(found.or(default).unwrap_or(""));
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The effective variables of one laptop.
///
/// 1. Project defaults in order (`containerEnv` entries, then `remoteEnv`); a later entry of the
///    same name replaces the value and keeps the first position. A value with `${containerEnv:`
///    is resolved against `container_env` and is not editable.
/// 2. Folder settings replace the value of the same name, or are appended.
/// 3. Laptop settings replace the value of the same name, or are appended.
/// 4. `needs_value` = the effective value is `Plain("")`.
pub fn resolve(
    defaults: &[(String, String)],
    container_env: &[(String, String)],
    folder: &[VarSetting],
    laptop: &[VarSetting],
) -> Vec<EffectiveVar> {
    let mut out: Vec<EffectiveVar> = Vec::new();
    let mut put = |name: &str, value: VarValue, source: VarSource, editable: bool| match out
        .iter_mut()
        .find(|v| v.name == name)
    {
        Some(existing) => {
            existing.value = value;
            existing.source = source;
            existing.editable = editable;
        }
        None => out.push(EffectiveVar {
            name: name.to_string(),
            value,
            source,
            editable,
            needs_value: false,
        }),
    };
    for (name, value) in defaults {
        if value.contains("${containerEnv:") {
            let resolved = resolve_container_env_refs(value, container_env);
            put(name, VarValue::Plain(resolved), VarSource::Project, false);
        } else {
            put(
                name,
                VarValue::Plain(value.clone()),
                VarSource::Project,
                true,
            );
        }
    }
    for s in folder {
        put(&s.name, s.value.clone(), VarSource::Folder, true);
    }
    for s in laptop {
        put(&s.name, s.value.clone(), VarSource::Laptop, true);
    }
    for v in &mut out {
        v.needs_value = matches!(&v.value, VarValue::Plain(s) if s.is_empty());
    }
    out
}

/// The session env file `/run/agentbook/env/session.env`: one `NAME='value'` line per variable,
/// `'` written as `'\''`, newlines kept inside the quotes. Names that are not valid
/// ([`is_valid_name`]) are left out. The format is fixed: an older layer's `session.sh` sources it.
pub fn render_env_file(vars: &[(String, String)]) -> String {
    vars.iter()
        .filter(|(name, _)| is_valid_name(name))
        .map(|(name, value)| format!("{name}='{}'\n", value.replace('\'', r"'\''")))
        .collect()
}
