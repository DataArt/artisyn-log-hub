//! Workspaces contract (API changes → Workspaces): list, get, create (and its name errors),
//! login sources and copy, `login_required`, patch, delete.

use futures_util::future::BoxFuture;
use serde_json::json;

use work_hub_server::docker::names;

use crate::harness::{Case, Ctx, assert_keys, assert_workspace, assert_workstream, uuid_of};

pub fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "workspaces::list_and_get",
            run: list_and_get,
        },
        Case {
            name: "workspaces::create_name_errors",
            run: create_name_errors,
        },
        Case {
            name: "workspaces::create_login_patch_delete",
            run: create_login_patch_delete,
        },
    ]
}

fn list_and_get(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let list =
            w.a.get("/api/v1/workspaces")
                .await
                .expect_status(200, "list")
                .json();
        let items = list.as_array().expect("list is an array");
        let mine = items
            .iter()
            .find(|v| v["id"] == w.workspace.to_string())
            .unwrap_or_else(|| panic!("the workspace is listed: {list}"));
        for item in items {
            assert_workspace(item, "list item");
        }
        assert_eq!(mine["name"], "Contract A");
        assert_eq!(mine["workingBranch"], "main");
        assert_eq!(mine["loginState"], "ok");
        assert_eq!(mine["agent"], "claude");

        let detail =
            w.a.get(&format!("/api/v1/workspaces/{}", w.workspace))
                .await
                .expect_status(200, "get")
                .json();
        let mut keys: Vec<&str> = crate::harness::WORKSPACE_KEYS.to_vec();
        keys.extend(["branches", "configureActive", "workstreams"]);
        assert_keys(&detail, &keys, "workspace detail");
        let branches = detail["branches"].as_array().expect("branches");
        assert!(branches.iter().any(|b| b == "main"), "branches: {detail}");
        assert_eq!(detail["configureActive"], false);
        assert!(detail["openWorkstreams"].as_i64().unwrap_or(0) >= 1);
        let streams = detail["workstreams"].as_array().expect("workstreams");
        assert!(
            !streams.is_empty(),
            "the open workstream is listed: {detail}"
        );
        for s in streams {
            assert_workstream(s, "detail workstream");
            assert_eq!(s["state"], "open", "detail lists open workstreams only");
        }

        // A malformed or unknown id is a 404 as well.
        w.a.get("/api/v1/workspaces/not-a-uuid").await.expect_error(
            404,
            "not_found",
            "malformed id",
        );
        w.a.get(&format!("/api/v1/workspaces/{}", uuid::Uuid::new_v4()))
            .await
            .expect_error(404, "not_found", "unknown id");
    })
}

fn create_name_errors(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        for (name, code) in [
            ("", "invalid_name"),
            ("   ", "invalid_name"),
            (&"x".repeat(101)[..], "invalid_name"),
            ("Contract A", "duplicate_name"),
            ("contract a", "duplicate_name"),
        ] {
            w.a.post("/api/v1/workspaces", json!({ "name": name }))
                .await
                .expect_error(400, code, &format!("create {name:?}"));
        }
        w.a.post("/api/v1/workspaces", json!({}))
            .await
            .expect_status(400, "create without a name");
    })
}

fn create_login_patch_delete(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let created =
            w.a.post("/api/v1/workspaces", json!({ "name": "Contract scratch" }))
                .await
                .expect_status(201, "create")
                .json();
        assert_workspace(&created, "created workspace");
        assert_eq!(created["name"], "Contract scratch");
        assert_eq!(created["workingBranch"], "main");
        assert_eq!(created["openWorkstreams"], 0);
        assert_eq!(created["loginState"], "missing");
        assert!(created["loginAt"].is_null());
        let id = uuid_of(&created["id"]);
        let base = format!("/api/v1/workspaces/{id}");

        // Without a login: configure and opening a workstream need one.
        w.a.post_empty(&format!("{base}/configure"))
            .await
            .expect_error(409, "login_required", "configure without a login");
        w.a.post(&format!("{base}/workstreams"), json!({ "name": "Nope" }))
            .await
            .expect_error(409, "login_required", "open without a login");

        // Login sources: the logged-in workspace, never itself.
        let sources =
            w.a.get(&format!("{base}/login/sources"))
                .await
                .expect_status(200, "login sources")
                .json();
        let sources = sources.as_array().expect("sources array");
        for s in sources {
            assert_keys(s, &["id", "name", "loginAt"], "login source");
            assert_ne!(s["id"], id.to_string(), "a workspace is not its own source");
        }
        assert!(
            sources.iter().any(|s| s["id"] == w.workspace.to_string()),
            "the logged-in workspace is a source: {sources:?}"
        );
        w.a.post(
            &format!("{base}/login/copy"),
            json!({ "fromWorkspaceId": uuid::Uuid::new_v4() }),
        )
        .await
        .expect_error(
            400,
            "invalid_login_source",
            "copy from an unknown workspace",
        );
        w.a.post(
            &format!("{base}/login/copy"),
            json!({ "fromWorkspaceId": id }),
        )
        .await
        .expect_error(400, "invalid_login_source", "copy from itself");
        let copied =
            w.a.post(
                &format!("{base}/login/copy"),
                json!({ "fromWorkspaceId": w.workspace }),
            )
            .await
            .expect_status(200, "copy the login")
            .json();
        assert_eq!(copied, json!({ "loggedIn": true }));

        // Patch the working branch.
        w.a.patch(&base, json!({ "workingBranch": "no-such-branch" }))
            .await
            .expect_error(400, "unknown_branch", "patch to an unknown branch");
        let patched =
            w.a.patch(&base, json!({ "workingBranch": "main" }))
                .await
                .expect_status(200, "patch")
                .json();
        assert_workspace(&patched, "patched workspace");
        assert_eq!(patched["workingBranch"], "main");
        assert_eq!(patched["loginState"], "ok");

        // Delete: 204, then gone from the API and from Docker.
        let res = w.a.delete(&base).await.expect_status(204, "delete");
        assert!(res.body.is_empty(), "delete has no body");
        w.a.get(&base)
            .await
            .expect_error(404, "not_found", "get after delete");
        let list =
            w.a.get("/api/v1/workspaces")
                .await
                .expect_status(200, "list")
                .json();
        assert!(
            !list
                .as_array()
                .expect("list")
                .iter()
                .any(|v| v["id"] == id.to_string()),
            "deleted workspace not listed: {list}"
        );
        let left = ctx
            .containers_with(&[(names::LABEL_WORKSPACE, id.to_string())])
            .await;
        assert!(left.is_empty(), "containers left after delete: {left:?}");
    })
}
