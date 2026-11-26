//! The per-user data folder layout (External surface, "Per-user data folder").

use std::path::{Path, PathBuf};

use agentbook_core::pins::{DEVCONTAINERS_CLI_VERSION, NODE_VERSION};

#[derive(Debug, Clone)]
pub struct DataLayout {
    root: PathBuf,
}

impl DataLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.root.join(agentbook_core::INSTANCE_LOCK_FILE)
    }

    pub fn laptop_dir(&self, laptop: &str) -> PathBuf {
        self.root.join("laptops").join(laptop)
    }

    /// Host key and `authorized_keys`, mounted read-only at `/opt/agentbook/key`.
    pub fn key_dir(&self, laptop: &str) -> PathBuf {
        self.laptop_dir(laptop).join("key")
    }

    /// The laptop's client key pair (`id_ed25519[.pub]`), host-only.
    pub fn client_dir(&self, laptop: &str) -> PathBuf {
        self.laptop_dir(laptop).join("client")
    }

    /// The client private key the laptop's ssh alias uses.
    pub fn client_key(&self, laptop: &str) -> PathBuf {
        self.client_dir(laptop).join("id_ed25519")
    }

    /// The laptop's host key (its `.pub` is pre-seeded in the alias's known_hosts).
    pub fn host_key(&self, laptop: &str) -> PathBuf {
        self.key_dir(laptop).join("ssh_host_ed25519_key")
    }

    /// Everything the tool keeps for one folder (`folders/<fid>/`).
    pub fn folder_dir(&self, folder: &str) -> PathBuf {
        self.root.join("folders").join(folder)
    }

    /// The generated override config (and compose file) of one generation.
    pub fn gen_dir(&self, laptop: &str, generation: u64) -> PathBuf {
        self.laptop_dir(laptop)
            .join("gen")
            .join(generation.to_string())
    }

    /// Mounted read-only at `/opt/agentbook/state` in the folder's laptops.
    pub fn folder_state_dir(&self, folder: &str) -> PathBuf {
        self.folder_dir(folder).join("state")
    }

    /// `ws`, `prompt-hook`, the skill; mounted read-only at `/opt/agentbook/bin`.
    pub fn tool_files_dir(&self) -> PathBuf {
        self.root.join("tool-files")
    }

    pub fn deps_dir(&self) -> PathBuf {
        self.root.join("deps")
    }

    /// The extracted host Node runtime.
    pub fn node_dir(&self) -> PathBuf {
        self.deps_dir().join(format!("node-{NODE_VERSION}"))
    }

    /// The extracted `@devcontainers/cli` package.
    pub fn cli_dir(&self) -> PathBuf {
        self.deps_dir()
            .join(format!("devcontainers-cli-{DEVCONTAINERS_CLI_VERSION}"))
    }

    /// The verified Linux Node archive sent into the standard Equipment's build context.
    pub fn linux_node_archive(&self, file_name: &str) -> PathBuf {
        self.deps_dir().join(file_name)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
}
