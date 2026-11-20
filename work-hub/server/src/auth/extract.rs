//! Request-side auth: the `CurrentUser` extractor (401 `unauthorized`), `MeUser` for `GET me`
//! (which also auto-identifies a local request in mode `none`, Log Hub's `AutoIdentifyGuard`), the
//! socket peer, and the auth-mode route guard (404 when the route's mode is off).

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use tower_sessions::Session;

use crate::auth::users::{self, UserRow};
use crate::auth::{AuthMode, local_request, sessions};
use crate::error::ApiError;
use crate::state::AppState;

/// The signed-in user and their session. Rejects with 401 `unauthorized` when there is no session
/// user or the user no longer exists.
pub struct CurrentUser {
    pub user: UserRow,
    pub session: Session,
}

impl CurrentUser {
    pub fn id(&self) -> i64 {
        self.user.id
    }
}

/// The TCP peer address (`None` when the server was not started with connect info).
#[derive(Debug, Clone, Copy)]
pub struct Peer(pub Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Peer(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0),
        ))
    }
}

async fn session_of(parts: &mut Parts, state: &AppState) -> Result<Session, ApiError> {
    Session::from_request_parts(parts, state)
        .await
        .map_err(|(_, msg)| ApiError::internal(format!("session layer missing: {msg}")))
}

/// The session's user: none without a session user, when the user no longer exists, or when the
/// password changed since this session signed in.
pub async fn session_user(
    state: &AppState,
    session: &Session,
) -> Result<Option<UserRow>, ApiError> {
    let Some(id) = sessions::session_user_id(session).await? else {
        return Ok(None);
    };
    let Some(user) = users::find_by_id(&state.db, id).await? else {
        return Ok(None);
    };
    if !sessions::fingerprint_matches(session, &user).await? {
        return Ok(None);
    }
    Ok(Some(user))
}

/// [`CurrentUser`] from an already extracted session, for handlers that must run a check (such as
/// the auth-mode guard) before the 401.
pub async fn require_user(state: &AppState, session: Session) -> Result<CurrentUser, ApiError> {
    match session_user(state, &session).await? {
        Some(user) => Ok(CurrentUser { user, session }),
        None => Err(ApiError::unauthorized()),
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let session = session_of(parts, state).await?;
        match session_user(state, &session).await? {
            Some(user) => Ok(CurrentUser { user, session }),
            None => Err(ApiError::unauthorized()),
        }
    }
}

/// `GET me`'s user: like [`CurrentUser`], but in mode `none` a local request without a session
/// user is signed in first (Log Hub's `AuthService.autoIdentifyMode1`).
pub struct MeUser(pub CurrentUser);

impl FromRequestParts<AppState> for MeUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let session = session_of(parts, state).await?;
        if let Some(user) = session_user(state, &session).await? {
            return Ok(MeUser(CurrentUser { user, session }));
        }
        let Peer(peer) = Peer::from_request_parts(parts, state)
            .await
            .unwrap_or(Peer(None));
        if state.config.auth.mode != AuthMode::None || !local_request::is_local_request(peer) {
            return Err(ApiError::unauthorized());
        }
        match auto_identify_user(state).await? {
            Some(user) => {
                sessions::log_in(&session, &user).await?;
                Ok(MeUser(CurrentUser { user, session }))
            }
            None => Err(ApiError::unauthorized()),
        }
    }
}

/// Which user a local mode-`none` request is signed in as: none when there are no users, the only
/// user when there is one, otherwise user id 1.
pub async fn auto_identify_user(state: &AppState) -> Result<Option<UserRow>, ApiError> {
    let total = users::count(&state.db).await?;
    if total == 0 {
        return Ok(None);
    }
    if total == 1 {
        return Ok(users::find_first(&state.db).await?);
    }
    Ok(users::find_by_id(&state.db, 1).await?)
}

/// The auth-mode guard: 404 `not_found` unless the active mode is one of `modes` (an off-mode
/// route must not confirm that it exists).
pub fn require_mode(state: &AppState, modes: &[AuthMode]) -> Result<(), ApiError> {
    if modes.contains(&state.config.auth.mode) {
        Ok(())
    } else {
        Err(ApiError::not_found())
    }
}
