//! The single-instance lock: an exclusive OS file lock on `agentbook.lock` in the data folder,
//! held for the engine's lifetime. The installed copy and a copy run from Downloads share the
//! folder, so a second copy only says that AgentBook is already running. The OS releases the
//! lock when the process ends, even on a crash; the file itself stays.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

/// What a second copy shows.
pub const ALREADY_RUNNING_MESSAGE: &str = "AgentBook is already running.";

#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockError {
    /// Another AgentBook holds the lock.
    AlreadyRunning,
    /// The lock file could not be created or locked.
    Io(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning => f.write_str(ALREADY_RUNNING_MESSAGE),
            Self::Io(m) => write!(f, "cannot lock the AgentBook data folder: {m}"),
        }
    }
}

impl std::error::Error for LockError {}

impl InstanceLock {
    /// Takes the lock on `path` (creating the file and its folder), without waiting.
    pub fn acquire(path: &Path) -> Result<Self, LockError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| LockError::Io(format!("{}: {e}", parent.display())))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| LockError::Io(format!("{}: {e}", path.display())))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(TryLockError::WouldBlock) => Err(LockError::AlreadyRunning),
            Err(TryLockError::Error(e)) => Err(LockError::Io(format!("{}: {e}", path.display()))),
        }
    }
}
