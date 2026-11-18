//! Files contract (API changes → Files, D12) on user A's workspace: list, poll, file read and
//! save (`changed_on_disk`, `not_text`), upload (`target_exists`), move (`invalid_path`),
//! download (file and folder zip), and a workstream view.

use futures_util::future::BoxFuture;
use reqwest::Method;
use serde_json::{Value, json};

use crate::harness::{Body, Case, Ctx, assert_keys};

pub fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "fs::list_and_poll",
            run: list_and_poll,
        },
        Case {
            name: "fs::read_and_save",
            run: read_and_save,
        },
        Case {
            name: "fs::upload_move_download",
            run: upload_move_download,
        },
        Case {
            name: "fs::workstream_view",
            run: workstream_view,
        },
    ]
}

#[track_caller]
fn assert_entry(v: &Value, context: &str) {
    assert_keys(v, &["name", "path", "kind", "size", "mtime"], context);
    assert!(
        v["name"].is_string() && v["path"].is_string(),
        "{context}: {v}"
    );
    assert!(
        ["file", "dir", "symlink"].iter().any(|k| v["kind"] == *k),
        "{context}: kind {v}"
    );
    assert!(v["size"].is_u64(), "{context}: size {v}");
    assert!(v["mtime"].is_i64(), "{context}: mtime {v}");
}

fn find<'a>(entries: &'a [Value], path: &str) -> Option<&'a Value> {
    entries.iter().find(|e| e["path"] == path)
}

fn list_and_poll(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let base = format!("/api/v1/workspaces/{}/views/main/fs", w.workspace);
        let root =
            w.a.get(&format!("{base}/list?dir="))
                .await
                .expect_status(200, "list root")
                .json();
        assert_keys(&root, &["entries"], "list");
        let entries = root["entries"].as_array().expect("entries");
        for e in entries {
            assert_entry(e, "root entry");
        }
        assert_eq!(
            find(entries, ".gitignore").map(|e| e["kind"].clone()),
            Some(json!("file")),
            "root holds .gitignore: {root}"
        );
        assert_eq!(
            find(entries, ".devcontainer").map(|e| e["kind"].clone()),
            Some(json!("dir")),
            "root holds .devcontainer/: {root}"
        );
        let sub =
            w.a.get(&format!("{base}/list?dir=.devcontainer"))
                .await
                .expect_status(200, "list .devcontainer")
                .json();
        assert!(
            find(
                sub["entries"].as_array().expect("entries"),
                ".devcontainer/devcontainer.json"
            )
            .is_some(),
            "entries carry repo-relative paths: {sub}"
        );
        w.a.get(&format!("{base}/list?dir=no-such-dir"))
            .await
            .expect_error(404, "not_found", "list a missing dir");

        let poll =
            w.a.post(
                &format!("{base}/poll"),
                json!({ "dirs": ["", "no-such-dir"], "files": [".gitignore", "no-such-file.txt"] }),
            )
            .await
            .expect_status(200, "poll")
            .json();
        assert_keys(&poll, &["dirs", "files"], "poll");
        let root_dir = poll["dirs"][""]
            .as_array()
            .expect("dirs[\"\"] is a listing");
        assert!(
            find(root_dir, ".gitignore").is_some(),
            "poll listing: {poll}"
        );
        assert!(
            poll["dirs"]["no-such-dir"].is_null(),
            "missing dir → null: {poll}"
        );
        assert!(
            poll["files"][".gitignore"]
                .as_str()
                .is_some_and(|v| !v.is_empty()),
            "file version: {poll}"
        );
        assert!(
            poll["files"]["no-such-file.txt"].is_null(),
            "missing file → null: {poll}"
        );
    })
}

fn read_and_save(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let base = format!("/api/v1/workspaces/{}/views/main/fs", w.workspace);
        let file = format!("{base}/file?path=.gitignore");
        let read = w.a.get(&file).await.expect_status(200, "read .gitignore");
        assert_eq!(read.header("x-workhub-kind").as_deref(), Some("text"));
        let etag = read.header("etag").expect("ETag");
        assert!(
            etag.starts_with('"') && etag.ends_with('"'),
            "quoted ETag: {etag}"
        );
        let version = etag.trim_matches('"').to_string();
        let original = read.body.clone();

        // A stale If-Match: 409 changed_on_disk with the version on disk.
        let stale =
            w.a.send(
                Method::PUT,
                &file,
                Body::Raw(b"stale\n".to_vec(), "text/plain"),
                &[("if-match", "\"0000000000000000000000000000000000000000\"")],
            )
            .await
            .expect_error(409, "changed_on_disk", "save with a stale If-Match");
        assert_eq!(
            stale["version"],
            version.as_str(),
            "the version on disk: {stale}"
        );

        // Binary content is not text.
        w.a.send(
            Method::PUT,
            &file,
            Body::Raw(vec![0, 1, 2, 0], "application/octet-stream"),
            &[("if-match", &etag)],
        )
        .await
        .expect_error(400, "not_text", "save binary content");

        // A matching If-Match saves and answers the new version.
        let mut content = original.to_vec();
        content.extend_from_slice(b"# contract\n");
        let saved =
            w.a.send(
                Method::PUT,
                &file,
                Body::Raw(content.clone(), "text/plain"),
                &[("if-match", &etag)],
            )
            .await
            .expect_status(200, "save")
            .json();
        assert_keys(&saved, &["version"], "save");
        let new_version = saved["version"].as_str().expect("version").to_string();
        assert_ne!(new_version, version, "the version changes");
        let reread = w.a.get(&file).await.expect_status(200, "read after save");
        assert_eq!(reread.header("etag"), Some(format!("\"{new_version}\"")));
        assert_eq!(reread.body.as_ref(), content.as_slice(), "saved content");

        w.a.send(
            Method::PUT,
            &format!("{base}/file?path=../outside.txt"),
            Body::Raw(b"x".to_vec(), "text/plain"),
            &[("if-match", "\"x\"")],
        )
        .await
        .expect_error(400, "invalid_path", "save outside the repo");
    })
}

fn upload_move_download(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let base = format!("/api/v1/workspaces/{}/views/main/fs", w.workspace);
        let files = || {
            Body::Files(vec![
                ("notes.txt".to_string(), b"first\n".to_vec()),
                ("sub/inner.txt".to_string(), b"inner\n".to_vec()),
            ])
        };
        let uploaded =
            w.a.send(
                Method::POST,
                &format!("{base}/upload?dir=docs&overwrite=0"),
                files(),
                &[],
            )
            .await
            .expect_status(200, "upload")
            .json();
        assert_keys(&uploaded, &["paths"], "upload");
        let mut paths: Vec<String> = uploaded["paths"]
            .as_array()
            .expect("paths")
            .iter()
            .map(|p| p.as_str().expect("path").to_string())
            .collect();
        paths.sort();
        assert_eq!(paths, ["docs/notes.txt", "docs/sub/inner.txt"]);

        let clash =
            w.a.send(
                Method::POST,
                &format!("{base}/upload?dir=docs&overwrite=0"),
                files(),
                &[],
            )
            .await
            .expect_error(409, "target_exists", "upload the same names again");
        assert!(
            clash["paths"]
                .as_array()
                .is_some_and(|p| p.iter().any(|v| v == "docs/notes.txt")),
            "target_exists names the paths: {clash}"
        );
        w.a.send(
            Method::POST,
            &format!("{base}/upload?dir=docs&overwrite=1"),
            files(),
            &[],
        )
        .await
        .expect_status(200, "upload with overwrite");

        // Move.
        let moved =
            w.a.post(
                &format!("{base}/move"),
                json!({ "from": "docs/notes.txt", "toDir": "", "overwrite": false }),
            )
            .await
            .expect_status(200, "move")
            .json();
        assert_eq!(moved, json!({ "path": "notes.txt" }));
        w.a.post(
            &format!("{base}/move"),
            json!({ "from": "../etc/passwd", "toDir": "", "overwrite": false }),
        )
        .await
        .expect_error(400, "invalid_path", "move from outside the repo");
        w.a.send(
            Method::POST,
            &format!("{base}/upload?dir=docs&overwrite=0"),
            Body::Files(vec![("notes.txt".to_string(), b"again\n".to_vec())]),
            &[],
        )
        .await
        .expect_status(200, "upload a second notes.txt");
        w.a.post(
            &format!("{base}/move"),
            json!({ "from": "docs/notes.txt", "toDir": "", "overwrite": false }),
        )
        .await
        .expect_error(409, "target_exists", "move onto an existing name");

        // Download a file and a folder.
        let file =
            w.a.get(&format!("{base}/download?path=notes.txt"))
                .await
                .expect_status(200, "download a file");
        let disposition = file.header("content-disposition").expect("disposition");
        assert!(
            disposition.starts_with("attachment;") && disposition.contains("notes.txt"),
            "attachment: {disposition}"
        );
        assert_eq!(file.body.as_ref(), b"first\n");
        let zip =
            w.a.get(&format!("{base}/download?path=docs"))
                .await
                .expect_status(200, "download a folder");
        assert_eq!(
            zip.header("content-type").as_deref(),
            Some("application/zip")
        );
        assert!(
            zip.header("content-disposition")
                .is_some_and(|d| d.contains("docs.zip")),
            "folder as docs.zip"
        );
        assert!(zip.body.starts_with(b"PK"), "a zip archive");
        w.a.get(&format!("{base}/download?path=no-such-file"))
            .await
            .expect_error(404, "not_found", "download a missing path");
    })
}

fn workstream_view(ctx: &Ctx) -> BoxFuture<'_, ()> {
    Box::pin(async move {
        let w = ctx.world().await;
        let base = format!(
            "/api/v1/workspaces/{}/views/{}/fs",
            w.workspace, w.workstream
        );
        let root =
            w.a.get(&format!("{base}/list?dir="))
                .await
                .expect_status(200, "list the workstream view")
                .json();
        let entries = root["entries"].as_array().expect("entries");
        assert!(
            find(entries, ".gitignore").is_some(),
            "worktree root: {root}"
        );
        w.a.get(&format!(
            "/api/v1/workspaces/{}/views/{}/fs/list?dir=",
            w.workspace,
            uuid::Uuid::new_v4()
        ))
        .await
        .expect_error(404, "not_found", "an unknown workstream view");
    })
}
