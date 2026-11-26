//! AgentBook platform layer: the `Platform` trait (data, ssh and home folders, Docker endpoint,
//! OpenSSH version, credential store, ssh-keygen, URL and folder opening, OS fonts) and its Windows
//! implementation. OS-specific code lives only in this crate, so macOS is a matter of adding one
//! implementation. `scripts/platform-check.mjs` (part of `npm run lint`) fails when `cfg(windows)`
//! or a Windows-only API appears in any other crate.

use std::fmt;
use std::path::{Path, PathBuf};

pub mod docker;

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::WindowsPlatform;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::MacPlatform;

/// What `AgentBook-Setup.exe` needs from the OS (install folders, Start-menu shortcut, message
/// boxes); the installer uses only this module and `native()`.
#[cfg(windows)]
pub use windows::install as installer;

pub use agentbook_core::docker_endpoint::EndpointKind;
pub use docker::{DockerEndpoint, DockerEndpointError, DockerEnv, Probed};

/// The credential-name prefix of the real tool (External surface: `AgentBook/<folderId>/<NAME>`
/// and `AgentBook/<folderId>/<laptopId>/<NAME>`). Scenario stands use `AgentBook-test-<instance>/`.
pub const CREDENTIAL_PREFIX: &str = "AgentBook/";

/// The credential-store name of a Hidden variable value: folder-wide when `laptop_id` is `None`,
/// else only for that laptop. `prefix` is [`CREDENTIAL_PREFIX`] outside scenario stands.
pub fn credential_target(
    prefix: &str,
    folder_id: &str,
    laptop_id: Option<&str>,
    name: &str,
) -> String {
    match laptop_id {
        Some(laptop) => format!("{prefix}{folder_id}/{laptop}/{name}"),
        None => format!("{prefix}{folder_id}/{name}"),
    }
}

/// The OpenSSH client version found on PATH (`ssh -V`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpensshVersion {
    pub major: u32,
    pub minor: u32,
    /// The first line `ssh -V` printed, for messages.
    pub raw: String,
    /// The `ssh` executable that printed it.
    pub path: PathBuf,
}

impl OpensshVersion {
    /// Whether it meets the floor Claude Desktop's SSH remote needs (9.4).
    pub fn meets_floor(&self) -> bool {
        agentbook_core::openssh::meets_floor((self.major, self.minor))
    }
}

/// What a font file is for in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontRole {
    /// The main proportional UI font (Segoe UI on Windows).
    Primary,
    /// Tried in order after the primary font for glyphs it lacks (CJK, symbols, emoji).
    Fallback,
    /// The monospace font (build logs).
    Monospace,
    /// A semibold face of the primary font (headings, names); the UI falls back to the primary
    /// font when there is none.
    Bold,
}

/// An OS font file. `index` is the face inside a `.ttc` collection (0 for `.ttf`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontFile {
    pub name: String,
    pub path: PathBuf,
    pub index: u32,
    pub role: FontRole,
}

/// The host git's `core.autocrlf`, as the inputs of `agentbook_core::autocrlf::effective`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostAutocrlf {
    /// Whether a `git` executable was found on PATH.
    pub has_git: bool,
    /// `git config --global --get core.autocrlf`, when set.
    pub global: Option<String>,
    /// `git config --system --get core.autocrlf`, when set.
    pub system: Option<String>,
}

impl HostAutocrlf {
    /// The value to write into the laptop's global git config.
    pub fn effective(&self, windows: bool) -> &'static str {
        agentbook_core::autocrlf::effective(
            self.global.as_deref(),
            self.system.as_deref(),
            self.has_git,
            windows,
        )
    }
}

/// The OS proxy settings, as `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` values. Passed as build
/// args to every image build the tool starts itself (a bollard build does not inherit the docker
/// CLI's proxy config).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProxySettings {
    pub http: Option<String>,
    pub https: Option<String>,
    pub no_proxy: Option<String>,
}

impl ProxySettings {
    /// From the `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` variables (upper or lower case).
    pub fn from_env() -> Self {
        let var = |names: [&str; 2]| {
            names
                .iter()
                .filter_map(|n| std::env::var(n).ok())
                .map(|v| v.trim().to_string())
                .find(|v| !v.is_empty())
        };
        Self {
            http: var(["HTTP_PROXY", "http_proxy"]),
            https: var(["HTTPS_PROXY", "https_proxy"]),
            no_proxy: var(["NO_PROXY", "no_proxy"]),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.http.is_none() && self.https.is_none()
    }

    /// The build args, both cases (Dockerfiles and tools read either).
    pub fn build_args(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (name, value) in [
            ("HTTP_PROXY", &self.http),
            ("HTTPS_PROXY", &self.https),
            ("NO_PROXY", &self.no_proxy),
        ] {
            if let Some(v) = value {
                out.push((name.to_string(), v.clone()));
                out.push((name.to_ascii_lowercase(), v.clone()));
            }
        }
        out
    }
}

/// A failed platform call, with a message fit for a log line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    /// A required program is not on PATH.
    ProgramNotFound(String),
    /// A program ran and failed.
    Command {
        program: String,
        status: String,
        output: String,
    },
    /// An OS call failed.
    Os { call: &'static str, code: u32 },
    /// A file-system or argument problem.
    Other(String),
}

impl fmt::Display for PlatformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProgramNotFound(p) => write!(f, "{p} was not found on PATH"),
            Self::Command {
                program,
                status,
                output,
            } => {
                write!(f, "{program} failed ({status})")?;
                if !output.trim().is_empty() {
                    write!(f, ": {}", output.trim())?;
                }
                Ok(())
            }
            Self::Os { call, code } => write!(f, "{call} failed with OS error {code}"),
            Self::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for PlatformError {}

/// Every OS-specific piece AgentBook needs. The engine holds it as `Arc<dyn Platform>`; the
/// scenario harness wraps the native one to redirect the folders.
pub trait Platform: Send + Sync {
    /// Whether this is Windows (picks Windows defaults in core algorithms).
    fn is_windows(&self) -> bool;

    /// The user's home folder.
    fn home_dir(&self) -> PathBuf;

    /// The per-user data folder (`%LOCALAPPDATA%\AgentBook` on Windows). Not created here.
    fn data_dir(&self) -> PathBuf;

    /// The user's OpenSSH folder (`<home>/.ssh`). Not created here.
    fn ssh_dir(&self) -> PathBuf;

    /// The Docker endpoint: `DOCKER_HOST`, then the current context, then the default pipe or
    /// socket. Both the result and the error list what was probed.
    fn docker_endpoint(&self) -> Result<DockerEndpoint, DockerEndpointError>;

    /// A program whose stdin/stdout is a raw connection to the engine of an endpoint AgentBook
    /// cannot open itself (a Docker engine inside WSL: `docker system dial-stdio` run in the
    /// distro). `None` for the endpoints a Docker client opens directly.
    fn docker_dial_command(&self, _endpoint: &DockerEndpoint) -> Option<std::process::Command> {
        None
    }

    /// Makes sure the engine keeps running when AgentBook is closed, as Docker Desktop's does: a
    /// Docker engine inside WSL stops with its distro once no `wsl.exe` is attached, so one
    /// keep-alive `wsl.exe` is left running for the distro (started once, found again later).
    /// Nothing to do for other engines.
    fn docker_keep_alive(&self, _endpoint: &DockerEndpoint) -> Result<(), PlatformError> {
        Ok(())
    }

    /// The first executable called `name` on PATH (`.exe` is added on Windows when missing).
    fn find_program(&self, name: &str) -> Option<PathBuf>;

    /// The version printed by `ssh -V` for the `ssh` on PATH; `None` when there is none or its
    /// output has no OpenSSH version.
    fn openssh_version(&self) -> Option<OpensshVersion>;

    /// A value from the OS credential store; `None` when no such credential exists.
    fn credential_get(&self, target: &str) -> Result<Option<String>, PlatformError>;

    /// Creates or replaces a credential.
    fn credential_set(&self, target: &str, value: &str) -> Result<(), PlatformError>;

    /// Deletes a credential; `false` when it did not exist.
    fn credential_delete(&self, target: &str) -> Result<bool, PlatformError>;

    /// The names of every credential whose name starts with `prefix` (removing a folder's or a
    /// scenario stand's credentials).
    fn credential_list(&self, prefix: &str) -> Result<Vec<String>, PlatformError>;

    /// Generates an ed25519 key pair at `path` and `path.pub` with no passphrase, using the
    /// system `ssh-keygen`. Fails when `path` already exists.
    fn ssh_keygen(&self, path: &Path, comment: &str) -> Result<(), PlatformError>;

    /// Restricts a private key file to the current user, so the system OpenSSH accepts it.
    fn restrict_private_key(&self, path: &Path) -> Result<(), PlatformError>;

    /// Opens a URL (including `claude://` links) with its registered handler.
    fn open_url(&self, url: &str) -> Result<(), PlatformError>;

    /// Shows a folder (or a file, selected in its folder) in the OS file manager.
    fn open_in_file_manager(&self, path: &Path) -> Result<(), PlatformError>;

    /// The native folder picker; `None` when cancelled. Blocks until the dialog closes.
    fn pick_folder(&self) -> Option<PathBuf>;

    /// The OS fonts for the UI: the primary font first, then fallbacks, then monospace. Only files
    /// that exist are returned.
    fn ui_fonts(&self) -> Vec<FontFile>;

    /// The host git's `core.autocrlf` settings.
    fn host_git_autocrlf(&self) -> HostAutocrlf;

    /// The OS proxy settings: the proxy variables when set, else the OS's own setting.
    fn system_proxy(&self) -> ProxySettings {
        ProxySettings::from_env()
    }

    /// Prepares a console program the engine starts (the devcontainer CLI, `docker`), e.g. so it
    /// does not flash a console window from the GUI app. The default does nothing.
    fn prepare_command(&self, _cmd: &mut std::process::Command) {}

    /// Puts text on the OS clipboard (Copy log, copy in text fields). The default has none.
    fn clipboard_set(&self, _text: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Other(
            "this platform has no clipboard".to_string(),
        ))
    }

    /// The text on the OS clipboard (paste in text fields); `None` when it holds no text.
    fn clipboard_get(&self) -> Option<String> {
        None
    }
}

/// The platform implementation of this OS.
#[cfg(windows)]
pub fn native() -> std::sync::Arc<dyn Platform> {
    std::sync::Arc::new(WindowsPlatform::new())
}

/// The platform implementation of this OS.
#[cfg(target_os = "macos")]
pub fn native() -> std::sync::Arc<dyn Platform> {
    std::sync::Arc::new(MacPlatform::new())
}
