//! Workstreams contract (API changes → Workstreams, D10): open (and its name errors), list,
//! close check, the three closes (`uncommitted`, `not_open`), discard (`cannot_discard`),
//! reopen (`not_closed`), retry and the recording.

use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use uuid::Uuid;

use work_hub_server::docker::names;

use crate::harness::{Case, Ctx, assert_keys, assert_workstream, uuid_of};

pub fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "workstreams::open_and_list",
            run: open_and_list,
        },
        Case {
            name: "workstreams::check_close_for_now_reopen",
            run: check_close_for_now_reopen,
        },
        Case {
            name: "workstreams::bring_into_main_and_discard",
            run: bring_into_main_and_discard,
        },
        Case {
            name: "workstreams::merged_elsewhere",
            run: merged_elsewhere,
        },
        Case {
            name: "workstreams::recording",
            run: recording,
        },
    ]
}

/// Opens a workstream of user A's workspace.
async fn open(ctx: &Ctx, name: &str) -> Value {
    let w = ctx.world().await;
    let s =
        w.a.post(
            &format!("/api/v1/workspaces/{}/workstreams", w.workspace),
            json!({ "name": name }),
        )
        .await
        .expect_status(201, &format!("open {name:?}"))
        .json();
    assert_workstream(&s, "opened workstream");
    s
}

fn ws_path(id: Uuid, tail: &str) -> String {
    format!("/api/v1/workstreams/{id}/{tail}")
}

fn open_and_list(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let s = open(ctx, "Contract open").await;
        assert_eq!(s["name"], "Contract open");
        assert_eq!(s["state"], "open");
        assert_eq!(s["baseBranch"], "main");
        assert_eq!(s["available"], true);
        for k in ["closedAt", "mergedAt", "discardedAt"] {
            assert!(s[k].is_null(), "{k} of a new workstream: {s}");
        }
        let id = uuid_of(&s["id"]);
        let running = ctx
            .containers_with(&[(names::LABEL_WORKSTREAM, id.to_string())])
            .await;
        assert_eq!(
            running,
            [names::workstream_container(id)],
            "its own container"
        );

        let base = format!("/api/v1/workspaces/{}/workstreams", w.workspace);
        for (name, code) in [
            ("", "invalid_name"),
            (&"y".repeat(101)[..], "invalid_name"),
            ("Stream one", "duplicate_name"),
            ("contract OPEN", "duplicate_name"),
        ] {
            w.a.post(&base, json!({ "name": name })).await.expect_error(
                400,
                code,
                &format!("open {name:?}"),
            );
        }

        let list = w.a.get(&base).await.expect_status(200, "list").json();
        let items = list.as_array().expect("list array");
        for item in items {
            assert_workstream(item, "list item");
        }
        assert!(
            items.iter().any(|v| v["id"] == id.to_string()),
            "the new workstream is listed: {list}"
        );

        let retried =
            w.a.post_empty(&ws_path(id, "retry"))
                .await
                .expect_status(200, "retry an open workstream")
                .json();
        assert_workstream(&retried, "retry");
        assert_eq!(retried["available"], true);
    })
}

fn check_close_for_now_reopen(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let s = open(ctx, "Contract for now").await;
        let id = uuid_of(&s["id"]);

        let check =
            w.a.post_empty(&ws_path(id, "close/check"))
                .await
                .expect_status(200, "close check")
                .json();
        assert_keys(&check, &["uncommitted", "agentBusy"], "close check");
        assert_eq!(check["uncommitted"], json!([]), "a fresh worktree: {check}");
        assert!(check["agentBusy"].is_boolean(), "agentBusy: {check}");

        // An uncommitted file: listed by the check, and blocks "bring into main".
        ctx.sh(
            w.workspace,
            &names::workstream_container(id),
            "echo pending > /workspace/worktree/pending.txt",
            None,
        )
        .await;
        let check =
            w.a.post_empty(&ws_path(id, "close/check"))
                .await
                .expect_status(200, "close check with a pending file")
                .json();
        assert_eq!(check["uncommitted"], json!(["pending.txt"]), "{check}");
        let err =
            w.a.post(
                &ws_path(id, "close"),
                json!({ "mode": "bring_into_main", "force": false }),
            )
            .await
            .expect_error(409, "uncommitted", "bring into main with a pending file");
        assert_eq!(err["paths"], json!(["pending.txt"]), "{err}");
        w.a.post(&ws_path(id, "close"), json!({ "mode": "sideways" }))
            .await
            .expect_status(400, "an unknown close mode");

        // Close for now keeps the files: no question asked.
        let closed =
            w.a.post(
                &ws_path(id, "close"),
                json!({ "mode": "for_now", "force": false }),
            )
            .await
            .expect_status(200, "close for now")
            .json();
        assert_workstream(&closed, "closed");
        assert_eq!(closed["state"], "closed");
        assert!(
            closed["closedAt"].is_string() && closed["mergedAt"].is_null(),
            "{closed}"
        );

        w.a.post_empty(&ws_path(id, "close/check"))
            .await
            .expect_error(409, "not_open", "check a closed workstream");
        w.a.post(
            &ws_path(id, "close"),
            json!({ "mode": "for_now", "force": false }),
        )
        .await
        .expect_error(409, "not_open", "close a closed workstream");
        w.a.post_empty(&ws_path(id, "retry")).await.expect_error(
            409,
            "not_open",
            "retry a closed workstream",
        );
        w.a.get(&format!(
            "/api/v1/workspaces/{}/views/{id}/fs/list?dir=",
            w.workspace
        ))
        .await
        .expect_error(409, "not_open", "the view of a closed workstream");

        let reopened =
            w.a.post_empty(&ws_path(id, "reopen"))
                .await
                .expect_status(200, "reopen")
                .json();
        assert_workstream(&reopened, "reopened");
        assert_eq!(reopened["state"], "open");
        w.a.post_empty(&ws_path(id, "reopen")).await.expect_error(
            409,
            "not_closed",
            "reopen an open workstream",
        );
        let check =
            w.a.post_empty(&ws_path(id, "close/check"))
                .await
                .expect_status(200, "check after reopen")
                .json();
        assert_eq!(
            check["uncommitted"],
            json!(["pending.txt"]),
            "files kept: {check}"
        );
    })
}

fn bring_into_main_and_discard(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let s = open(ctx, "Contract merge").await;
        let id = uuid_of(&s["id"]);
        ctx.sh(
            w.workspace,
            &names::workstream_container(id),
            "cd /workspace/worktree && echo merged > merged-by-contract.txt && git add -A && \
             git -c user.name=Contract -c user.email=contract@arrakis.test commit -q -m contract",
            None,
        )
        .await;
        let closed =
            w.a.post(
                &ws_path(id, "close"),
                json!({ "mode": "bring_into_main", "force": false }),
            )
            .await
            .expect_status(200, "bring into main")
            .json();
        assert_workstream(&closed, "brought into main");
        assert_eq!(closed["state"], "closed");
        assert!(closed["mergedAt"].is_string(), "mergedAt: {closed}");
        w.a.get(&format!(
            "/api/v1/workspaces/{}/views/main/fs/file?path=merged-by-contract.txt",
            w.workspace
        ))
        .await
        .expect_status(200, "the merged file is on the working branch");

        let discarded =
            w.a.post_empty(&ws_path(id, "discard"))
                .await
                .expect_status(200, "discard a closed workstream")
                .json();
        assert_workstream(&discarded, "discarded");
        assert_eq!(discarded["state"], "discarded");
        assert!(discarded["discardedAt"].is_string(), "{discarded}");
        let left = ctx
            .containers_with(&[(names::LABEL_WORKSTREAM, id.to_string())])
            .await;
        assert!(left.is_empty(), "containers left after discard: {left:?}");
        w.a.post_empty(&ws_path(id, "discard")).await.expect_error(
            409,
            "cannot_discard",
            "discard twice",
        );
        w.a.post_empty(&ws_path(id, "reopen")).await.expect_error(
            409,
            "not_closed",
            "reopen a discarded workstream",
        );
        // A discarded workstream's name can be used again.
        let again = open(ctx, "Contract merge").await;
        w.a.post_empty(&ws_path(uuid_of(&again["id"]), "discard"))
            .await
            .expect_status(200, "discard an open workstream");
    })
}

fn merged_elsewhere(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let s = open(ctx, "Contract elsewhere").await;
        let id = uuid_of(&s["id"]);
        let done =
            w.a.post(
                &ws_path(id, "close"),
                json!({ "mode": "merged_elsewhere", "force": true }),
            )
            .await
            .expect_status(200, "already merged elsewhere")
            .json();
        assert_workstream(&done, "done");
        assert_eq!(done["state"], "done");
        let left = ctx
            .containers_with(&[(names::LABEL_WORKSTREAM, id.to_string())])
            .await;
        assert!(left.is_empty(), "containers left after done: {left:?}");
        w.a.post_empty(&ws_path(id, "reopen")).await.expect_error(
            409,
            "not_closed",
            "reopen a done workstream",
        );
        w.a.post_empty(&ws_path(id, "discard")).await.expect_error(
            409,
            "cannot_discard",
            "discard a done workstream",
        );
        let list =
            w.a.get(&format!("/api/v1/workspaces/{}/workstreams", w.workspace))
                .await
                .expect_status(200, "list")
                .json();
        assert!(
            list.as_array()
                .expect("list")
                .iter()
                .any(|v| v["id"] == id.to_string() && v["state"] == "done"),
            "the list holds every state: {list}"
        );
    })
}

fn recording(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let meta =
            w.a.get(&ws_path(w.workstream, "recording/meta"))
                .await
                .expect_status(200, "recording meta")
                .json();
        assert_keys(
            &meta,
            &["totalBytes", "initial", "resizes"],
            "recording meta",
        );
        assert!(meta["totalBytes"].is_i64(), "{meta}");
        assert_keys(
            &meta["initial"],
            &["cols", "rows"],
            "recording meta.initial",
        );
        assert!(meta["initial"]["cols"].is_i64() && meta["initial"]["rows"].is_i64());
        for r in meta["resizes"].as_array().expect("resizes") {
            assert_keys(r, &["offset", "cols", "rows"], "resize");
        }
        let rec =
            w.a.get(&ws_path(w.workstream, "recording"))
                .await
                .expect_status(200, "recording");
        assert_eq!(
            rec.header("content-type").as_deref(),
            Some("application/octet-stream")
        );
        assert!(
            rec.body.len() as i64 >= meta["totalBytes"].as_i64().unwrap_or(0),
            "the recording has at least the bytes of the earlier meta"
        );
    })
}
