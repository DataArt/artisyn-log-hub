//! Timing constants (D4). The web's `POLL_INTERVAL_MS` (2000) lives in `web/src/ide/useFsPoll.ts`.

use std::time::Duration;

/// The agent counts as busy when the chat window had activity within this window.
pub const AGENT_BUSY_WINDOW: Duration = Duration::from_secs(5);
/// How often the workstream reconciler runs.
pub const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);
/// Rows stuck in `creating` / `opening` longer than this are cleaned up.
pub const STALE_TRANSIENT_AGE: Duration = Duration::from_secs(10 * 60);
/// How often a running login session checks the agent login.
pub const LOGIN_WATCH_INTERVAL: Duration = Duration::from_secs(2);
/// How often a running configure session is checked.
pub const CONFIGURE_WATCH_INTERVAL: Duration = Duration::from_secs(5);
/// How often chat recordings are copied out of running containers.
pub const RECORDING_SYNC_INTERVAL: Duration = Duration::from_secs(30);
