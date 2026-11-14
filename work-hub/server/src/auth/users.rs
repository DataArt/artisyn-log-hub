//! `users` table access. Work Hub has no roles in the alpha: the public profile always says
//! `role: "user"` (D3).

use serde::Serialize;
use sqlx::PgPool;
use time::OffsetDateTime;

use crate::auth::js;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: i64,
    pub email: String,
    pub email_key: String,
    pub password_hash: Option<String>,
    pub email_confirmed_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
}

/// Log Hub's public profile shape `{id, email, role, createdAt}`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfile {
    pub id: i64,
    pub email: String,
    pub role: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

impl UserRow {
    pub fn public_profile(&self) -> PublicProfile {
        PublicProfile {
            id: self.id,
            email: self.email.clone(),
            role: "user",
            created_at: self.created_at,
        }
    }
}

/// The e-mail as stored (trimmed) and its lookup key (trimmed, lowercased).
pub fn normalize_email(email: &str) -> (String, String) {
    let trimmed = js::trim(email).to_string();
    let key = trimmed.to_lowercase();
    (trimmed, key)
}

const COLUMNS: &str = "id, email, email_key, password_hash, email_confirmed_at, created_at";

pub async fn find_by_id(db: &PgPool, id: i64) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(&format!("SELECT {COLUMNS} FROM users WHERE id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn find_by_email(db: &PgPool, email: &str) -> Result<Option<UserRow>, sqlx::Error> {
    let (_, key) = normalize_email(email);
    sqlx::query_as::<_, UserRow>(&format!("SELECT {COLUMNS} FROM users WHERE email_key = $1"))
        .bind(key)
        .fetch_optional(db)
        .await
}

pub async fn count(db: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
        .fetch_one(db)
        .await
}

/// The oldest user (lowest id), if any.
pub async fn find_first(db: &PgPool) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(&format!("SELECT {COLUMNS} FROM users ORDER BY id LIMIT 1"))
        .fetch_optional(db)
        .await
}

/// Inserts a user; `Ok(None)` when the e-mail is already taken.
pub async fn create(
    db: &PgPool,
    email: &str,
    password_hash: Option<&str>,
) -> Result<Option<UserRow>, sqlx::Error> {
    let (email, key) = normalize_email(email);
    sqlx::query_as::<_, UserRow>(&format!(
        "INSERT INTO users (email, email_key, password_hash) VALUES ($1, $2, $3) \
         ON CONFLICT (email_key) DO NOTHING RETURNING {COLUMNS}"
    ))
    .bind(email)
    .bind(key)
    .bind(password_hash)
    .fetch_optional(db)
    .await
}

/// The user with this e-mail, created without a password when missing (mode `none` identify and
/// the Azure callback). Safe under concurrent calls for the same e-mail.
pub async fn find_or_create(db: &PgPool, email: &str) -> Result<UserRow, sqlx::Error> {
    if let Some(u) = create(db, email, None).await? {
        return Ok(u);
    }
    find_by_email(db, email)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

/// Marks the e-mail confirmed (keeps an earlier confirmation time).
pub async fn confirm_email(db: &PgPool, id: i64) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(&format!(
        "UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, now()) \
         WHERE id = $1 RETURNING {COLUMNS}"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn set_password_hash(
    db: &PgPool,
    id: i64,
    password_hash: &str,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(password_hash)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Deletes the user; their tokens, workspaces and workstreams cascade.
pub async fn delete(db: &PgPool, id: i64) -> Result<bool, sqlx::Error> {
    let res = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}
