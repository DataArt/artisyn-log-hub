//! Forwarded ports: one `ssh -N -L 127.0.0.1:<host>:localhost:<port> sbx-<id>` per forwarded port
//! of a working laptop, through the tool's own ssh config (`~/.ssh/agentbook/config`), the way VS
//! Code forwards a devcontainer's `forwardPorts`. The tunnel arrives at `localhost` inside the
//! laptop, so a dev server listening only there (Vite's default) is reachable, and nothing in the
//! container changes. The poller reconciles every laptop each tick: tunnels of a laptop that is
//! not working or of a port no longer listed are ended, a missing or ended tunnel is started
//! again (at most every [`RETRY`]), and a port another program already listens on is reported as
//! taken. Tunnels end with AgentBook.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agentbook_core::paths::ssh_alias;
use agentbook_core::state::PortForward;
use tokio::io::AsyncReadExt;

use crate::engine::Ctx;
use crate::snapshot::PortState;

/// How long an ended or refused tunnel waits before the next try.
const RETRY: Duration = Duration::from_secs(15);

type Key = (String, u16, u16);

struct Tunnel {
    child: Option<tokio::process::Child>,
    /// The last line ssh wrote to stderr.
    error: Arc<Mutex<String>>,
    tried: Instant,
    state: PortState,
}

#[derive(Default)]
pub(crate) struct Tunnels {
    map: Mutex<HashMap<Key, Tunnel>>,
}

impl Tunnels {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Tunnel>> {
        match self.map.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        }
    }

    /// How the forward of `port` to `host` on `laptop` is now.
    pub fn state(&self, laptop: &str, port: u16, host: u16) -> PortState {
        self.lock()
            .get(&(laptop.to_string(), port, host))
            .map(|t| t.state.clone())
            .unwrap_or_default()
    }

    /// Ends the tunnels of laptops that are gone.
    pub fn keep_laptops(&self, ids: &[&str]) {
        self.lock()
            .retain(|(id, _, _), _| ids.contains(&id.as_str()));
    }

    /// Ends every tunnel of `laptop` that is not in `keep`.
    fn end_others(&self, laptop: &str, keep: &[PortForward]) {
        self.lock().retain(|(id, port, host), _| {
            id != laptop || keep.iter().any(|f| f.port == *port && f.host == *host)
        });
    }
}

/// Whether nothing listens on `127.0.0.1:<port>` of this computer.
fn host_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Brings `laptop`'s tunnels in line with `forwards`: none unless `working`.
pub(crate) fn reconcile(ctx: &Arc<Ctx>, laptop: &str, forwards: &[PortForward], working: bool) {
    let tunnels = &ctx.tunnels;
    if !working {
        tunnels.end_others(laptop, &[]);
        return;
    }
    tunnels.end_others(laptop, forwards);
    let ssh = ctx.platform.find_program("ssh");
    let config = crate::ssh::config_file(&ctx.platform.ssh_dir());
    let mut map = tunnels.lock();
    for f in forwards {
        let key = (laptop.to_string(), f.port, f.host);
        if let Some(t) = map.get_mut(&key) {
            let alive = t
                .child
                .as_mut()
                .is_some_and(|c| matches!(c.try_wait(), Ok(None)));
            if alive {
                t.state = PortState::Forwarding;
                continue;
            }
            if t.child.take().is_some() {
                let why = t.error.lock().map(|e| e.clone()).unwrap_or_default();
                t.state = PortState::Failed(if why.trim().is_empty() {
                    "the tunnel ended".to_string()
                } else {
                    why
                });
            }
            if t.tried.elapsed() < RETRY {
                continue;
            }
        }
        let error = Arc::new(Mutex::new(String::new()));
        let mut tunnel = Tunnel {
            child: None,
            error: error.clone(),
            tried: Instant::now(),
            state: PortState::Starting,
        };
        if !host_port_free(f.host) {
            tunnel.state = PortState::Taken;
            map.insert(key, tunnel);
            continue;
        }
        let Some(ssh) = ssh.as_ref() else {
            tunnel.state = PortState::Failed("no ssh command was found".into());
            map.insert(key, tunnel);
            continue;
        };
        let mut cmd = std::process::Command::new(ssh);
        cmd.arg("-F")
            .arg(&config)
            .args([
                "-N",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "BatchMode=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-L",
            ])
            .arg(format!("127.0.0.1:{}:localhost:{}", f.host, f.port))
            .arg(ssh_alias(laptop))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        ctx.platform.prepare_command(&mut cmd);
        let mut cmd = tokio::process::Command::from(cmd);
        cmd.kill_on_drop(true);
        match cmd.spawn() {
            Ok(mut child) => {
                if let Some(mut stderr) = child.stderr.take() {
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let _ = stderr.read_to_end(&mut buf).await;
                        let text = String::from_utf8_lossy(&buf);
                        if let Some(line) = text.lines().map(str::trim).rfind(|l| !l.is_empty())
                            && let Ok(mut e) = error.lock()
                        {
                            *e = line.to_string();
                        }
                    });
                }
                tunnel.child = Some(child);
            }
            Err(e) => tunnel.state = PortState::Failed(format!("cannot start ssh: {e}")),
        }
        map.insert(key, tunnel);
    }
}
