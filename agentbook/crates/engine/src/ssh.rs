//! SSH (FR-4): each laptop's key pairs, its block in the tool-owned ssh config, its pre-seeded
//! known_hosts and the one `Include` line in `~/.ssh/config`.
//!
//! - `laptops/<id>/key/`: the host key (comment `agentbook-laptop-<id>`, which `ws` reads) and
//!   `authorized_keys`, mounted read-only into every container of the laptop, so the fingerprint
//!   survives every recreate;
//! - `laptops/<id>/client/id_ed25519`: the client key, restricted to the user;
//! - `~/.ssh/agentbook/config`: one block per alias `sbx-<id>` between `# >>> sbx-<id>` and
//!   `# <<< sbx-<id>` markers. A block is only added, replaced (port or user changed) or removed;
//!   every other block stays byte-identical;
//! - `~/.ssh/agentbook/known_hosts_sbx-<id>`: `sbx-<id> <host key>` (the block's `HostKeyAlias`);
//! - `~/.ssh/config`: `Include ~/.ssh/agentbook/config`, added once at the top (an `Include` below
//!   a `Host` block would only apply inside it). The user's own lines are never changed.

use std::path::{Path, PathBuf};

use agentbook_core::paths::ssh_alias;

use crate::assets::host_key_comment;
use crate::engine::{Ctx, EngineError, EngineResult};
use crate::files::{slash_path, write_atomic};

/// The line added at the top of `~/.ssh/config`.
pub const INCLUDE_LINE: &str = "Include ~/.ssh/agentbook/config";

const CONFIG_HEADER: &str = "# Written by AgentBook: one block per laptop (sbx-<id>). AgentBook \
     adds, replaces and removes only its own blocks.\n";

/// `~/.ssh/agentbook/`.
pub fn agentbook_ssh_dir(ssh_dir: &Path) -> PathBuf {
    ssh_dir.join("agentbook")
}

/// The tool-owned ssh config.
pub fn config_file(ssh_dir: &Path) -> PathBuf {
    agentbook_ssh_dir(ssh_dir).join("config")
}

/// The alias's own known_hosts file.
pub fn known_hosts_file(ssh_dir: &Path, laptop_id: &str) -> PathBuf {
    agentbook_ssh_dir(ssh_dir).join(format!("known_hosts_{}", ssh_alias(laptop_id)))
}

fn begin_marker(alias: &str) -> String {
    format!("# >>> {alias}")
}

fn end_marker(alias: &str) -> String {
    format!("# <<< {alias}")
}

/// The config text without `alias`'s block (other text untouched).
pub fn remove_block(text: &str, alias: &str) -> String {
    let begin = begin_marker(alias);
    let end = end_marker(alias);
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if !inside && trimmed == begin {
            inside = true;
            continue;
        }
        if inside {
            if trimmed == end {
                inside = false;
            }
            continue;
        }
        out.push_str(line);
    }
    out
}

/// The config text with `alias`'s block set to `block`: replaced in place when present, else
/// appended at the end.
pub fn upsert_block(text: &str, alias: &str, block: &str) -> String {
    let begin = begin_marker(alias);
    if !text.lines().any(|l| l.trim_end() == begin) {
        let mut out = text.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(block);
        return out;
    }
    let end = end_marker(alias);
    let mut out = String::with_capacity(text.len() + block.len());
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if !inside && trimmed == begin {
            inside = true;
            out.push_str(block);
            continue;
        }
        if inside {
            if trimmed == end {
                inside = false;
            }
            continue;
        }
        out.push_str(line);
    }
    out
}

/// One alias block (the PoC recipe).
pub fn alias_block(alias: &str, port: u16, user: &str, key: &Path, known_hosts: &Path) -> String {
    [
        begin_marker(alias),
        format!("Host {alias}"),
        "  HostName 127.0.0.1".to_string(),
        format!("  Port {port}"),
        format!("  User {user}"),
        format!("  IdentityFile \"{}\"", slash_path(key)),
        "  IdentitiesOnly yes".to_string(),
        format!("  HostKeyAlias {alias}"),
        format!("  UserKnownHostsFile \"{}\"", slash_path(known_hosts)),
        "  StrictHostKeyChecking yes".to_string(),
        end_marker(alias),
        String::new(),
    ]
    .join("\n")
}

/// Whether `text` already has the include line (any case of `Include`, any spacing).
fn has_include(text: &str) -> bool {
    text.lines().any(|l| {
        let mut parts = l.split_whitespace();
        matches!(
            (parts.next(), parts.next(), parts.next()),
            (Some(k), Some(v), None)
                if k.eq_ignore_ascii_case("include") && v == "~/.ssh/agentbook/config"
        )
    })
}

/// Adds the include line at the top of `~/.ssh/config` once (keeping the file's line endings).
/// The file is written in place, so its permissions stay as the user set them.
pub(crate) fn ensure_include(ssh_dir: &Path) -> EngineResult<()> {
    let path = ssh_dir.join("config");
    let current = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(EngineError(format!("cannot read {}: {e}", path.display()))),
    };
    if has_include(&current) {
        return Ok(());
    }
    let eol = if current.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let text = format!("{INCLUDE_LINE}{eol}{current}");
    std::fs::create_dir_all(ssh_dir)
        .and_then(|()| std::fs::write(&path, text))
        .map_err(|e| EngineError(format!("cannot write {}: {e}", path.display())))
}

/// Generates the laptop's host and client keys when missing and writes `authorized_keys`.
/// Returns whether anything was generated.
pub(crate) fn ensure_keys(ctx: &Ctx, laptop_id: &str) -> EngineResult<bool> {
    let mut generated = false;
    let host = ctx.layout.host_key(laptop_id);
    let client = ctx.layout.client_key(laptop_id);
    for (key, comment, restrict) in [
        (&host, host_key_comment(laptop_id), false),
        (&client, format!("agentbook-client-{laptop_id}"), true),
    ] {
        let public = key.with_extension("pub");
        if key.is_file() && public.is_file() {
            continue;
        }
        // A half-made pair (an interrupted earlier run) is made again.
        let _ = std::fs::remove_file(key);
        let _ = std::fs::remove_file(&public);
        ctx.platform
            .ssh_keygen(key, &comment)
            .map_err(|e| EngineError(format!("cannot create the laptop's SSH key: {e}")))?;
        if restrict {
            ctx.platform.restrict_private_key(key).map_err(|e| {
                EngineError(format!(
                    "cannot restrict {} to this user: {e}",
                    key.display()
                ))
            })?;
        }
        generated = true;
    }
    let authorized = ctx.layout.key_dir(laptop_id).join("authorized_keys");
    let client_pub = std::fs::read_to_string(client.with_extension("pub"))
        .map_err(|e| EngineError(format!("cannot read the client key: {e}")))?;
    let want = format!("{}\n", client_pub.trim());
    if std::fs::read_to_string(&authorized).ok().as_deref() != Some(want.as_str()) {
        write_atomic(&authorized, want.as_bytes())
            .map_err(|e| EngineError(format!("cannot write {}: {e}", authorized.display())))?;
    }
    Ok(generated)
}

/// Writes the laptop's alias block (only when it changed), its known_hosts and the include line.
pub(crate) fn write_alias(ctx: &Ctx, laptop_id: &str, port: u16, user: &str) -> EngineResult<()> {
    let ssh_dir = ctx.platform.ssh_dir();
    let alias = ssh_alias(laptop_id);
    let known = known_hosts_file(&ssh_dir, laptop_id);
    let host_pub = std::fs::read_to_string(ctx.layout.host_key(laptop_id).with_extension("pub"))
        .map_err(|e| EngineError(format!("cannot read the laptop's host key: {e}")))?;
    let mut fields = host_pub.split_whitespace();
    let (Some(kind), Some(key)) = (fields.next(), fields.next()) else {
        return Err(EngineError("the laptop's host key is not valid".into()));
    };
    let known_text = format!("{alias} {kind} {key}\n");
    if std::fs::read_to_string(&known).ok().as_deref() != Some(known_text.as_str()) {
        write_atomic(&known, known_text.as_bytes())
            .map_err(|e| EngineError(format!("cannot write {}: {e}", known.display())))?;
    }
    let config = config_file(&ssh_dir);
    let current = std::fs::read_to_string(&config).unwrap_or_default();
    let base = if current.is_empty() {
        CONFIG_HEADER.to_string()
    } else {
        current.clone()
    };
    let block = alias_block(
        &alias,
        port,
        user,
        &ctx.layout.client_key(laptop_id),
        &known,
    );
    let next = upsert_block(&base, &alias, &block);
    if next != current {
        write_atomic(&config, next.as_bytes())
            .map_err(|e| EngineError(format!("cannot write {}: {e}", config.display())))?;
    }
    ensure_include(&ssh_dir)
}

/// Removes the laptop's alias block and known_hosts file.
pub(crate) fn remove_alias(ctx: &Ctx, laptop_id: &str) -> EngineResult<()> {
    let ssh_dir = ctx.platform.ssh_dir();
    let config = config_file(&ssh_dir);
    if let Ok(current) = std::fs::read_to_string(&config) {
        let next = remove_block(&current, &ssh_alias(laptop_id));
        if next != current {
            write_atomic(&config, next.as_bytes())
                .map_err(|e| EngineError(format!("cannot write {}: {e}", config.display())))?;
        }
    }
    match std::fs::remove_file(known_hosts_file(&ssh_dir, laptop_id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(EngineError(format!(
            "cannot remove the known_hosts file: {e}"
        ))),
    }
}
