//! The files AgentBook puts into every laptop, embedded in the binary from `agentbook/assets/`:
//!
//! - [`layer`]: the laptop layer (sshd + SFTP, SSH user, `entry.sh` / `session.sh`) built on top of
//!   any Debian/Ubuntu or Alpine based image;
//! - [`standard`]: the standard Equipment's Dockerfile (Ubuntu 24.04 by digest + Node);
//! - [`tools`]: `ws`, `prompt-hook` (the read-only `/opt/agentbook/bin` mount) and the `agentbook-ws`
//!   skill;
//! - [`claude_md`]: the generated `~/.claude/CLAUDE.md`.
//!
//! Text assets are LF-only (`.gitattributes`); [`Asset::text`] also drops any `\r`, so a CRLF
//! checkout can neither break the scripts nor change the versions derived from them.

use agentbook_core::equipment::sha256_hex;

/// One embedded text file.
#[derive(Debug, Clone, Copy)]
pub struct Asset {
    /// File name as written into a build context or a tool folder.
    pub name: &'static str,
    raw: &'static str,
    /// Whether the file is written with the executable bit (mode 0755) where modes apply.
    pub executable: bool,
}

impl Asset {
    /// The file's text with LF line endings.
    pub fn text(&self) -> String {
        self.raw.replace('\r', "")
    }

    /// The file's bytes with LF line endings.
    pub fn bytes(&self) -> Vec<u8> {
        self.text().into_bytes()
    }

    /// Unix mode to write the file with.
    pub fn mode(&self) -> u32 {
        if self.executable { 0o755 } else { 0o644 }
    }
}

/// A short content version over `assets` plus `extra` strings: the first 12 hex characters of a
/// sha256 over each name and LF text. Any change to an asset therefore changes the version, which
/// marks laptops "Equipment changed" through the config hash.
fn content_version(assets: &[&Asset], extra: &[&str]) -> String {
    let mut buf = Vec::new();
    for a in assets {
        buf.extend_from_slice(a.name.as_bytes());
        buf.push(0);
        buf.extend_from_slice(&a.bytes());
        buf.push(0);
    }
    for e in extra {
        buf.extend_from_slice(e.as_bytes());
        buf.push(0);
    }
    sha256_hex(&buf)[..12].to_string()
}

/// Prefix of the comment the laptop's host key is generated with (`agentbook-laptop-<id>`).
/// `ws` reads this laptop's id from it, since the state directory is shared by every laptop of a
/// folder.
pub const HOST_KEY_COMMENT_PREFIX: &str = "agentbook-laptop-";

/// The comment to generate a laptop's host key with.
pub fn host_key_comment(laptop_id: &str) -> String {
    format!("{HOST_KEY_COMMENT_PREFIX}{laptop_id}")
}

/// The laptop layer.
pub mod layer {
    use super::{Asset, content_version};

    pub const DOCKERFILE: Asset = Asset {
        name: "Dockerfile",
        raw: include_str!("../../../assets/layer/Dockerfile"),
        executable: false,
    };
    pub const INSTALL: Asset = Asset {
        name: "install.sh",
        raw: include_str!("../../../assets/layer/install.sh"),
        executable: true,
    };
    pub const ENTRY: Asset = Asset {
        name: "entry.sh",
        raw: include_str!("../../../assets/layer/entry.sh"),
        executable: true,
    };
    pub const SESSION: Asset = Asset {
        name: "session.sh",
        raw: include_str!("../../../assets/layer/session.sh"),
        executable: true,
    };

    /// Every file of the layer's build context (the Dockerfile first).
    pub const CONTEXT: [Asset; 4] = [DOCKERFILE, INSTALL, ENTRY, SESSION];

    /// Build arg: the image the layer is added to.
    pub const ARG_BASE: &str = "BASE";
    /// Build arg: the resolved SSH user (empty = the tool's `claude` user).
    pub const ARG_SSH_USER: &str = "SSHUSER";

    /// The wrapper entrypoint inside the laptop.
    pub const ENTRYPOINT: &str = "/usr/local/share/agentbook/entry.sh";
    /// The entry appended to the image's `devcontainer.metadata` label array.
    pub const METADATA_ENTRY: &str =
        r#"{"id":"agentbook-laptop","entrypoint":"/usr/local/share/agentbook/entry.sh"}"#;
    /// File in the layered image holding the SSH user the layer was built for.
    pub const SSH_USER_FILE: &str = "/usr/local/share/agentbook/ssh-user";
    /// File in the layered image holding the libc family (`glibc` or `musl`).
    pub const LIBC_FILE: &str = "/usr/local/share/agentbook/libc";

    /// Printed by `install.sh` when the base image has neither apt-get nor apk.
    pub const UNSUPPORTED_MARKER: &str = "AGENTBOOK-LAYER-UNSUPPORTED";

    /// The plain message for a base image the layer cannot be added to (AC-7a).
    pub const UNSUPPORTED_MESSAGE: &str = "AgentBook cannot add the laptop layer to this image. \
         The project's Equipment must be based on Debian, Ubuntu or Alpine (an image with a shell \
         and apt-get or apk); distroless and scratch images are not supported.";

    /// The layer version: changes whenever any layer file changes.
    pub fn version() -> String {
        let refs: Vec<&Asset> = CONTEXT.iter().collect();
        content_version(&refs, &[])
    }

    /// Whether a failed layer build's log means the base image cannot take the layer: the
    /// `install.sh` marker (no apt-get / apk), or no `/bin/sh` at all (scratch, distroless), as
    /// BuildKit and the classic builder report it.
    pub fn is_unsupported_base(log: &str) -> bool {
        if log.contains(UNSUPPORTED_MARKER) {
            return true;
        }
        log.lines().any(|line| {
            let l = line.to_ascii_lowercase();
            l.contains("/bin/sh")
                && (l.contains("no such file or directory")
                    || l.contains("executable file not found")
                    || l.contains("not found in $path"))
        })
    }
}

/// The standard Equipment (`agentbook-std:<version>`).
pub mod standard {
    use super::{Asset, content_version};
    use agentbook_core::pins::NODE_VERSION;

    pub const DOCKERFILE: Asset = Asset {
        name: "Dockerfile",
        raw: include_str!("../../../assets/standard/Dockerfile"),
        executable: false,
    };

    /// Name of the Linux Node archive in the build context.
    pub const NODE_ARCHIVE: &str = "node-linux.tar.xz";
    /// Build arg: the Node version (`agentbook_core::pins::NODE_VERSION`).
    pub const ARG_NODE_VERSION: &str = "NODE_VERSION";
    /// Build arg: the Node archive's sha256, checked again inside the build.
    pub const ARG_NODE_SHA256: &str = "NODE_SHA256";

    /// The pinned base image (`ubuntu:24.04@sha256:…`), read from the Dockerfile's `FROM` line,
    /// which is the single place that names it. The engine pulls it by this reference first.
    pub fn base_image() -> &'static str {
        DOCKERFILE
            .raw
            .lines()
            .find_map(|l| l.trim().strip_prefix("FROM "))
            .map(str::trim)
            .unwrap_or("")
    }

    /// The standard Equipment version: changes with the Dockerfile or the pinned Node.
    pub fn version() -> String {
        content_version(&[&DOCKERFILE], &[NODE_VERSION])
    }

    /// The image tag of the standard Equipment.
    pub fn image_tag() -> String {
        format!("agentbook-std:{}", version())
    }
}

/// The in-laptop tools and the `ws` skill.
pub mod tools {
    use super::Asset;

    pub const WS: Asset = Asset {
        name: "ws",
        raw: include_str!("../../../assets/tools/ws"),
        executable: true,
    };
    pub const PROMPT_HOOK: Asset = Asset {
        name: "prompt-hook",
        raw: include_str!("../../../assets/tools/prompt-hook"),
        executable: true,
    };

    /// Files of the read-only `/opt/agentbook/bin` mount (`tool-files/` in the data folder).
    pub const BIN: [Asset; 2] = [WS, PROMPT_HOOK];

    /// The `UserPromptSubmit` hook command; also the merge key of its `settings.json` entry.
    pub const PROMPT_HOOK_COMMAND: &str = "/opt/agentbook/bin/prompt-hook";

    /// The skill folder name under `~/.claude/skills/` (reserved for the tool).
    pub const SKILL_DIR: &str = "agentbook-ws";
    /// The skill's files (inside [`SKILL_DIR`]).
    pub const SKILL: [Asset; 1] = [Asset {
        name: "SKILL.md",
        raw: include_str!("../../../assets/skills/agentbook-ws/SKILL.md"),
        executable: false,
    }];
}

/// The generated user-level `~/.claude/CLAUDE.md` (FR-4b).
pub mod claude_md {
    use super::Asset;

    pub const TEMPLATE: Asset = Asset {
        name: "CLAUDE.md",
        raw: include_str!("../../../assets/claude-md/CLAUDE.md.template"),
        executable: false,
    };

    /// A given folder as the file lists it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct GivenFolder {
        /// Path in the laptop.
        pub container: String,
        /// Folder on the user's computer.
        pub host: String,
        pub read_only: bool,
    }

    /// What the generated file describes. Variables appear by name only.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Context {
        pub laptop_name: String,
        pub shared_folder_name: String,
        /// The shared folder's path in the laptop.
        pub shared_path: String,
        /// The shared folder on the user's computer.
        pub shared_host_path: String,
        /// The SSH user's home folder (the laptop's volume).
        pub home: String,
        pub given: Vec<GivenFolder>,
        /// Variable names (never values).
        pub variable_names: Vec<String>,
    }

    fn connected_folders(ctx: &Context) -> String {
        let mut out = vec![format!(
            "- `{}`: the shared folder (`{}`), read and write",
            ctx.shared_path, ctx.shared_host_path
        )];
        for g in &ctx.given {
            let mode = if g.read_only {
                "View only"
            } else {
                "read and write"
            };
            out.push(format!(
                "- `{}`: given folder (`{}`), {mode}",
                g.container, g.host
            ));
        }
        if ctx.given.is_empty() {
            out.push("- No given folders.".to_string());
        }
        out.join("\n")
    }

    fn variables(ctx: &Context) -> String {
        // This file is written when the laptop is opened; the user may add Variables later, so the
        // list is marked as a snapshot and points to `ws env ls` for the current one.
        if ctx.variable_names.is_empty() {
            return "No Variables were set when this laptop was opened; `ws env ls` shows the \
                    current ones."
                .to_string();
        }
        let names: Vec<String> = ctx
            .variable_names
            .iter()
            .map(|n| format!("`{n}`"))
            .collect();
        format!(
            "Set when this laptop was opened (names only; values are never written here): {}. \
             `ws env ls` shows the current ones.",
            names.join(", ")
        )
    }

    /// Renders the template. Placeholders are `{{name}}`; substituted text is never scanned
    /// again, so a laptop or folder name containing `{{…}}` stays literal. An unknown placeholder
    /// is kept as-is.
    pub fn render(ctx: &Context) -> String {
        let template = TEMPLATE.text();
        let lookup = |key: &str| -> Option<String> {
            Some(match key {
                "laptop_name" => ctx.laptop_name.clone(),
                "shared_folder_name" => ctx.shared_folder_name.clone(),
                "shared_path" => ctx.shared_path.clone(),
                "shared_host_path" => ctx.shared_host_path.clone(),
                "home" => ctx.home.clone(),
                "connected_folders" => connected_folders(ctx),
                "variables" => variables(ctx),
                _ => return None,
            })
        };
        let mut out = String::with_capacity(template.len() + 512);
        let mut rest = template.as_str();
        while let Some(start) = rest.find("{{") {
            out.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            match after.find("}}") {
                Some(end) => match lookup(&after[..end]) {
                    Some(value) => {
                        out.push_str(&value);
                        rest = &after[end + 2..];
                    }
                    None => {
                        out.push_str("{{");
                        rest = after;
                    }
                },
                None => {
                    out.push_str("{{");
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }
}
