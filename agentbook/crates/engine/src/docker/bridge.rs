//! A loopback bridge to an engine AgentBook cannot open itself (a Docker engine inside WSL): it
//! listens on `127.0.0.1:<random port>` and, for every connection the Docker client opens,
//! starts the platform's dial program (`docker system dial-stdio` in the distro) and copies bytes
//! both ways. The client keeps connections alive, so a program is started per connection, not
//! per request. Starting the bridge also asks the platform to keep the engine running after
//! AgentBook closes (`Platform::docker_keep_alive`). The bridge stops when it is dropped (the
//! client is reset).

use std::process::Stdio;
use std::sync::Arc;

use agentbook_platform::{DockerEndpoint, Platform};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use super::{DockerError, DockerResult};

pub struct Bridge {
    /// `tcp://127.0.0.1:<port>`.
    pub url: String,
    accept: JoinHandle<()>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

/// Starts the bridge; fails when the platform has no dial program for the endpoint.
pub async fn start(platform: Arc<dyn Platform>, endpoint: &DockerEndpoint) -> DockerResult<Bridge> {
    if platform.docker_dial_command(endpoint).is_none() {
        return Err(DockerError::Failed(format!(
            "AgentBook cannot reach the Docker engine at {} {}",
            endpoint.kind.as_str(),
            endpoint.address
        )));
    }
    // Best effort: without it laptops still work while AgentBook runs (its polls keep WSL up).
    let keeper = platform.clone();
    let kept = endpoint.clone();
    let _ = tokio::task::spawn_blocking(move || keeper.docker_keep_alive(&kept)).await;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let endpoint = endpoint.clone();
    let accept = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                continue;
            };
            let Some(cmd) = platform.docker_dial_command(&endpoint) else {
                return;
            };
            tokio::spawn(pipe(socket, cmd));
        }
    });
    Ok(Bridge {
        url: format!("tcp://127.0.0.1:{port}"),
        accept,
    })
}

/// Copies one client connection to and from a fresh dial program.
async fn pipe(mut socket: TcpStream, cmd: std::process::Command) {
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(mut child) = cmd.spawn() else {
        return;
    };
    let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return;
    };
    let (mut from_client, mut to_client) = socket.split();
    let up = async {
        let _ = tokio::io::copy(&mut from_client, &mut stdin).await;
        // The client is done sending: close the program's stdin (dial-stdio half-closes).
        let _ = stdin.shutdown().await;
        drop(stdin);
    };
    let down = async {
        let _ = tokio::io::copy(&mut stdout, &mut to_client).await;
        let _ = to_client.shutdown().await;
    };
    tokio::join!(up, down);
    let _ = child.kill().await;
}
