//! Container paths, the SSH alias and the `claude://` link (FR-3, FR-8, FR-4).
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-container-paths.md`.

/// Parent of the shared folder in the container, unless the devcontainer sets `workspaceFolder`.
pub const WORK_ROOT: &str = "/work";

/// Parent of the given folders in the container.
pub const GIVEN_ROOT: &str = "/work/given";

/// Prefix of every SSH alias; the rest is the laptop id.
pub const ALIAS_PREFIX: &str = "sbx-";

/// Name used when a host path has no last segment at all (`/`).
pub const ROOT_NAME: &str = "root";

/// The last segment of a host path (Windows or POSIX), kept as-is (spaces, non-ASCII, case).
/// `\\?\` and `\\?\UNC\` prefixes and trailing separators are ignored; a drive root `C:\` gives
/// `C`; `/` gives [`ROOT_NAME`].
pub fn host_basename(host_path: &str) -> String {
    let path = strip_verbatim(host_path);
    let last = path
        .split(['/', '\\'])
        .rfind(|s| !s.is_empty())
        .unwrap_or("");
    if last.is_empty() {
        return ROOT_NAME.to_string();
    }
    match last.strip_suffix(':') {
        Some(drive) if drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic()) => {
            drive.to_string()
        }
        _ => last.to_string(),
    }
}

/// Drops a Windows verbatim prefix: `\\?\UNC\server\share` → `\\server\share`, `\\?\C:\x` → `C:\x`.
pub fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// A Windows host path as a Docker engine inside WSL sees it (the source of a bind mount):
/// `D:\work\x` → `<mount_root>d/work/x` (`mount_root` is the distro's automount root, `/mnt/` by
/// default; the drive letter is lowercased, the rest keeps its case), `D:\` → `<mount_root>d`,
/// `\\wsl.localhost\<distro>\home\me` or `\\wsl$\<distro>\home\me` of the engine's own distro →
/// `/home/me`. A POSIX path is kept. `None` for any other UNC path (a network share, another
/// distro): the engine cannot see it.
pub fn wsl_path(host_path: &str, distro: &str, mount_root: &str) -> Option<String> {
    let path = strip_verbatim(host_path);
    if path.starts_with('/') {
        return Some(path);
    }
    let unix = |rest: &str| {
        rest.split(['\\', '/'])
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    };
    if let Some(unc) = path.strip_prefix(r"\\").or_else(|| path.strip_prefix("//")) {
        let mut parts = unc.splitn(3, ['\\', '/']);
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        let wsl_server =
            server.eq_ignore_ascii_case("wsl.localhost") || server.eq_ignore_ascii_case("wsl$");
        if wsl_server && !share.is_empty() && share.eq_ignore_ascii_case(distro) {
            return Some(format!("/{}", unix(rest)));
        }
        return None;
    }
    let mut chars = path.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    if chars.next() != Some(':') {
        return None;
    }
    let rest = unix(chars.as_str());
    let root = format!(
        "{}/{}",
        mount_root.trim_end_matches('/'),
        drive.to_ascii_lowercase()
    );
    Some(if rest.is_empty() {
        root
    } else {
        format!("{root}/{rest}")
    })
}

/// The shared folder's path in the container: the devcontainer's `workspaceFolder` when it sets
/// one, else `/work/<basename>`.
pub fn shared_container_path(host_path: &str, workspace_folder: Option<&str>) -> String {
    match workspace_folder.map(str::trim) {
        Some(wf) if !wf.is_empty() => wf.to_string(),
        _ => format!("{WORK_ROOT}/{}", host_basename(host_path)),
    }
}

/// Container paths of a laptop's given folders, in the given order: `/work/given/<basename>`,
/// and on a collision with an earlier one the first free of `<basename>-2`, `-3`, …
/// Names are compared exactly (the container is case-sensitive).
pub fn given_container_paths(host_paths: &[&str]) -> Vec<String> {
    let mut taken: Vec<String> = Vec::with_capacity(host_paths.len());
    for host in host_paths {
        let base = host_basename(host);
        let mut name = base.clone();
        let mut n = 2u32;
        while taken.contains(&name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        taken.push(name);
    }
    taken
        .into_iter()
        .map(|name| format!("{GIVEN_ROOT}/{name}"))
        .collect()
}

/// The laptop's SSH alias, `sbx-<id>`. Never derived from the display name.
pub fn ssh_alias(laptop_id: &str) -> String {
    format!("{ALIAS_PREFIX}{laptop_id}")
}

/// Percent-encodes like JavaScript's `encodeURIComponent`: every UTF-8 byte except
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )` becomes `%XX` (uppercase hex).
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The Claude Desktop link that opens a new session on the laptop in `folder`.
pub fn claude_link(laptop_id: &str, folder: &str) -> String {
    format!(
        "claude://code/new?ssh_host={}&ssh_folder={}",
        encode_uri_component(&ssh_alias(laptop_id)),
        encode_uri_component(folder)
    )
}
