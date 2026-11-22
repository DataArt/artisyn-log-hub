//! Shared application state (D16 "AppState final fields"). Fields are added as their modules land.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use sqlx::PgPool;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::agent::AgentRegistry;
use crate::auth::azure::{AzureAuth, AzureSettings};
use crate::auth::backoff::{Clock, LoginBackoff, SystemClock};
use crate::auth::mailer::Mailer;
use crate::auth::rate_limit::RateLimiter;
use crate::auth::{AccountCleanup, NoopAccountCleanup};
use crate::config::{Config, RunEnv};
use crate::locks::ContainerLocks;
use crate::terminal::TerminalHub;
use crate::workspaces::WorkspaceAccountCleanup;

/// Docker Engine client handle (cheap to clone).
pub type DockerClient = crate::docker::Docker;

/// State of the default container image build. API: `"building" | "ok" | "failed"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageStatus {
    Building,
    Ok,
    Failed(String),
}

impl ImageStatus {
    pub fn as_api_str(&self) -> &'static str {
        match self {
            ImageStatus::Building => "building",
            ImageStatus::Ok => "ok",
            ImageStatus::Failed(_) => "failed",
        }
    }
}

/// State of the git proxy sidecar (plan D5). API (`system/status` `gitProxy`):
/// `"building" | "ok" | "failed"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyStatus {
    /// At startup and while the sidecar is being (re)created or its state re-pushed.
    Building,
    /// The sidecar runs and holds the current connections, routes and capabilities.
    Ok,
    /// The image build or the container start failed; the startup task retries.
    Failed(String),
}

impl ProxyStatus {
    pub fn as_api_str(&self) -> &'static str {
        match self {
            ProxyStatus::Building => "building",
            ProxyStatus::Ok => "ok",
            ProxyStatus::Failed(_) => "failed",
        }
    }
}

/// Where a clone of workspace create is. API (`CloneOp.state`):
/// `"running" | "done" | "failed" | "cancelled"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneState {
    Running,
    Done,
    Failed,
    Cancelled,
}

impl CloneState {
    pub fn as_api_str(self) -> &'static str {
        match self {
            CloneState::Running => "running",
            CloneState::Done => "done",
            CloneState::Failed => "failed",
            CloneState::Cancelled => "cancelled",
        }
    }
}

/// The progress of one clone (plan D11 "Clone ops"), keyed by the client's `opId`.
#[derive(Debug, Clone)]
pub struct CloneOp {
    /// The user who started the clone; only they can read or cancel it.
    pub user_id: i64,
    pub state: CloneState,
    /// The last progress line git printed (or `Fetching from <host>…` before the first one).
    pub line: String,
    /// The last `(\d+)%` of the last progress line.
    pub percent: Option<u8>,
    pub cancelled: bool,
    /// When the clone ended; the entry is removed 10 minutes later.
    pub ended_at: Option<Instant>,
    /// The workspace container the clone runs in, once known (cancel kills the clone there).
    pub container: Option<String>,
}

/// The git proxy sidecar's status and the running clone operations.
#[derive(Debug)]
pub struct GitProxyState {
    pub status: RwLock<ProxyStatus>,
    pub clone_ops: Mutex<HashMap<Uuid, CloneOp>>,
}

impl GitProxyState {
    pub fn new() -> Self {
        GitProxyState {
            status: RwLock::new(ProxyStatus::Building),
            clone_ops: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for GitProxyState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub docker: DockerClient,
    /// Coding-agent adapters keyed by `workspaces.agent`.
    pub agents: Arc<AgentRegistry>,
    pub locks: Arc<ContainerLocks>,
    /// Live terminal connections (takeover) and the service-session watchers.
    pub terminals: Arc<TerminalHub>,
    /// Workstreams whose container could not be started (`available:false` until a retry works).
    pub unavailable: Arc<Mutex<HashSet<Uuid>>>,
    pub image_status: Arc<RwLock<ImageStatus>>,
    /// The git proxy sidecar (status, clone operations).
    pub git_proxy: Arc<GitProxyState>,
    /// Login backoff (off under `WORK_HUB_ENV=test`, as Log Hub's is under `NODE_ENV=test`).
    pub backoff: Arc<LoginBackoff>,
    /// Rate limit of signup / forgot / resend / reset.
    pub rate_limit: Arc<RateLimiter>,
    /// Outbound e-mail (confirm / reset links, password-changed notice).
    pub mailer: Arc<Mailer>,
    /// Azure Entra ID sign-in (used in `azure-oauth` only; built lazily).
    pub azure: Arc<AzureAuth>,
    /// What `delete-account` removes before the user (no-op until the workspace service).
    pub account_cleanup: Arc<dyn AccountCleanup>,
}

impl AppState {
    /// `Err` when the SMTP settings cannot be turned into a transport.
    pub fn new(config: Config, db: PgPool, docker: DockerClient) -> Result<Self, String> {
        let mailer = Arc::new(Mailer::from_config(&config)?);
        let azure = Arc::new(AzureAuth::new(AzureSettings::from_env(&config.auth_env)));
        let clock: Arc<dyn Clock> = Arc::new(SystemClock::new());
        let backoff = Arc::new(LoginBackoff::new(config.env != RunEnv::Test, clock.clone()));
        let rate_limit = Arc::new(RateLimiter::new(
            config.auth.rate_limit_points,
            config.auth.rate_limit_window_sec,
            clock,
        ));
        let mut state = AppState {
            config: Arc::new(config),
            db,
            docker,
            agents: Arc::new(AgentRegistry::new()),
            locks: Arc::new(ContainerLocks::new()),
            terminals: Arc::new(TerminalHub::new()),
            unavailable: Arc::new(Mutex::new(HashSet::new())),
            image_status: Arc::new(RwLock::new(ImageStatus::Building)),
            git_proxy: Arc::new(GitProxyState::new()),
            backoff,
            rate_limit,
            mailer,
            azure,
            account_cleanup: Arc::new(NoopAccountCleanup),
        };
        // The cleanup holds a copy of the state with the no-op cleanup, so there is no cycle.
        state.account_cleanup = Arc::new(WorkspaceAccountCleanup::new(state.clone()));
        Ok(state)
    }
}
