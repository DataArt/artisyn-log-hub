//! Equipment change (FR-7): the config hash that keys the image cache and marks laptops
//! "Equipment changed", the card state it gives, and whether Update laptop clears the
//! downloaded Claude Code CLI because the libc family switched.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-equipment.md`.

use sha2::{Digest, Sha256};

use crate::state::Libc;

/// Domain tag hashed first, so a future change of the hash layout cannot collide with this one.
pub const HASH_TAG: &str = "agentbook-equipment-v1";

/// Lowercase hex sha256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The Equipment config hash.
///
/// `files` are the Equipment source files (the selected devcontainer config, every file in its
/// folder, the compose files and Dockerfile it references), each as (path relative to the shared
/// folder, bytes); empty for the standard Equipment. Paths use `/` (a `\` is turned into `/`); the
/// list is sorted by path and a repeated path counts once (its first entry).
///
/// Hashed: `HASH_TAG`, `\n`; per file: path, a 0 byte, the length as 8 big-endian bytes, the
/// bytes; then `std=<standard version>\n` and `layer=<layer version>\n`.
pub fn config_hash(files: &[(String, Vec<u8>)], std_version: &str, layer_version: &str) -> String {
    let mut sorted: Vec<(String, &[u8])> = files
        .iter()
        .map(|(p, b)| (p.replace('\\', "/"), b.as_slice()))
        .collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted.dedup_by(|later, earlier| later.0 == earlier.0);

    let mut h = Sha256::new();
    h.update(HASH_TAG.as_bytes());
    h.update(b"\n");
    for (path, bytes) in &sorted {
        h.update(path.as_bytes());
        h.update([0u8]);
        h.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
        h.update(bytes);
    }
    h.update(format!("std={std_version}\nlayer={layer_version}\n").as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The Equipment state on a laptop card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EquipmentState {
    /// No image built yet (no recorded hash).
    NotBuilt,
    /// The recorded hash equals the current one.
    Current,
    /// "Equipment changed — Update laptop".
    Changed,
}

impl EquipmentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotBuilt => "not-built",
            Self::Current => "current",
            Self::Changed => "changed",
        }
    }
}

/// Compares a laptop's recorded hash with the current one.
pub fn equipment_state(recorded: Option<&str>, current: &str) -> EquipmentState {
    match recorded {
        None => EquipmentState::NotBuilt,
        Some(r) if r == current => EquipmentState::Current,
        Some(_) => EquipmentState::Changed,
    }
}

/// Whether Update laptop clears `~/.claude/remote/ccd-cli` in the kept volume: the new image's
/// libc family differs from the recorded one, or none was recorded (an unknown family is treated
/// as a switch; the cost is one CLI download).
pub fn clears_ccd_cli(recorded: Option<&Libc>, new: &Libc) -> bool {
    recorded != Some(new)
}
