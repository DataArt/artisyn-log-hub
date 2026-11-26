//! What the UI renders: the latest [`Snapshot`] of folders, laptops, prerequisites, downloads and
//! running actions. The engine replaces parts of it as work progresses; the UI only reads clones.

use std::path::PathBuf;

use agentbook_core::equipment::EquipmentState;
use agentbook_core::host_exposure::Exposure;
use agentbook_core::state::{Folder, Laptop};

use crate::docker::EngineInfo;

#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub docker: DockerStatus,
    pub openssh: OpensshStatus,
    /// The `docker` CLI on PATH (project Equipment needs it; the standard Equipment does not).
    pub docker_cli: Option<PathBuf>,
    pub dependencies: Vec<Dependency>,
    /// The dependency states were read from disk and Docker at least once (before that every
    /// item shows Missing).
    pub dependencies_checked: bool,
    /// `state.json` was written by a newer AgentBook (or could not be read): nothing is saved.
    pub state_read_only: bool,
    /// Why `state.json` could not be read, when it could not.
    pub state_error: Option<String>,
    pub folders: Vec<FolderView>,
    pub laptops: Vec<LaptopView>,
    /// Recently chosen folder paths, newest first (the choose-folder screen).
    pub recent: Vec<String>,
    /// Recent and running actions, oldest first.
    pub actions: Vec<ActionView>,
}

impl Snapshot {
    pub fn action(&self, id: u64) -> Option<&ActionView> {
        self.actions.iter().find(|a| a.id == id)
    }

    pub fn folder(&self, id: &str) -> Option<&FolderView> {
        self.folders.iter().find(|f| f.folder.id == id)
    }

    pub fn laptop(&self, id: &str) -> Option<&LaptopView> {
        self.laptops.iter().find(|l| l.laptop.id == id)
    }

    pub fn dependency(&self, id: DependencyId) -> Option<&Dependency> {
        self.dependencies.iter().find(|d| d.id == id)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum DockerStatus {
    #[default]
    Unknown,
    Ok(EngineInfo),
    /// The plain message (FR-9) and what was probed.
    Failed {
        message: String,
        probed: Vec<String>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum OpensshStatus {
    #[default]
    Unknown,
    Ok(String),
    /// The plain message naming what to update.
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DependencyId {
    Node,
    DevcontainersCli,
    StandardEquipment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyState {
    Missing,
    Downloading,
    Ready,
    /// The plain message with what to do (Retry).
    Failed(String),
}

/// One first-launch download (FR-10): name, version, size and progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub id: DependencyId,
    pub name: String,
    pub version: String,
    /// Bytes to download.
    pub size: u64,
    /// Bytes downloaded so far.
    pub done: u64,
    pub state: DependencyState,
    /// What is happening now (`Downloading`, `Building the standard Equipment`, …).
    pub detail: String,
}

/// A host-exposure finding, as the warning names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExposureView {
    /// `writable-bind`, `docker-socket`, `privileged`, `host-network`, `host-pid`.
    pub kind: String,
    pub text: String,
}

impl ExposureView {
    pub fn from_exposure(e: &Exposure) -> Self {
        let text = match e {
            Exposure::WritableBind(s) => {
                format!("The devcontainer gives the laptop write access to {s} on this computer.")
            }
            Exposure::DockerSocket(s) => format!(
                "The devcontainer mounts the Docker socket ({s}): programs in the laptop can \
                 control Docker on this computer."
            ),
            Exposure::Privileged => {
                "The devcontainer runs the laptop privileged (full access to this computer's \
                 devices)."
                    .to_string()
            }
            Exposure::HostNetwork => {
                "The devcontainer puts the laptop on this computer's network.".to_string()
            }
            Exposure::HostPid => {
                "The devcontainer lets the laptop see this computer's processes.".to_string()
            }
        };
        Self {
            kind: e.kind().to_string(),
            text,
        }
    }
}

/// The Equipment of a folder as last checked (at start and before every Open).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderEquipment {
    /// The current config hash; `None` until checked or when the check failed.
    pub hash: Option<String>,
    pub exposures: Vec<ExposureView>,
    /// Why the check failed (devcontainer tools missing, unreadable config, …).
    pub error: Option<String>,
    /// The project's variable defaults (`containerEnv`, then `remoteEnv`), in order.
    pub defaults: Vec<(String, String)>,
}

/// A variable value as the UI shows it: hidden values are never in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarShown {
    Plain(String),
    Hidden,
}

/// One row of a folder's Variables dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderVariable {
    pub name: String,
    /// The devcontainer's value, when it declares the name.
    pub project_default: Option<String>,
    /// The folder-wide setting, when there is one.
    pub folder: Option<VarShown>,
    /// "Only for one laptop" settings: (laptop id, value).
    pub laptops: Vec<(String, VarShown)>,
    /// The effective folder-wide value is empty ("needs a value").
    pub needs_value: bool,
}

#[derive(Debug, Clone)]
pub struct FolderView {
    pub folder: Folder,
    pub equipment: FolderEquipment,
    /// The folder's path no longer exists ("Locate folder…").
    pub missing: bool,
    /// Several `.claude/` folders were found and none chosen yet: ask once (relative paths,
    /// `""` = the root).
    pub claude_choices: Vec<String>,
    /// The devcontainer configs found in the folder, when there are several (relative paths).
    pub config_choices: Vec<String>,
    /// The Variables dialog rows (editable variables only).
    pub variables: Vec<FolderVariable>,
    /// The git repos in the folder (the folder itself and its direct subfolders).
    pub repos: Vec<crate::repos::RepoView>,
}

/// Whether a laptop's container runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RunState {
    /// Not looked at yet.
    #[default]
    Unknown,
    /// No container yet (Equipment not built, or a failed first build).
    NotCreated,
    Working,
    /// Stopped (by Sleep, or outside the tool).
    Sleeping,
}

impl RunState {
    /// The word in the in-container state files (`working` / `sleeping`).
    pub fn state_word(self) -> &'static str {
        match self {
            Self::Working => "working",
            _ => "sleeping",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaptopView {
    pub laptop: Laptop,
    /// Against the folder's current hash; `None` while that is unknown.
    pub equipment: Option<EquipmentState>,
    /// Working / Sleeping, from the poller (every 5 s) and the engine's own actions.
    pub run: RunState,
    /// Attached Desktop sessions (established SSH connections), while Working.
    pub sessions: u32,
    /// Another laptop of the same folder has the same name (a note, not a block).
    pub duplicate_name: bool,
    /// Variables whose effective value is empty ("N variables need a value").
    pub needs_value: Vec<String>,
    /// Bind sources (shared or given folders) that no longer exist; Open refuses to start.
    pub missing_sources: Vec<String>,
    /// A one-line note from the last action (e.g. a port reallocation).
    pub note: Option<String>,
    /// While Claude Desktop sets up Claude on the laptop (it copies its server and the Claude Code
    /// CLI into `~/.claude/remote` over SFTP the first time it connects): the KB copied so far.
    /// From the poller; `None` otherwise.
    pub claude_setup_kb: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionState {
    Running,
    Done,
    /// The plain message; the log tail stays in [`ActionView::log_tail`] (Copy log, Retry).
    Failed {
        message: String,
    },
}

/// A long action (download, build, update, recreate) with its progress and log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionView {
    pub id: u64,
    /// `download`, `get-equipment`, `update`, `recreate`, `check-equipment`, `prerequisites`.
    pub kind: String,
    pub laptop: Option<String>,
    pub folder: Option<String>,
    /// The current step's text and its place (1-based) among `steps_total`.
    pub step: String,
    pub step_index: u32,
    pub steps_total: u32,
    pub state: ActionState,
    /// The last log lines (kept after a failure).
    pub log_tail: Vec<String>,
    /// The full log in the data folder's `logs/`.
    pub log_file: Option<PathBuf>,
}

impl ActionView {
    pub fn finished(&self) -> bool {
        !matches!(self.state, ActionState::Running)
    }
}
