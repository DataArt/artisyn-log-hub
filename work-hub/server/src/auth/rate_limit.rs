//! Auth request rate limit — in-memory Rust port of Log Hub's
//! `server/src/auth/auth-rate-limit.service.ts`.
//!
//! Per-IP and per-email limits for signup, forgot-password, resend-confirmation and
//! reset-password: `AUTH_RATE_LIMIT_POINTS` requests (default 5; 0 disables) per
//! `AUTH_RATE_LIMIT_WINDOW_SEC` (default 900) per key, in a fixed window from the first request.
//! Keys: `<route>:i:<ip>` and `<route>:a:<lowercased email>`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::auth::backoff::Clock;
use crate::auth::{TooManyRequests, js};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitRoute {
    Signup,
    Forgot,
    Resend,
    Reset,
}

impl RateLimitRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            RateLimitRoute::Signup => "signup",
            RateLimitRoute::Forgot => "forgot",
            RateLimitRoute::Resend => "resend",
            RateLimitRoute::Reset => "reset",
        }
    }
}

const PRUNE_THRESHOLD: usize = 10_000;

pub struct RateLimiter {
    points: u64,
    window_ms: u64,
    clock: Arc<dyn Clock>,
    /// key -> (consumed, window end).
    entries: Mutex<HashMap<String, (u64, u64)>>,
}

fn email_key(route: RateLimitRoute, email: &str) -> String {
    format!("{}:a:{}", route.as_str(), js::trim(email).to_lowercase())
}

impl RateLimiter {
    /// `points = 0` disables limiting; `window_sec` must be positive (callers default it to 900).
    pub fn new(points: u64, window_sec: u64, clock: Arc<dyn Clock>) -> Self {
        RateLimiter {
            points,
            window_ms: window_sec.max(1).saturating_mul(1000),
            clock,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one request on `key`; `Some(ms before the window ends)` when over the limit.
    fn consume(&self, key: String) -> Option<u64> {
        if self.points == 0 {
            return None;
        }
        let now = self.clock.now_ms();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() > PRUNE_THRESHOLD {
            entries.retain(|_, (_, end)| *end > now);
        }
        let entry = entries.entry(key).or_insert((0, now + self.window_ms));
        if now >= entry.1 {
            *entry = (0, now + self.window_ms);
        }
        entry.0 += 1;
        (entry.0 > self.points).then(|| entry.1 - now)
    }

    /// Counts one request from `ip` on `route`; `Err` (429 + `Retry-After`) once over the limit.
    pub fn consume_ip(&self, route: RateLimitRoute, ip: &str) -> Result<(), TooManyRequests> {
        match self.consume(format!("{}:i:{ip}", route.as_str())) {
            None => Ok(()),
            Some(ms) => Err(TooManyRequests {
                retry_after_secs: js::ceil_secs(ms).max(1),
            }),
        }
    }

    /// Counts one request for `email` on `route`; `false` when over the limit.
    pub fn consume_email(&self, route: RateLimitRoute, email: &str) -> bool {
        self.consume(email_key(route, email)).is_none()
    }

    /// Retry-After for an email-limited request, read without consuming; 1 when nothing is
    /// recorded.
    pub fn email_retry_after_seconds(&self, route: RateLimitRoute, email: &str) -> u64 {
        if self.points == 0 {
            return 1;
        }
        let now = self.clock.now_ms();
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let ms = entries
            .get(&email_key(route, email))
            .map_or(0, |(_, end)| end.saturating_sub(now));
        js::ceil_secs(ms).max(1)
    }
}
