//! Per-container locks (D9): a `tokio::Mutex` per container name around every git write.
//! Opening a workstream holds the workspace container's lock while it copies volumes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::OwnedMutexGuard;

#[derive(Default)]
pub struct ContainerLocks {
    map: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ContainerLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Waits for and holds the lock of `container` until the guard is dropped.
    pub async fn lock(&self, container: &str) -> OwnedMutexGuard<()> {
        let mutex = {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            // Drop entries nobody holds or waits on, so the map does not grow forever.
            map.retain(|_, m| Arc::strong_count(m) > 1);
            map.entry(container.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        mutex.lock_owned().await
    }
}
