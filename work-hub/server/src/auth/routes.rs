//! The auth routes (D3): the contract of Log Hub's `server/src/auth/auth.controller.ts` —
//! the same paths, request bodies, response shapes, status codes and per-mode 404s. Error bodies
//! use Work Hub's `{error, message}` shape (D4).
//!
//! Order of checks, as in Log Hub: the auth-mode guard (404 for an off-mode route) first, then the
//! session guard (401), then the body (400), then the route's own checks. Bodies are therefore
//! read as raw bytes and parsed inside the handler, after the guards.

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tower_sessions::Session;

use crate::auth::extract::{require_user, session_user};
use crate::auth::mailer::{EmailDelivery, mask_email};
use crate::auth::password_policy::apply_password_policy;
use crate::auth::rate_limit::RateLimitRoute;
use crate::auth::startup::is_email;
use crate::auth::tokens::{self, Consume, Issue, TokenKind};
use crate::auth::users::{self, PublicProfile, UserRow};
use crate::auth::{
    AuthMode, MeUser, Peer, TooManyRequests, azure, local_request, password_hash, require_mode,
    sessions,
};
use crate::error::ApiError;
use crate::state::AppState;

/// An auth route's error: an [`ApiError`] or a 429 with `Retry-After`.
pub enum AuthError {
    Api(ApiError),
    TooMany(TooManyRequests),
}

impl From<ApiError> for AuthError {
    fn from(e: ApiError) -> Self {
        AuthError::Api(e)
    }
}

impl From<TooManyRequests> for AuthError {
    fn from(e: TooManyRequests) -> Self {
        AuthError::TooMany(e)
    }
}

impl From<sqlx::Error> for AuthError {
    fn from(e: sqlx::Error) -> Self {
        AuthError::Api(e.into())
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        match self {
            AuthError::Api(e) => e.into_response(),
            AuthError::TooMany(e) => e.into_response(),
        }
    }
}

type AuthResult = Result<Response, AuthError>;

const PASSWORD_MAX_LEN: usize = 128;
const PASSWORD_MODES: &[AuthMode] = &[AuthMode::Password, AuthMode::PasswordConfirm];

// ---- errors ------------------------------------------------------------------------------------

fn validation(message: impl Into<String>) -> ApiError {
    ApiError::bad_request("validation_failed", message)
}

fn already_authenticated() -> ApiError {
    ApiError::bad_request("already_authenticated", "You are already signed in.")
}

fn password_mismatch() -> ApiError {
    ApiError::bad_request("password_mismatch", "Passwords do not match")
}

fn invalid_credentials() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "invalid_credentials",
        "Wrong email or password.",
    )
}

fn invalid_token() -> ApiError {
    ApiError::bad_request("invalid_token", "Invalid or unknown token")
}

fn token_expired() -> ApiError {
    ApiError::new(StatusCode::GONE, "token_expired", "Token has expired")
}

// ---- request bodies ----------------------------------------------------------------------------

/// Parses a JSON body; any malformed or mistyped body is a 400 (Log Hub's validation pipe).
fn parse_body<T: DeserializeOwned>(body: &Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|e| validation(format!("Invalid request body: {e}")))
}

fn check_email(email: &str) -> Result<(), ApiError> {
    if is_email(email) {
        Ok(())
    } else {
        Err(validation("email must be an email"))
    }
}

fn check_password_len(password: &str) -> Result<(), ApiError> {
    if password.encode_utf16().count() > PASSWORD_MAX_LEN {
        Err(validation(format!(
            "password must be shorter than or equal to {PASSWORD_MAX_LEN} characters"
        )))
    } else {
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct EmailBody {
    email: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignupBody {
    email: String,
    password: String,
    password_confirm: String,
}

#[derive(serde::Deserialize)]
struct TokenBody {
    token: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetBody {
    token: String,
    password: String,
    password_confirm: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeBody {
    current_password: String,
    password: String,
    password_confirm: String,
}

#[derive(serde::Deserialize)]
struct DeleteBody {
    confirm: String,
}

// ---- helpers -----------------------------------------------------------------------------------

/// A profile plus `email_delivery` (sign-up in `password-confirm`, change-password).
#[derive(Serialize)]
struct ProfileWithDelivery {
    #[serde(flatten)]
    profile: PublicProfile,
    email_delivery: EmailDelivery,
}

fn ok_json<T: Serialize>(status: StatusCode, body: T) -> Response {
    (status, Json(body)).into_response()
}

fn delivery(d: EmailDelivery) -> Response {
    ok_json(StatusCode::OK, json!({ "email_delivery": d }))
}

fn client_ip(st: &AppState, peer: Peer, headers: &HeaderMap) -> String {
    local_request::client_ip(peer.0, headers, &st.config.auth.trust_proxy)
}

fn policy(st: &AppState) -> Option<&str> {
    Some(st.config.auth.password_policy.as_str())
}

/// `password-confirm` sign-up allow-list: exact match on the part after the last `@`.
fn check_domain_allowed(st: &AppState, email: &str) -> Result<(), ApiError> {
    let allowed = &st.config.auth.allowed_email_domains;
    if st.config.auth.mode != AuthMode::PasswordConfirm || allowed.is_empty() {
        return Ok(());
    }
    let domain = email
        .rfind('@')
        .map_or(email, |i| &email[i + 1..])
        .trim()
        .to_lowercase();
    if allowed.contains(&domain) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "email_domain_not_allowed",
            format!(
                "Sign-up is limited to these email domains: {}",
                allowed.join(", ")
            ),
        ))
    }
}

// ---- routes ------------------------------------------------------------------------------------

/// `GET /api/v1/auth/config` (public): the mode and what the login page needs for it.
pub async fn config(State(st): State<AppState>) -> Json<Value> {
    let auth = &st.config.auth;
    let mut body = json!({ "mode": auth.mode.as_str() });
    match auth.mode {
        AuthMode::AzureOauth => {
            let s = azure::AzureSettings::from_env(&st.config.auth_env);
            body["azure"] = json!({
                "authority": s.authority,
                "clientId": s.client_id,
                "redirectUri": s.redirect_uri,
            });
        }
        AuthMode::Password | AuthMode::PasswordConfirm => {
            if let Some(admin) = &auth.admin_contact_email {
                body["adminContactEmail"] = json!(admin);
            }
            // false in `password` without SMTP_HOST: the client disables "Forgot password?".
            body["passwordResetAvailable"] = json!(st.mailer.is_configured());
        }
        AuthMode::None => {}
    }
    Json(body)
}

/// `POST /api/v1/auth/identify` (mode `none`, local requests only): sign in as this e-mail,
/// creating the user on first use.
pub async fn identify(
    State(st): State<AppState>,
    peer: Peer,
    session: Session,
    body: Bytes,
) -> AuthResult {
    require_mode(&st, &[AuthMode::None])?;
    let b: EmailBody = parse_body(&body)?;
    check_email(&b.email)?;
    if !local_request::is_local_request(peer.0) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Signing in without a password works only from this computer.",
        )
        .into());
    }
    let user = users::find_or_create(&st.db, &b.email).await?;
    sessions::log_in(&session, &user).await?;
    Ok(ok_json(StatusCode::OK, user.public_profile()))
}

/// `POST /api/v1/auth/signup` (modes `password`, `password-confirm`) → 201 profile. In
/// `password` it also signs in; in `password-confirm` it e-mails a confirmation link instead and
/// adds `email_delivery`.
pub async fn signup(
    State(st): State<AppState>,
    peer: Peer,
    headers: HeaderMap,
    session: Session,
    body: Bytes,
) -> AuthResult {
    require_mode(&st, PASSWORD_MODES)?;
    let b: SignupBody = parse_body(&body)?;
    check_email(&b.email)?;
    check_password_len(&b.password)?;
    if session_user(&st, &session).await?.is_some() {
        return Err(already_authenticated().into());
    }
    let route = RateLimitRoute::Signup;
    st.rate_limit
        .consume_ip(route, &client_ip(&st, peer, &headers))?;
    if !st.rate_limit.consume_email(route, &b.email) {
        return Err(TooManyRequests {
            retry_after_secs: st.rate_limit.email_retry_after_seconds(route, &b.email),
        }
        .into());
    }

    if b.password != b.password_confirm {
        return Err(password_mismatch().into());
    }
    check_domain_allowed(&st, &b.email)?;
    if users::find_by_email(&st.db, &b.email).await?.is_some() {
        return Err(email_taken().into());
    }
    apply_password_policy(policy(&st), &b.password).map_err(ApiError::from)?;
    let hash = password_hash::hash_password(&b.password).await?;
    let Some(user) = users::create(&st.db, &b.email, Some(&hash)).await? else {
        return Err(email_taken().into());
    };
    tracing::info!(
        "Signup: email={} userId={}",
        mask_email(&user.email),
        user.id
    );

    if st.config.auth.mode == AuthMode::PasswordConfirm {
        let token = tokens::create(&st.db, user.id, TokenKind::Confirm).await?;
        let email_delivery = match st.mailer.confirm_url(&token) {
            None => EmailDelivery::Failed,
            Some(url) => st.mailer.send_confirmation_email(&user.email, &url).await,
        };
        return Ok(ok_json(
            StatusCode::CREATED,
            ProfileWithDelivery {
                profile: user.public_profile(),
                email_delivery,
            },
        ));
    }
    sessions::log_in(&session, &user).await?;
    Ok(ok_json(StatusCode::CREATED, user.public_profile()))
}

fn email_taken() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "email_taken",
        "Email already registered",
    )
}

/// `POST /api/v1/auth/login` (modes `password`, `password-confirm`), with the login backoff.
pub async fn login(
    State(st): State<AppState>,
    peer: Peer,
    headers: HeaderMap,
    session: Session,
    body: Bytes,
) -> AuthResult {
    require_mode(&st, PASSWORD_MODES)?;
    if session_user(&st, &session).await?.is_some() {
        return Err(already_authenticated().into());
    }
    // Log Hub's passport-local: missing credentials are a plain 401.
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (Some(email), Some(password)) = (
        v.get("email")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty()),
        v.get("password")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty()),
    ) else {
        return Err(invalid_credentials().into());
    };
    let ip = client_ip(&st, peer, &headers);
    if let Err(e) = st.backoff.check(email, &ip) {
        tracing::warn!(
            "Login rejected while a brute-force delay is active: email={} ip={ip}",
            mask_email(email)
        );
        return Err(e.into());
    }

    let user = validate_user(&st, email, password).await?;
    let Some(user) = user else {
        let delay = st.backoff.record_failure(email, &ip);
        tracing::warn!("Login failed: email={} ip={ip}", mask_email(email));
        if delay > 0 {
            tracing::warn!(
                "Login delay applied: email={} ip={ip} seconds={delay}",
                mask_email(email)
            );
        }
        return Err(invalid_credentials().into());
    };
    st.backoff.record_success(email);
    if st.config.auth.mode == AuthMode::PasswordConfirm && user.email_confirmed_at.is_none() {
        tracing::warn!(
            "Login rejected, email not confirmed: email={} userId={}",
            mask_email(email),
            user.id
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "email_not_confirmed",
            "Confirm your email address first: open the link we sent you.",
        )
        .into());
    }
    sessions::log_in(&session, &user).await?;
    tracing::info!(
        "Login succeeded: email={} userId={}",
        mask_email(email),
        user.id
    );
    Ok(ok_json(StatusCode::OK, user.public_profile()))
}

/// The user when the password matches; users without a password never match.
async fn validate_user(
    st: &AppState,
    email: &str,
    password: &str,
) -> Result<Option<UserRow>, ApiError> {
    let Some(user) = users::find_by_email(&st.db, email).await? else {
        return Ok(None);
    };
    let Some(hash) = user.password_hash.as_deref() else {
        return Ok(None);
    };
    if password_hash::verify_password(password, hash).await? {
        Ok(Some(user))
    } else {
        Ok(None)
    }
}

/// `POST /api/v1/auth/logout` (session) → 204; the session row is deleted and the cookie expired.
pub async fn logout(State(st): State<AppState>, session: Session) -> AuthResult {
    let current = require_user(&st, session).await?;
    sessions::log_out(&current.session).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /api/v1/auth/confirm-email` (mode `password-confirm`) → 200 profile.
pub async fn confirm_email(State(st): State<AppState>, body: Bytes) -> AuthResult {
    require_mode(&st, &[AuthMode::PasswordConfirm])?;
    let b: TokenBody = parse_body(&body)?;
    let user_id = match tokens::consume(&st.db, &b.token, TokenKind::Confirm).await? {
        Consume::Ok(id) => id,
        other => {
            tracing::warn!("Email confirmation failed: reason={}", other.reason());
            return Err(match other {
                Consume::Expired => token_expired(),
                Consume::AlreadyUsed => ApiError::new(
                    StatusCode::CONFLICT,
                    "already_confirmed",
                    "Email already confirmed",
                ),
                _ => invalid_token(),
            }
            .into());
        }
    };
    let user = users::confirm_email(&st.db, user_id)
        .await?
        .ok_or_else(invalid_token)?;
    tracing::info!(
        "Email confirmed: email={} userId={}",
        mask_email(&user.email),
        user.id
    );
    Ok(ok_json(StatusCode::OK, user.public_profile()))
}

/// `POST /api/v1/auth/resend-confirmation` (mode `password-confirm`): enumeration-safe; an
/// over-limit e-mail gets the normal answer and nothing is sent.
pub async fn resend_confirmation(
    State(st): State<AppState>,
    peer: Peer,
    headers: HeaderMap,
    body: Bytes,
) -> AuthResult {
    require_mode(&st, &[AuthMode::PasswordConfirm])?;
    let b: EmailBody = parse_body(&body)?;
    check_email(&b.email)?;
    let route = RateLimitRoute::Resend;
    st.rate_limit
        .consume_ip(route, &client_ip(&st, peer, &headers))?;
    if !st.rate_limit.consume_email(route, &b.email) {
        return Ok(delivery(EmailDelivery::Sent));
    }
    let user = users::find_by_email(&st.db, &b.email).await?;
    let user = match user {
        Some(u) if u.email_confirmed_at.is_none() => u,
        _ => return Ok(delivery(EmailDelivery::Sent)),
    };
    let token = match tokens::issue_with_cooldown(&st.db, user.id, TokenKind::Confirm).await? {
        Issue::Issued(t) => t,
        Issue::Cooldown { retry_after_secs } => {
            return Err(TooManyRequests { retry_after_secs }.into());
        }
    };
    let Some(url) = st.mailer.confirm_url(&token) else {
        return Ok(delivery(EmailDelivery::Failed));
    };
    Ok(delivery(
        st.mailer.send_confirmation_email(&user.email, &url).await,
    ))
}

/// `POST /api/v1/auth/forgot-password` (modes `password`, `password-confirm`): enumeration-safe.
pub async fn forgot_password(
    State(st): State<AppState>,
    peer: Peer,
    headers: HeaderMap,
    body: Bytes,
) -> AuthResult {
    require_mode(&st, PASSWORD_MODES)?;
    let b: EmailBody = parse_body(&body)?;
    check_email(&b.email)?;
    let route = RateLimitRoute::Forgot;
    st.rate_limit
        .consume_ip(route, &client_ip(&st, peer, &headers))?;
    if !st.rate_limit.consume_email(route, &b.email) {
        return Ok(delivery(EmailDelivery::Sent));
    }
    // Without SMTP no reset is possible: answered before the lookup to stay enumeration-safe.
    if !st.mailer.is_configured() {
        return Ok(delivery(EmailDelivery::Failed));
    }
    let Some(user) = users::find_by_email(&st.db, &b.email).await? else {
        tracing::warn!(
            "Password reset requested for an unknown email: email={}",
            mask_email(&b.email)
        );
        return Ok(delivery(EmailDelivery::Sent));
    };
    let token = match tokens::issue_with_cooldown(&st.db, user.id, TokenKind::Reset).await? {
        Issue::Issued(t) => t,
        Issue::Cooldown { retry_after_secs } => {
            tracing::warn!(
                "Password reset blocked by cooldown: email={} userId={} retryAfterSeconds={retry_after_secs}",
                mask_email(&user.email),
                user.id
            );
            return Err(TooManyRequests { retry_after_secs }.into());
        }
    };
    tracing::info!(
        "Password reset token issued: email={} userId={}",
        mask_email(&user.email),
        user.id
    );
    let Some(url) = st.mailer.reset_url(&token) else {
        return Ok(delivery(EmailDelivery::Failed));
    };
    Ok(delivery(
        st.mailer.send_password_reset_email(&user.email, &url).await,
    ))
}

/// `POST /api/v1/auth/reset-password` (modes `password`, `password-confirm`) → 200 profile.
/// Rate-limited per IP only (the request carries a token, not an e-mail).
pub async fn reset_password(
    State(st): State<AppState>,
    peer: Peer,
    headers: HeaderMap,
    body: Bytes,
) -> AuthResult {
    require_mode(&st, PASSWORD_MODES)?;
    let b: ResetBody = parse_body(&body)?;
    check_password_len(&b.password)?;
    st.rate_limit
        .consume_ip(RateLimitRoute::Reset, &client_ip(&st, peer, &headers))?;
    let user_id = match tokens::consume(&st.db, &b.token, TokenKind::Reset).await? {
        Consume::Ok(id) => id,
        other => {
            tracing::warn!("Password reset failed: reason={}", other.reason());
            return Err(match other {
                Consume::Expired => token_expired(),
                Consume::AlreadyUsed => {
                    ApiError::new(StatusCode::CONFLICT, "token_used", "Token already used")
                }
                _ => invalid_token(),
            }
            .into());
        }
    };
    if b.password != b.password_confirm {
        tracing::warn!("Password reset failed: reason=password_mismatch userId={user_id}");
        return Err(password_mismatch().into());
    }
    if let Err(w) = apply_password_policy(policy(&st), &b.password) {
        tracing::warn!("Password reset failed: reason=weak_password userId={user_id}");
        return Err(ApiError::from(w).into());
    }
    let hash = password_hash::hash_password(&b.password).await?;
    users::set_password_hash(&st.db, user_id, &hash).await?;
    let user = users::find_by_id(&st.db, user_id)
        .await?
        .ok_or_else(invalid_token)?;
    tracing::info!(
        "Password reset succeeded: email={} userId={}",
        mask_email(&user.email),
        user.id
    );
    Ok(ok_json(StatusCode::OK, user.public_profile()))
}

/// `POST /api/v1/auth/change-password` (modes `password`, `password-confirm`, session) → 200
/// profile + `email_delivery`. Every other session of the user is signed out.
pub async fn change_password(
    State(st): State<AppState>,
    session: Session,
    body: Bytes,
) -> AuthResult {
    require_mode(&st, PASSWORD_MODES)?;
    let current = require_user(&st, session).await?;
    let b: ChangeBody = parse_body(&body)?;
    if b.current_password.is_empty() || b.password.is_empty() || b.password_confirm.is_empty() {
        return Err(validation(
            "currentPassword, password and passwordConfirm should not be empty",
        )
        .into());
    }
    check_password_len(&b.current_password)?;
    check_password_len(&b.password)?;
    let user = &current.user;
    let fail = |reason: &str| {
        tracing::warn!(
            "Password change failed: email={} userId={} reason={reason}",
            mask_email(&user.email),
            user.id
        );
    };
    let Some(hash) = user.password_hash.as_deref() else {
        fail("no_local_password");
        return Err(
            ApiError::bad_request("no_local_password", "This account has no password set").into(),
        );
    };
    if !password_hash::verify_password(&b.current_password, hash).await? {
        fail("invalid_current_password");
        // 403, not 401: a 401 makes the web client sign the user out.
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_current_password",
            "Current password is incorrect",
        )
        .into());
    }
    if b.password != b.password_confirm {
        fail("password_mismatch");
        return Err(password_mismatch().into());
    }
    if let Err(w) = apply_password_policy(policy(&st), &b.password) {
        fail("weak_password");
        return Err(ApiError::from(w).into());
    }
    let new_hash = password_hash::hash_password(&b.password).await?;
    users::set_password_hash(&st.db, user.id, &new_hash).await?;
    let updated = users::find_by_id(&st.db, user.id)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    // This session keeps working; every other one no longer matches the password fingerprint.
    sessions::refresh_fingerprint(&current.session, &updated).await?;
    let email_delivery = if st.mailer.is_configured() {
        st.mailer.send_password_changed_email(&updated.email).await
    } else {
        EmailDelivery::Skipped
    };
    tracing::info!(
        "Password changed: email={} userId={} otherSessionsRevoked=true emailDelivery={email_delivery:?}",
        mask_email(&updated.email),
        updated.id
    );
    Ok(ok_json(
        StatusCode::OK,
        ProfileWithDelivery {
            profile: updated.public_profile(),
            email_delivery,
        },
    ))
}

/// `POST /api/v1/auth/delete-account` (session, every mode), body `{confirm:"delete"}` → 204:
/// the user's workspaces first, then the user (tokens cascade); the cookie is cleared.
pub async fn delete_account(
    State(st): State<AppState>,
    session: Session,
    body: Bytes,
) -> AuthResult {
    let current = require_user(&st, session).await?;
    let b: DeleteBody = parse_body(&body)?;
    if b.confirm != "delete" {
        return Err(validation("confirm must be equal to delete").into());
    }
    let id = current.id();
    st.account_cleanup.delete_user_data(id).await?;
    users::delete(&st.db, id).await?;
    tracing::info!(
        "Account deleted: email={} userId={id}",
        mask_email(&current.user.email)
    );
    // The account is gone either way; a failed session delete must not turn this into a 500.
    if let Err(e) = sessions::log_out(&current.session).await {
        tracing::warn!("session delete after account deletion failed: {e}");
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `GET /api/v1/auth/me` (session; in mode `none` a local request is signed in automatically).
pub async fn me(MeUser(current): MeUser) -> Json<PublicProfile> {
    Json(current.user.public_profile())
}
