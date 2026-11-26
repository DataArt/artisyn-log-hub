//! The Windows `Platform`: known folders, `ssh.exe` / `ssh-keygen.exe` / `git.exe` from PATH,
//! Windows Credential Manager, a user-only DACL for private keys, the shell for URLs and folders,
//! the common folder dialog and fonts from the system font folder.

mod clipboard;
mod credentials;
mod fonts;
pub mod install;
mod proxy;
mod security;
mod wide;
mod wsl;

use std::net::{TcpStream, ToSocketAddrs};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use agentbook_core::docker_endpoint::{Endpoint, EndpointKind};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, GetLastError};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, FOLDERID_Profile, ShellExecuteW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::docker::{
    DockerEndpoint, DockerEndpointError, DockerEnv, Probed, resolve_docker_endpoint,
};
use crate::{FontFile, HostAutocrlf, OpensshVersion, Platform, PlatformError, ProxySettings};

use wide::{known_folder, to_wide};

/// The native Windows platform.
#[derive(Debug, Default, Clone)]
pub struct WindowsPlatform;

impl WindowsPlatform {
    pub fn new() -> Self {
        Self
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// A console program started without flashing a console window from the GUI app.
fn hidden_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn run(cmd: &mut Command, program: &Path) -> Result<Output, PlatformError> {
    cmd.output()
        .map_err(|e| PlatformError::Other(format!("could not start {}: {e}", program.display())))
}

fn combined(output: &Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text
}

fn probe_pipe(address: &str) -> Result<(), String> {
    let name = to_wide(address);
    // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call.
    let ok = unsafe { WaitNamedPipeW(name.as_ptr(), 1) };
    if ok != 0 {
        return Ok(());
    }
    // SAFETY: reads the calling thread's last-error value.
    let code = unsafe { GetLastError() };
    if code == ERROR_FILE_NOT_FOUND {
        Err("not found".into())
    } else {
        // Busy or timed out: the pipe exists, so the engine is there.
        Ok(())
    }
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
        EndpointKind::Pipe => probe_pipe(&endpoint.address).map(|()| Probed::default()),
        EndpointKind::Tcp => probe_tcp(&endpoint.address).map(|()| Probed::default()),
        EndpointKind::Unix => Err("Unix sockets are not used on Windows".into()),
        EndpointKind::Wsl => wsl::probe(&endpoint.address),
    }
}

impl Platform for WindowsPlatform {
    fn is_windows(&self) -> bool {
        true
    }

    fn home_dir(&self) -> PathBuf {
        known_folder(&FOLDERID_Profile)
            .or_else(|| env_var("USERPROFILE").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from(r"C:\Users\Default"))
    }

    fn data_dir(&self) -> PathBuf {
        known_folder(&FOLDERID_LocalAppData)
            .or_else(|| env_var("LOCALAPPDATA").map(PathBuf::from))
            .unwrap_or_else(|| self.home_dir().join("AppData").join("Local"))
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
            windows: true,
        };
        resolve_docker_endpoint(&env, probe)
    }

    fn docker_dial_command(&self, endpoint: &DockerEndpoint) -> Option<Command> {
        (endpoint.kind == EndpointKind::Wsl).then(|| wsl::dial_command(&endpoint.address))
    }

    fn docker_keep_alive(&self, endpoint: &DockerEndpoint) -> Result<(), PlatformError> {
        if endpoint.kind != EndpointKind::Wsl {
            return Ok(());
        }
        wsl::keep_alive(&endpoint.address).map_err(PlatformError::Other)
    }

    fn find_program(&self, name: &str) -> Option<PathBuf> {
        let file = if Path::new(name).extension().is_some() {
            name.to_string()
        } else {
            format!("{name}.exe")
        };
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(&file))
            .find(|candidate| candidate.is_file())
    }

    fn openssh_version(&self) -> Option<OpensshVersion> {
        let ssh = self.find_program("ssh")?;
        let output = run(hidden_command(&ssh).arg("-V"), &ssh).ok()?;
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
        // Prefer the ssh-keygen next to the ssh on PATH, so both come from one OpenSSH.
        let keygen = self
            .find_program("ssh")
            .and_then(|ssh| {
                let sibling = ssh.with_file_name("ssh-keygen.exe");
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
            hidden_command(&keygen)
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
        security::restrict_to_current_user(path)
    }

    fn open_url(&self, url: &str) -> Result<(), PlatformError> {
        shell_open(url)
    }

    fn open_in_file_manager(&self, path: &Path) -> Result<(), PlatformError> {
        if path.is_dir() {
            return shell_open(&path.to_string_lossy());
        }
        let explorer = env_var("WINDIR")
            .map(|w| PathBuf::from(w).join("explorer.exe"))
            .unwrap_or_else(|| PathBuf::from("explorer.exe"));
        Command::new(&explorer)
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| PlatformError::Other(format!("could not start explorer: {e}")))
    }

    fn pick_folder(&self) -> Option<PathBuf> {
        rfd::FileDialog::new().pick_folder()
    }

    fn ui_fonts(&self) -> Vec<FontFile> {
        fonts::ui_fonts()
    }

    fn host_git_autocrlf(&self) -> HostAutocrlf {
        let Some(git) = self.find_program("git") else {
            return HostAutocrlf::default();
        };
        let read = |scope: &str| -> Option<String> {
            let output = run(
                hidden_command(&git)
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
        proxy::registry_proxy().unwrap_or_default()
    }

    fn prepare_command(&self, cmd: &mut Command) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    fn clipboard_set(&self, text: &str) -> Result<(), PlatformError> {
        clipboard::set_text(text)
    }

    fn clipboard_get(&self) -> Option<String> {
        clipboard::get_text()
    }
}

fn shell_open(target: &str) -> Result<(), PlatformError> {
    let verb = to_wide("open");
    let file = to_wide(target);
    // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call; null window,
    // parameters and directory are allowed.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success as a value above 32.
    let code = result as usize;
    if code > 32 {
        Ok(())
    } else {
        Err(PlatformError::Os {
            call: "ShellExecuteW",
            code: code as u32,
        })
    }
}
