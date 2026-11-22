//! Field rules of connections and remotes (D9, algorithm `workhub-connection-fields`).
//! Uniqueness (connection names, remote names, expose names) is checked by the services against
//! the database; these are the per-value shape rules.

use super::providers::{AuthMethod, Provider};
use super::template;

/// Most characters in a PAT.
pub const MAX_PAT_CHARS: usize = 4096;
/// Most bytes in an uploaded private key.
pub const MAX_KEY_BYTES: usize = 16 * 1024;
/// Most characters in an exposed env variable name.
pub const MAX_ENV_CHARS: usize = 64;
/// Most characters in a remote name.
pub const MAX_REMOTE_CHARS: usize = 64;
/// Env names a connection can never expose.
pub const RESERVED_ENV: [&str; 8] = [
    "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "PWD", "HOSTNAME",
];
/// Prefix of Work Hub's own env variables.
pub const WH_ENV_PREFIX: &str = "WH_";

/// A rejected field value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldError {
    /// The base URL is not an absolute URL.
    BaseUrlNotUrl,
    /// The base URL scheme is not https (or http where the provider allows it).
    BaseUrlScheme,
    /// The base URL has a query, a fragment or user info.
    BaseUrlExtra,
    /// The base URL does not have the provider's form.
    BaseUrlForm,
    RemoteName,
    Pat,
    PrivateKey,
    EnvName,
    ExposeNotAllowed,
}

impl FieldError {
    /// The fine-grained rule code (algorithm rows).
    pub fn rule(self) -> &'static str {
        match self {
            Self::BaseUrlNotUrl => "base_url_not_url",
            Self::BaseUrlScheme => "base_url_scheme",
            Self::BaseUrlExtra => "base_url_extra",
            Self::BaseUrlForm => "base_url_form",
            Self::RemoteName => "remote_name",
            Self::Pat => "pat",
            Self::PrivateKey => "private_key",
            Self::EnvName => "env_name",
            Self::ExposeNotAllowed => "expose_not_allowed",
        }
    }

    /// The API error code (400).
    pub fn code(self) -> &'static str {
        match self {
            Self::RemoteName => "invalid_remote_name",
            Self::EnvName => "invalid_env_name",
            Self::ExposeNotAllowed => "expose_not_allowed",
            _ => "invalid_connection",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::BaseUrlNotUrl => {
                "Enter the full server address, for example https://git.example.com."
            }
            Self::BaseUrlScheme => "The server address must start with https://.",
            Self::BaseUrlExtra => {
                "The server address cannot have a user name, a ?query or a #fragment."
            }
            Self::BaseUrlForm => "This is not a server address of this provider.",
            Self::RemoteName => {
                "Use letters, digits, '.', '_' or '-' (at most 64, not ending in .lock)."
            }
            Self::Pat => "Paste the token: 1 to 4096 characters, no spaces or line breaks.",
            Self::PrivateKey => "Paste a private key that begins with -----BEGIN (at most 16 KiB).",
            Self::EnvName => {
                "Use an upper-case variable name not used by the system, the agent or Work Hub."
            }
            Self::ExposeNotAllowed => "Only a token connection can be exposed as a variable.",
        }
    }
}

/// Checks and normalises a base URL (trailing `/` stripped). A provider with a fixed base URL
/// takes it when `raw` is empty and accepts nothing else.
pub fn validate_base_url(p: &Provider, raw: &str) -> Result<String, FieldError> {
    let raw = raw.trim();
    if let Some(fixed) = p.base_fixed
        && (raw.is_empty() || raw.trim_end_matches('/').eq_ignore_ascii_case(fixed))
    {
        return Ok(fixed.to_string());
    }
    let url = url::Url::parse(raw).map_err(|_| FieldError::BaseUrlNotUrl)?;
    match url.scheme() {
        "https" => {}
        "http" if p.allow_http => {}
        _ => return Err(FieldError::BaseUrlScheme),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(FieldError::BaseUrlNotUrl);
    }
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(FieldError::BaseUrlExtra);
    }
    let normalized = url.as_str().trim_end_matches('/').to_string();
    if template::match_template(p.base_template, &normalized).is_none() {
        return Err(FieldError::BaseUrlForm);
    }
    Ok(normalized)
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, not ending in `.lock`.
pub fn validate_remote_name(name: &str) -> Result<(), FieldError> {
    let mut chars = name.chars();
    let ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && name.len() <= MAX_REMOTE_CHARS
        && !name.ends_with(".lock");
    if ok {
        Ok(())
    } else {
        Err(FieldError::RemoteName)
    }
}

/// 1–4096 characters, no whitespace or control characters.
pub fn validate_pat(pat: &str) -> Result<(), FieldError> {
    let n = pat.chars().count();
    if (1..=MAX_PAT_CHARS).contains(&n) && !pat.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        Ok(())
    } else {
        Err(FieldError::Pat)
    }
}

/// Begins with `-----BEGIN` (leading whitespace allowed) and is at most 16 KiB.
pub fn validate_private_key(key: &str) -> Result<(), FieldError> {
    if key.len() <= MAX_KEY_BYTES && key.trim_start().starts_with("-----BEGIN") {
        Ok(())
    } else {
        Err(FieldError::PrivateKey)
    }
}

/// `^[A-Z_][A-Z0-9_]*$`, at most 64 characters.
pub fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && name.len() <= MAX_ENV_CHARS
}

/// An exposed env name: only for PAT connections, a valid name, not reserved, not `WH_*` and
/// not any agent's token variable (`agent_envs`).
pub fn validate_expose_env(
    name: &str,
    method: AuthMethod,
    agent_envs: &[&str],
) -> Result<(), FieldError> {
    if method != AuthMethod::Pat {
        return Err(FieldError::ExposeNotAllowed);
    }
    if !is_env_name(name)
        || RESERVED_ENV.contains(&name)
        || name.starts_with(WH_ENV_PREFIX)
        || agent_envs.contains(&name)
    {
        return Err(FieldError::EnvName);
    }
    Ok(())
}
