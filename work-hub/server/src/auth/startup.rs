//! Auth startup validation — Rust port of Log Hub's
//! `server/src/auth/config/auth-startup-validation.ts` with `allowed-email-domains.ts`
//! (rules: `docs/knowledgebase/algorithms/auth-startup-config.md`; the rows' `NODE_ENV` is
//! `WORK_HUB_ENV` here).
//!
//! [`validate_auth_startup_config`] is the pure rule: it reads raw values (unset = `None`, values
//! untrimmed) through a lookup and returns the effective `AUTH_MODE` / `PASSWORD_POLICY` (the
//! defaults Log Hub writes back) or the message of the first failed check.
//! [`AuthSettings::from_env`] runs it at startup and parses the rest of the auth settings.

use crate::auth::AuthMode;
use crate::auth::js;
use crate::config::{AuthEnv, RunEnv};

pub const VALID_AUTH_MODES: [&str; 4] = ["none", "password", "password-confirm", "azure-oauth"];
pub const VALID_PASSWORD_POLICIES: [&str; 3] = ["any", "mid", "long"];

/// The effective values after a passing validation (defaults applied).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupOutcome {
    pub auth_mode: AuthMode,
    pub password_policy: String,
}

/// Raw environment lookup: `None` = unset; a set value is returned exactly as it is.
pub type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

fn require_non_empty(name: &str, value: Option<String>) -> Result<String, String> {
    match value {
        Some(v) if !js::trim(&v).is_empty() => Ok(v),
        _ => Err(format!(
            "{name} environment variable is required when AUTH_MODE requires it"
        )),
    }
}

/// `new URL(value)` succeeds and the protocol is `http:` or `https:`.
pub fn is_absolute_http_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| u.scheme() == "http" || u.scheme() == "https")
}

fn validate_public_base_url(env: EnvLookup, is_production: bool) -> Result<(), String> {
    let raw = env("PUBLIC_BASE_URL").unwrap_or_default();
    let raw = js::trim(&raw);
    if raw.is_empty() {
        if is_production {
            return Err("PUBLIC_BASE_URL environment variable is required in production for AUTH_MODE=password and password-confirm (emailed links are built from it)".into());
        }
        return Ok(());
    }
    if !is_absolute_http_url(raw) {
        return Err(format!(
            "PUBLIC_BASE_URL environment variable must be an absolute http(s) URL, got: {raw}"
        ));
    }
    Ok(())
}

/// `8-4-4-4-12` hex digits, any case.
fn is_tenant_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn validate_azure_tenant(env: EnvLookup) -> Result<(), String> {
    let tenant_raw = require_non_empty("AZURE_TENANT_ID", env("AZURE_TENANT_ID"))?;
    let tenant = js::trim(&tenant_raw);
    if !is_tenant_guid(tenant) {
        return Err("AZURE_TENANT_ID must be a tenant GUID; multi-tenant values (common/organizations/consumers/domain) are not supported".into());
    }
    let authority_raw = env("AZURE_AUTHORITY").unwrap_or_default();
    let authority = js::trim(&authority_raw);
    if !authority.is_empty() {
        let path = match url::Url::parse(authority) {
            Ok(u) => u.path().to_string(),
            Err(_) => authority.to_string(),
        };
        let wanted = tenant.to_lowercase();
        if !path.split('/').any(|seg| seg.to_lowercase() == wanted) {
            return Err(format!("AZURE_AUTHORITY must point at tenant {tenant}"));
        }
    }
    Ok(())
}

fn validate_mode4(env: EnvLookup) -> Result<(), String> {
    validate_azure_tenant(env)?;
    require_non_empty("AZURE_CLIENT_ID", env("AZURE_CLIENT_ID"))?;
    require_non_empty("AZURE_CLIENT_SECRET", env("AZURE_CLIENT_SECRET"))?;
    let redirect = require_non_empty("AZURE_REDIRECT_URI", env("AZURE_REDIRECT_URI"))?;
    if url::Url::parse(&redirect).is_err() {
        return Err(format!(
            "AZURE_REDIRECT_URI environment variable must be an absolute URL, got: {redirect}"
        ));
    }
    if env("AZURE_SCOPES").as_deref() == Some("") {
        return Err("AZURE_SCOPES environment variable must not be set to an empty string".into());
    }
    Ok(())
}

fn validate_smtp_block(env: EnvLookup) -> Result<(), String> {
    require_non_empty("SMTP_HOST", env("SMTP_HOST"))?;
    require_non_empty("SMTP_FROM", env("SMTP_FROM"))?;
    let port_raw = require_non_empty("SMTP_PORT", env("SMTP_PORT"))?;
    let port = js::number(&port_raw);
    if !js::is_integer(port) || !(1.0..=65535.0).contains(&port) {
        return Err(format!(
            "SMTP_PORT environment variable must be an integer between 1 and 65535, got: {port_raw}"
        ));
    }
    Ok(())
}

fn validate_mode2(env: EnvLookup, is_production: bool) -> Result<(), String> {
    validate_public_base_url(env, is_production)?;
    if !js::is_blank(env("SMTP_HOST").as_deref()) {
        validate_smtp_block(env)?;
    }
    Ok(())
}

fn validate_mode3(env: EnvLookup, is_production: bool) -> Result<(), String> {
    validate_public_base_url(env, is_production)?;
    parse_allowed_email_domains(env("ALLOWED_EMAIL_DOMAINS").as_deref())?;
    let admin = env("ADMIN_CONTACT_EMAIL");
    let admin = match admin {
        Some(a) if !js::trim(&a).is_empty() => a,
        _ => {
            return Err(
                "ADMIN_CONTACT_EMAIL environment variable is required for AUTH_MODE=password-confirm"
                    .into(),
            );
        }
    };
    if !is_email(&admin) {
        return Err(format!(
            "ADMIN_CONTACT_EMAIL environment variable must be a valid email address, got: {admin}"
        ));
    }
    validate_smtp_block(env)
}

/// Runs the rules; returns the effective mode and policy or the first failure's message.
pub fn validate_auth_startup_config(
    env: EnvLookup,
    is_production: bool,
) -> Result<StartupOutcome, String> {
    let mode_raw = env("AUTH_MODE");
    let mode_str = if js::is_blank(mode_raw.as_deref()) {
        "password".to_string()
    } else {
        mode_raw.unwrap_or_default()
    };
    let auth_mode = AuthMode::parse(&mode_str).ok_or_else(|| {
        format!(
            "AUTH_MODE environment variable has an unrecognized value \"{mode_str}\"; must be one of {}",
            VALID_AUTH_MODES.join(", ")
        )
    })?;
    match auth_mode {
        AuthMode::None => {}
        AuthMode::Password => validate_mode2(env, is_production)?,
        AuthMode::AzureOauth => validate_mode4(env)?,
        AuthMode::PasswordConfirm => validate_mode3(env, is_production)?,
    }
    let policy_raw = env("PASSWORD_POLICY");
    let password_policy = if js::is_blank(policy_raw.as_deref()) {
        "long".to_string()
    } else {
        let p = policy_raw.unwrap_or_default();
        if !VALID_PASSWORD_POLICIES.contains(&p.as_str()) {
            return Err(format!(
                "PASSWORD_POLICY environment variable must be one of {}, got: {p}",
                VALID_PASSWORD_POLICIES.join(", ")
            ));
        }
        p
    };
    Ok(StartupOutcome {
        auth_mode,
        password_policy,
    })
}

/// `ALLOWED_EMAIL_DOMAINS` → lowercased domains; unset or blank = `[]` (no restriction).
pub fn parse_allowed_email_domains(raw: Option<&str>) -> Result<Vec<String>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if js::trim(raw).is_empty() {
        return Ok(Vec::new());
    }
    raw.split(',')
        .map(|part| {
            let domain = js::trim(part).to_lowercase();
            if domain.is_empty() {
                return Err(format!(
                    "ALLOWED_EMAIL_DOMAINS contains an empty entry, got: {raw}"
                ));
            }
            if domain.contains('@') {
                return Err(format!(
                    "ALLOWED_EMAIL_DOMAINS entries must be domains without \"@\", got: {domain}"
                ));
            }
            if js::has_whitespace(&domain) {
                return Err(format!(
                    "ALLOWED_EMAIL_DOMAINS entries must not contain whitespace, got: {domain}"
                ));
            }
            if !is_domain_pattern(&domain) {
                return Err(format!(
                    "ALLOWED_EMAIL_DOMAINS entry is not a valid domain, got: {domain}"
                ));
            }
            Ok(domain)
        })
        .collect()
}

/// `/^[a-z0-9-]+(\.[a-z0-9-]+)+$/`.
fn is_domain_pattern(d: &str) -> bool {
    let labels: Vec<&str> = d.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

// ---- class-validator `isEmail` with its defaults (validator.js) ------------------------------

fn in_utf8_local_ranges(c: char) -> bool {
    matches!(c, '\u{00A1}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFEF}')
}

/// `emailUserUtf8Part`: one dot-separated piece of an unquoted local part.
fn is_local_atom(part: &str) -> bool {
    !part.is_empty()
        && part.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || "!#$%&'*+-/=?^_`{|}~".contains(c)
                || in_utf8_local_ranges(c)
        })
}

/// `quotedEmailUserUtf8` over the inside of a quoted local part.
fn is_quoted_local(inner: &str) -> bool {
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(n)
                    if matches!(n, '\u{01}'..='\u{09}' | '\u{0B}' | '\u{0C}' | '\u{0D}'..='\u{7F}')
                        || in_utf8_local_ranges(n) => {}
                _ => return false,
            }
            continue;
        }
        let ok = js::is_js_whitespace(c)
            || matches!(c, '\u{01}'..='\u{08}' | '\u{0B}' | '\u{0C}' | '\u{0E}'..='\u{1F}' | '\u{7F}' | '\u{21}' | '\u{23}'..='\u{5B}' | '\u{5D}'..='\u{7E}')
            || in_utf8_local_ranges(c);
        if !ok {
            return false;
        }
    }
    true
}

/// validator.js `isFQDN` with `require_tld: true`, no underscores, no trailing dot, no numeric TLD.
fn is_fqdn(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    let tld = parts[parts.len() - 1];
    let tld_letters = tld.chars().count() >= 2
        && tld.chars().all(|c| {
            c.is_ascii_alphabetic()
                || matches!(c, '\u{00A1}'..='\u{00A8}' | '\u{00AA}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFEF}')
        });
    let tld_punycode = {
        let lower = tld.to_ascii_lowercase();
        lower.len() >= 4
            && lower.starts_with("xn")
            && lower[2..]
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    };
    if !(tld_letters || tld_punycode) || js::has_whitespace(tld) {
        return false;
    }
    parts.iter().all(|part| {
        part.encode_utf16().count() <= 63
            && !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c >= '\u{00A1}')
            && !part.chars().any(|c| matches!(c, '\u{FF01}'..='\u{FF5E}'))
            && !part.starts_with('-')
            && !part.ends_with('-')
            && !part.contains('_')
    })
}

/// class-validator `isEmail(value)` with default options: no display name, a TLD required,
/// UTF-8 local parts allowed, no IP domains.
pub fn is_email(s: &str) -> bool {
    if s.encode_utf16().count() > 254 {
        return false;
    }
    let (user, domain) = match s.rfind('@') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => ("", s),
    };
    if user.len() > 64 || domain.len() > 254 {
        return false;
    }
    if !is_fqdn(domain) {
        return false;
    }
    if user.starts_with('"') {
        // validator.js slices off the first and the last character unconditionally.
        let mut chars = user.chars();
        chars.next();
        chars.next_back();
        return is_quoted_local(chars.as_str());
    }
    user.split('.').all(is_local_atom)
}

// ---- the validated settings the server runs with ----------------------------------------------

/// `TRUST_PROXY` as Express understands it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustProxy {
    Off,
    /// `true`: trust every hop (the left-most `X-Forwarded-For` entry is the client).
    All,
    /// A hop count.
    Hops(u32),
    /// A comma-separated list of trusted proxy addresses (exact addresses).
    List(Vec<String>),
}

impl TrustProxy {
    /// Log Hub's `parseTrustProxy`: unset / empty / `false` = off.
    pub fn parse(raw: Option<&str>) -> Self {
        let v = js::trim(raw.unwrap_or(""));
        if v.is_empty() || v.eq_ignore_ascii_case("false") {
            return TrustProxy::Off;
        }
        if v.eq_ignore_ascii_case("true") {
            return TrustProxy::All;
        }
        if v.bytes().all(|c| c.is_ascii_digit()) {
            return v.parse().map(TrustProxy::Hops).unwrap_or(TrustProxy::All);
        }
        TrustProxy::List(
            v.split(',')
                .map(|s| js::trim(s).to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        )
    }

    pub fn enabled(&self) -> bool {
        *self != TrustProxy::Off
    }
}

/// The session cookie's `Secure` attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieSecure {
    Always,
    Never,
    /// Behind a trusted proxy: secure when the request came in over https (`X-Forwarded-Proto`).
    Auto,
}

/// Auth settings after the startup validation (D2, D3).
#[derive(Debug, Clone)]
pub struct AuthSettings {
    pub mode: AuthMode,
    /// `any` | `mid` | `long` (only under `WORK_HUB_ENV=test` can it hold another raw value).
    pub password_policy: String,
    pub allowed_email_domains: Vec<String>,
    /// `PUBLIC_BASE_URL` trimmed, trailing `/` removed.
    pub public_base_url: Option<String>,
    pub admin_contact_email: Option<String>,
    /// `AUTH_RATE_LIMIT_POINTS` (default 5; 0 disables the limit).
    pub rate_limit_points: u64,
    /// `AUTH_RATE_LIMIT_WINDOW_SEC` (default 900).
    pub rate_limit_window_sec: u64,
    pub trust_proxy: TrustProxy,
    pub cookie_secure: CookieSecure,
}

impl Default for AuthSettings {
    fn default() -> Self {
        AuthSettings {
            mode: AuthMode::Password,
            password_policy: "long".into(),
            allowed_email_domains: Vec::new(),
            public_base_url: None,
            admin_contact_email: None,
            rate_limit_points: 5,
            rate_limit_window_sec: 900,
            trust_proxy: TrustProxy::Off,
            cookie_secure: CookieSecure::Never,
        }
    }
}

/// Non-negative integer by `Number()`, else the fallback (Log Hub's `readNonNegativeInt`).
fn read_non_negative_int(raw: Option<&str>, fallback: u64) -> u64 {
    match raw {
        None => fallback,
        Some(r) if js::trim(r).is_empty() => fallback,
        Some(r) => {
            let v = js::number(r);
            if js::is_integer(v) && v >= 0.0 {
                v.min(u64::MAX as f64) as u64
            } else {
                fallback
            }
        }
    }
}

impl AuthSettings {
    /// Validates the auth environment (skipped under `WORK_HUB_ENV=test`, as Log Hub skips it
    /// under `NODE_ENV=test`; the mode must still be a known one) and builds the settings.
    pub fn from_env(auth_env: &AuthEnv, run_env: RunEnv) -> Result<Self, String> {
        let lookup = |name: &str| auth_env.get(name).map(str::to_string);
        let outcome = if run_env == RunEnv::Test {
            let mode_raw = lookup("AUTH_MODE");
            let mode = if js::is_blank(mode_raw.as_deref()) {
                AuthMode::Password
            } else {
                let m = mode_raw.unwrap_or_default();
                AuthMode::parse(&m).ok_or_else(|| {
                    format!(
                        "AUTH_MODE environment variable has an unrecognized value \"{m}\"; must be one of {}",
                        VALID_AUTH_MODES.join(", ")
                    )
                })?
            };
            let policy_raw = lookup("PASSWORD_POLICY");
            StartupOutcome {
                auth_mode: mode,
                password_policy: if js::is_blank(policy_raw.as_deref()) {
                    "long".into()
                } else {
                    policy_raw.unwrap_or_default()
                },
            }
        } else {
            validate_auth_startup_config(&lookup, run_env == RunEnv::Production)?
        };

        let allowed_email_domains = if outcome.auth_mode == AuthMode::PasswordConfirm {
            parse_allowed_email_domains(auth_env.get("ALLOWED_EMAIL_DOMAINS"))?
        } else {
            Vec::new()
        };
        let public_base_url = auth_env
            .get("PUBLIC_BASE_URL")
            .map(|v| js::trim(v).trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty());
        let admin_contact_email = auth_env
            .get("ADMIN_CONTACT_EMAIL")
            .map(|v| js::trim(v).to_string())
            .filter(|v| !v.is_empty());
        let rate_limit_points = read_non_negative_int(auth_env.get("AUTH_RATE_LIMIT_POINTS"), 5);
        let window = read_non_negative_int(auth_env.get("AUTH_RATE_LIMIT_WINDOW_SEC"), 900);
        let rate_limit_window_sec = if window > 0 { window } else { 900 };
        let trust_proxy = TrustProxy::parse(auth_env.get("TRUST_PROXY"));
        // As in Log Hub (`server/src/app.module.ts`): TRUST_PROXY wins over COOKIE_SECURE; otherwise
        // the cookie is Secure unless COOKIE_SECURE is `false` (unset included). Browsers accept a
        // Secure cookie on plain http://localhost; any other plain-http origin sets it to false.
        let cookie_secure = if trust_proxy.enabled() {
            CookieSecure::Auto
        } else if auth_env
            .get("COOKIE_SECURE")
            .is_some_and(|v| v.eq_ignore_ascii_case("false"))
        {
            CookieSecure::Never
        } else {
            CookieSecure::Always
        };
        Ok(AuthSettings {
            mode: outcome.auth_mode,
            password_policy: outcome.password_policy,
            allowed_email_domains,
            public_base_url,
            admin_contact_email,
            rate_limit_points,
            rate_limit_window_sec,
            trust_proxy,
            cookie_secure,
        })
    }
}
