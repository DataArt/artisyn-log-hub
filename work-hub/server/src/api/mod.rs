//! HTTP layer (D13). Every route is declared once in the [`routes!`] invocation below: each
//! `METHOD "path" => handler` line both adds the route to the axum `Router` and appends
//! `("METHOD", "path")` to [`ROUTE_TABLE`], which the contract meta-test compares with its registry.
//!
//! Everything that is not a declared route is the web UI ([`static_files`]); unknown `/api/*`
//! paths answer the JSON 404.

pub mod fs;
pub mod security_headers;
pub mod static_files;
pub mod system;
pub mod terminals;
pub mod workspaces;
pub mod workstreams;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use tower_http::trace::TraceLayer;

use crate::auth::azure;
use crate::auth::routes as auth;
use crate::auth::sessions::{self, Sessions};
use crate::state::AppState;

/// Declares the routes: generates `pub static ROUTE_TABLE` and `fn declared_routes()`.
/// Methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Two lines may share a path with different
/// methods (axum merges them). A line may end in `; unlimited` to disable the default request
/// body limit on that route only (uploads and saves have no size cap in the alpha, D4).
macro_rules! routes {
    (@method GET) => { ::axum::routing::get };
    (@method POST) => { ::axum::routing::post };
    (@method PUT) => { ::axum::routing::put };
    (@method PATCH) => { ::axum::routing::patch };
    (@method DELETE) => { ::axum::routing::delete };
    (@opt unlimited, $mr:expr) => { $mr.layer(DefaultBodyLimit::disable()) };
    ($( $method:ident $path:literal => $handler:expr $(; $opt:ident)? ),* $(,)?) => {
        /// Every declared `(METHOD, path)`, in declaration order.
        pub static ROUTE_TABLE: &[(&str, &str)] = &[ $( (stringify!($method), $path) ),* ];

        fn declared_routes() -> Router<AppState> {
            let router = Router::new();
            $(
                let method_router = routes!(@method $method)($handler);
                $( let method_router = routes!(@opt $opt, method_router); )?
                let router = router.route($path, method_router);
            )*
            router
        }
    };
}

routes! {
    GET "/health" => system::health,
    GET "/api/v1/system/status" => system::status,

    GET "/api/v1/auth/config" => auth::config,
    POST "/api/v1/auth/identify" => auth::identify,
    POST "/api/v1/auth/signup" => auth::signup,
    POST "/api/v1/auth/login" => auth::login,
    GET "/api/v1/auth/azure" => azure::start,
    POST "/api/v1/auth/logout" => auth::logout,
    POST "/api/v1/auth/confirm-email" => auth::confirm_email,
    POST "/api/v1/auth/resend-confirmation" => auth::resend_confirmation,
    POST "/api/v1/auth/forgot-password" => auth::forgot_password,
    POST "/api/v1/auth/reset-password" => auth::reset_password,
    POST "/api/v1/auth/change-password" => auth::change_password,
    POST "/api/v1/auth/delete-account" => auth::delete_account,
    GET "/api/v1/auth/me" => auth::me,
    GET "/api/auth/callback" => azure::callback,

    GET "/api/v1/workspaces" => workspaces::list,
    POST "/api/v1/workspaces" => workspaces::create,
    GET "/api/v1/workspaces/{id}" => workspaces::get,
    PATCH "/api/v1/workspaces/{id}" => workspaces::update,
    DELETE "/api/v1/workspaces/{id}" => workspaces::delete,
    GET "/api/v1/workspaces/{id}/login/sources" => workspaces::login_sources,
    POST "/api/v1/workspaces/{id}/login/copy" => workspaces::login_copy,
    POST "/api/v1/workspaces/{id}/login/start" => workspaces::login_start,
    POST "/api/v1/workspaces/{id}/login/cancel" => workspaces::login_cancel,
    POST "/api/v1/workspaces/{id}/login/logout" => workspaces::login_logout,
    POST "/api/v1/workspaces/{id}/configure" => workspaces::configure,
    POST "/api/v1/workspaces/{id}/configure/finish" => workspaces::configure_finish,
    GET "/api/v1/workspaces/{id}/workstreams" => workspaces::list_workstreams,
    POST "/api/v1/workspaces/{id}/workstreams" => workspaces::open_workstream,

    GET "/api/v1/workspaces/{id}/views/{view}/fs/list" => fs::list,
    POST "/api/v1/workspaces/{id}/views/{view}/fs/poll" => fs::poll,
    GET "/api/v1/workspaces/{id}/views/{view}/fs/file" => fs::read,
    PUT "/api/v1/workspaces/{id}/views/{view}/fs/file" => fs::save; unlimited,
    POST "/api/v1/workspaces/{id}/views/{view}/fs/upload" => fs::upload; unlimited,
    POST "/api/v1/workspaces/{id}/views/{view}/fs/move" => fs::move_path,
    GET "/api/v1/workspaces/{id}/views/{view}/fs/download" => fs::download,

    POST "/api/v1/workstreams/{id}/close/check" => workstreams::close_check,
    POST "/api/v1/workstreams/{id}/close" => workstreams::close,
    POST "/api/v1/workstreams/{id}/discard" => workstreams::discard,
    POST "/api/v1/workstreams/{id}/reopen" => workstreams::reopen,
    POST "/api/v1/workstreams/{id}/retry" => workstreams::retry,
    GET "/api/v1/workstreams/{id}/recording" => workstreams::recording,
    GET "/api/v1/workstreams/{id}/recording/meta" => workstreams::recording_meta,

    GET "/api/v1/workstreams/{id}/chat/ws" => terminals::chat,
    GET "/api/v1/workspaces/{id}/login/ws" => terminals::login,
    GET "/api/v1/workspaces/{id}/configure/ws" => terminals::configure,
}

/// The `{id}` path parameter as a uuid. A malformed id answers 404 `not_found`, like a missing
/// or foreign one (D4), rather than axum's plain-text 400.
#[derive(Debug, Clone, Copy)]
pub struct IdPath(pub uuid::Uuid);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for IdPath {
    type Rejection = crate::error::ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let params =
            axum::extract::Path::<std::collections::HashMap<String, String>>::from_request_parts(
                parts, state,
            )
            .await
            .map_err(|_| crate::error::ApiError::not_found())?;
        params
            .get("id")
            .and_then(|v| uuid::Uuid::parse_str(v).ok())
            .map(IdPath)
            .ok_or_else(crate::error::ApiError::not_found)
    }
}

/// The application: the declared routes with the session layer, the web UI as the fallback
/// (outside the session layer, so asset requests never touch the session store), the security
/// headers and request tracing on every response.
pub fn router(state: AppState, sessions: Sessions) -> Router {
    let api = sessions::attach(declared_routes().with_state(state.clone()), sessions);
    let app = api.merge(static_files::router(&state.config));
    security_headers::apply(app).layer(TraceLayer::new_for_http())
}
