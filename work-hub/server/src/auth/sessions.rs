//! Sessions (D3): tower-sessions with `PostgresStore` in `WORK_HUB_DB_SCHEMA.auth_sessions`
//! (created by `migrate()` at startup), a signed cookie `workhub.sid` (`HttpOnly`,
//! `SameSite=Lax`, 1 h inactivity expiry renewed on every request), `Secure` from
//! `COOKIE_SECURE` / `TRUST_PROXY`.

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use sha2::{Digest, Sha512};
use sqlx::PgPool;
use tower_sessions::cookie::{Key, SameSite};
use tower_sessions::service::SignedCookie;
use tower_sessions::{ExpiredDeletion, Expiry, Session, SessionManagerLayer};
use tower_sessions_sqlx_store::PostgresStore;

use crate::auth::js;
use crate::auth::startup::CookieSecure;
use crate::auth::users::UserRow;
use crate::config::{Config, RunEnv};
use crate::error::ApiError;

pub const COOKIE_NAME: &str = "workhub.sid";
pub const TABLE_NAME: &str = "auth_sessions";
/// The session field holding the signed-in user's id.
pub const USER_ID_KEY: &str = "userId";
/// Inactivity expiry.
pub const INACTIVITY: time::Duration = time::Duration::hours(1);
/// How often expired rows are deleted from `auth_sessions`.
const DELETE_EXPIRED_EVERY: std::time::Duration = std::time::Duration::from_secs(15 * 60);

pub type SessionLayer = SessionManagerLayer<PostgresStore, SignedCookie>;

#[derive(Debug, thiserror::Error)]
pub enum SessionsError {
    #[error("{0}")]
    Config(String),
    #[error("cannot create the session table: {0}")]
    Migrate(#[from] sqlx::Error),
}

/// The cookie signing key: SHA-512 of `SESSION_SECRET` (64 bytes). Required in production;
/// elsewhere a random key per process start, with a warning (sessions end on restart).
pub fn session_key(secret: Option<&str>, env: RunEnv) -> Result<Key, SessionsError> {
    match secret {
        Some(s) if !s.is_empty() => {
            let digest = Sha512::digest(s.as_bytes());
            Key::try_from(&digest[..]).map_err(|e| SessionsError::Config(e.to_string()))
        }
        _ if env == RunEnv::Production => Err(SessionsError::Config(
            "SESSION_SECRET environment variable is required when WORK_HUB_ENV=production".into(),
        )),
        _ => {
            tracing::warn!(
                "SESSION_SECRET is not set: using a random key, so sessions end when the server restarts"
            );
            let mut bytes = [0u8; 64];
            rand::fill(&mut bytes[..]);
            Ok(Key::from(&bytes))
        }
    }
}

/// The store in `schema.auth_sessions`, its table created when missing.
pub async fn init_store(db: &PgPool, schema: &str) -> Result<PostgresStore, SessionsError> {
    let store = PostgresStore::new(db.clone())
        .with_schema_name(schema)
        .and_then(|s| s.with_table_name(TABLE_NAME))
        .map_err(SessionsError::Config)?;
    store.migrate().await?;
    Ok(store)
}

/// The session layer and the cookie's `Secure` mode, ready for [`attach`].
#[derive(Clone)]
pub struct Sessions {
    pub layer: SessionLayer,
    pub secure: CookieSecure,
}

/// Startup: key, store (migrated), layer, and the background deletion of expired sessions.
pub async fn init(config: &Config, db: &PgPool) -> Result<Sessions, SessionsError> {
    let key = session_key(config.session_secret.as_deref(), config.env)?;
    let store = init_store(db, &config.db_schema).await?;
    let deletion = store.clone();
    tokio::spawn(async move {
        if let Err(e) = deletion
            .continuously_delete_expired(DELETE_EXPIRED_EVERY)
            .await
        {
            tracing::error!("expired-session cleanup stopped: {e}");
        }
    });
    let secure = config.auth.cookie_secure;
    Ok(Sessions {
        layer: layer(store, key, secure),
        secure,
    })
}

/// The tower-sessions layer with the D3 cookie attributes.
pub fn layer(store: PostgresStore, key: Key, secure: CookieSecure) -> SessionLayer {
    SessionManagerLayer::new(store)
        .with_name(COOKIE_NAME)
        .with_http_only(true)
        .with_same_site(SameSite::Lax)
        .with_path("/")
        .with_secure(secure == CookieSecure::Always)
        .with_expiry(Expiry::OnInactivity(INACTIVITY))
        // Rolling expiry (Log Hub's `rolling: true`): every request renews the session.
        .with_always_save(true)
        .with_signed(key)
}

/// Adds the session layer to the app; with `CookieSecure::Auto` the cookie also gets `Secure`
/// on requests that a trusted proxy marks as https.
pub fn attach(router: Router, sessions: Sessions) -> Router {
    let router = router.layer(sessions.layer);
    if sessions.secure == CookieSecure::Auto {
        router.layer(middleware::from_fn(secure_cookie_when_https))
    } else {
        router
    }
}

/// `X-Forwarded-Proto` (first entry) is `https`.
fn forwarded_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .is_some_and(|p| js::trim(p).eq_ignore_ascii_case("https"))
}

async fn secure_cookie_when_https(req: Request, next: Next) -> Response {
    let https = forwarded_https(req.headers());
    let mut res = next.run(req).await;
    if !https {
        return res;
    }
    let prefix = format!("{COOKIE_NAME}=");
    let cookies: Vec<HeaderValue> = res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .cloned()
        .collect();
    if cookies.is_empty() {
        return res;
    }
    res.headers_mut().remove(header::SET_COOKIE);
    for value in cookies {
        let fixed = match value.to_str() {
            Ok(s) if s.starts_with(&prefix) && !s.to_ascii_lowercase().contains("; secure") => {
                HeaderValue::from_str(&format!("{s}; Secure")).unwrap_or(value)
            }
            _ => value,
        };
        res.headers_mut().append(header::SET_COOKIE, fixed);
    }
    res
}

fn session_error(e: tower_sessions::session::Error) -> ApiError {
    ApiError::internal(format!("session store: {e}"))
}

/// The session field holding the [`password_fingerprint`] the session was signed in with.
pub const PASSWORD_FP_KEY: &str = "pwd";

/// A short digest of the user's password hash (`""` for a user without a password). A session
/// stays valid only while it matches the user's current one, so a password change or reset signs
/// out every other session (Log Hub deletes their `auth_sessions` rows; tower-sessions stores the
/// session data opaquely, so it cannot be queried by user).
pub fn password_fingerprint(password_hash: Option<&str>) -> String {
    let digest = sha2::Sha256::digest(password_hash.unwrap_or("").as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Signs `user` in: a new session id (no fixation), then the user id and password fingerprint.
pub async fn log_in(session: &Session, user: &UserRow) -> Result<(), ApiError> {
    session.cycle_id().await.map_err(session_error)?;
    session
        .insert(USER_ID_KEY, user.id)
        .await
        .map_err(session_error)?;
    refresh_fingerprint(session, user).await
}

/// Stores `user`'s current password fingerprint (after this session changed the password).
pub async fn refresh_fingerprint(session: &Session, user: &UserRow) -> Result<(), ApiError> {
    session
        .insert(
            PASSWORD_FP_KEY,
            password_fingerprint(user.password_hash.as_deref()),
        )
        .await
        .map_err(session_error)
}

/// The session was signed in with `user`'s current password.
pub async fn fingerprint_matches(session: &Session, user: &UserRow) -> Result<bool, ApiError> {
    let stored: Option<String> = session.get(PASSWORD_FP_KEY).await.map_err(session_error)?;
    Ok(stored.as_deref() == Some(password_fingerprint(user.password_hash.as_deref()).as_str()))
}

/// Ends the session: its row is deleted and the cookie expired.
pub async fn log_out(session: &Session) -> Result<(), ApiError> {
    session.flush().await.map_err(session_error)
}

/// The signed-in user's id, if any.
pub async fn session_user_id(session: &Session) -> Result<Option<i64>, ApiError> {
    session.get::<i64>(USER_ID_KEY).await.map_err(session_error)
}
