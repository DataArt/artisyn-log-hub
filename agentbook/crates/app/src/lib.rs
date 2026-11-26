//! AgentBook desktop app: the egui window over the engine. It only ever sends engine commands and
//! renders engine snapshots; OS specifics (fonts, clipboard, folder picker, opening links) come from
//! the platform layer.

mod app;
mod choose;
mod dialogs;
mod folder;
mod fonts;
mod help;
mod home;
mod icons;
mod laptop;
mod setup;
mod theme;
mod variables;
mod window;

use std::path::PathBuf;
use std::sync::Arc;

use agentbook_engine::{Engine, EngineTestConfig};
use agentbook_platform::Platform;

/// Starts the engine on `platform` (its data folder, or `data_dir`) and runs the window until it
/// is closed. A second AgentBook on the same data folder shows only "AgentBook is already
/// running". The error is why the window could not open.
pub fn run_with(
    platform: Arc<dyn Platform>,
    data_dir: Option<PathBuf>,
    test: Option<EngineTestConfig>,
) -> Result<(), String> {
    let engine = Engine::new(platform.clone(), data_dir, test).map_err(|e| e.to_string());
    let app = app::App::new(platform.clone(), engine);
    window::run(
        window::WindowOptions {
            title: "AgentBook".to_string(),
            size: (1100.0, 780.0),
            min_size: (720.0, 520.0),
        },
        platform,
        app,
    )
}

/// Runs AgentBook on this computer's platform.
pub fn run() -> Result<(), String> {
    run_with(agentbook_platform::native(), None, None)
}
