//! A Docker engine inside a WSL distro (Docker Engine installed in Ubuntu without Docker Desktop).
//! Windows has no pipe to it, so AgentBook talks to it through `docker system dial-stdio` run
//! in the distro as root (`wsl.exe -d <distro> -u root -e docker system dial-stdio`): the
//! program's stdin/stdout is a raw connection to the engine's socket. Root needs no password in
//! WSL and avoids depending on the default user being in the `docker` group.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::docker::Probed;

/// Distros of other Docker products: their engines are reached through their own pipes.
const SKIPPED_PREFIXES: [&str; 2] = ["docker-desktop", "rancher-desktop"];

/// How long one distro may take to answer (a stopped distro boots first).
const PROBE_TIMEOUT: Duration = Duration::from_secs(25);

/// Run as root in the distro: fails with a word when there is no engine, else prints where
/// `C:\` is mounted (the automount root plus `c/`).
const CHECK: &str = "test -S /var/run/docker.sock || { echo 'no Docker engine socket'; exit 3; }; \
     command -v docker >/dev/null 2>&1 || { echo 'no docker command'; exit 4; }; \
     docker version --format '{{.Server.APIVersion}}' >/dev/null 2>&1 || \
       { echo 'the Docker engine does not answer'; exit 5; }; \
     wslpath -u 'C:\\'";

fn wsl_exe() -> PathBuf {
    std::env::var_os("WINDIR")
        .map(|w| PathBuf::from(w).join("System32").join("wsl.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("wsl.exe"))
}

fn command() -> Command {
    let mut cmd = Command::new(wsl_exe());
    // UTF-8 output instead of UTF-16 for `wsl.exe -l`.
    cmd.env("WSL_UTF8", "1").creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Runs `cmd`, killing it after `timeout`. Returns (success, stdout, stderr).
fn run(mut cmd: Command, timeout: Duration) -> Result<(bool, String, String), String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start wsl.exe: {e}"))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("no answer in {} s", timeout.as_secs()));
            }
            Err(e) => return Err(format!("wsl.exe failed: {e}")),
        }
    };
    let text = |r: Option<&mut dyn Read>| {
        let mut buf = Vec::new();
        if let Some(r) = r {
            let _ = r.read_to_end(&mut buf);
        }
        // `wsl.exe` itself may still answer in UTF-16; drop the NULs.
        String::from_utf8_lossy(&buf).replace('\0', "")
    };
    let out = text(child.stdout.as_mut().map(|s| s as &mut dyn Read));
    let err = text(child.stderr.as_mut().map(|s| s as &mut dyn Read));
    Ok((status.success(), out, err))
}

/// The installed distros, default first, without Docker Desktop's and Rancher Desktop's own.
fn distros() -> Result<Vec<String>, String> {
    let mut cmd = command();
    cmd.args(["-l", "-q"]);
    let (ok, out, err) = run(cmd, Duration::from_secs(10))?;
    if !ok {
        let why = err.trim();
        return Err(if why.is_empty() {
            "WSL is not installed".to_string()
        } else {
            why.to_string()
        });
    }
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .filter(|n| {
            let lower = n.to_ascii_lowercase();
            !SKIPPED_PREFIXES.iter().any(|p| lower.starts_with(p))
        })
        .map(str::to_string)
        .collect())
}

/// Checks one distro for a Docker engine; its automount root on success.
fn probe_distro(distro: &str) -> Result<String, String> {
    let mut cmd = command();
    cmd.args(["-d", distro, "-u", "root", "-e", "sh", "-c", CHECK]);
    let (ok, out, err) = run(cmd, PROBE_TIMEOUT)?;
    let last = out
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("");
    if !ok {
        let why = if last.is_empty() { err.trim() } else { last };
        return Err(if why.is_empty() {
            "no Docker engine".to_string()
        } else {
            why.to_string()
        });
    }
    match last.strip_suffix("c/").or_else(|| last.strip_suffix('c')) {
        Some(root) if root.starts_with('/') => Ok(root.to_string()),
        _ => Err(format!("unexpected wslpath answer {last:?}")),
    }
}

/// Probes a `wsl` candidate: the named distro, or (empty name) every distro in order until one
/// runs a Docker engine.
pub(super) fn probe(distro: &str) -> Result<Probed, String> {
    if !distro.is_empty() {
        let root = probe_distro(distro)?;
        return Ok(Probed {
            address: None,
            wsl_mount_root: Some(root),
        });
    }
    let names = distros()?;
    if names.is_empty() {
        return Err("no WSL distro is installed".to_string());
    }
    let mut why = Vec::new();
    for name in names {
        match probe_distro(&name) {
            Ok(root) => {
                return Ok(Probed {
                    address: Some(name),
                    wsl_mount_root: Some(root),
                });
            }
            Err(e) => why.push(format!("{name}: {e}")),
        }
    }
    Err(why.join("; "))
}

/// The name the keep-alive shell runs under in the distro (its `$0`), to find it again.
const KEEP_ALIVE_NAME: &str = "agentbook-keep-alive";

/// Keeps the distro running, like Docker Desktop keeps its engine: WSL stops a distro about 15 s
/// after its last `wsl.exe` process ends, and the laptops' containers with it, so without this
/// closing AgentBook would end every Claude Desktop session. Starts one `wsl.exe` running a
/// named sleeping shell in the distro, unless one already runs (from an earlier start); it is
/// left running when AgentBook closes and ends with the user's session or `wsl --shutdown`.
pub(super) fn keep_alive(distro: &str) -> Result<(), String> {
    let mut check = command();
    check.args([
        "-d",
        distro,
        "-u",
        "root",
        "-e",
        "sh",
        "-c",
        // `…aliv[e]` matches the name but not this check's own command line.
        &format!(
            "grep -qs '{}[e]' /proc/[0-9]*/cmdline",
            &KEEP_ALIVE_NAME[..KEEP_ALIVE_NAME.len() - 1]
        ),
    ]);
    if run(check, Duration::from_secs(15))?.0 {
        return Ok(());
    }
    let mut cmd = command();
    cmd.args([
        "-d",
        distro,
        "-u",
        "root",
        "-e",
        "sh",
        "-c",
        "while :; do sleep 3600; done",
        KEEP_ALIVE_NAME,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    // The child is not waited for: it outlives AgentBook on purpose.
    cmd.spawn()
        .map(drop)
        .map_err(|e| format!("cannot start wsl.exe: {e}"))
}

/// The program whose stdin/stdout is a connection to the distro's Docker engine.
pub(super) fn dial_command(distro: &str) -> Command {
    let mut cmd = command();
    cmd.args([
        "-d",
        distro,
        "-u",
        "root",
        "-e",
        "docker",
        "system",
        "dial-stdio",
    ]);
    cmd
}
