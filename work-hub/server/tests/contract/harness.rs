//! The contract stand (D13) and its runner.
//!
//! - **Stand.** One run gets schema `whc_<8hex>` in `WORK_HUB_TEST_DATABASE_URL` (default
//!   `postgresql://postgres:pw@localhost:5432/postgres`), Docker instance `whc-<8hex>` and a data
//!   dir `tmp/work-hub-contract/run-<8hex>/data` under the repo root. The app runs in process on
//!   `127.0.0.1:0` in auth mode `none` with the fake-agent image as its default image; apps in the
//!   other auth modes are started on demand on the same schema (auth-shape tests only).
//! - **Runner.** `harness = false`: every case runs in order on one tokio runtime against the
//!   shared stand; a failing case (panic) is reported and the next one runs. After the last case
//!   the schema is dropped and every container, volume and image labelled with the run's
//!   instance is removed, whatever happened before.
//! - **Arguments.** Words that do not start with `-` filter cases by substring; `--list` lists
//!   them; other flags (`--test-threads=1` from `cargo test`) are ignored.
//! - **Guard.** The cases run only with `WORK_HUB_CONTRACT=1` (set by `scripts/contract.mjs`), so
//!   a bare `cargo test` without Postgres and Docker skips them with a notice.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

use work_hub_server::auth::AuthSettings;
use work_hub_server::config::{AuthEnv, Config, RunEnv};
use work_hub_server::docker::{self, Docker, containers, exec, images, names, volumes};
use work_hub_server::state::{AppState, ImageStatus};
use work_hub_server::{api, auth, db, terminal, workspaces, workstreams};

pub const DEFAULT_DATABASE_URL: &str = "postgresql://postgres:pw@localhost:5432/postgres";
/// The fake-agent image (D14), used as `WORK_HUB_DEFAULT_IMAGE`.
pub const FAKE_AGENT_IMAGE: &str = "artisyn-work-hub-fake-agent:test";
/// The e-mail domain of the stand's users.
pub const EMAIL_DOMAIN: &str = "arrakis.test";
/// Longest time one case may take.
const CASE_TIMEOUT: Duration = Duration::from_secs(600);

// ---------------------------------------------------------------------------------------------
// Cases and the runner
// ---------------------------------------------------------------------------------------------

pub type CaseFn = for<'a> fn(&'a Ctx) -> BoxFuture<'a, ()>;

/// One contract case: a name (`family::case`) and its body.
pub struct Case {
    pub name: &'static str,
    pub run: CaseFn,
}

/// Runs the cases matching the command-line filters on one stand and cleans it up.
pub fn run_cases(cases: Vec<Case>) -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--list") {
        for c in &cases {
            println!("{}: test", c.name);
        }
        return ExitCode::SUCCESS;
    }
    let filters: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let selected: Vec<Case> = cases
        .into_iter()
        .filter(|c| filters.is_empty() || filters.iter().any(|f| c.name.contains(f.as_str())))
        .collect();
    if std::env::var("WORK_HUB_CONTRACT").as_deref() != Ok("1") {
        println!(
            "contract: skipped ({} cases): they need Postgres and Docker; run `npm run test:contract` from work-hub/",
            selected.len()
        );
        return ExitCode::SUCCESS;
    }
    work_hub_server::init_tracing();
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("contract: cannot start the runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    let ok = rt.block_on(run_all(selected));
    // Background tasks of the apps (session cleanup, recording sync) end with the runtime.
    rt.shutdown_timeout(Duration::from_secs(5));
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn run_all(cases: Vec<Case>) -> bool {
    let stand = match Stand::new().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("contract: cannot set up the stand: {e}");
            return false;
        }
    };
    println!(
        "contract: stand schema {} instance {} data {}",
        stand.schema,
        stand.instance,
        stand.data_dir.display()
    );
    let ctx = match Ctx::new(stand).await {
        Ok(c) => c,
        Err((stand, e)) => {
            eprintln!("contract: cannot start the app: {e}");
            stand.cleanup().await;
            return false;
        }
    };

    let mut failed: Vec<&'static str> = Vec::new();
    let total = cases.len();
    for case in &cases {
        let started = Instant::now();
        println!("test {} ...", case.name);
        let fut = AssertUnwindSafe((case.run)(&ctx)).catch_unwind();
        let outcome = tokio::time::timeout(CASE_TIMEOUT, fut).await;
        let secs = started.elapsed().as_secs_f32();
        match outcome {
            Ok(Ok(())) => println!("test {} ... ok ({secs:.1}s)", case.name),
            Ok(Err(_)) => {
                println!("test {} ... FAILED ({secs:.1}s)", case.name);
                failed.push(case.name);
            }
            Err(_) => {
                println!("test {} ... FAILED (timed out after {secs:.0}s)", case.name);
                failed.push(case.name);
            }
        }
    }

    ctx.stop_apps();
    let clean = ctx.stand.cleanup().await;
    println!(
        "\ncontract: {} passed, {} failed",
        total - failed.len(),
        failed.len()
    );
    for name in &failed {
        println!("  failed: {name}");
    }
    failed.is_empty() && clean
}

// ---------------------------------------------------------------------------------------------
// The stand: schema, instance, data dir, Docker
// ---------------------------------------------------------------------------------------------

pub struct Stand {
    pub schema: String,
    pub instance: String,
    pub database_url: String,
    pub run_dir: PathBuf,
    pub data_dir: PathBuf,
    pub docker: Docker,
    pub session_secret: String,
}

impl Stand {
    async fn new() -> Result<Self, String> {
        let hex = Uuid::new_v4().simple().to_string()[..8].to_string();
        let database_url = std::env::var("WORK_HUB_TEST_DATABASE_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_DATABASE_URL.to_string());
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..");
        let run_dir = repo_root
            .join("tmp")
            .join("work-hub-contract")
            .join(format!("run-{hex}"));
        let data_dir = run_dir.join("data");
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("cannot create {}: {e}", data_dir.display()))?;
        // Without `..` (the bind source of every volume is derived from it); no `\\?\` prefix.
        let data_dir = std::fs::canonicalize(&data_dir)
            .map_err(|e| format!("cannot resolve {}: {e}", data_dir.display()))?;
        let data_dir = PathBuf::from(
            data_dir
                .display()
                .to_string()
                .trim_start_matches(r"\\?\")
                .to_string(),
        );
        let docker = docker::connect().map_err(|e| e.to_string())?;
        if docker.ping().await.is_err() {
            return Err("Docker is not reachable: start Docker and try again".into());
        }
        if !images::exists(&docker, FAKE_AGENT_IMAGE)
            .await
            .map_err(|e| e.to_string())?
        {
            return Err(format!(
                "image {FAKE_AGENT_IMAGE} is missing: run `npm run test:contract`, which builds it"
            ));
        }
        let stand = Stand {
            schema: format!("whc_{hex}"),
            instance: format!("whc-{hex}"),
            database_url,
            run_dir,
            data_dir,
            docker,
            session_secret: format!("contract-{}", Uuid::new_v4().simple()),
        };
        // A record of the run, so that `scripts/contract.mjs` can clean up after a hard kill.
        let info = json!({
            "pid": std::process::id(),
            "schema": stand.schema,
            "instance": stand.instance,
            "databaseUrl": stand.database_url,
        });
        let _ = std::fs::write(stand.run_dir.join("run.json"), info.to_string());
        Ok(stand)
    }

    /// Drops the schema, removes every Docker object of the instance and the run dir. `false`
    /// when something is left.
    async fn cleanup(&self) -> bool {
        let mut clean = true;
        let filter = names::instance_filter(&self.instance);
        if let Ok(list) = containers::list_by_labels(&self.docker, &filter).await {
            for c in list {
                if let Err(e) = containers::remove(&self.docker, &c.name).await {
                    eprintln!("contract cleanup: container {}: {e}", c.name);
                }
            }
        }
        if let Ok(list) = volumes::list_by_labels(&self.docker, &filter).await {
            for v in list {
                if let Err(e) = volumes::remove(&self.docker, &v).await {
                    eprintln!("contract cleanup: volume {v}: {e}");
                }
            }
        }
        if let Ok(list) = images::list_by_labels(&self.docker, &filter).await {
            for i in list {
                if let Err(e) = images::remove(&self.docker, &i).await {
                    eprintln!("contract cleanup: image {i}: {e}");
                }
            }
        }
        let left = containers::list_by_labels(&self.docker, &filter)
            .await
            .map(|l| l.len())
            .unwrap_or(1)
            + volumes::list_by_labels(&self.docker, &filter)
                .await
                .map(|l| l.len())
                .unwrap_or(1)
            + images::list_by_labels(&self.docker, &filter)
                .await
                .map(|l| l.len())
                .unwrap_or(1);
        if left > 0 {
            eprintln!(
                "contract cleanup: {left} Docker objects of {} are left",
                self.instance
            );
            clean = false;
        }

        match sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&self.database_url)
            .await
        {
            Ok(pool) => {
                let sql = format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", self.schema);
                if let Err(e) = sqlx::query(&sql).execute(&pool).await {
                    eprintln!("contract cleanup: cannot drop {}: {e}", self.schema);
                    clean = false;
                }
                // Schemas of earlier runs that were killed hard (found by scripts/contract.mjs).
                for stale in stale_schemas() {
                    let sql = format!("DROP SCHEMA IF EXISTS \"{stale}\" CASCADE");
                    match sqlx::query(&sql).execute(&pool).await {
                        Ok(_) => println!("contract cleanup: dropped {stale} of an earlier run"),
                        Err(e) => eprintln!("contract cleanup: cannot drop {stale}: {e}"),
                    }
                }
                pool.close().await;
            }
            Err(e) => {
                eprintln!(
                    "contract cleanup: cannot connect to drop {}: {e}",
                    self.schema
                );
                clean = false;
            }
        }
        if let Err(e) = std::fs::remove_dir_all(&self.run_dir) {
            eprintln!(
                "contract cleanup: cannot remove {}: {e}",
                self.run_dir.display()
            );
        }
        println!(
            "contract cleanup: schema {} dropped, objects of {} removed",
            self.schema, self.instance
        );
        clean
    }
}

/// `WORK_HUB_CONTRACT_STALE_SCHEMAS`: comma-separated `whc_<8hex>` names; anything else is
/// ignored.
fn stale_schemas() -> Vec<String> {
    std::env::var("WORK_HUB_CONTRACT_STALE_SCHEMAS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| {
            s.len() == 12
                && s.starts_with("whc_")
                && s[4..]
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        })
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------------------------

/// One in-process app on `127.0.0.1:<free port>`.
pub struct App {
    pub url: String,
    pub state: AppState,
    task: tokio::task::JoinHandle<()>,
}

impl App {
    /// A client of this app (keeps the session cookie).
    pub fn client(&self) -> Client {
        Client::new(&self.url, true)
    }

    /// A client that never sends a cookie.
    pub fn anon(&self) -> Client {
        Client::new(&self.url, false)
    }
}

/// The auth env of each mode the auth tests use.
fn mode_env(mode: &str) -> Vec<(&'static str, String)> {
    let mut vars = vec![
        ("AUTH_MODE", mode.to_string()),
        ("AUTH_RATE_LIMIT_POINTS", "1000".to_string()),
        ("ADMIN_CONTACT_EMAIL", format!("admin@{EMAIL_DOMAIN}")),
    ];
    match mode {
        "password-confirm" => vars.extend([
            ("SMTP_HOST", "localhost".to_string()),
            ("SMTP_PORT", "1025".to_string()),
            ("SMTP_FROM", format!("noreply@{EMAIL_DOMAIN}")),
            ("PUBLIC_BASE_URL", "http://localhost:3100".to_string()),
        ]),
        "azure-oauth" => vars.extend([
            ("AZURE_TENANT_ID", "contract-tenant".to_string()),
            ("AZURE_CLIENT_ID", "contract-client".to_string()),
            ("AZURE_CLIENT_SECRET", "contract-secret".to_string()),
            (
                "AZURE_REDIRECT_URI",
                "http://localhost:3100/api/auth/callback".to_string(),
            ),
        ]),
        _ => {}
    }
    vars
}

async fn start_app(stand: &Stand, mode: &str, background: bool) -> Result<App, String> {
    let auth_env = AuthEnv {
        vars: mode_env(mode).into_iter().collect::<HashMap<_, _>>(),
    };
    let auth = AuthSettings::from_env(&auth_env, RunEnv::Test)?;
    let config = Config {
        port: 0,
        host: "127.0.0.1".into(),
        database_url: stand.database_url.clone(),
        db_schema: stand.schema.clone(),
        env: RunEnv::Test,
        data_dir: stand.data_dir.clone(),
        engine_data_dir: work_hub_server::config::default_engine_path(&stand.data_dir),
        docker_host: None,
        default_image: FAKE_AGENT_IMAGE.into(),
        instance: stand.instance.clone(),
        static_dir: None,
        session_secret: Some(stand.session_secret.clone()),
        auth_env,
        auth,
    };
    let pool = db::init(&config).await.map_err(|e| e.to_string())?;
    let sessions = auth::sessions::init(&config, &pool)
        .await
        .map_err(|e| e.to_string())?;
    let state = AppState::new(config, pool, stand.docker.clone())?;
    // The image exists (checked by the stand): `ok` at once, never a build.
    *state.image_status.write().await = ImageStatus::Ok;
    if background {
        terminal::spawn_background(&state);
        workstreams::reconciler::spawn(state.clone());
    }
    let router = api::router(state.clone(), sessions);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let task = tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            eprintln!("contract: app stopped: {e}");
        }
    });
    Ok(App {
        url: format!("http://{addr}"),
        state,
        task,
    })
}

// ---------------------------------------------------------------------------------------------
// Context shared by the cases
// ---------------------------------------------------------------------------------------------

/// User A's world: a logged-in workspace with one open workstream, and user B with no
/// workspaces (AC-5).
pub struct World {
    pub a: Client,
    pub b: Client,
    pub workspace: Uuid,
    pub workstream: Uuid,
}

pub struct Ctx {
    pub stand: Stand,
    /// The app in mode `none` (the one with the background tasks).
    pub app: App,
    others: Mutex<Vec<tokio::task::AbortHandle>>,
    password: OnceCell<App>,
    password_confirm: OnceCell<App>,
    azure: OnceCell<App>,
    world: OnceCell<World>,
}

impl Ctx {
    async fn new(stand: Stand) -> Result<Self, (Stand, String)> {
        let app = match start_app(&stand, "none", true).await {
            Ok(a) => a,
            Err(e) => return Err((stand, e)),
        };
        Ok(Ctx {
            stand,
            app,
            others: Mutex::new(Vec::new()),
            password: OnceCell::new(),
            password_confirm: OnceCell::new(),
            azure: OnceCell::new(),
            world: OnceCell::new(),
        })
    }

    fn stop_apps(&self) {
        self.app.task.abort();
        for h in self.others.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            h.abort();
        }
    }

    /// The app in auth `mode` (`none`, `password`, `password-confirm`, `azure-oauth`).
    pub async fn app_in(&self, mode: &str) -> &App {
        let cell = match mode {
            "none" => return &self.app,
            "password" => &self.password,
            "password-confirm" => &self.password_confirm,
            "azure-oauth" => &self.azure,
            other => panic!("unknown auth mode {other}"),
        };
        cell.get_or_init(|| async {
            let app = start_app(&self.stand, mode, false)
                .await
                .unwrap_or_else(|e| panic!("cannot start the {mode} app: {e}"));
            self.others
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(app.task.abort_handle());
            app
        })
        .await
    }

    /// The pool of the `none` app (search_path = the stand's schema).
    pub fn db(&self) -> &PgPool {
        &self.app.state.db
    }

    /// A client of the `none` app signed in as `local@arrakis.test` via identify.
    pub async fn identify(&self, local: &str) -> Client {
        let c = self.app.client();
        c.post(
            "/api/v1/auth/identify",
            json!({ "email": format!("{local}@{EMAIL_DOMAIN}") }),
        )
        .await
        .expect_status(200, "identify");
        c
    }

    /// User A's world, created on first use.
    pub async fn world(&self) -> &World {
        self.world
            .get_or_init(|| async {
                let a = self.identify("contract-a").await;
                let b = self.identify("contract-b").await;
                let ws = a
                    .post("/api/v1/workspaces", json!({ "name": "Contract A" }))
                    .await
                    .expect_status(201, "create user A's workspace")
                    .json();
                let workspace = uuid_of(&ws["id"]);
                self.fake_login(&a, workspace).await;
                let s = a
                    .post(
                        &format!("/api/v1/workspaces/{workspace}/workstreams"),
                        json!({ "name": "Stream one" }),
                    )
                    .await
                    .expect_status(201, "open user A's workstream")
                    .json();
                World {
                    a,
                    b,
                    workspace,
                    workstream: uuid_of(&s["id"]),
                }
            })
            .await
    }

    /// The container user and home of a workspace (from its row).
    pub async fn container_user(&self, workspace: Uuid) -> (String, String) {
        let row = workspaces::repo::get_by_id(self.db(), workspace)
            .await
            .expect("workspace row")
            .expect("workspace exists");
        (
            row.container_user.expect("container user"),
            row.home_dir.expect("home dir"),
        )
    }

    /// Runs `sh -c script` in `container` as the workspace's container user; panics on a
    /// non-zero exit.
    pub async fn sh(&self, workspace: Uuid, container: &str, script: &str, stdin: Option<Bytes>) {
        let (user, _) = self.container_user(workspace).await;
        let out = exec::exec_capture(
            &self.stand.docker,
            container,
            &user,
            &exec::sh(script),
            stdin,
            Duration::from_secs(60),
        )
        .await
        .unwrap_or_else(|e| panic!("exec in {container}: {e}"));
        assert!(
            out.success(),
            "exec in {container} failed ({}): {}",
            out.exit_code,
            out.stderr_str()
        );
    }

    /// The fake agent's login (D14): its credentials file in the workspace container, then the
    /// live check of `GET …/{id}` caches `loginState:"ok"`.
    pub async fn fake_login(&self, client: &Client, workspace: Uuid) {
        let (_, home) = self.container_user(workspace).await;
        let dir = format!("{}/.claude", home.trim_end_matches('/'));
        self.sh(
            workspace,
            &names::workspace_container(workspace),
            &format!("mkdir -p '{dir}' && cat > '{dir}/.credentials.json'"),
            Some(Bytes::from_static(b"{\"fake\":\"ok\"}\n")),
        )
        .await;
        let detail = client
            .get(&format!("/api/v1/workspaces/{workspace}"))
            .await
            .expect_status(200, "get workspace after the fake login")
            .json();
        assert_eq!(detail["loginState"], "ok", "fake login: {detail}");
    }

    /// Names of the containers labelled with this run's instance and `extra`.
    pub async fn containers_with(&self, extra: &[(&str, String)]) -> Vec<String> {
        let filter = names::label_filter(&self.stand.instance, extra);
        containers::list_by_labels(&self.stand.docker, &filter)
            .await
            .expect("list containers")
            .into_iter()
            .map(|c| c.name)
            .collect()
    }
}

/// A uuid JSON value.
pub fn uuid_of(v: &Value) -> Uuid {
    v.as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or_else(|| panic!("not a uuid: {v}"))
}

// ---------------------------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------------------------

/// A response, fully read.
pub struct Resp {
    pub what: String,
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Resp {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// Asserts the status; the message carries the body.
    #[track_caller]
    pub fn expect_status(self, status: u16, context: &str) -> Self {
        assert_eq!(
            self.status.as_u16(),
            status,
            "{context}: {} answered {}: {}",
            self.what,
            self.status,
            self.text()
        );
        self
    }

    /// Asserts an error answer `{error:<code>, message:<non-empty>}` with this status.
    #[track_caller]
    pub fn expect_error(self, status: u16, code: &str, context: &str) -> Value {
        let resp = self.expect_status(status, context);
        let body = resp.json();
        assert_eq!(body["error"], code, "{context}: {} → {body}", resp.what);
        assert!(
            body["message"].as_str().is_some_and(|m| !m.is_empty()),
            "{context}: {} has no message: {body}",
            resp.what
        );
        body
    }

    #[track_caller]
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("{}: not JSON ({e}): {}", self.what, self.text()))
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }
}

/// A request body.
pub enum Body {
    None,
    Json(Value),
    Raw(Vec<u8>, &'static str),
    /// `files` parts: (file name = relative path, content).
    Files(Vec<(String, Vec<u8>)>),
}

pub struct Client {
    base: String,
    http: reqwest::Client,
    keep_cookie: bool,
    cookie: Mutex<Option<String>>,
}

impl Client {
    fn new(base: &str, keep_cookie: bool) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(300))
            .build()
            .expect("http client");
        Client {
            base: base.to_string(),
            http,
            keep_cookie,
            cookie: Mutex::new(None),
        }
    }

    /// The session cookie (`workhub.sid=…`) the client holds.
    pub fn cookie(&self) -> Option<String> {
        self.cookie
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Replaces the held session cookie.
    pub fn set_cookie(&self, cookie: Option<String>) {
        *self.cookie.lock().unwrap_or_else(|e| e.into_inner()) = cookie;
    }

    pub async fn send(
        &self,
        method: Method,
        path: &str,
        body: Body,
        headers: &[(&str, &str)],
    ) -> Resp {
        let what = format!("{method} {path}");
        let mut req = self.http.request(method, format!("{}{path}", self.base));
        if let Some(c) = self.cookie() {
            req = req.header("cookie", c);
        }
        for (k, v) in headers {
            req = req.header(
                HeaderName::from_bytes(k.as_bytes()).expect("header name"),
                HeaderValue::from_str(v).expect("header value"),
            );
        }
        req = match body {
            Body::None => req,
            Body::Json(v) => req
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&v).expect("json")),
            Body::Raw(bytes, ty) => req.header("content-type", ty).body(bytes),
            Body::Files(files) => {
                let boundary = format!("whc-{}", Uuid::new_v4().simple());
                let mut out = Vec::new();
                for (name, content) in files {
                    out.extend_from_slice(
                        format!(
                            "--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                        )
                        .as_bytes(),
                    );
                    out.extend_from_slice(&content);
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
                req.header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(out)
            }
        };
        let res = req
            .send()
            .await
            .unwrap_or_else(|e| panic!("{what}: request failed: {e}"));
        let status = res.status();
        let headers = res.headers().clone();
        if self.keep_cookie {
            for v in headers.get_all("set-cookie") {
                let Ok(v) = v.to_str() else { continue };
                let pair = v.split(';').next().unwrap_or("").trim();
                if let Some(value) = pair.strip_prefix("workhub.sid=") {
                    self.set_cookie(if value.is_empty() {
                        None
                    } else {
                        Some(pair.to_string())
                    });
                }
            }
        }
        let body = res
            .bytes()
            .await
            .unwrap_or_else(|e| panic!("{what}: reading the body failed: {e}"));
        Resp {
            what,
            status,
            headers,
            body,
        }
    }

    pub async fn get(&self, path: &str) -> Resp {
        self.send(Method::GET, path, Body::None, &[]).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Resp {
        self.send(Method::POST, path, Body::Json(body), &[]).await
    }

    pub async fn post_empty(&self, path: &str) -> Resp {
        self.send(Method::POST, path, Body::None, &[]).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> Resp {
        self.send(Method::PATCH, path, Body::Json(body), &[]).await
    }

    pub async fn delete(&self, path: &str) -> Resp {
        self.send(Method::DELETE, path, Body::None, &[]).await
    }
}

// ---------------------------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------------------------

/// Asserts that `v` is an object with exactly these keys.
#[track_caller]
pub fn assert_keys(v: &Value, keys: &[&str], context: &str) {
    let obj = v
        .as_object()
        .unwrap_or_else(|| panic!("{context}: not an object: {v}"));
    let mut got: Vec<&str> = obj.keys().map(String::as_str).collect();
    got.sort_unstable();
    let mut want = keys.to_vec();
    want.sort_unstable();
    assert_eq!(got, want, "{context}: keys of {v}");
}

/// Asserts an ISO-8601 date string (RFC 3339).
#[track_caller]
pub fn assert_date(v: &Value, context: &str) {
    let s = v
        .as_str()
        .unwrap_or_else(|| panic!("{context}: not a date string: {v}"));
    assert!(
        time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).is_ok(),
        "{context}: not an ISO-8601 date: {s}"
    );
}

/// Asserts a date string or null.
#[track_caller]
pub fn assert_date_or_null(v: &Value, context: &str) {
    if !v.is_null() {
        assert_date(v, context);
    }
}

pub const WORKSPACE_KEYS: &[&str] = &[
    "id",
    "name",
    "workingBranch",
    "openWorkstreams",
    "agent",
    "agentName",
    "loginState",
    "loginAt",
    "createdAt",
];

pub const WORKSTREAM_KEYS: &[&str] = &[
    "id",
    "name",
    "state",
    "baseBranch",
    "openedAt",
    "closedAt",
    "mergedAt",
    "discardedAt",
    "available",
];

/// Asserts the `Workspace` shape.
#[track_caller]
pub fn assert_workspace(v: &Value, context: &str) {
    assert_keys(v, WORKSPACE_KEYS, context);
    uuid_of(&v["id"]);
    assert!(v["name"].is_string(), "{context}: name {v}");
    assert!(
        v["workingBranch"].is_string(),
        "{context}: workingBranch {v}"
    );
    assert!(
        v["openWorkstreams"].is_i64(),
        "{context}: openWorkstreams {v}"
    );
    assert!(v["agent"].is_string(), "{context}: agent {v}");
    assert!(v["agentName"].is_string(), "{context}: agentName {v}");
    assert!(
        v["loginState"] == "ok" || v["loginState"] == "missing",
        "{context}: loginState {v}"
    );
    assert_date_or_null(&v["loginAt"], context);
    assert_date(&v["createdAt"], context);
}

/// Asserts the `WorkstreamSummary` shape.
#[track_caller]
pub fn assert_workstream(v: &Value, context: &str) {
    assert_keys(v, WORKSTREAM_KEYS, context);
    uuid_of(&v["id"]);
    assert!(v["name"].is_string(), "{context}: name {v}");
    assert!(
        ["open", "closed", "done", "discarded"]
            .iter()
            .any(|s| v["state"] == *s),
        "{context}: state {v}"
    );
    assert!(v["baseBranch"].is_string(), "{context}: baseBranch {v}");
    assert_date(&v["openedAt"], context);
    assert_date_or_null(&v["closedAt"], context);
    assert_date_or_null(&v["mergedAt"], context);
    assert_date_or_null(&v["discardedAt"], context);
    assert!(v["available"].is_boolean(), "{context}: available {v}");
}
