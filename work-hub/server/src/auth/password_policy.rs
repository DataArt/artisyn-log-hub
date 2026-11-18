//! Password policy — Rust port of Log Hub's `server/src/auth/utils/password-policy.ts`
//! (rules: `docs/knowledgebase/algorithms/password-policy.md`).

use axum::http::StatusCode;

use crate::error::ApiError;

pub const MESSAGE_ANY: &str = "must be at least 2 characters";
pub const MESSAGE_MID: &str = "must be at least 10 characters and include a digit";
pub const MESSAGE_LONG: &str = "must be at least 14 characters and include a digit, punctuation, and both upper and lower case";

/// A password the active policy refuses: `400 {error:"weak_password", message}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeakPassword {
    pub message: &'static str,
}

impl From<WeakPassword> for ApiError {
    fn from(w: WeakPassword) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, "weak_password", w.message)
    }
}

fn has_digit(p: &str) -> bool {
    p.chars().any(|c| c.is_ascii_digit())
}

/// Printable ASCII punctuation: `!-/`, `:-@`, `[-``, `{-~`.
fn has_punctuation(p: &str) -> bool {
    p.chars()
        .any(|c| matches!(c, '!'..='/' | ':'..='@' | '['..='`' | '{'..='~'))
}

fn has_upper(p: &str) -> bool {
    p.chars().any(|c| c.is_ascii_uppercase())
}

fn has_lower(p: &str) -> bool {
    p.chars().any(|c| c.is_ascii_lowercase())
}

/// Checks `password` against `policy` (the raw `PASSWORD_POLICY`; `None` or `""` = `long`).
/// Length is counted in UTF-16 code units, as JavaScript does. An unknown policy value checks
/// nothing (the startup validation never lets one through outside `WORK_HUB_ENV=test`).
pub fn apply_password_policy(policy: Option<&str>, password: &str) -> Result<(), WeakPassword> {
    let policy = match policy {
        None | Some("") => "long",
        Some(p) => p,
    };
    let len = password.encode_utf16().count();
    let weak = |message| Err(WeakPassword { message });
    match policy {
        "any" if len < 2 => weak(MESSAGE_ANY),
        "mid" if len < 10 || !has_digit(password) => weak(MESSAGE_MID),
        "long"
            if len < 14
                || !has_digit(password)
                || !has_punctuation(password)
                || !has_upper(password)
                || !has_lower(password) =>
        {
            weak(MESSAGE_LONG)
        }
        _ => Ok(()),
    }
}
