//! AgentBook core: the pure domain model (folders, laptops, variables), the `state.json` and
//! in-container state file types and every algorithm. No I/O and no clock, so everything here is
//! table-tested from the `agentbook-*` algorithm docs (`tests/algo.rs`).

pub mod autocrlf;
pub mod broad_folder;
pub mod claude_dir;
pub mod docker_endpoint;
pub mod equipment;
pub mod host_exposure;
pub mod openssh;
pub mod override_config;
pub mod paths;
pub mod pins;
pub mod ports;
pub mod sessions;
pub mod ssh_user;
pub mod state;
pub mod variables;

/// The single-instance lock file in the data folder. The engine holds an exclusive lock on it
/// while AgentBook runs; the installer only probes it (never creates it) to ask the user to close
/// AgentBook before replacing the exe.
pub const INSTANCE_LOCK_FILE: &str = "agentbook.lock";
