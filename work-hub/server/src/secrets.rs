//! Secret store (owner, 2026-11-14). Everything a user works on stays readable on disk (FR-5g);
//! secrets do not. A secret is one file `<data dir>/secrets/<user id>/<name>.enc` holding
//! `WHS1 || nonce (12) || AES-256-GCM(value)` with `<user id>/<name>` as associated data; the key
//! is 32 random bytes in the `secret_key` table, generated on first use. So a copy of the data
//! directory alone, or a database dump alone, does not give the secrets away. Values are only
//! decrypted in the server's memory, when a process that needs them is started.
//!
//! The first secret is the agent's long-lived token (`<agent id>-token`); later secrets go here
//! too.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};

use crate::error::ApiError;
use crate::state::AppState;

const MAGIC: &[u8; 4] = b"WHS1";
const NONCE_LEN: usize = 12;

/// A secret name: lowercase letters, digits and `-` (it is a file name).
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn path(st: &AppState, user_id: i64, name: &str) -> std::path::PathBuf {
    st.config
        .data_dir
        .join("secrets")
        .join(user_id.to_string())
        .join(format!("{name}.enc"))
}

/// The store's key, generated and stored on first use.
async fn key(st: &AppState) -> Result<[u8; 32], ApiError> {
    if let Some((k,)) = sqlx::query_as::<_, (Vec<u8>,)>("SELECT key FROM secret_key WHERE id = 1")
        .fetch_optional(&st.db)
        .await?
    {
        return k
            .try_into()
            .map_err(|_| ApiError::internal("the secret store key has a wrong length"));
    }
    let mut fresh = [0u8; 32];
    rand::fill(&mut fresh[..]);
    sqlx::query("INSERT INTO secret_key (id, key) VALUES (1, $1) ON CONFLICT (id) DO NOTHING")
        .bind(&fresh[..])
        .execute(&st.db)
        .await?;
    // Another request may have won the insert: read back whichever key is stored.
    let (k,): (Vec<u8>,) = sqlx::query_as("SELECT key FROM secret_key WHERE id = 1")
        .fetch_one(&st.db)
        .await?;
    k.try_into()
        .map_err(|_| ApiError::internal("the secret store key has a wrong length"))
}

fn cipher(key: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
}

/// Stores (or replaces) a secret of the user.
pub async fn put(st: &AppState, user_id: i64, name: &str, value: &[u8]) -> Result<(), ApiError> {
    if !valid_name(name) {
        return Err(ApiError::internal(format!("bad secret name {name:?}")));
    }
    let key = key(st).await?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::fill(&mut nonce[..]);
    let aad = format!("{user_id}/{name}");
    let sealed = cipher(&key)
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: value,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| ApiError::internal("cannot encrypt the secret"))?;
    let mut file = Vec::with_capacity(MAGIC.len() + NONCE_LEN + sealed.len());
    file.extend_from_slice(MAGIC);
    file.extend_from_slice(&nonce);
    file.extend_from_slice(&sealed);

    let target = path(st, user_id, name);
    let dir = target
        .parent()
        .ok_or_else(|| ApiError::internal("secret path has no parent"))?;
    std::fs::create_dir_all(dir).map_err(ApiError::internal)?;
    restrict(dir);
    let tmp = target.with_extension("enc.tmp");
    std::fs::write(&tmp, &file).map_err(ApiError::internal)?;
    restrict(&tmp);
    std::fs::rename(&tmp, &target).map_err(ApiError::internal)?;
    Ok(())
}

/// The secret's value; `None` when it is missing or no longer decrypts (e.g. the key was lost —
/// the user then logs in again).
pub async fn get(st: &AppState, user_id: i64, name: &str) -> Result<Option<Vec<u8>>, ApiError> {
    if !valid_name(name) {
        return Ok(None);
    }
    let file = match std::fs::read(path(st, user_id, name)) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ApiError::internal(e)),
    };
    if file.len() < MAGIC.len() + NONCE_LEN || &file[..MAGIC.len()] != MAGIC {
        tracing::warn!("secret {name} of user {user_id} has an unknown format");
        return Ok(None);
    }
    let key = key(st).await?;
    let (nonce, sealed) = file[MAGIC.len()..].split_at(NONCE_LEN);
    let aad = format!("{user_id}/{name}");
    match cipher(&key).decrypt(
        Nonce::from_slice(nonce),
        Payload {
            msg: sealed,
            aad: aad.as_bytes(),
        },
    ) {
        Ok(v) => Ok(Some(v)),
        Err(_) => {
            tracing::warn!("secret {name} of user {user_id} does not decrypt with the current key");
            Ok(None)
        }
    }
}

/// True when the user has this secret (and it decrypts).
pub async fn exists(st: &AppState, user_id: i64, name: &str) -> Result<bool, ApiError> {
    Ok(get(st, user_id, name).await?.is_some())
}

/// Deletes a secret; a missing one is fine.
pub async fn delete(st: &AppState, user_id: i64, name: &str) -> Result<(), ApiError> {
    if !valid_name(name) {
        return Ok(());
    }
    match std::fs::remove_file(path(st, user_id, name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// Deletes every secret of the user (account deletion).
pub fn delete_all(st: &AppState, user_id: i64) -> Result<(), ApiError> {
    let dir = st.config.data_dir.join("secrets").join(user_id.to_string());
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// 0700 / 0600 on Unix; a no-op elsewhere.
fn restrict(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if path.is_dir() { 0o700 } else { 0o600 };
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = path;
}
