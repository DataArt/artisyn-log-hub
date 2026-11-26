//! The engine: a tokio runtime on background threads that runs [`Command`]s and keeps the
//! [`Snapshot`] the UI renders. The UI never blocks on Docker: [`Engine::run`] returns at once
//! with the action's id, and progress shows up in [`Engine::snapshot`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agentbook_core::state::{LoadedState, State, StateError, parse_state, write_state};
use agentbook_platform::{CREDENTIAL_PREFIX, DockerEndpoint, Platform};

use crate::action::Action;
use crate::docker::{self, Docker, DockerError};
use crate::layout::DataLayout;
use crate::lifecycle::{GivenChange, GivenInput, LaptopDraft};
use crate::lock::{InstanceLock, LockError};
use crate::snapshot::{
    ActionView, DockerStatus, FolderEquipment, FolderView, LaptopView, OpensshStatus, RunState,
    Snapshot,
};
use crate::vars::VarEdit;
use crate::{context, deps, equipment, lifecycle, poller, vars};

/// The scenario label put on every Docker object a scenario stand creates.
pub const INSTANCE_LABEL: &str = "artisyn.agentbook.instance";

/// Opens `claude://` links in place of the OS handler (scenario stands record them).
pub trait DesktopLauncher: Send + Sync {
    fn open(&self, url: &str);
}

/// Scenario hooks: a constructor argument, never a CLI flag or variable.
#[derive(Clone)]
pub struct EngineTestConfig {
    /// Put on every Docker object as [`INSTANCE_LABEL`]; the stand removes only these.
    pub instance: String,
    /// Replaces nodejs.org / registry.npmjs.org: `<base>/nodejs/dist/…` and `<base>/npm/…`.
    pub download_base: Option<String>,
    pub desktop_launcher: Option<Arc<dyn DesktopLauncher>>,
    /// `AgentBook-test-<instance>/`.
    pub credential_prefix: String,
}

impl EngineTestConfig {
    pub fn new(instance: &str) -> Self {
        Self {
            instance: instance.to_string(),
            download_base: None,
            desktop_launcher: None,
            credential_prefix: format!("AgentBook-test-{instance}/"),
        }
    }
}

impl std::fmt::Debug for EngineTestConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineTestConfig")
            .field("instance", &self.instance)
            .field("download_base", &self.download_base)
            .field("credential_prefix", &self.credential_prefix)
            .finish_non_exhaustive()
    }
}

/// What the UI asks the engine to do. Each run is an action in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Docker endpoint and engine, OpenSSH, the `docker` CLI (FR-9, FR-10).
    CheckPrerequisites,
    /// The first-launch downloads; also Retry (FR-10). Items already present are skipped.
    DownloadDependencies,
    /// Recomputes the Equipment hash and host-exposure warnings of one folder or all.
    CheckEquipment {
        folder: Option<String>,
    },
    /// Builds the laptop's Equipment and creates its container, when it has none yet (first
    /// start, or Retry after a failed first build).
    GetEquipment {
        laptop: String,
    },
    /// "Update laptop": rebuild and replace the container, keeping the volume (FR-7).
    UpdateLaptop {
        laptop: String,
    },
    /// FR-1: add a shared folder (or pick the one with the same path). `config`: the devcontainer
    /// config to use, else the first one found, else the standard Equipment. A whole-disk, home
    /// or home-ancestor path needs `confirm_broad`.
    AddFolder {
        path: String,
        config: Option<String>,
        confirm_broad: bool,
    },
    /// The answer to the one-time `.claude/` question (a relative path, `""` = the root).
    ChooseClaudeDir {
        folder: String,
        dir: String,
    },
    /// Picks the folder's devcontainer config (`None`: the standard Equipment).
    ChooseEquipment {
        folder: String,
        config: Option<String>,
    },
    /// "Get a laptop" / "Another laptop like this" (`copy_from`: its "Only for one laptop"
    /// variables are copied): creates the laptop and opens Desktop on it.
    GetLaptop {
        folder: String,
        name: String,
        given: Vec<GivenInput>,
        copy_from: Option<String>,
        confirm_broad: bool,
    },
    /// "Open laptop": wakes it when needed and opens Desktop on it.
    Open {
        laptop: String,
    },
    /// "Sleep": stops the container, keeping the volume.
    Sleep {
        laptop: String,
    },
    /// "Wake up": starts it without opening Desktop.
    WakeUp {
        laptop: String,
    },
    Rename {
        laptop: String,
        name: String,
    },
    /// "Give a folder" on the go (recreates the container, volume kept).
    GiveFolder {
        laptop: String,
        path: String,
        read_only: bool,
        confirm_broad: bool,
    },
    /// Changes a given folder's mode (recreates the container).
    SetGivenMode {
        laptop: String,
        path: String,
        read_only: bool,
    },
    /// Removes a given folder (recreates the container).
    RemoveGiven {
        laptop: String,
        path: String,
    },
    /// FR-6: removes the container, volume, alias and record. Folders are never touched.
    RemoveLaptop {
        laptop: String,
    },
    /// Removes the folder from the list with its laptops. The folder on disk is never touched.
    RemoveFolder {
        folder: String,
    },
    /// "Locate folder…": re-points the folder and recreates its laptops (volumes kept).
    LocateFolder {
        folder: String,
        path: String,
        confirm_broad: bool,
    },
    /// "Variables…": the folder-wide list and, per listed laptop, its "Only for one laptop" list.
    SetVariables {
        folder: String,
        vars: Vec<VarEdit>,
        laptop_vars: Vec<(String, Vec<VarEdit>)>,
    },
}

/// Why the engine could not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineStartError {
    /// Another AgentBook holds the data folder.
    AlreadyRunning,
    Lock(String),
    Runtime(String),
}

impl std::fmt::Display for EngineStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning => f.write_str(crate::lock::ALREADY_RUNNING_MESSAGE),
            Self::Lock(m) | Self::Runtime(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for EngineStartError {}

/// A failed engine operation: the plain message for the user (the log has the detail).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError(pub String);

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EngineError {}

impl From<DockerError> for EngineError {
    fn from(e: DockerError) -> Self {
        Self(e.plain_message())
    }
}

impl From<StateError> for EngineError {
    fn from(e: StateError) -> Self {
        Self(e.to_string())
    }
}

pub type EngineResult<T> = Result<T, EngineError>;

type CachedDocker = (Docker, DockerEndpoint, Option<Arc<docker::bridge::Bridge>>);

/// The shared engine state every task works with.
pub(crate) struct Ctx {
    pub platform: Arc<dyn Platform>,
    pub layout: DataLayout,
    pub test: Option<EngineTestConfig>,
    pub http: reqwest::Client,
    state: Mutex<LoadedState>,
    snapshot: Mutex<Snapshot>,
    /// The client, its endpoint and, for a Docker engine inside WSL, the bridge it talks through
    /// (dropped with the client).
    docker: tokio::sync::Mutex<Option<CachedDocker>>,
    laptop_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    next_action: AtomicU64,
    /// Folders whose `.claude/` question is open, with the choices.
    claude_choices: Mutex<HashMap<String, Vec<String>>>,
}

impl Ctx {
    pub fn update_snapshot(&self, f: impl FnOnce(&mut Snapshot)) {
        if let Ok(mut s) = self.snapshot.lock() {
            f(&mut s);
        }
    }

    pub fn read_snapshot<T>(&self, f: impl FnOnce(&Snapshot) -> T) -> T {
        match self.snapshot.lock() {
            Ok(s) => f(&s),
            Err(poisoned) => f(&poisoned.into_inner()),
        }
    }

    /// A copy of the current `state.json` content.
    pub fn state(&self) -> State {
        match self.state.lock() {
            Ok(s) => s.state.clone(),
            Err(poisoned) => poisoned.into_inner().state.clone(),
        }
    }

    /// Changes the state and writes `state.json` (temp file, then rename). A read-only state
    /// (written by a newer AgentBook) is never changed.
    pub fn modify_state(&self, f: impl FnOnce(&mut State)) -> EngineResult<()> {
        let text = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| EngineError("the state lock is poisoned".into()))?;
            if guard.read_only {
                return Err(StateError::ReadOnly.into());
            }
            let mut next = guard.state.clone();
            f(&mut next);
            let candidate = LoadedState {
                state: next,
                read_only: false,
            };
            let text = write_state(&candidate)?;
            *guard = candidate;
            text
        };
        let path = self.layout.state_file();
        let tmp = path.with_extension("json.tmp");
        std::fs::create_dir_all(self.layout.root())
            .and_then(|()| std::fs::write(&tmp, text))
            .and_then(|()| std::fs::rename(&tmp, &path))
            .map_err(|e| EngineError(format!("cannot write {}: {e}", path.display())))?;
        self.refresh_views();
        Ok(())
    }

    /// Re-derives the folder and laptop views from the state, keeping the known Equipment
    /// results and the poller's run states, session counts and notes.
    pub fn refresh_views(&self) {
        let state = self.state();
        // File-system facts first, outside the snapshot lock.
        let fs_facts: HashMap<String, (bool, Vec<String>, Vec<crate::repos::RepoView>)> = state
            .folders
            .iter()
            .map(|f| {
                let root = Path::new(&f.path);
                let configs = lifecycle::devcontainer_configs(root);
                let configs = if configs.len() > 1 {
                    configs
                } else {
                    Vec::new()
                };
                (
                    f.id.clone(),
                    (!root.is_dir(), configs, crate::repos::scan(root)),
                )
            })
            .collect();
        let missing: HashMap<String, Vec<String>> = state
            .laptops
            .iter()
            .filter_map(|l| {
                let f = state.folders.iter().find(|f| f.id == l.folder_id)?;
                Some((l.id.clone(), lifecycle::missing_sources(f, l)))
            })
            .collect();
        let choices = match self.claude_choices.lock() {
            Ok(m) => m.clone(),
            Err(p) => p.into_inner().clone(),
        };
        self.update_snapshot(|s| {
            s.recent.clone_from(&state.recent);
            let old: HashMap<String, FolderEquipment> = s
                .folders
                .iter()
                .map(|f| (f.folder.id.clone(), f.equipment.clone()))
                .collect();
            type Kept = (RunState, u32, Option<String>, Option<u64>);
            let old_laptops: HashMap<String, Kept> = s
                .laptops
                .iter()
                .map(|l| {
                    let kept = (l.run, l.sessions, l.note.clone(), l.claude_setup_kb);
                    (l.laptop.id.clone(), kept)
                })
                .collect();
            s.folders = state
                .folders
                .iter()
                .map(|f| {
                    let equipment = old.get(&f.id).cloned().unwrap_or_default();
                    let (gone, configs, repos) = fs_facts.get(&f.id).cloned().unwrap_or_default();
                    FolderView {
                        variables: vars::folder_rows(&equipment.defaults, f, &state.laptops),
                        folder: f.clone(),
                        equipment,
                        missing: gone,
                        claude_choices: choices.get(&f.id).cloned().unwrap_or_default(),
                        config_choices: configs,
                        repos,
                    }
                })
                .collect();
            let folders = &s.folders;
            s.laptops = state
                .laptops
                .iter()
                .map(|l| {
                    let folder = folders.iter().find(|f| f.folder.id == l.folder_id);
                    let hash = folder.and_then(|f| f.equipment.hash.clone());
                    let needs_value = folder
                        .map(|f| {
                            vars::effective(&f.equipment.defaults, &f.folder, Some(l))
                                .into_iter()
                                .filter(|v| v.editable && v.needs_value)
                                .map(|v| v.name)
                                .collect()
                        })
                        .unwrap_or_default();
                    let duplicate_name = state.laptops.iter().any(|o| {
                        o.id != l.id
                            && o.folder_id == l.folder_id
                            && o.name.trim().eq_ignore_ascii_case(l.name.trim())
                    });
                    let (run, sessions, note, claude_setup_kb) =
                        old_laptops.get(&l.id).cloned().unwrap_or_default();
                    LaptopView {
                        laptop: l.clone(),
                        equipment: hash.map(|h| {
                            agentbook_core::equipment::equipment_state(
                                l.equipment_hash.as_deref(),
                                &h,
                            )
                        }),
                        run,
                        sessions,
                        duplicate_name,
                        needs_value,
                        missing_sources: missing.get(&l.id).cloned().unwrap_or_default(),
                        note,
                        claude_setup_kb,
                    }
                })
                .collect();
        });
    }

    /// Records a laptop's run state (and session count, when known).
    pub fn set_run(&self, laptop: &str, run: RunState, sessions: Option<u32>) {
        self.update_snapshot(|s| {
            if let Some(l) = s.laptops.iter_mut().find(|l| l.laptop.id == laptop) {
                l.run = run;
                if let Some(n) = sessions {
                    l.sessions = n;
                }
                if run != RunState::Working {
                    l.sessions = 0;
                    l.claude_setup_kb = None;
                }
            }
        });
    }

    /// Sets (or clears) "Claude Desktop is setting up Claude" on a laptop card.
    pub fn set_claude_setup(&self, laptop: &str, kb: Option<u64>) {
        self.update_snapshot(|s| {
            if let Some(l) = s.laptops.iter_mut().find(|l| l.laptop.id == laptop) {
                l.claude_setup_kb = kb;
            }
        });
    }

    /// Sets (or clears) a laptop card's one-line note.
    pub fn set_note(&self, laptop: &str, note: Option<String>) {
        self.update_snapshot(|s| {
            if let Some(l) = s.laptops.iter_mut().find(|l| l.laptop.id == laptop) {
                l.note = note;
            }
        });
    }

    /// Opens (non-empty) or closes (empty) a folder's `.claude/` question.
    pub fn set_claude_choices(&self, folder: &str, choices: Vec<String>) {
        let mut map = match self.claude_choices.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        if choices.is_empty() {
            map.remove(folder);
        } else {
            map.insert(folder.to_string(), choices);
        }
    }

    /// The Docker client, connecting (and resolving the endpoint) on first use or after a
    /// failure. The error is the plain FR-9 message.
    pub async fn docker(&self) -> EngineResult<Docker> {
        Ok(self.docker_with_endpoint().await?.0)
    }

    pub async fn docker_with_endpoint(&self) -> EngineResult<(Docker, DockerEndpoint)> {
        let mut guard = self.docker.lock().await;
        if let Some((client, endpoint, _)) = guard.as_ref() {
            return Ok((client.clone(), endpoint.clone()));
        }
        let platform = self.platform.clone();
        let endpoint = tokio::task::spawn_blocking(move || platform.docker_endpoint())
            .await
            .map_err(|e| EngineError(e.to_string()))?
            .map_err(|e| EngineError(docker::endpoint_message(&e)))?;
        let (client, bridge) = if self.platform.docker_dial_command(&endpoint).is_some() {
            let bridge = docker::bridge::start(self.platform.clone(), &endpoint).await?;
            (docker::connect_url(&bridge.url)?, Some(Arc::new(bridge)))
        } else {
            (docker::connect(&endpoint)?, None)
        };
        *guard = Some((client.clone(), endpoint.clone(), bridge));
        Ok((client, endpoint))
    }

    /// Forgets the client (after the engine went away), so the next call resolves again.
    pub async fn reset_docker(&self) {
        *self.docker.lock().await = None;
    }

    /// Serialises work on one laptop.
    pub fn laptop_lock(&self, laptop: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = match self.laptop_locks.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        map.entry(laptop.to_string()).or_default().clone()
    }

    /// `artisyn.agentbook=1` plus the scenario instance label.
    pub fn base_labels(&self) -> Vec<(String, String)> {
        let mut labels = vec![("artisyn.agentbook".to_string(), "1".to_string())];
        if let Some(t) = &self.test {
            labels.push((INSTANCE_LABEL.to_string(), t.instance.clone()));
        }
        labels
    }

    pub fn instance(&self) -> Option<&str> {
        self.test.as_ref().map(|t| t.instance.as_str())
    }

    /// The credential-name prefix (Hidden variables).
    pub fn credential_prefix(&self) -> &str {
        self.test
            .as_ref()
            .map(|t| t.credential_prefix.as_str())
            .unwrap_or(CREDENTIAL_PREFIX)
    }

    pub fn new_action(
        self: &Arc<Self>,
        kind: &str,
        laptop: Option<&str>,
        folder: Option<&str>,
    ) -> Action {
        let id = self.next_action.fetch_add(1, Ordering::SeqCst);
        Action::start(self, id, kind, laptop, folder)
    }
}

/// The engine handle the UI (and the scenario suite) holds.
pub struct Engine {
    ctx: Arc<Ctx>,
    runtime: tokio::runtime::Runtime,
    _lock: InstanceLock,
}

impl Engine {
    /// Takes the single-instance lock on the data folder (the platform's, or `data_dir_override`),
    /// loads `state.json` and starts the background runtime, which checks the prerequisites,
    /// the downloads and every folder's Equipment.
    pub fn new(
        platform: Arc<dyn Platform>,
        data_dir_override: Option<PathBuf>,
        test: Option<EngineTestConfig>,
    ) -> Result<Engine, EngineStartError> {
        let root = data_dir_override.unwrap_or_else(|| platform.data_dir());
        let layout = DataLayout::new(root);
        let lock = InstanceLock::acquire(&layout.lock_file()).map_err(|e| match e {
            LockError::AlreadyRunning => EngineStartError::AlreadyRunning,
            LockError::Io(m) => EngineStartError::Lock(m),
        })?;
        let (loaded, state_error) = load_state(&layout);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("agentbook-engine")
            .enable_all()
            .build()
            .map_err(|e| EngineStartError::Runtime(e.to_string()))?;
        let mut http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .user_agent(concat!("AgentBook/", env!("CARGO_PKG_VERSION")));
        if test.as_ref().is_some_and(|t| t.download_base.is_some()) {
            // The stand's file server is on loopback: never through a proxy.
            http = http.no_proxy();
        }
        let http = http
            .build()
            .map_err(|e| EngineStartError::Runtime(e.to_string()))?;
        let snapshot = Snapshot {
            state_read_only: loaded.read_only,
            state_error,
            dependencies: deps::initial_list(),
            ..Snapshot::default()
        };
        let ctx = Arc::new(Ctx {
            platform,
            layout,
            test,
            http,
            state: Mutex::new(loaded),
            snapshot: Mutex::new(snapshot),
            docker: tokio::sync::Mutex::new(None),
            laptop_locks: Mutex::new(HashMap::new()),
            next_action: AtomicU64::new(1),
            claude_choices: Mutex::new(HashMap::new()),
        });
        ctx.refresh_views();
        let engine = Engine {
            ctx,
            runtime,
            _lock: lock,
        };
        let ctx = engine.ctx.clone();
        engine.runtime.spawn(async move {
            let _ = context::write_tool_files(&ctx);
            prerequisites(&ctx).await;
            tokio::spawn(poller::run(ctx.clone()));
            deps::refresh_status(&ctx).await;
            lifecycle::scan_pending_claude_dirs(&ctx).await;
            equipment::check_all(&ctx, None).await;
        });
        Ok(engine)
    }

    /// The data folder in use.
    pub fn data_dir(&self) -> PathBuf {
        self.ctx.layout.root().to_path_buf()
    }

    /// Starts a command; returns its action id at once.
    pub fn run(&self, command: Command) -> u64 {
        let ctx = self.ctx.clone();
        // New folders and laptops get their id now, so the action names them at once.
        let new_id = lifecycle::new_id(&ctx.state());
        let some = |s: &String| Some(s.clone());
        let (kind, laptop, folder) = match &command {
            Command::CheckPrerequisites => ("prerequisites", None, None),
            Command::DownloadDependencies => ("download", None, None),
            Command::CheckEquipment { folder } => ("check-equipment", None, folder.clone()),
            Command::GetEquipment { laptop } => ("get-equipment", some(laptop), None),
            Command::UpdateLaptop { laptop } => ("update", some(laptop), None),
            Command::AddFolder { .. } => ("add-folder", None, Some(new_id.clone())),
            Command::ChooseClaudeDir { folder, .. } => ("choose-claude-dir", None, some(folder)),
            Command::ChooseEquipment { folder, .. } => ("choose-equipment", None, some(folder)),
            Command::GetLaptop { folder, .. } => ("get-laptop", Some(new_id.clone()), some(folder)),
            Command::Open { laptop } => ("open", some(laptop), None),
            Command::Sleep { laptop } => ("sleep", some(laptop), None),
            Command::WakeUp { laptop } => ("wake-up", some(laptop), None),
            Command::Rename { laptop, .. } => ("rename", some(laptop), None),
            Command::GiveFolder { laptop, .. } => ("give-folder", some(laptop), None),
            Command::SetGivenMode { laptop, .. } => ("given-mode", some(laptop), None),
            Command::RemoveGiven { laptop, .. } => ("remove-given", some(laptop), None),
            Command::RemoveLaptop { laptop } => ("remove-laptop", some(laptop), None),
            Command::RemoveFolder { folder } => ("remove-folder", None, some(folder)),
            Command::LocateFolder { folder, .. } => ("locate-folder", None, some(folder)),
            Command::SetVariables { folder, .. } => ("variables", None, some(folder)),
        };
        let action = ctx.new_action(kind, laptop.as_deref(), folder.as_deref());
        let id = action.id;
        self.runtime.spawn(async move {
            let result = match command {
                Command::CheckPrerequisites => {
                    prerequisites(&ctx).await;
                    Ok(())
                }
                Command::DownloadDependencies => deps::download_all(&ctx, &action).await,
                Command::CheckEquipment { folder } => {
                    equipment::check_all(&ctx, folder.as_deref()).await;
                    Ok(())
                }
                Command::GetEquipment { laptop } => {
                    lifecycle::equipment_action(&ctx, &laptop, false, &action).await
                }
                Command::UpdateLaptop { laptop } => {
                    lifecycle::equipment_action(&ctx, &laptop, true, &action).await
                }
                Command::AddFolder {
                    path,
                    config,
                    confirm_broad,
                } => {
                    lifecycle::add_folder(&ctx, &new_id, &path, config, confirm_broad, &action)
                        .await
                }
                Command::ChooseClaudeDir { folder, dir } => {
                    lifecycle::choose_claude_dir(&ctx, &folder, &dir)
                }
                Command::ChooseEquipment { folder, config } => {
                    lifecycle::choose_equipment(&ctx, &folder, config).await
                }
                Command::GetLaptop {
                    folder,
                    name,
                    given,
                    copy_from,
                    confirm_broad,
                } => {
                    lifecycle::get_laptop(
                        &ctx,
                        &new_id,
                        &folder,
                        &name,
                        &given,
                        copy_from.as_deref(),
                        confirm_broad,
                        &action,
                    )
                    .await
                }
                Command::Open { laptop } => lifecycle::open(&ctx, &laptop, true, &action).await,
                Command::WakeUp { laptop } => lifecycle::open(&ctx, &laptop, false, &action).await,
                Command::Sleep { laptop } => lifecycle::sleep(&ctx, &laptop).await,
                Command::Rename { laptop, name } => lifecycle::rename(&ctx, &laptop, &name),
                Command::GiveFolder {
                    laptop,
                    path,
                    read_only,
                    confirm_broad,
                } => {
                    let change = GivenChange::Give { path, read_only };
                    lifecycle::change_given(&ctx, &laptop, &change, confirm_broad, &action).await
                }
                Command::SetGivenMode {
                    laptop,
                    path,
                    read_only,
                } => {
                    let change = GivenChange::SetMode { path, read_only };
                    lifecycle::change_given(&ctx, &laptop, &change, true, &action).await
                }
                Command::RemoveGiven { laptop, path } => {
                    let change = GivenChange::Remove { path };
                    lifecycle::change_given(&ctx, &laptop, &change, true, &action).await
                }
                Command::RemoveLaptop { laptop } => {
                    lifecycle::remove_laptop(&ctx, &laptop, &action).await
                }
                Command::RemoveFolder { folder } => {
                    lifecycle::remove_folder(&ctx, &folder, &action).await
                }
                Command::LocateFolder {
                    folder,
                    path,
                    confirm_broad,
                } => lifecycle::locate_folder(&ctx, &folder, &path, confirm_broad, &action).await,
                Command::SetVariables {
                    folder,
                    vars,
                    laptop_vars,
                } => set_variables(&ctx, &folder, &vars, &laptop_vars).await,
            };
            match result {
                Ok(()) => action.done(),
                Err(e) => action.fail(&e.0),
            }
        });
        id
    }

    /// The first free "Laptop N" of a folder (the Get a laptop dialog's suggestion).
    pub fn suggest_name(&self, folder: &str) -> String {
        lifecycle::suggest_name(&self.ctx.state(), folder)
    }

    /// What "Another laptop like this" pre-fills for `laptop`.
    pub fn like_this(&self, laptop: &str) -> Option<LaptopDraft> {
        lifecycle::like_this(&self.ctx.state(), laptop)
    }

    /// The latest snapshot.
    pub fn snapshot(&self) -> Snapshot {
        self.ctx.read_snapshot(Clone::clone)
    }

    /// Waits until the action has finished (or `timeout` passed) and returns its last view.
    pub fn wait(&self, action: u64, timeout: Duration) -> Option<ActionView> {
        let deadline = Instant::now() + timeout;
        loop {
            let view = self.ctx.read_snapshot(|s| s.action(action).cloned());
            match view {
                Some(v) if v.finished() => return Some(v),
                _ if Instant::now() >= deadline => return view,
                _ => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    /// Runs a future on the engine's runtime (scenario checks).
    pub fn block_on<F: std::future::Future>(&self, f: F) -> F::Output {
        self.runtime.block_on(f)
    }

    /// The Docker client the engine uses (scenario checks).
    pub fn docker_client(&self) -> EngineResult<Docker> {
        let ctx = self.ctx.clone();
        self.runtime.block_on(async move { ctx.docker().await })
    }
}

fn load_state(layout: &DataLayout) -> (LoadedState, Option<String>) {
    let path = layout.state_file();
    match std::fs::read_to_string(&path) {
        Ok(text) => match parse_state(&text) {
            Ok(loaded) => (loaded, None),
            // An unreadable file is shown, never overwritten.
            Err(e) => (
                LoadedState {
                    state: State::default(),
                    read_only: true,
                },
                Some(e.to_string()),
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
            LoadedState {
                state: State::default(),
                read_only: false,
            },
            None,
        ),
        Err(e) => (
            LoadedState {
                state: State::default(),
                read_only: true,
            },
            Some(format!("cannot read {}: {e}", path.display())),
        ),
    }
}

/// FR-9 / FR-10: the engine, OpenSSH and the `docker` CLI.
pub(crate) async fn prerequisites(ctx: &Arc<Ctx>) {
    ctx.reset_docker().await;
    let docker_status = match ctx.docker_with_endpoint().await {
        Ok((client, endpoint)) => match docker::engine_info(&client).await {
            Ok(info) => DockerStatus::Ok(info),
            Err(e) => DockerStatus::Failed {
                message: e.plain_message(),
                probed: endpoint.probed.clone(),
            },
        },
        Err(e) => {
            let platform = ctx.platform.clone();
            let probed = tokio::task::spawn_blocking(move || {
                platform
                    .docker_endpoint()
                    .err()
                    .map(|e| e.probed().to_vec())
                    .unwrap_or_default()
            })
            .await
            .unwrap_or_default();
            DockerStatus::Failed {
                message: e.0,
                probed,
            }
        }
    };
    if matches!(docker_status, DockerStatus::Failed { .. }) {
        ctx.reset_docker().await;
    }
    let platform = ctx.platform.clone();
    let (openssh, docker_cli) = tokio::task::spawn_blocking(move || {
        let openssh = if !platform.is_windows() {
            OpensshStatus::Ok(String::new())
        } else {
            match platform.openssh_version() {
                Some(v) if v.meets_floor() => OpensshStatus::Ok(v.raw),
                Some(v) => OpensshStatus::Failed(format!(
                    "AgentBook needs OpenSSH 9.4 or later; this computer has {}. Update OpenSSH \
                     (Windows Settings > System > Optional features, or the Win32-OpenSSH \
                     release).",
                    v.raw
                )),
                None => OpensshStatus::Failed(
                    "AgentBook needs OpenSSH 9.4 or later, and no ssh command was found. Install \
                     OpenSSH (Windows Settings > System > Optional features)."
                        .to_string(),
                ),
            }
        };
        (openssh, platform.find_program("docker"))
    })
    .await
    .unwrap_or((OpensshStatus::Unknown, None));
    ctx.update_snapshot(|s| {
        s.docker = docker_status;
        s.openssh = openssh;
        s.docker_cli = docker_cli;
    });
}

/// The plain message when project Equipment needs the `docker` command and it is missing.
pub const NEEDS_DOCKER_CLI_MESSAGE: &str = "This folder's devcontainer needs the docker command, \
     which was not found. Install the Docker CLI (it comes with Docker Desktop and Rancher \
     Desktop) and try again.";

impl Ctx {
    /// The `docker` executable for the devcontainer CLI, or the plain message.
    pub fn docker_cli(&self) -> EngineResult<PathBuf> {
        self.platform
            .find_program("docker")
            .ok_or_else(|| EngineError(NEEDS_DOCKER_CLI_MESSAGE.to_string()))
    }
}

/// "Variables…": stores the settings, then rewrites the env file of every running laptop of the
/// folder and the folder's state files (variable names). New sessions see the new values.
async fn set_variables(
    ctx: &Arc<Ctx>,
    folder: &str,
    folder_vars: &[VarEdit],
    laptop_vars: &[(String, Vec<VarEdit>)],
) -> EngineResult<()> {
    let ctx2 = ctx.clone();
    let (f, fv, lv) = (
        folder.to_string(),
        folder_vars.to_vec(),
        laptop_vars.to_vec(),
    );
    tokio::task::spawn_blocking(move || vars::set_variables(&ctx2, &f, &fv, &lv))
        .await
        .map_err(|e| EngineError(e.to_string()))??;
    context::write_folder_state(ctx, folder)?;
    let state = ctx.state();
    let Some(folder_rec) = state.folders.iter().find(|f| f.id == folder) else {
        return Ok(());
    };
    let docker = ctx.docker().await?;
    for laptop in state.laptops.iter().filter(|l| l.folder_id == folder) {
        if let Some(c) = equipment::main_container(&docker, laptop)
            .await?
            .filter(|c| c.running())
        {
            vars::deliver(ctx, &docker, &c.id, folder_rec, laptop).await?;
        }
    }
    Ok(())
}
