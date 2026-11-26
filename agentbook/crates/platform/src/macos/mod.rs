//! The macOS `Platform`: `~/Library/Application Support/AgentBook`, Docker Desktop's socket,
//! `ssh` / `ssh-keygen` / `git` from PATH (plus the usual Homebrew and Docker folders a Finder-started
//! app does not get), the login Keychain, `chmod 600` for private keys, `open` for URLs and
//! folders, the AppKit folder panel, fonts from the system font folders and the clipboard through
//! `pbcopy` / `pbpaste`.

mod clipboard;
mod credentials;
mod fonts;
mod proxy;

use std::ffi::OsString;
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use agentbook_core::docker_endpoint::{Endpoint, EndpointKind};

use crate::docker::{
    DockerEndpoint, DockerEndpointError, DockerEnv, Probed, resolve_docker_endpoint,
};
use crate::{FontFile, HostAutocrlf, OpensshVersion, Platform, PlatformError, ProxySettings};

/// Folders searched after PATH: an app started from the Finder or the Dock gets only
/// `/usr/bin:/bin:/usr/sbin:/sbin`, while `docker` and a newer `git` live here.
const EXTRA_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    "/opt/local/bin",
];

/// The native macOS platform.
#[derive(Debug, Default, Clone)]
pub struct MacPlatform;

impl MacPlatform {
    pub fn new() -> Self {
        Self
    }

    /// PATH followed by `~/.docker/bin`, `~/.orbstack/bin` and [`EXTRA_BIN_DIRS`], without
    /// duplicates.
    fn search_path(&self) -> Vec<PathBuf> {
        let home = self.home_dir();
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        let extra = [
            home.join(".docker").join("bin"),
            home.join(".orbstack").join("bin"),
        ]
        .into_iter()
        .chain(EXTRA_BIN_DIRS.iter().map(PathBuf::from))
        .chain(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
        for dir in extra {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        dirs.retain(|d| d.is_absolute());
        dirs
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn run(cmd: &mut Command, program: &Path) -> Result<Output, PlatformError> {
    cmd.output()
        .map_err(|e| PlatformError::Other(format!("could not start {}: {e}", program.display())))
}

fn quiet(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null());
    cmd
}

fn combined(output: &Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text
}

fn probe_unix(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err("not found".into());
    }
    UnixStream::connect(path)
        .map(|_| ())
        .map_err(|e| format!("no answer: {e}"))
}

fn probe_tcp(url: &str) -> Result<(), String> {
    let authority = crate::docker::tcp_authority(url).ok_or_else(|| "has no host".to_string())?;
    let addrs = authority
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {authority}: {e}"))?;
    let mut last = "has no address".to_string();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
            Ok(_) => return Ok(()),
            Err(e) => last = format!("no answer on {addr}: {e}"),
        }
    }
    Err(last)
}

fn probe(endpoint: &Endpoint) -> Result<Probed, String> {
    match endpoint.kind {
        EndpointKind::Unix => probe_unix(&endpoint.address).map(|()| Probed::default()),
        EndpointKind::Tcp => probe_tcp(&endpoint.address).map(|()| Probed::default()),
        EndpointKind::Pipe => Err("named pipes are not used on macOS".into()),
        EndpointKind::Wsl => Err("WSL is not available on macOS".into()),
    }
}

fn open(args: &[&std::ffi::OsStr]) -> Result<(), PlatformError> {
    let program = Path::new("/usr/bin/open");
    let output = run(quiet(program).args(args), program)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(PlatformError::Command {
            program: "open".into(),
            status: output.status.to_string(),
            output: combined(&output),
        })
    }
}

impl Platform for MacPlatform {
    fn is_windows(&self) -> bool {
        false
    }

    fn home_dir(&self) -> PathBuf {
        env_var("HOME")
            .map(PathBuf::from)
            .or_else(std::env::home_dir)
            .unwrap_or_else(|| PathBuf::from("/Users/Shared"))
    }

    fn data_dir(&self) -> PathBuf {
        self.home_dir()
            .join("Library")
            .join("Application Support")
            .join("AgentBook")
    }

    fn ssh_dir(&self) -> PathBuf {
        self.home_dir().join(".ssh")
    }

    fn docker_endpoint(&self) -> Result<DockerEndpoint, DockerEndpointError> {
        let home = self.home_dir();
        let env = DockerEnv {
            docker_host: env_var("DOCKER_HOST"),
            docker_context: env_var("DOCKER_CONTEXT"),
            config_dir: env_var("DOCKER_CONFIG")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".docker")),
            home: home.to_string_lossy().into_owned(),
            windows: false,
        };
        resolve_docker_endpoint(&env, probe)
    }

    fn find_program(&self, name: &str) -> Option<PathBuf> {
        if name.contains('/') {
            let p = PathBuf::from(name);
            return p.is_file().then_some(p);
        }
        self.search_path()
            .into_iter()
            .map(|dir| dir.join(name))
            .find(|candidate| {
                candidate
                    .metadata()
                    .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            })
    }

    fn openssh_version(&self) -> Option<OpensshVersion> {
        let ssh = self.find_program("ssh")?;
        let output = run(quiet(&ssh).arg("-V"), &ssh).ok()?;
        let text = combined(&output);
        let (major, minor) = agentbook_core::openssh::parse_version(&text)?;
        Some(OpensshVersion {
            major,
            minor,
            raw: text.lines().next().unwrap_or("").trim().to_string(),
            path: ssh,
        })
    }

    fn credential_get(&self, target: &str) -> Result<Option<String>, PlatformError> {
        credentials::get(target)
    }

    fn credential_set(&self, target: &str, value: &str) -> Result<(), PlatformError> {
        credentials::set(target, value)
    }

    fn credential_delete(&self, target: &str) -> Result<bool, PlatformError> {
        credentials::delete(target)
    }

    fn credential_list(&self, prefix: &str) -> Result<Vec<String>, PlatformError> {
        credentials::list(prefix)
    }

    fn ssh_keygen(&self, path: &Path, comment: &str) -> Result<(), PlatformError> {
        if path.exists() {
            return Err(PlatformError::Other(format!(
                "{} already exists",
                path.display()
            )));
        }
        // Prefer the ssh-keygen next to the ssh found, so both come from one OpenSSH.
        let keygen = self
            .find_program("ssh")
            .and_then(|ssh| {
                let sibling = ssh.with_file_name("ssh-keygen");
                sibling.is_file().then_some(sibling)
            })
            .or_else(|| self.find_program("ssh-keygen"))
            .ok_or_else(|| PlatformError::ProgramNotFound("ssh-keygen".into()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                PlatformError::Other(format!("cannot create {}: {e}", parent.display()))
            })?;
        }
        let output = run(
            quiet(&keygen)
                .args(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f"])
                .arg(path),
            &keygen,
        )?;
        if !output.status.success() || !path.is_file() {
            return Err(PlatformError::Command {
                program: keygen.display().to_string(),
                status: output.status.to_string(),
                output: combined(&output),
            });
        }
        Ok(())
    }

    fn restrict_private_key(&self, path: &Path) -> Result<(), PlatformError> {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| PlatformError::Other(format!("chmod 600 {}: {e}", path.display())))
    }

    fn open_url(&self, url: &str) -> Result<(), PlatformError> {
        open(&[url.as_ref()])
    }

    fn open_in_file_manager(&self, path: &Path) -> Result<(), PlatformError> {
        if path.is_dir() {
            open(&[path.as_os_str()])
        } else {
            // `-R` reveals the file, selected, in its Finder window.
            open(&["-R".as_ref(), path.as_os_str()])
        }
    }

    fn pick_folder(&self) -> Option<PathBuf> {
        // rfd runs the panel on the main thread itself when called from another one.
        rfd::FileDialog::new().pick_folder()
    }

    fn ui_fonts(&self) -> Vec<FontFile> {
        fonts::ui_fonts()
    }

    fn host_git_autocrlf(&self) -> HostAutocrlf {
        // `/usr/bin/git` is a stub that asks to install the Command Line Tools when they are
        // missing; only a git that really runs counts.
        let Some(git) = self.find_program("git") else {
            return HostAutocrlf::default();
        };
        let works = run(quiet(&git).arg("--version"), &git).is_ok_and(|o| o.status.success());
        if !works {
            return HostAutocrlf::default();
        }
        let read = |scope: &str| -> Option<String> {
            let output = run(
                quiet(&git)
                    .args(["config", scope, "--get", "core.autocrlf"])
                    .current_dir(self.home_dir()),
                &git,
            )
            .ok()?;
            if !output.status.success() {
                return None;
            }
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!value.is_empty()).then_some(value)
        };
        HostAutocrlf {
            has_git: true,
            global: read("--global"),
            system: read("--system"),
        }
    }

    fn system_proxy(&self) -> ProxySettings {
        let env = ProxySettings::from_env();
        if !env.is_empty() {
            return env;
        }
        proxy::scutil_proxy().unwrap_or_default()
    }

    fn prepare_command(&self, cmd: &mut Command) {
        // The devcontainer CLI and docker itself look up `docker`, credential helpers and `git`
        // on PATH, which a Finder-started app lacks.
        let joined: Option<OsString> = std::env::join_paths(self.search_path()).ok();
        if let Some(path) = joined {
            cmd.env("PATH", path);
        }
    }

    fn clipboard_set(&self, text: &str) -> Result<(), PlatformError> {
        clipboard::set_text(text)
    }

    fn clipboard_get(&self) -> Option<String> {
        clipboard::get_text()
    }
}
