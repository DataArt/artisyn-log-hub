//! Remote URL rules (D8, algorithm `workhub-remote-url`): parse a pasted git URL, check it
//! against a connection and build the upstream URL the git proxy talks to.

use super::providers::{AuthMethod, Provider};
use super::template::{self, Vars};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Https,
    Http,
    Ssh,
}

/// A pasted git URL taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUrl {
    pub scheme: Scheme,
    /// User name (`git@…`, `https://user@…`); a password part is dropped.
    pub user: Option<String>,
    /// Lowercased host (IPv6 keeps its brackets).
    pub host: String,
    pub port: Option<u16>,
    /// Repository path without leading `/` and without a trailing `.git`.
    pub path: String,
    /// Whether the URL was the scp form `user@host:path`.
    pub scp: bool,
    /// The path exactly as written (with its leading `/` and `.git`, if any).
    pub raw_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlError {
    NotAGitUrl,
    WrongHost,
    WrongPath,
    TransportMismatch,
    HttpNotAllowed,
}

impl UrlError {
    /// The rule code (rows and logs); the API answers 400 `invalid_remote_url` with [`Self::message`].
    pub fn code(self) -> &'static str {
        match self {
            Self::NotAGitUrl => "not_a_git_url",
            Self::WrongHost => "wrong_host",
            Self::WrongPath => "wrong_path",
            Self::TransportMismatch => "transport_mismatch",
            Self::HttpNotAllowed => "http_not_allowed",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NotAGitUrl => {
                "This is not a git URL. Paste an https://, ssh:// or user@host:path URL."
            }
            Self::WrongHost => "This URL is on a different host than the connection.",
            Self::WrongPath => "This URL does not point to a repository of the connection.",
            Self::TransportMismatch => {
                "Use an SSH URL for an SSH key connection and an http(s) URL for a token connection."
            }
            Self::HttpNotAllowed => "This host needs an https:// URL.",
        }
    }
}

/// The result of [`resolve`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Variables matched from the base URL and the repository path.
    pub vars: Vars,
    /// The URL the git proxy fetches from and pushes to.
    pub upstream_url: String,
    /// The repository's web page, when the provider has one.
    pub web_repo_url: Option<String>,
}

/// Normalises a path: strips leading/trailing `/` and one trailing `.git`; rejects empty
/// paths, empty segments and `.`/`..` segments.
fn clean_path(raw: &str) -> Result<String, UrlError> {
    let p = raw.trim_start_matches('/').trim_end_matches('/');
    let p = p.strip_suffix(".git").unwrap_or(p).trim_end_matches('/');
    if p.is_empty() || p.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return Err(UrlError::NotAGitUrl);
    }
    Ok(p.to_string())
}

fn valid_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty() && inner.chars().all(|c| c.is_ascii_hexdigit() || c == ':');
    }
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Splits `host[:port]` (IPv6 in brackets).
fn host_port(hp: &str) -> Result<(String, Option<u16>), UrlError> {
    let (host, port) = if hp.starts_with('[') {
        let close = hp.find(']').ok_or(UrlError::NotAGitUrl)?;
        match &hp[close + 1..] {
            "" => (&hp[..=close], None),
            rest => (
                &hp[..=close],
                Some(rest.strip_prefix(':').ok_or(UrlError::NotAGitUrl)?),
            ),
        }
    } else {
        match hp.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (hp, None),
        }
    };
    let port = match port {
        Some(p) => Some(
            p.parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or(UrlError::NotAGitUrl)?,
        ),
        None => None,
    };
    let host = host.to_ascii_lowercase();
    if !valid_host(&host) {
        return Err(UrlError::NotAGitUrl);
    }
    Ok((host, port))
}

fn user_part(raw: &str) -> Option<String> {
    let user = raw.split(':').next().unwrap_or("");
    (!user.is_empty()).then(|| user.to_string())
}

/// Parses `https://[user@]host[:port]/path`, `http://…`, `ssh://[user@]host[:port]/path` and
/// the scp form `user@host:path`.
pub fn parse(raw: &str) -> Result<ParsedUrl, UrlError> {
    let s = raw.trim();
    if s.is_empty() || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(UrlError::NotAGitUrl);
    }
    if let Some((scheme, rest)) = s.split_once("://") {
        let scheme = match scheme.to_ascii_lowercase().as_str() {
            "https" => Scheme::Https,
            "http" => Scheme::Http,
            "ssh" => Scheme::Ssh,
            _ => return Err(UrlError::NotAGitUrl),
        };
        if rest.contains(['?', '#']) {
            return Err(UrlError::NotAGitUrl);
        }
        let (authority, raw_path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
        let (user, hp) = match authority.rsplit_once('@') {
            Some((u, hp)) => (user_part(u), hp),
            None => (None, authority),
        };
        let (host, port) = host_port(hp)?;
        return Ok(ParsedUrl {
            scheme,
            user,
            host,
            port,
            path: clean_path(raw_path)?,
            scp: false,
            raw_path: raw_path.to_string(),
        });
    }
    // scp form: user@host:path (a `/` before the `:` would make it a local path).
    let (user, rest) = s.split_once('@').ok_or(UrlError::NotAGitUrl)?;
    let (host, raw_path) = rest.split_once(':').ok_or(UrlError::NotAGitUrl)?;
    if user.is_empty() || user.contains([':', '/']) || host.contains('/') {
        return Err(UrlError::NotAGitUrl);
    }
    let host = host.to_ascii_lowercase();
    if !valid_host(&host) || host.starts_with('[') {
        return Err(UrlError::NotAGitUrl);
    }
    Ok(ParsedUrl {
        scheme: Scheme::Ssh,
        user: Some(user.to_string()),
        host,
        port: None,
        path: clean_path(raw_path)?,
        scp: true,
        raw_path: raw_path.to_string(),
    })
}

/// Host, effective port and path segments of a (validated) base URL.
struct Base {
    url: String,
    host: String,
    port: Option<u16>,
    segments: Vec<String>,
}

fn base_parts(base_url: &str) -> Result<Base, UrlError> {
    let url = url::Url::parse(base_url).map_err(|_| UrlError::WrongHost)?;
    let host = url
        .host_str()
        .ok_or(UrlError::WrongHost)?
        .to_ascii_lowercase();
    Ok(Base {
        url: base_url.trim_end_matches('/').to_string(),
        host,
        port: url.port_or_known_default(),
        segments: url
            .path_segments()
            .map(|s| s.filter(|x| !x.is_empty()).map(str::to_string).collect())
            .unwrap_or_default(),
    })
}

fn default_port(scheme: Scheme) -> u16 {
    match scheme {
        Scheme::Https => 443,
        Scheme::Http => 80,
        Scheme::Ssh => 22,
    }
}

/// The repository path relative to the base path (HTTP(S) URLs).
fn rest_after_base(base: &Base, path: &str) -> Result<String, UrlError> {
    let segs: Vec<&str> = path.split('/').collect();
    if segs.len() <= base.segments.len() || segs.iter().zip(&base.segments).any(|(a, b)| a != b) {
        return Err(UrlError::WrongPath);
    }
    Ok(segs[base.segments.len()..].join("/"))
}

/// Merges `extra` into `vars`; a variable both define must agree (case-insensitively).
fn merge(vars: &mut Vars, extra: Vars) -> Result<(), UrlError> {
    for (k, v) in extra {
        match vars.get(&k) {
            Some(existing) if !existing.eq_ignore_ascii_case(&v) => {
                return Err(UrlError::WrongPath);
            }
            Some(_) => {}
            None => {
                vars.insert(k, v);
            }
        }
    }
    Ok(())
}

/// Checks a parsed URL against a connection (provider, base URL, auth method) and builds the
/// upstream URL.
pub fn resolve(
    p: &Provider,
    base_url: &str,
    auth_method: AuthMethod,
    parsed: &ParsedUrl,
) -> Result<Resolved, UrlError> {
    if parsed.scheme == Scheme::Http && !p.allow_http {
        return Err(UrlError::HttpNotAllowed);
    }
    let base = base_parts(base_url)?;
    let mut vars =
        template::match_template(p.base_template, &base.url).ok_or(UrlError::WrongHost)?;
    let is_http = parsed.scheme != Scheme::Ssh;

    if is_http
        && (parsed.host != base.host
            || Some(parsed.port.unwrap_or(default_port(parsed.scheme))) != base.port)
    {
        return Err(UrlError::WrongHost);
    }

    let Some(ssh) = p.ssh else {
        // Generic: the pasted URL is the upstream; its transport must match the auth method.
        if auth_method.is_ssh() == is_http {
            return Err(UrlError::TransportMismatch);
        }
        let rel = if is_http {
            rest_after_base(&base, &parsed.path)?
        } else {
            if parsed.host != base.host {
                return Err(UrlError::WrongHost);
            }
            parsed.path.clone()
        };
        let matched = template::match_template(p.https_path, &rel).ok_or(UrlError::WrongPath)?;
        merge(&mut vars, matched)?;
        let user = parsed
            .user
            .as_deref()
            .map(|u| format!("{u}@"))
            .unwrap_or_default();
        let port = parsed.port.map(|p| format!(":{p}")).unwrap_or_default();
        let upstream_url = match parsed.scheme {
            Scheme::Ssh if parsed.scp => format!("{user}{}:{}", parsed.host, parsed.raw_path),
            Scheme::Ssh => format!("ssh://{user}{}{port}{}", parsed.host, parsed.raw_path),
            Scheme::Https | Scheme::Http => {
                let scheme = if parsed.scheme == Scheme::Https {
                    "https"
                } else {
                    "http"
                };
                format!("{scheme}://{}{port}{}", parsed.host, parsed.raw_path)
            }
        };
        return Ok(Resolved {
            vars,
            upstream_url,
            web_repo_url: None,
        });
    };

    let ssh_host = ssh
        .host
        .map(str::to_string)
        .unwrap_or_else(|| base.host.clone());
    let matched = if is_http {
        let rel = rest_after_base(&base, &parsed.path)?;
        template::match_template(p.https_path, &rel)
    } else {
        if parsed.host != ssh_host {
            return Err(UrlError::WrongHost);
        }
        template::match_template(ssh.path, &parsed.path)
    }
    .ok_or(UrlError::WrongPath)?;
    merge(&mut vars, matched)?;

    let suffix = if p.git_suffix { ".git" } else { "" };
    let https_rel = template::fill(p.https_path, &vars);
    let upstream_url = if auth_method.is_ssh() {
        let port = match parsed.scheme {
            Scheme::Ssh => parsed.port.unwrap_or(ssh.port),
            _ => ssh.port,
        };
        format!(
            "ssh://{}@{ssh_host}:{port}/{}{suffix}",
            ssh.user,
            template::fill(ssh.path, &vars)
        )
    } else {
        format!("{}/{https_rel}{suffix}", base.url)
    };
    Ok(Resolved {
        vars,
        upstream_url,
        web_repo_url: Some(format!("{}/{https_rel}", base.url)),
    })
}

/// The "open a pull/merge request" page for `branch` into `target`; `None` without one.
pub fn pr_url(
    p: &Provider,
    base_url: &str,
    vars: &Vars,
    target: &str,
    branch: &str,
) -> Option<String> {
    let tmpl = p.pr_url?;
    let mut all = vars.clone();
    all.insert("web".into(), base_url.trim_end_matches('/').to_string());
    all.insert("target".into(), target.to_string());
    all.insert("branch".into(), branch.to_string());
    Some(template::fill(tmpl, &all))
}
