//! Security headers on every response (D16): the CSP, `X-Content-Type-Options: nosniff` and
//! `Referrer-Policy: same-origin`.

use axum::Router;
use axum::http::{HeaderName, HeaderValue, header};
use tower_http::set_header::SetResponseHeaderLayer;

/// D16. Monaco and xterm inject styles (`'unsafe-inline'` for styles only); Monaco runs its
/// editor worker from a blob or same-origin URL; images come from blob URLs (the IDE image tab).
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; \
worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";

/// Every header this layer sets, with its value.
pub fn headers() -> [(HeaderName, HeaderValue); 3] {
    [
        (
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        ),
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
        (
            header::REFERRER_POLICY,
            HeaderValue::from_static("same-origin"),
        ),
    ]
}

/// Adds the headers to every response of `router` (overriding any a handler set).
pub fn apply(router: Router) -> Router {
    let mut router = router;
    for (name, value) in headers() {
        router = router.layer(SetResponseHeaderLayer::overriding(name, value));
    }
    router
}
