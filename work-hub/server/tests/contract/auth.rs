//! Auth contract (D3): `GET config` per mode, 404 for every route of another mode, and the
//! shapes of `identify`, `me`, `logout` and `delete-account`.

use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::harness::{Case, Ctx, EMAIL_DOMAIN, assert_date, assert_keys};
use crate::registry::{Auth, REGISTRY, fill, method_of, probe_body};

const MODES: &[&str] = &["none", "password", "password-confirm", "azure-oauth"];

pub fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "auth::config_per_mode",
            run: config_per_mode,
        },
        Case {
            name: "auth::off_mode_routes_404",
            run: off_mode_404,
        },
        Case {
            name: "auth::identify_me_logout",
            run: identify_me_logout,
        },
        Case {
            name: "auth::delete_account",
            run: delete_account,
        },
    ]
}

/// Log Hub's public profile: `{id, email, role:"user", createdAt}`.
#[track_caller]
fn assert_profile(v: &Value, email: &str, context: &str) {
    assert_keys(v, &["id", "email", "role", "createdAt"], context);
    assert!(v["id"].is_i64(), "{context}: id {v}");
    assert_eq!(v["email"], email, "{context}: email");
    assert_eq!(v["role"], "user", "{context}: role");
    assert_date(&v["createdAt"], context);
}

fn config_per_mode(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let admin = format!("admin@{EMAIL_DOMAIN}");
        let expected = [
            ("none", json!({ "mode": "none" })),
            (
                "password",
                // No SMTP_HOST: "Forgot password?" is off.
                json!({ "mode": "password", "adminContactEmail": admin, "passwordResetAvailable": false }),
            ),
            (
                "password-confirm",
                json!({ "mode": "password-confirm", "adminContactEmail": admin, "passwordResetAvailable": true }),
            ),
        ];
        for (mode, want) in expected {
            let got = ctx
                .app_in(mode)
                .await
                .anon()
                .get("/api/v1/auth/config")
                .await
                .expect_status(200, mode)
                .json();
            assert_eq!(got, want, "config in mode {mode}");
        }
        let got = ctx
            .app_in("azure-oauth")
            .await
            .anon()
            .get("/api/v1/auth/config")
            .await
            .expect_status(200, "azure-oauth")
            .json();
        assert_keys(&got, &["mode", "azure"], "azure-oauth config");
        assert_eq!(got["mode"], "azure-oauth");
        assert_keys(
            &got["azure"],
            &["authority", "clientId", "redirectUri"],
            "azure-oauth config.azure",
        );
        assert_eq!(got["azure"]["clientId"], "contract-client");
        assert_eq!(
            got["azure"]["redirectUri"],
            "http://localhost:3100/api/auth/callback"
        );
        assert!(
            got["azure"]["authority"]
                .as_str()
                .is_some_and(|a| a.contains("contract-tenant")),
            "authority from AZURE_TENANT_ID: {got}"
        );
    })
}

/// Every mode-only route answers 404 `not_found` in each mode it does not belong to, before
/// any session or body check.
fn off_mode_404(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        for mode in MODES {
            let client = ctx.app_in(mode).await.anon();
            for r in REGISTRY {
                let Auth::ModeOnly(modes) = r.auth else {
                    continue;
                };
                if modes.contains(mode) {
                    continue;
                }
                let path = fill(r.path, Uuid::new_v4(), "main");
                client
                    .send(method_of(r.method), &path, probe_body(r), &[])
                    .await
                    .expect_error(404, "not_found", &format!("off-mode route in mode {mode}"));
            }
        }
    })
}

fn identify_me_logout(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let c = ctx.app.client();
        c.post("/api/v1/auth/identify", json!({ "email": "not an email" }))
            .await
            .expect_status(400, "identify with a bad e-mail");

        let email = format!("contract-me@{EMAIL_DOMAIN}");
        let profile = c
            .post("/api/v1/auth/identify", json!({ "email": email }))
            .await
            .expect_status(200, "identify")
            .json();
        assert_profile(&profile, &email, "identify");
        assert!(c.cookie().is_some(), "identify sets workhub.sid");

        let me = c
            .get("/api/v1/auth/me")
            .await
            .expect_status(200, "me")
            .json();
        assert_profile(&me, &email, "me");
        assert_eq!(me["id"], profile["id"], "me is the identified user");

        // Identify again with the same e-mail: the same user.
        let again = c
            .post("/api/v1/auth/identify", json!({ "email": email }))
            .await
            .expect_status(200, "identify again")
            .json();
        assert_eq!(again["id"], profile["id"], "identify reuses the user");

        let old_cookie = c.cookie();
        let out = c
            .post_empty("/api/v1/auth/logout")
            .await
            .expect_status(204, "logout");
        assert!(out.body.is_empty(), "logout has no body");
        // The old session no longer works.
        let replay = ctx.app.client();
        replay.set_cookie(old_cookie);
        replay.get("/api/v1/workspaces").await.expect_error(
            401,
            "unauthorized",
            "the session after logout",
        );

        // Outside mode none `me` never signs anyone in.
        ctx.app_in("password")
            .await
            .anon()
            .get("/api/v1/auth/me")
            .await
            .expect_error(401, "unauthorized", "me in mode password without a session");
    })
}

fn delete_account(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let c = ctx.identify("contract-delete").await;
        c.post("/api/v1/auth/delete-account", json!({ "confirm": "nope" }))
            .await
            .expect_status(400, "delete-account without the confirmation");
        let res = c
            .post(
                "/api/v1/auth/delete-account",
                json!({ "confirm": "delete" }),
            )
            .await
            .expect_status(204, "delete-account");
        assert!(res.body.is_empty(), "delete-account has no body");
        c.get("/api/v1/workspaces")
            .await
            .expect_error(401, "unauthorized", "after delete-account");
    })
}
