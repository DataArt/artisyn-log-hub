//! One-time e-mail tokens (D3): the e-mail confirmation token (24 h) and the password reset token
//! (1 h), both in `email_tokens`, told apart by `kind`. Only the SHA-256 of a token is stored; the
//! token itself goes into the e-mailed link. A token is single-use; issuing a new one marks the
//! user's earlier unused tokens of that kind used; a 60 s cooldown applies to re-issuing.
//!
//! Lifetimes and the cooldown are Log Hub's (`email-confirmation-tokens.service.ts:8-9`,
//! `password-reset-tokens.service.ts:8-9`).

use sha2::{Digest, Sha256};
use sqlx::PgPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Confirm,
    Reset,
}

impl TokenKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenKind::Confirm => "confirm",
            TokenKind::Reset => "reset",
        }
    }

    /// Token lifetime in seconds.
    pub fn ttl_secs(self) -> i64 {
        match self {
            TokenKind::Confirm => 24 * 60 * 60,
            TokenKind::Reset => 60 * 60,
        }
    }
}

/// Minimum time between two tokens of one kind for one user.
pub const RESEND_COOLDOWN_MS: i64 = 60 * 1000;

/// The result of [`issue_with_cooldown`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Issue {
    Issued(String),
    Cooldown { retry_after_secs: u64 },
}

/// The result of [`consume`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consume {
    Ok(i64),
    Unknown,
    Expired,
    AlreadyUsed,
}

impl Consume {
    /// The reason logged when consuming failed.
    pub fn reason(self) -> &'static str {
        match self {
            Consume::Ok(_) => "ok",
            Consume::Unknown => "unknown",
            Consume::Expired => "expired",
            Consume::AlreadyUsed => "already_used",
        }
    }
}

/// A fresh random token: 32 random bytes as 64 lowercase hex digits.
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes[..]);
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 hex of a token (the stored form).
pub fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

async fn insert(
    ex: &mut sqlx::PgConnection,
    user_id: i64,
    kind: TokenKind,
) -> Result<String, sqlx::Error> {
    let token = new_token();
    sqlx::query(
        "INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) \
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
    )
    .bind(user_id)
    .bind(kind.as_str())
    .bind(token_hash(&token))
    .bind(kind.ttl_secs() as f64)
    .execute(ex)
    .await?;
    Ok(token)
}

/// Issues a token without the cooldown (sign-up's first confirmation e-mail).
pub async fn create(db: &PgPool, user_id: i64, kind: TokenKind) -> Result<String, sqlx::Error> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, user_id, kind).await
}

/// Cooldown check, invalidation of the earlier unused tokens and the new token, in one
/// transaction that locks the user row, so two concurrent requests cannot both pass the cooldown.
pub async fn issue_with_cooldown(
    db: &PgPool,
    user_id: i64,
    kind: TokenKind,
) -> Result<Issue, sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let elapsed_ms: Option<i64> = sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::bigint FROM email_tokens \
         WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(kind.as_str())
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(elapsed) = elapsed_ms
        && elapsed < RESEND_COOLDOWN_MS
    {
        let left_ms = (RESEND_COOLDOWN_MS - elapsed.max(0)) as u64;
        tx.rollback().await?;
        return Ok(Issue::Cooldown {
            retry_after_secs: left_ms.div_ceil(1000).max(1),
        });
    }
    sqlx::query(
        "UPDATE email_tokens SET used_at = now() \
         WHERE user_id = $1 AND kind = $2 AND used_at IS NULL",
    )
    .bind(user_id)
    .bind(kind.as_str())
    .execute(&mut *tx)
    .await?;
    let token = insert(&mut tx, user_id, kind).await?;
    tx.commit().await?;
    Ok(Issue::Issued(token))
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: i64,
    used: bool,
    expired: bool,
}

/// Looks the token up, then consumes it atomically, so two concurrent uses of one valid token
/// give exactly one `Ok` and one `AlreadyUsed`. A used reset token also retires every other unused
/// reset token of that user.
pub async fn consume(db: &PgPool, token: &str, kind: TokenKind) -> Result<Consume, sqlx::Error> {
    let row = sqlx::query_as::<_, TokenRow>(
        "SELECT id, used_at IS NOT NULL AS used, expires_at < now() AS expired \
         FROM email_tokens WHERE token_hash = $1 AND kind = $2",
    )
    .bind(token_hash(token))
    .bind(kind.as_str())
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(Consume::Unknown);
    };
    if row.used {
        return Ok(Consume::AlreadyUsed);
    }
    if row.expired {
        return Ok(Consume::Expired);
    }
    let user_id: Option<i64> = sqlx::query_scalar(
        "UPDATE email_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL \
         RETURNING user_id",
    )
    .bind(row.id)
    .fetch_optional(db)
    .await?;
    let Some(user_id) = user_id else {
        return Ok(Consume::AlreadyUsed);
    };
    if kind == TokenKind::Reset {
        sqlx::query(
            "UPDATE email_tokens SET used_at = now() \
             WHERE user_id = $1 AND kind = 'reset' AND used_at IS NULL",
        )
        .bind(user_id)
        .execute(db)
        .await?;
    }
    Ok(Consume::Ok(user_id))
}
