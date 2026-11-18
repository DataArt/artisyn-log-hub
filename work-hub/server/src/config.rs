//! Server configuration read from the environment (D2).
//!
//! `work-hub/.env` is loaded with `dotenvy` first when it exists; real environment variables win.
//! The auth variables are kept raw here: the auth startup validation (`auth::startup`) checks them
//! and turns them into the validated auth settings.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::auth::AuthSettings;

/// `WORK_HUB_ENV`: the role `NODE_ENV` plays in Log Hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnv {
    Production,
    Development,
    Test,
}

impl RunEnv {
    pub fn as_str(self) -> &'static str {
        match self {
            RunEnv::Production => "production",
            RunEnv::Development => "development",
            RunEnv::Test => "test",
        }
    }
}

/// The auth variables exactly as found in the environment (unset = absent; set values are kept
/// untrimmed, even `""`, because the startup rules distinguish them). Names and meaning are Log
/// Hub's; `auth::startup` validates them.
#[derive(Debug, Clone, Default)]
pub struct AuthEnv {
    pub vars: HashMap<&'static str, String>,
}

impl AuthEnv {
    /// Every auth variable name read into [`AuthEnv`].
    pub const NAMES: &'static [&'static str] = &[
        "AUTH_MODE",
        "PASSWORD_POLICY",
        "ADMIN_CONTACT_EMAIL",
        "AUTH_RATE_LIMIT_POINTS",
        "AUTH_RATE_LIMIT_WINDOW_SEC",
        "ALLOWED_EMAIL_DOMAINS",
        "PUBLIC_BASE_URL",
        "COOKIE_SECURE",
        "TRUST_PROXY",
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_FROM",
        "SMTP_USER",
        "SMTP_PASSWORD",
        "SMTP_SECURE",
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_REDIRECT_URI",
        "AZURE_AUTHORITY",
        "AZURE_SCOPES",
    ];

    /// The raw value of one auth variable, `None` when unset.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub database_url: String,
    pub db_schema: String,
    pub env: RunEnv,
    /// Absolute `WORK_HUB_DATA_DIR`: the file area (FR-5g), recordings and temp files.
    pub data_dir: PathBuf,
    /// The data directory as the Docker Engine sees it (the bind source of every volume):
    /// `WORK_HUB_DOCKER_DATA_DIR`, else `data_dir` (on Windows mapped to Docker Desktop's
    /// `/run/desktop/mnt/host/<drive>/…`).
    pub engine_data_dir: String,
    /// `DOCKER_HOST`; `None` = bollard's platform default.
    pub docker_host: Option<String>,
    pub default_image: String,
    pub instance: String,
    pub static_dir: Option<PathBuf>,
    pub session_secret: Option<String>,
    pub auth_env: AuthEnv,
    /// The validated auth settings (`auth::startup`).
    pub auth: AuthSettings,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{name} has an invalid value {value:?}: {reason}")]
    Invalid {
        name: &'static str,
        value: String,
        reason: &'static str,
    },
    /// The auth startup validation failed; the message names the variable (auth-startup-config).
    #[error("{0}")]
    Auth(String),
}

/// Reads a variable; unset or whitespace-only counts as unset.
fn var(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => None,
    }
}

/// A schema name we can safely put into `search_path` and `CREATE SCHEMA` unquoted.
pub fn is_valid_schema_name(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    s.len() <= 63 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

impl Config {
    /// Loads `.env` (when present) and reads every D2 variable, applying the defaults.
    pub fn from_env() -> Result<Self, ConfigError> {
        // A missing .env is normal; real environment variables are never overridden.
        let _ = dotenvy::dotenv();
        Self::from_current_env()
    }

    /// Reads the process environment only (no `.env`).
    pub fn from_current_env() -> Result<Self, ConfigError> {
        let port = match var("PORT") {
            None => 3100,
            Some(v) => v.parse::<u16>().map_err(|_| ConfigError::Invalid {
                name: "PORT",
                value: v.clone(),
                reason: "expected a port number",
            })?,
        };
        let host = var("HOST").unwrap_or_else(|| "0.0.0.0".to_string());
        let database_url = var("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?;
        let db_schema = var("WORK_HUB_DB_SCHEMA").unwrap_or_else(|| "work_hub".to_string());
        if !is_valid_schema_name(&db_schema) {
            return Err(ConfigError::Invalid {
                name: "WORK_HUB_DB_SCHEMA",
                value: db_schema,
                reason: "use lowercase letters, digits and _ (starting with a letter or _)",
            });
        }
        let env = match var("WORK_HUB_ENV").as_deref() {
            None | Some("production") => RunEnv::Production,
            Some("development") => RunEnv::Development,
            Some("test") => RunEnv::Test,
            Some(other) => {
                return Err(ConfigError::Invalid {
                    name: "WORK_HUB_ENV",
                    value: other.to_string(),
                    reason: "expected production, development or test",
                });
            }
        };
        let data_dir = PathBuf::from(var("WORK_HUB_DATA_DIR").unwrap_or_else(|| "./data".into()));
        let data_dir = std::path::absolute(&data_dir).map_err(|_| ConfigError::Invalid {
            name: "WORK_HUB_DATA_DIR",
            value: data_dir.display().to_string(),
            reason: "cannot be made an absolute path",
        })?;
        let engine_data_dir = var("WORK_HUB_DOCKER_DATA_DIR")
            .map(|v| v.trim_end_matches('/').to_string())
            .unwrap_or_else(|| default_engine_path(&data_dir));
        let default_image = var("WORK_HUB_DEFAULT_IMAGE")
            .unwrap_or_else(|| format!("artisyn-work-hub-default:{}", crate::VERSION));
        let instance = var("WORK_HUB_INSTANCE").unwrap_or_else(|| "default".to_string());
        let auth_env = AuthEnv {
            vars: AuthEnv::NAMES
                .iter()
                .filter_map(|&n| std::env::var(n).ok().map(|v| (n, v)))
                .collect(),
        };
        let auth = AuthSettings::from_env(&auth_env, env).map_err(ConfigError::Auth)?;
        Ok(Config {
            port,
            host,
            database_url,
            db_schema,
            env,
            data_dir,
            engine_data_dir,
            docker_host: var("DOCKER_HOST"),
            default_image,
            instance,
            static_dir: var("WORK_HUB_STATIC_DIR").map(PathBuf::from),
            session_secret: var("SESSION_SECRET"),
            auth_env,
            auth,
        })
    }

    /// `<DATA_DIR>/recordings`.
    pub fn recordings_dir(&self) -> PathBuf {
        self.data_dir.join("recordings")
    }

    /// `<DATA_DIR>/tmp`.
    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }
}

/// The engine's view of an absolute host path when nothing else is configured: the same path,
/// except a Windows drive path (`D:\a\b`), which Docker Desktop sees as `/run/desktop/mnt/host/d/a/b`.
pub fn default_engine_path(path: &std::path::Path) -> String {
    let s = path.display().to_string();
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let rest = s[2..].replace('\\', "/");
        let rest = rest.trim_end_matches('/');
        format!(
            "/run/desktop/mnt/host/{}{rest}",
            (bytes[0] as char).to_ascii_lowercase()
        )
    } else {
        s.trim_end_matches('/').to_string()
    }
}
