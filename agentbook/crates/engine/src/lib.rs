//! AgentBook engine: Docker (bollard), the devcontainer CLI, first-launch downloads, the
//! Equipment pipeline, laptop lifecycle, SSH config, variables and context push. It depends only on
//! `agentbook-core` and the `Platform` trait; the UI talks to it through commands and snapshots.

mod action;
pub mod assets;
pub mod context;
pub mod deps;
mod devcontainer;
pub mod docker;
mod engine;
pub mod equipment;
mod files;
pub mod layout;
pub mod lifecycle;
pub mod lock;
mod poller;
pub mod repos;
pub mod snapshot;
pub mod ssh;
pub mod vars;

pub use engine::{
    Command, DesktopLauncher, Engine, EngineError, EngineStartError, EngineTestConfig,
    INSTANCE_LABEL, NEEDS_DOCKER_CLI_MESSAGE,
};
pub use lifecycle::{GivenInput, LaptopDraft};
pub use poller::POLL_INTERVAL;
pub use snapshot::*;
pub use vars::{Secret, VarEdit, VarInput};
