//! Artisyn AI Work Hub server library.

pub mod agent;
pub mod api;
pub mod auth;
pub mod config;
pub mod db;
pub mod devcontainer;
pub mod docker;
pub mod error;
pub mod files;
pub mod fs;
pub mod git;
pub mod locks;
pub mod names;
pub mod repo_path;
pub mod secrets;
pub mod state;
pub mod terminal;
pub mod timing;
pub mod workspaces;
pub mod workstreams;

use std::net::SocketAddr;

use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

/// The crate version, also the tag of the default container image.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Logs to stderr; `RUST_LOG` overrides the default `info` level.
pub fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

/// Starts the server: config (with the auth startup validation), DB (schema + migrations),
/// sessions, Docker client, HTTP on `HOST:PORT`.
pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = Config::from_env()?;
    init_tracing();
    tracing::info!(
        version = VERSION,
        env = config.env.as_str(),
        schema = %config.db_schema,
        instance = %config.instance,
        "starting Work Hub"
    );

    if config.auth.mode == auth::AuthMode::None {
        match auth::local_request::trusted_gateway() {
            Some(gw) => {
                tracing::info!("AUTH_MODE=none: also trusting the container gateway {gw} as local")
            }
            None => tracing::info!("AUTH_MODE=none: only loopback requests are local"),
        }
    }

    let db = db::init(&config).await?;
    let sessions = auth::sessions::init(&config, &db).await?;
    let docker = docker::connect()?;
    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .map_err(|e| format!("invalid HOST/PORT {}:{}: {e}", config.host, config.port))?;

    let state = AppState::new(config, db, docker)?;
    // Log Hub's MailService.onModuleInit: an unreachable relay aborts startup in password-confirm.
    state.mailer.verify_at_startup().await?;
    // D6: the default image is checked (and built when missing) in the background; until then
    // `/api/v1/system/status` reports `defaultImage:"building"` and creating a workspace answers
    // `image_not_ready`.
    {
        let st = state.clone();
        tokio::spawn(async move {
            docker::images::ensure_default_image(
                &st.docker,
                &st.config.default_image,
                &st.image_status,
            )
            .await;
        });
    }
    // Terminal background work: the periodic recording sync and the resumed configure watchers.
    terminal::spawn_background(&state);
    // D10: open workstreams running with their chat, stale creating/opening rows cleaned up.
    workstreams::reconciler::spawn(state.clone());
    let app = api::router(state, sessions);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
