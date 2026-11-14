//! Password hashing (D3): Argon2id, m = 19456 KiB, t = 2, p = 1 (the OWASP baseline), stored as a
//! PHC string. Hashing is CPU-bound, so the async helpers run it on the blocking pool.

use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};

use crate::error::ApiError;

pub const M_COST_KIB: u32 = 19_456;
pub const T_COST: u32 = 2;
pub const P_COST: u32 = 1;

fn hasher() -> Result<Argon2<'static>, argon2::Error> {
    let params = Params::new(M_COST_KIB, T_COST, P_COST, None)?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// A fresh PHC string (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) with a random salt.
pub fn hash_password_sync(password: &str) -> Result<String, String> {
    let argon = hasher().map_err(|e| e.to_string())?;
    argon
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// `true` when `password` matches the PHC string. A malformed hash is a mismatch, never a panic.
/// The parameters come from the stored hash, so older hashes keep verifying.
pub fn verify_password_sync(password: &str, phc: &str) -> bool {
    match hasher() {
        Ok(argon) => argon.verify_password(password.as_bytes(), phc).is_ok(),
        Err(_) => false,
    }
}

/// [`hash_password_sync`] on the blocking pool.
pub async fn hash_password(password: &str) -> Result<String, ApiError> {
    let password = password.to_string();
    tokio::task::spawn_blocking(move || hash_password_sync(&password))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)
}

/// [`verify_password_sync`] on the blocking pool.
pub async fn verify_password(password: &str, phc: &str) -> Result<bool, ApiError> {
    let (password, phc) = (password.to_string(), phc.to_string());
    tokio::task::spawn_blocking(move || verify_password_sync(&password, &phc))
        .await
        .map_err(ApiError::internal)
}
