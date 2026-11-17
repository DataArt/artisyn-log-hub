//! Login backoff — in-memory Rust port of Log Hub's `server/src/auth/login-backoff.service.ts`
//! (rules: `docs/knowledgebase/algorithms/login-backoff.md`).
//!
//! Two independent dimensions (account by trimmed, lowercased e-mail; source IP as given); the
//! N-th failure inside a fixed 900 s window blocks the key for N - 1 seconds. State is per process.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::auth::{TooManyRequests, js};

/// A millisecond clock, injectable so the table test can move time exactly.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

/// Real time: milliseconds since the clock was created.
pub struct SystemClock {
    start: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        SystemClock {
            start: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// A clock that only moves when told to (tests).
#[derive(Default)]
pub struct ManualClock {
    now: AtomicU64,
}

impl ManualClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn advance(&self, ms: u64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
}

/// A counter is forgotten this long after its first failure (fixed window).
pub const COUNTER_DURATION_MS: u64 = 900_000;

/// Above this many entries a map is pruned of expired ones (bounded memory).
const PRUNE_THRESHOLD: usize = 10_000;

#[derive(Default)]
struct Inner {
    /// key -> (failures, window end).
    counters: HashMap<String, (u64, u64)>,
    /// key -> block end.
    gates: HashMap<String, u64>,
}

pub struct LoginBackoff {
    enabled: bool,
    clock: Arc<dyn Clock>,
    inner: Mutex<Inner>,
}

fn account_key(email: &str) -> String {
    format!("a:{}", js::trim(email).to_lowercase())
}

fn ip_key(ip: &str) -> String {
    format!("i:{ip}")
}

impl LoginBackoff {
    /// `enabled = false` turns every operation into a no-op (Log Hub's `NODE_ENV=test` switch).
    pub fn new(enabled: bool, clock: Arc<dyn Clock>) -> Self {
        LoginBackoff {
            enabled,
            clock,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ms_left(inner: &Inner, key: &str, now: u64) -> u64 {
        inner
            .gates
            .get(key)
            .map_or(0, |&until| until.saturating_sub(now))
    }

    /// Before a login: `Err` with the seconds left when either key is still blocked. Changes
    /// nothing, so a rejected attempt never extends its own penalty.
    pub fn check(&self, email: &str, ip: &str) -> Result<(), TooManyRequests> {
        if !self.enabled {
            return Ok(());
        }
        let now = self.clock.now_ms();
        let inner = self.lock();
        let ms = Self::ms_left(&inner, &account_key(email), now).max(Self::ms_left(
            &inner,
            &ip_key(ip),
            now,
        ));
        if ms > 0 {
            return Err(TooManyRequests {
                retry_after_secs: js::ceil_secs(ms),
            });
        }
        Ok(())
    }

    /// Records one failed login on both keys; returns the larger delay (seconds) now in force.
    pub fn record_failure(&self, email: &str, ip: &str) -> u64 {
        if !self.enabled {
            return 0;
        }
        let now = self.clock.now_ms();
        let mut inner = self.lock();
        Self::prune(&mut inner, now);
        let a = Self::apply_delay(&mut inner, account_key(email), now);
        let i = Self::apply_delay(&mut inner, ip_key(ip), now);
        a.max(i)
    }

    /// Clears the account's counter and block; the IP keeps its history.
    pub fn record_success(&self, email: &str) {
        if !self.enabled {
            return;
        }
        let key = account_key(email);
        let mut inner = self.lock();
        inner.counters.remove(&key);
        inner.gates.remove(&key);
    }

    fn apply_delay(inner: &mut Inner, key: String, now: u64) -> u64 {
        let entry = inner
            .counters
            .entry(key.clone())
            .or_insert((0, now + COUNTER_DURATION_MS));
        if now >= entry.1 {
            *entry = (0, now + COUNTER_DURATION_MS);
        }
        entry.0 += 1;
        let seconds = entry.0 - 1;
        if seconds < 1 {
            return 0;
        }
        inner.gates.insert(key, now + seconds * 1000);
        seconds
    }

    fn prune(inner: &mut Inner, now: u64) {
        if inner.counters.len() > PRUNE_THRESHOLD {
            inner.counters.retain(|_, (_, end)| *end > now);
        }
        if inner.gates.len() > PRUNE_THRESHOLD {
            inner.gates.retain(|_, until| *until > now);
        }
    }
}
