//! Small host-file helpers: write-then-rename, POSIX-sh quoting and host paths as ssh and Docker
//! want them.

use std::path::Path;

use agentbook_core::paths::strip_verbatim;

/// Writes `bytes` to a temp file next to `path`, then renames it over `path`, so a reader (the
/// container's `ws`, ssh) sees either the old or the new file, never a half-written one.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// A host path with forward slashes and no verbatim prefix (ssh config values).
pub(crate) fn slash_path(p: &Path) -> String {
    strip_verbatim(&p.to_string_lossy()).replace('\\', "/")
}

/// A host path as Docker and the CLI get it (no Windows verbatim prefix).
pub(crate) fn host_path(p: &Path) -> String {
    strip_verbatim(&p.to_string_lossy())
}

/// Single-quotes `s` for POSIX sh (`'` becomes `'\''`).
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
