//! Terminals (D11): tmux sessions inside the containers, the WebSocket bridge, the live-connection
//! hub with takeover, the chat recordings and the watchers of the login and configure sessions.

pub mod bridge;
pub mod hub;
pub mod recording;
pub mod tmux;
pub mod watchers;

pub use hub::{ConnId, HubEvent, TerminalHub};
pub use tmux::Session;

use crate::state::AppState;

/// Starts the terminal background work: the periodic recording sync (every
/// [`crate::timing::RECORDING_SYNC_INTERVAL`]) and the configure watchers of workspaces whose
/// configure session was running when the server stopped.
pub fn spawn_background(st: &AppState) {
    recording::spawn_periodic_sync(st.clone());
    let st = st.clone();
    tokio::spawn(async move {
        watchers::resume_configure_watchers(&st).await;
    });
}
