//! The contract registry (D13): one [`Contract`] row per route of `api::ROUTE_TABLE`, the
//! meta-test that keeps the two equal, and the generic checks every row gets:
//!
//! - every `Session` row answers 401 `unauthorized` without a session cookie (AC-6);
//! - every `owner_scoped` row answers 404 `not_found` to user B on user A's ids (AC-5).
//!
//! A new route without a row here fails `registry::meta`.

use futures_util::future::BoxFuture;
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

use work_hub_server::api::ROUTE_TABLE;

use crate::harness::{Body, Case, Client, Ctx};

/// Who may call a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    /// No session needed.
    Public,
    /// The session cookie is required (401 without it).
    Session,
    /// Exists only in these auth modes (404 in the others); the route's own rules apply there.
    ModeOnly(&'static [&'static str]),
}

#[derive(Debug, Clone, Copy)]
pub struct Contract {
    pub method: &'static str,
    pub path: &'static str,
    pub auth: Auth,
    /// The `{id}` names something the session user owns: 404 for anyone else.
    pub owner_scoped: bool,
}

const fn row(method: &'static str, path: &'static str, auth: Auth, owner_scoped: bool) -> Contract {
    Contract {
        method,
        path,
        auth,
        owner_scoped,
    }
}

const PASSWORD_MODES: &[&str] = &["password", "password-confirm"];
const S: Auth = Auth::Session;
const P: Auth = Auth::Public;

pub static REGISTRY: &[Contract] = &[
    // System
    row("GET", "/health", P, false),
    row("GET", "/api/v1/system/status", P, false),
    // Auth (D3)
    row("GET", "/api/v1/auth/config", P, false),
    row(
        "POST",
        "/api/v1/auth/identify",
        Auth::ModeOnly(&["none"]),
        false,
    ),
    row(
        "POST",
        "/api/v1/auth/signup",
        Auth::ModeOnly(PASSWORD_MODES),
        false,
    ),
    row(
        "POST",
        "/api/v1/auth/login",
        Auth::ModeOnly(PASSWORD_MODES),
        false,
    ),
    row(
        "GET",
        "/api/v1/auth/azure",
        Auth::ModeOnly(&["azure-oauth"]),
        false,
    ),
    row("POST", "/api/v1/auth/logout", S, false),
    row(
        "POST",
        "/api/v1/auth/confirm-email",
        Auth::ModeOnly(&["password-confirm"]),
        false,
    ),
    row(
        "POST",
        "/api/v1/auth/resend-confirmation",
        Auth::ModeOnly(&["password-confirm"]),
        false,
    ),
    row(
        "POST",
        "/api/v1/auth/forgot-password",
        Auth::ModeOnly(PASSWORD_MODES),
        false,
    ),
    row(
        "POST",
        "/api/v1/auth/reset-password",
        Auth::ModeOnly(PASSWORD_MODES),
        false,
    ),
    row(
        "POST",
        "/api/v1/auth/change-password",
        Auth::ModeOnly(PASSWORD_MODES),
        false,
    ),
    row("POST", "/api/v1/auth/delete-account", S, false),
    row("GET", "/api/v1/auth/me", S, false),
    row(
        "GET",
        "/api/auth/callback",
        Auth::ModeOnly(&["azure-oauth"]),
        false,
    ),
    // Workspaces
    row("GET", "/api/v1/workspaces", S, false),
    row("POST", "/api/v1/workspaces", S, false),
    row("GET", "/api/v1/workspaces/{id}", S, true),
    row("PATCH", "/api/v1/workspaces/{id}", S, true),
    row("DELETE", "/api/v1/workspaces/{id}", S, true),
    row("GET", "/api/v1/workspaces/{id}/login/sources", S, true),
    row("POST", "/api/v1/workspaces/{id}/login/copy", S, true),
    row("POST", "/api/v1/workspaces/{id}/login/start", S, true),
    row("POST", "/api/v1/workspaces/{id}/login/cancel", S, true),
    row("POST", "/api/v1/workspaces/{id}/login/logout", S, true),
    row("POST", "/api/v1/workspaces/{id}/configure", S, true),
    row("POST", "/api/v1/workspaces/{id}/configure/finish", S, true),
    row("GET", "/api/v1/workspaces/{id}/workstreams", S, true),
    row("POST", "/api/v1/workspaces/{id}/workstreams", S, true),
    // Files
    row(
        "GET",
        "/api/v1/workspaces/{id}/views/{view}/fs/list",
        S,
        true,
    ),
    row(
        "POST",
        "/api/v1/workspaces/{id}/views/{view}/fs/poll",
        S,
        true,
    ),
    row(
        "GET",
        "/api/v1/workspaces/{id}/views/{view}/fs/file",
        S,
        true,
    ),
    row(
        "PUT",
        "/api/v1/workspaces/{id}/views/{view}/fs/file",
        S,
        true,
    ),
    row(
        "POST",
        "/api/v1/workspaces/{id}/views/{view}/fs/upload",
        S,
        true,
    ),
    row(
        "POST",
        "/api/v1/workspaces/{id}/views/{view}/fs/move",
        S,
        true,
    ),
    row(
        "GET",
        "/api/v1/workspaces/{id}/views/{view}/fs/download",
        S,
        true,
    ),
    // Workstreams
    row("POST", "/api/v1/workstreams/{id}/close/check", S, true),
    row("POST", "/api/v1/workstreams/{id}/close", S, true),
    row("POST", "/api/v1/workstreams/{id}/discard", S, true),
    row("POST", "/api/v1/workstreams/{id}/reopen", S, true),
    row("POST", "/api/v1/workstreams/{id}/retry", S, true),
    row("GET", "/api/v1/workstreams/{id}/recording", S, true),
    row("GET", "/api/v1/workstreams/{id}/recording/meta", S, true),
    // Terminal WebSockets (D11): a plain GET gets the same 401 / 404 as an upgrade.
    row("GET", "/api/v1/workstreams/{id}/chat/ws", S, true),
    row("GET", "/api/v1/workspaces/{id}/login/ws", S, true),
    row("GET", "/api/v1/workspaces/{id}/configure/ws", S, true),
];

pub fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "registry::meta",
            run: meta,
        },
        Case {
            name: "registry::session_rows_401_without_cookie",
            run: session_rows_401,
        },
        Case {
            name: "registry::owner_scoped_rows_404_for_other_user",
            run: owner_scoped_404,
        },
    ]
}

/// `ROUTE_TABLE` and [`REGISTRY`] hold the same `(method, path)` pairs, each once.
fn meta(_ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let mut problems = Vec::new();
        for (i, r) in REGISTRY.iter().enumerate() {
            if REGISTRY[..i]
                .iter()
                .any(|o| o.method == r.method && o.path == r.path)
            {
                problems.push(format!("registry row twice: {} {}", r.method, r.path));
            }
            if !ROUTE_TABLE.contains(&(r.method, r.path)) {
                problems.push(format!(
                    "registry row without a route: {} {}",
                    r.method, r.path
                ));
            }
        }
        for (m, p) in ROUTE_TABLE {
            if !REGISTRY.iter().any(|r| r.method == *m && r.path == *p) {
                problems.push(format!(
                    "route without a registry row: {m} {p} (add it to tests/contract/registry.rs)"
                ));
            }
        }
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    })
}

pub fn method_of(m: &str) -> Method {
    Method::from_bytes(m.as_bytes()).expect("method")
}

/// The row's path with `{id}` and `{view}` filled in.
pub fn fill(path: &str, id: Uuid, view: &str) -> String {
    path.replace("{id}", &id.to_string())
        .replace("{view}", view)
}

/// A body the route's extractors accept (multipart for uploads, JSON otherwise), so the answer
/// comes from the auth or ownership check rather than a body rejection.
pub fn probe_body(r: &Contract) -> Body {
    if r.path.ends_with("/fs/upload") {
        Body::Files(vec![("probe.txt".into(), b"probe".to_vec())])
    } else if r.path.ends_with("/fs/file") && r.method == "PUT" {
        Body::Raw(b"probe".to_vec(), "text/plain")
    } else if r.method == "GET" || r.method == "DELETE" {
        Body::None
    } else {
        Body::Json(json!({}))
    }
}

async fn expect_401(client: &Client, r: &Contract, mode: &str) {
    let path = fill(r.path, Uuid::new_v4(), "main");
    client
        .send(method_of(r.method), &path, probe_body(r), &[])
        .await
        .expect_error(401, "unauthorized", &format!("mode {mode}, no cookie"));
}

/// AC-6: every `Session` row answers 401 without a cookie, in mode `none` (where `GET me` is the
/// exception: a local request is signed in automatically once a user exists) and in `password`.
fn session_rows_401(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        // At least one user exists, so the mode-`none` exception of `me` is real.
        ctx.identify("contract-401").await;
        let none = ctx.app.anon();
        let password = ctx.app_in("password").await.anon();
        for r in REGISTRY.iter().filter(|r| r.auth == Auth::Session) {
            if r.path != "/api/v1/auth/me" {
                expect_401(&none, r, "none").await;
            }
            expect_401(&password, r, "password").await;
        }
        // `change-password` is mode-only but needs a session where it exists.
        let r = REGISTRY
            .iter()
            .find(|r| r.path == "/api/v1/auth/change-password")
            .expect("change-password row");
        expect_401(&password, r, "password").await;
    })
}

/// AC-5: user B gets 404 on every owner-scoped route with user A's workspace and workstream ids
/// (both views for the file routes), and A's data is unchanged afterwards.
fn owner_scoped_404(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let stream_view = w.workstream.to_string();
        for r in REGISTRY.iter().filter(|r| r.owner_scoped) {
            let id = if r.path.starts_with("/api/v1/workstreams/") {
                w.workstream
            } else {
                w.workspace
            };
            let views: &[&str] = if r.path.contains("{view}") {
                &["main", stream_view.as_str()]
            } else {
                &["main"]
            };
            for view in views {
                let path = fill(r.path, id, view);
                w.b.send(method_of(r.method), &path, probe_body(r), &[])
                    .await
                    .expect_error(404, "not_found", "user B on user A's id");
            }
        }
        // B sees none of A's workspaces; A still has the workspace and the open workstream.
        let list =
            w.b.get("/api/v1/workspaces")
                .await
                .expect_status(200, "B's list")
                .json();
        assert_eq!(list, json!([]), "user B's workspaces");
        let detail =
            w.a.get(&format!("/api/v1/workspaces/{}", w.workspace))
                .await
                .expect_status(200, "A's workspace after B's calls")
                .json();
        let open = detail["workstreams"].as_array().expect("workstreams");
        assert!(
            open.iter().any(|s| s["id"] == w.workstream.to_string()),
            "A's workstream is still open: {detail}"
        );
    })
}
