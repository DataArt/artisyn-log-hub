//! SSH user resolution (FR-4): who SSH logs in as, whether the laptop layer creates that user,
//! its home folder (the laptop volume's mount point) and the sshd `PermitRootLogin` value.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-ssh-user.md`.

/// The user the laptop layer creates when the devcontainer names none.
pub const TOOL_USER: &str = "claude";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshUser {
    pub user: String,
    /// The layer creates the user (only for [`TOOL_USER`]; the layer skips it when it exists).
    pub create: bool,
    pub home: String,
    /// sshd `PermitRootLogin`: `prohibit-password` (key only) when the user is root, else `no`.
    pub permit_root_login: &'static str,
}

/// Resolves the SSH user from the merged devcontainer config. The image's own default user is
/// deliberately not an input: an image that runs as root still gets [`TOOL_USER`] unless the
/// config names `root` explicitly.
///
/// 1. The first of `remoteUser`, `containerUser` that is set and not blank (trimmed).
/// 2. Its part before `:` (a `user:group` form); `0` means `root`.
/// 3. None set: [`TOOL_USER`], created by the layer.
/// 4. Home: `/root` for root, else `/home/<user>`.
pub fn resolve(remote_user: Option<&str>, container_user: Option<&str>) -> SshUser {
    let named = [remote_user, container_user]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|u| !u.is_empty())
        .map(|u| u.split(':').next().unwrap_or(u).trim())
        .filter(|u| !u.is_empty());
    let (user, create) = match named {
        Some("0") => ("root".to_string(), false),
        Some(u) => (u.to_string(), false),
        None => (TOOL_USER.to_string(), true),
    };
    let root = user == "root";
    SshUser {
        home: if root {
            "/root".to_string()
        } else {
            format!("/home/{user}")
        },
        permit_root_login: if root { "prohibit-password" } else { "no" },
        user,
        create,
    }
}
