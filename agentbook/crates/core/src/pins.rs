//! Pinned versions and sha256 checksums of what AgentBook downloads itself (FR-10). A file is used
//! only after its checksum matches the constant here. The standard Equipment's Ubuntu base is
//! pinned by digest in its Dockerfile (`agentbook/assets/standard/Dockerfile`), the single place
//! that names it.

/// Node.js release used on the host (devcontainer CLI runtime) and in the standard Equipment.
pub const NODE_VERSION: &str = "v24.22.3";

/// sha256 of `node-<NODE_VERSION>-win-x64.zip` (nodejs.org `SHASUMS256.txt`).
pub const NODE_WIN_X64_SHA256: &str =
    "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f";

/// sha256 of `node-<NODE_VERSION>-linux-x64.tar.xz`.
pub const NODE_LINUX_X64_SHA256: &str =
    "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb";

/// sha256 of `node-<NODE_VERSION>-linux-arm64.tar.xz`.
pub const NODE_LINUX_ARM64_SHA256: &str =
    "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c";

/// The Linux Node archive for the Docker engine's architecture (`x64` or `arm64`), as
/// (file name, sha256). `None` for an architecture the standard Equipment does not support.
pub fn node_linux_archive(arch: &str) -> Option<(String, &'static str)> {
    let (suffix, sha) = match arch {
        "x64" | "amd64" | "x86_64" => ("x64", NODE_LINUX_X64_SHA256),
        "arm64" | "aarch64" => ("arm64", NODE_LINUX_ARM64_SHA256),
        _ => return None,
    };
    Some((format!("node-{NODE_VERSION}-linux-{suffix}.tar.xz"), sha))
}

/// Size in bytes of `node-<NODE_VERSION>-win-x64.zip` (shown before the download).
pub const NODE_WIN_X64_SIZE: u64 = 37_762_649;

/// Size in bytes of `node-<NODE_VERSION>-linux-x64.tar.xz`.
pub const NODE_LINUX_X64_SIZE: u64 = 32_064_292;

/// Size in bytes of `node-<NODE_VERSION>-linux-arm64.tar.xz`.
pub const NODE_LINUX_ARM64_SIZE: u64 = 30_991_864;

/// sha256 of `node-<NODE_VERSION>-darwin-arm64.tar.gz`.
pub const NODE_DARWIN_ARM64_SHA256: &str =
    "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd";

/// sha256 of `node-<NODE_VERSION>-darwin-x64.tar.gz`.
pub const NODE_DARWIN_X64_SHA256: &str =
    "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7";

/// Size in bytes of `node-<NODE_VERSION>-darwin-arm64.tar.gz`.
pub const NODE_DARWIN_ARM64_SIZE: u64 = 53_084_299;

/// Size in bytes of `node-<NODE_VERSION>-darwin-x64.tar.gz`.
pub const NODE_DARWIN_X64_SIZE: u64 = 54_395_976;

/// How a host Node archive is packed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    Zip,
    TarGz,
}

/// The Node archive the host runs the devcontainer CLI with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeHostArchive {
    /// The file name under `<NODE_BASE>/<NODE_VERSION>/`.
    pub file: String,
    pub sha256: &'static str,
    pub size: u64,
    pub kind: ArchiveKind,
    /// The Node executable's path inside the archive.
    pub inner: String,
}

/// The host Node archive for `std::env::consts::{OS, ARCH}`: the win-x64 zip on Windows (arm64
/// Windows runs it emulated), the darwin tarball of the Mac's CPU on macOS; `None` elsewhere.
pub fn node_host_archive(os: &str, arch: &str) -> Option<NodeHostArchive> {
    let (platform, sha256, size, kind, exe) = match (os, arch) {
        ("windows", _) => (
            "win-x64",
            NODE_WIN_X64_SHA256,
            NODE_WIN_X64_SIZE,
            ArchiveKind::Zip,
            "node.exe",
        ),
        ("macos", "aarch64" | "arm64") => (
            "darwin-arm64",
            NODE_DARWIN_ARM64_SHA256,
            NODE_DARWIN_ARM64_SIZE,
            ArchiveKind::TarGz,
            "bin/node",
        ),
        ("macos", "x86_64" | "x64") => (
            "darwin-x64",
            NODE_DARWIN_X64_SHA256,
            NODE_DARWIN_X64_SIZE,
            ArchiveKind::TarGz,
            "bin/node",
        ),
        _ => return None,
    };
    let ext = match kind {
        ArchiveKind::Zip => "zip",
        ArchiveKind::TarGz => "tar.gz",
    };
    Some(NodeHostArchive {
        file: format!("node-{NODE_VERSION}-{platform}.{ext}"),
        sha256,
        size,
        kind,
        inner: format!("node-{NODE_VERSION}-{platform}/{exe}"),
    })
}

/// The `@devcontainers/cli` release run with the downloaded Node (it has no runtime dependencies).
pub const DEVCONTAINERS_CLI_VERSION: &str = "0.91.0";

/// sha256 of `cli-<DEVCONTAINERS_CLI_VERSION>.tgz` from registry.npmjs.org.
pub const DEVCONTAINERS_CLI_SHA256: &str =
    "d83e2291a799818ea8abfba634f0bb699f05a8df21376feefb07bb631844f41f";

/// Size in bytes of `cli-<DEVCONTAINERS_CLI_VERSION>.tgz`.
pub const DEVCONTAINERS_CLI_SIZE: u64 = 617_509;

/// The pinned size of a Linux Node archive (see [`node_linux_archive`]).
pub fn node_linux_size(arch: &str) -> Option<u64> {
    match arch {
        "x64" | "amd64" | "x86_64" => Some(NODE_LINUX_X64_SIZE),
        "arm64" | "aarch64" => Some(NODE_LINUX_ARM64_SIZE),
        _ => None,
    }
}
