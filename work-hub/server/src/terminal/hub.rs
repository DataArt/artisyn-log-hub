//! Live terminal connections (D11 "Takeover"): one connection per `(container, session)`. A new
//! connection sends [`HubEvent::TakenOver`] to the older one, which then sends `taken_over` to its
//! browser tab and closes (FR-27c, AC-22d). Background watchers reach the live connection of a
//! session through [`TerminalHub::notify`].
//!
//! The hub also remembers which `(container, session)` pairs have a watcher running, so a login
//! or configure session never gets two.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::mpsc;

/// `(container name, session name)`.
pub type HubKey = (String, String);

/// Identifies one registered connection.
pub type ConnId = u64;

/// Events for a live connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubEvent {
    /// Another tab took the session.
    TakenOver,
    /// The login or configure process finished (`logged_in` only for login).
    Ended { logged_in: Option<bool> },
    /// A plain-language error for the user.
    Error(String),
}

/// Queue length per connection; events are rare.
const EVENT_QUEUE: usize = 8;

#[derive(Default)]
pub struct TerminalHub {
    next_id: AtomicU64,
    live: Mutex<HashMap<HubKey, (ConnId, mpsc::Sender<HubEvent>)>>,
    watching: Mutex<HashSet<HubKey>>,
}

impl TerminalHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a new live connection for `key`. The previous connection of the key, if any,
    /// receives [`HubEvent::TakenOver`] and is forgotten.
    pub fn register(&self, key: (String, String)) -> (ConnId, mpsc::Receiver<HubEvent>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel(EVENT_QUEUE);
        let old = {
            let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
            live.insert(key, (id, tx))
        };
        if let Some((_, old_tx)) = old {
            // A full or closed queue means the old connection is going away anyway.
            let _ = old_tx.try_send(HubEvent::TakenOver);
        }
        (id, rx)
    }

    /// Forgets the connection, unless a newer one has already replaced it.
    pub fn unregister(&self, key: &(String, String), id: ConnId) {
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        if live.get(key).is_some_and(|(cur, _)| *cur == id) {
            live.remove(key);
        }
    }

    /// Sends `ev` to the live connection of `key`; nothing happens when there is none.
    pub fn notify(&self, key: &(String, String), ev: HubEvent) {
        let tx = {
            let live = self.live.lock().unwrap_or_else(|e| e.into_inner());
            live.get(key).map(|(_, tx)| tx.clone())
        };
        if let Some(tx) = tx
            && let Err(e) = tx.try_send(ev)
        {
            tracing::debug!("terminal {key:?}: event not delivered: {e}");
        }
    }

    /// True when `key` has a live connection.
    pub fn is_live(&self, key: &(String, String)) -> bool {
        let live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        live.contains_key(key)
    }

    /// Claims the watcher slot of `key`: `false` when a watcher already runs for it.
    pub fn start_watching(&self, key: &(String, String)) -> bool {
        let mut watching = self.watching.lock().unwrap_or_else(|e| e.into_inner());
        watching.insert(key.clone())
    }

    /// Releases the watcher slot of `key`.
    pub fn stop_watching(&self, key: &(String, String)) {
        let mut watching = self.watching.lock().unwrap_or_else(|e| e.into_inner());
        watching.remove(key);
    }
}

/// The hub key of a session in a container.
pub fn key(container: &str, session: super::Session) -> HubKey {
    (container.to_string(), session.as_str().to_string())
}
