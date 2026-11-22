//! Server-driven checks of a connection against its git host (plan D14 Test, D11a branches)
//! and the one writer of the connection status (D1 item 9). Every check runs in the git proxy
//! sidecar, so these need a ready proxy (503 `git_proxy_not_ready` otherwise).

use uuid::Uuid;

use super::providers::{self, AuthMethod, Provider};
use super::remote_url::{self, Resolved, Scheme};
use super::repo::{self, ConnectionRow};
use crate::auth::users::UserRow;
use crate::error::ApiError;
use crate::gitproxy::{self, Outcome, ctl};
use crate::state::{AppState, ProxyStatus};

/// Most characters kept in `status_detail` / a test message.
const MAX_DETAIL_CHARS: usize = 500;

/// The `result` of a connection Test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestKind {
    Ok,
    HostKeyUnknown,
    HostKeyChanged,
    Rejected,
    Failed,
}

impl TestKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::HostKeyUnknown => "host_key_unknown",
            Self::HostKeyChanged => "host_key_changed",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }
}

/// A scanned SSH host key shown for pinning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey {
    pub fingerprint: String,
    pub key_type: String,
}

/// The answer of `POST /connections/{id}/test` (API `TestResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestResult {
    pub result: TestKind,
    /// The user the host authenticated, when it said.
    pub user: Option<String>,
    pub message: Option<String>,
    pub host_key: Option<HostKey>,
}

/// The branches of a repository (API `Branches`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Branches {
    pub default_branch: Option<String>,
    pub branches: Vec<String>,
}

fn cut(s: &str) -> String {
    s.trim().chars().take(MAX_DETAIL_CHARS).collect()
}

/// The UI sentence of a non-ok outcome of connection `name`.
pub fn outcome_message(name: &str, outcome: &Outcome) -> Option<String> {
    match outcome {
        Outcome::Ok => None,
        Outcome::Rejected => Some(format!(
            "The host rejected the connection {name}. Update its key or token in Connections."
        )),
        Outcome::HostKeyChanged => Some(format!(
            "The host key of the git host of {name} changed. Check it and pin it again with Test."
        )),
        Outcome::Failed(m) if m.trim().is_empty() => {
            Some(format!("The git host of {name} could not be reached."))
        }
        Outcome::Failed(m) => Some(cut(m)),
    }
}

/// Stores the outcome of a server-driven operation as the connection status (D1 item 9):
/// `status`, `status_detail`, `status_user`, `status_at`. An ok outcome without a `user` keeps the
/// user stored before. Failures are logged, never returned.
pub async fn record_outcome(st: &AppState, conn_id: Uuid, outcome: &Outcome, user: Option<&str>) {
    let res = async {
        let Some(row) = repo::get_by_id(&st.db, conn_id).await? else {
            return Ok(());
        };
        let status_user = match (outcome, user) {
            (Outcome::Ok, Some(u)) => Some(u.to_string()),
            (Outcome::Ok, None) => row.status_user.clone(),
            _ => None,
        };
        let detail = outcome_message(&row.name, outcome);
        repo::set_status(
            &st.db,
            conn_id,
            outcome.as_status(),
            detail.as_deref(),
            status_user.as_deref(),
        )
        .await
    }
    .await;
    if let Err(e) = res {
        tracing::warn!("connection {conn_id}: status not stored: {e}");
    }
}

fn require_ready_status(status: &ProxyStatus) -> Result<(), ApiError> {
    if *status == ProxyStatus::Ok {
        Ok(())
    } else {
        Err(ApiError::git_proxy_not_ready())
    }
}

pub(crate) async fn require_ready(st: &AppState) -> Result<(), ApiError> {
    require_ready_status(&*st.git_proxy.status.read().await)
}

pub(crate) fn provider_and_method(
    row: &ConnectionRow,
) -> Result<(&'static Provider, AuthMethod), ApiError> {
    let p = providers::get(&row.provider)
        .ok_or_else(|| ApiError::internal(format!("connection {}: unknown provider", row.id)))?;
    let m = AuthMethod::parse(&row.auth_method)
        .ok_or_else(|| ApiError::internal(format!("connection {}: unknown auth method", row.id)))?;
    Ok((p, m))
}

/// Parses `url` and checks it against the connection (400 `invalid_remote_url`).
pub fn resolve_url(
    row: &ConnectionRow,
    p: &Provider,
    method: AuthMethod,
    url: &str,
) -> Result<(remote_url::ParsedUrl, Resolved), ApiError> {
    let parsed = remote_url::parse(url).map_err(|e| ApiError::invalid_remote_url(e.message()))?;
    let resolved = remote_url::resolve(p, &row.base_url, method, &parsed)
        .map_err(|e| ApiError::invalid_remote_url(e.message()))?;
    Ok((parsed, resolved))
}

/// The SSH endpoint `(user, host, port)` of a connection: the descriptor's SSH host (or the
/// base host); for a provider without one, the host of the pasted URL.
fn ssh_endpoint(
    row: &ConnectionRow,
    p: &Provider,
    parsed: Option<&remote_url::ParsedUrl>,
) -> Result<(String, String, u16), ApiError> {
    let ssh_url = parsed.filter(|u| u.scheme == Scheme::Ssh);
    if let Some(rule) = p.ssh {
        let host = match rule.host {
            Some(h) => h.to_string(),
            None => url::Url::parse(&row.base_url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
                .ok_or_else(|| {
                    ApiError::internal(format!("connection {}: bad base URL", row.id))
                })?,
        };
        let port = ssh_url.and_then(|u| u.port).unwrap_or(rule.port);
        return Ok((rule.user.to_string(), host, port));
    }
    let u = ssh_url.ok_or_else(|| {
        ApiError::invalid_remote_url("Enter the SSH URL of a repository to test this connection.")
    })?;
    Ok((
        u.user.clone().unwrap_or_else(|| "git".to_string()),
        u.host.clone(),
        u.port.unwrap_or(22),
    ))
}

/// One scanned key: its known_hosts line, type and fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScannedKey {
    pub line: String,
    pub key_type: String,
    pub fingerprint: String,
}

/// Pairs the known_hosts lines of `scan` with its `FINGERPRINT <type> <fp>` lines (same order).
pub(crate) fn parse_scan(out: &str) -> Vec<ScannedKey> {
    let mut lines = Vec::new();
    let mut fps = Vec::new();
    for l in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(rest) = l.strip_prefix("FINGERPRINT ") {
            let mut parts = rest.split_whitespace();
            if let (Some(t), Some(f)) = (parts.next(), parts.next()) {
                fps.push((t.to_string(), f.to_string()));
            }
        } else {
            lines.push(l.to_string());
        }
    }
    lines
        .into_iter()
        .zip(fps)
        .map(|(line, (key_type, fingerprint))| ScannedKey {
            line,
            key_type,
            fingerprint,
        })
        .collect()
}

/// The key to pin: the ed25519 one, else the first.
pub(crate) fn preferred_key(keys: &[ScannedKey]) -> Option<&ScannedKey> {
    keys.iter()
        .find(|k| k.key_type == "ssh-ed25519")
        .or_else(|| keys.first())
}

/// Splits `test-ssh` output into the text and the `EXIT <code>` of ssh.
fn split_exit(out: &str) -> (String, Option<i64>) {
    let mut text: Vec<&str> = out.lines().collect();
    let code = match text.last().and_then(|l| l.trim().strip_prefix("EXIT ")) {
        Some(c) => {
            let code = c.trim().parse().ok();
            text.pop();
            code
        }
        None => None,
    };
    (text.join("\n"), code)
}

/// The outcome of `test-ssh`: the greeting gives the user; without a greeting, any answer of
/// the host that is not an ssh error (exit 255) counts as authenticated.
fn ssh_outcome(p: &Provider, out: &str) -> (Outcome, Option<String>) {
    let (text, code) = split_exit(out);
    if p.ssh_greeting.is_some()
        && let Some(user) = text
            .lines()
            .find_map(|l| providers::greeting_user(p, l.trim()))
    {
        return (Outcome::Ok, Some(user));
    }
    let failed = gitproxy::classify(&text);
    match failed {
        Outcome::HostKeyChanged | Outcome::Rejected => (failed, None),
        _ if p.ssh_greeting.is_none() && code.is_some_and(|c| c != 255) => (Outcome::Ok, None),
        other => (other, None),
    }
}

/// Splits `test-http` output into the body and the HTTP code.
fn split_http(out: &str) -> (String, Option<u16>) {
    match out.rsplit_once("\nHTTP ") {
        Some((body, code)) => (body.to_string(), code.trim().parse().ok()),
        None => match out.strip_prefix("HTTP ") {
            Some(code) => (String::new(), code.trim().parse().ok()),
            None => (out.to_string(), None),
        },
    }
}

/// The value at a dotted path of a JSON document, as text.
fn json_field(body: &str, path: &str) -> Option<String> {
    let mut v: serde_json::Value = serde_json::from_str(body).ok()?;
    for key in path.split('.') {
        v = v.get(key)?.clone();
    }
    match v {
        serde_json::Value::String(s) if !s.is_empty() => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The API test of a PAT connection.
async fn api_check(
    st: &AppState,
    row: &ConnectionRow,
    p: &Provider,
) -> Result<(Outcome, Option<String>), ApiError> {
    let Some((url, _)) = providers::api_request(p, &row.base_url, "") else {
        return Ok((Outcome::Ok, None));
    };
    let id = row.id.to_string();
    let out = ctl::ctl(st, &["test-http", &id, &url], None, ctl::CTL_TIMEOUT).await?;
    if !out.success() {
        let text = format!("{}\n{}", out.stdout_str(), out.stderr_str());
        return Ok((gitproxy::classify(&text), None));
    }
    let (body, code) = split_http(&out.stdout_str());
    Ok(match code {
        Some(200..=299) => (
            Outcome::Ok,
            p.api_test.and_then(|t| json_field(&body, t.user_field)),
        ),
        Some(401 | 403) => (Outcome::Rejected, None),
        Some(c) => (
            Outcome::Failed(format!("The host answered HTTP {c}.")),
            None,
        ),
        None => (
            Outcome::Failed("The host gave no answer.".to_string()),
            None,
        ),
    })
}

/// `ls-remote` of an upstream URL through the sidecar.
pub(crate) async fn ls_remote(
    st: &AppState,
    conn_id: Uuid,
    upstream: &str,
) -> Result<Result<String, Outcome>, ApiError> {
    let id = conn_id.to_string();
    let out = ctl::ctl(st, &["ls-remote", &id, upstream], None, ctl::CTL_TIMEOUT).await?;
    if out.success() {
        Ok(Ok(out.stdout_str()))
    } else {
        Ok(Err(gitproxy::classify(&format!(
            "{}\n{}",
            out.stdout_str(),
            out.stderr_str()
        ))))
    }
}

pub(crate) fn test_result(name: &str, outcome: &Outcome, user: Option<String>) -> TestResult {
    let result = match outcome {
        Outcome::Ok => TestKind::Ok,
        Outcome::Rejected => TestKind::Rejected,
        Outcome::HostKeyChanged => TestKind::HostKeyChanged,
        Outcome::Failed(_) => TestKind::Failed,
    };
    TestResult {
        result,
        user,
        message: outcome_message(name, outcome),
        host_key: None,
    }
}

/// Tests a connection (D14). For an SSH method without a pinned host key (or with
/// `accept_host_key`) the host key is scanned first: without `accept_host_key` the answer is
/// `host_key_unknown` with the key; with it, the key is pinned when the fingerprint matches (else
/// 400 `host_key_mismatch`). Then the check: the API test (PAT), `ssh -T` (SSH with a descriptor
/// SSH host) and, when a URL is given or the provider needs one, `ls-remote` of it. The outcome
/// is stored as the connection status; `host_key_unknown` leaves it unchanged.
pub async fn test(
    st: &AppState,
    user: &UserRow,
    id: Uuid,
    url: Option<&str>,
    accept_host_key: Option<&str>,
) -> Result<TestResult, ApiError> {
    let mut row = repo::get_owned(&st.db, user.id, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let (p, method) = provider_and_method(&row)?;
    let url = url.map(str::trim).filter(|u| !u.is_empty());
    let target = match url {
        Some(u) => Some(resolve_url(&row, p, method, u)?),
        None if p.test_needs_url => {
            return Err(ApiError::invalid_remote_url(
                "Enter the URL of a repository to test this connection.",
            ));
        }
        None => None,
    };
    require_ready(st).await?;

    let accept = accept_host_key.map(str::trim).filter(|a| !a.is_empty());
    let ssh = if method.is_ssh() {
        Some(ssh_endpoint(
            &row,
            p,
            target.as_ref().map(|(parsed, _)| parsed),
        )?)
    } else {
        None
    };
    if let Some((_, host, port)) = &ssh
        && (row
            .known_hosts
            .as_deref()
            .is_none_or(|k| k.trim().is_empty())
            || accept.is_some())
    {
        let port_s = port.to_string();
        let out = ctl::ctl(st, &["scan", host, &port_s], None, ctl::CTL_TIMEOUT).await?;
        let keys = if out.success() {
            parse_scan(&out.stdout_str())
        } else {
            Vec::new()
        };
        let Some(key) = preferred_key(&keys) else {
            let outcome =
                Outcome::Failed(format!("No SSH host key was received from {host}:{port}."));
            record_outcome(st, id, &outcome, None).await;
            return Ok(test_result(&row.name, &outcome, None));
        };
        let Some(fp) = accept else {
            return Ok(TestResult {
                result: TestKind::HostKeyUnknown,
                user: None,
                message: None,
                host_key: Some(HostKey {
                    fingerprint: key.fingerprint.clone(),
                    key_type: key.key_type.clone(),
                }),
            });
        };
        if fp != key.fingerprint {
            return Err(ApiError::host_key_mismatch());
        }
        repo::set_host_key(&st.db, id, &key.line, &key.fingerprint).await?;
        gitproxy::sync_connection(st, id).await?;
        row.known_hosts = Some(key.line.clone());
        row.host_key_fingerprint = Some(key.fingerprint.clone());
    }

    let (mut outcome, mut host_user) = (Outcome::Ok, None);
    if method == AuthMethod::Pat && p.api_test.is_some() {
        (outcome, host_user) = api_check(st, &row, p).await?;
    } else if let (Some((ssh_user, host, port)), Some(_)) = (&ssh, p.ssh) {
        let (cid, port_s) = (id.to_string(), port.to_string());
        let out = ctl::ctl(
            st,
            &["test-ssh", &cid, ssh_user, host, &port_s],
            None,
            ctl::CTL_TIMEOUT,
        )
        .await?;
        if out.stdout.is_empty() && !out.success() {
            outcome = Outcome::Failed(out.stderr_str().trim().to_string());
        } else {
            (outcome, host_user) = ssh_outcome(p, &out.stdout_str());
        }
    }
    if outcome == Outcome::Ok
        && let Some((_, resolved)) = &target
        && let Err(failed) = ls_remote(st, id, &resolved.upstream_url).await?
    {
        outcome = failed;
    }
    record_outcome(st, id, &outcome, host_user.as_deref()).await;
    Ok(test_result(&row.name, &outcome, host_user))
}

/// Parses `git ls-remote --symref` output: the `ref: refs/heads/<b>\tHEAD` symref and every
/// `refs/heads/*` branch (in git's order).
pub fn parse_ls_remote(out: &str) -> Branches {
    let mut b = Branches::default();
    for line in out.lines() {
        let Some((left, refname)) = line.split_once('\t') else {
            continue;
        };
        let refname = refname.trim();
        if let Some(target) = left.strip_prefix("ref: ") {
            if refname == "HEAD" {
                b.default_branch = target
                    .trim()
                    .strip_prefix("refs/heads/")
                    .map(str::to_string);
            }
        } else if let Some(branch) = refname.strip_prefix("refs/heads/")
            && !branch.is_empty()
        {
            b.branches.push(branch.to_string());
        }
    }
    b
}

/// The branches of the repository at `url` (D11a): `resolve`, `ls-remote` in the sidecar, then
/// the outcome as the connection status. A rejected credential answers 400
/// `credential_rejected`, other host errors 400 `remote_error`.
pub async fn branches(
    st: &AppState,
    user: &UserRow,
    id: Uuid,
    url: &str,
) -> Result<Branches, ApiError> {
    let row = repo::get_owned(&st.db, user.id, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let (p, method) = provider_and_method(&row)?;
    let (_, resolved) = resolve_url(&row, p, method, url.trim())?;
    require_ready(st).await?;
    if method.is_ssh()
        && row
            .known_hosts
            .as_deref()
            .is_none_or(|k| k.trim().is_empty())
    {
        return Err(ApiError::remote_error(format!(
            "Test the connection {} first to pin the host key of its git host.",
            row.name
        )));
    }
    match ls_remote(st, id, &resolved.upstream_url).await? {
        Ok(out) => {
            record_outcome(st, id, &Outcome::Ok, None).await;
            Ok(parse_ls_remote(&out))
        }
        Err(outcome) => {
            record_outcome(st, id, &outcome, None).await;
            let message = outcome_message(&row.name, &outcome).unwrap_or_default();
            Err(match outcome {
                Outcome::Rejected => ApiError::credential_rejected(id, message),
                _ => ApiError::remote_error(message),
            })
        }
    }
}
