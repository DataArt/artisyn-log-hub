//! PoC: browser terminal (xterm.js) <-> WebSocket <-> Rust (axum) <-> Docker exec with a TTY
//! <-> `tmux attach` <-> the interactive CLI running inside the container.
//!
//! tmux inside the container owns the session, so the CLI survives page reloads, browser
//! disconnects and restarts of this server. `tmux pipe-pane` records the raw pane output for the
//! read-only history view.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use bollard::{
    exec::{CreateExecOptions, ResizeExecOptions, StartExecResults},
    Docker,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

const HISTORY_DIR: &str = "/home/node/.wh";

fn container() -> String {
    std::env::var("WH_CONTAINER").unwrap_or_else(|_| "wh-poc-term".into())
}

/// The program the session runs; `claude` by default, overridable for tests.
fn session_command() -> String {
    std::env::var("WH_SESSION_CMD").unwrap_or_else(|_| "claude".into())
}

#[derive(Deserialize)]
struct SessionQuery {
    session: String,
}

#[derive(Deserialize)]
struct Resize {
    cols: u16,
    rows: u16,
}

fn valid_session(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Runs a command in the container without a TTY and returns its combined output.
async fn exec_plain(docker: &Docker, cmd: Vec<String>) -> Result<Vec<u8>, bollard::errors::Error> {
    let exec = docker
        .create_exec(
            &container(),
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(cmd),
                user: Some("node".to_string()),
                ..Default::default()
            },
        )
        .await?;
    let mut out = Vec::new();
    if let StartExecResults::Attached { mut output, .. } = docker.start_exec(&exec.id, None).await? {
        while let Some(chunk) = output.next().await {
            out.extend_from_slice(&chunk?.into_bytes());
        }
    }
    Ok(out)
}

/// Creates the tmux session if it does not exist yet. The pane waits on a tmux channel until
/// recording is attached, so not a single byte of the CLI's output is missed in the history.
async fn ensure_session(docker: &Docker, session: &str) -> Result<(), bollard::errors::Error> {
    let script = format!(
        "tmux has-session -t {s} 2>/dev/null && exit 0; \
         tmux new-session -d -s {s} -x 120 -y 32 -c /workspace \"tmux wait-for go-{s}; exec {cmd}\" && \
         tmux pipe-pane -o -t {s} 'cat >> {dir}/{s}.raw' && \
         tmux wait-for -S go-{s}",
        s = session,
        cmd = session_command(),
        dir = HISTORY_DIR
    );
    exec_plain(docker, vec!["sh".into(), "-c".into(), script]).await?;
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, Query(q): Query<SessionQuery>) -> Response {
    if !valid_session(&q.session) {
        return (StatusCode::BAD_REQUEST, "bad session name").into_response();
    }
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = bridge(socket, q.session).await {
            eprintln!("bridge error: {e}");
        }
    })
}

async fn bridge(socket: WebSocket, session: String) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let docker = Docker::connect_with_local_defaults()?;
    ensure_session(&docker, &session).await?;

    let exec = docker
        .create_exec(
            &container(),
            CreateExecOptions {
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(true),
                env: Some(vec!["TERM=xterm-256color".to_string()]),
                user: Some("node".to_string()),
                // Print our pty first so this client can be detached precisely on disconnect;
                // `-d` drops clients left behind by an earlier connection or a crashed server.
                cmd: Some(vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    format!("tty; exec tmux attach -d -t {session}"),
                ]),
                ..Default::default()
            },
        )
        .await?;

    let StartExecResults::Attached { mut output, mut input } = docker.start_exec(&exec.id, None).await? else {
        return Err("exec started detached".into());
    };

    // First line of output is the client's pty; the rest belongs to the terminal.
    let mut head = Vec::new();
    while !head.contains(&b'\n') {
        match output.next().await {
            Some(chunk) => head.extend_from_slice(&chunk?.into_bytes()),
            None => return Err("attach ended before it started".into()),
        }
    }
    let nl = head.iter().position(|b| *b == b'\n').unwrap();
    let client_tty = String::from_utf8_lossy(&head[..nl]).trim().to_string();
    let rest = head[nl + 1..].to_vec();

    let (mut ws_tx, mut ws_rx) = socket.split();
    let to_browser = tokio::spawn(async move {
        if !rest.is_empty() && ws_tx.send(Message::Binary(rest.into())).await.is_err() {
            return;
        }
        while let Some(Ok(chunk)) = output.next().await {
            if ws_tx.send(Message::Binary(chunk.into_bytes())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            // keystrokes and pasted text: raw bytes, passed through untouched
            Message::Binary(bytes) => input.write_all(&bytes).await?,
            // control messages: JSON, currently only resize
            Message::Text(text) => {
                if let Ok(r) = serde_json::from_str::<Resize>(text.as_str()) {
                    docker
                        .resize_exec(&exec.id, ResizeExecOptions { width: r.cols, height: r.rows })
                        .await?;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Closing stdin of a TTY exec does NOT end `tmux attach` (found by this PoC): detach this
    // client explicitly. The session and the CLI keep running inside the container.
    input.shutdown().await.ok();
    to_browser.abort();
    exec_plain(&docker, vec!["tmux".into(), "detach-client".into(), "-t".into(), client_tty]).await?;
    Ok(())
}

async fn history(Query(q): Query<SessionQuery>) -> Response {
    if !valid_session(&q.session) {
        return (StatusCode::BAD_REQUEST, "bad session name").into_response();
    }
    let docker = match Docker::connect_with_local_defaults() {
        Ok(d) => d,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let path = format!("{HISTORY_DIR}/{}.raw", q.session);
    match exec_plain(&docker, vec!["cat".into(), path]).await {
        Ok(bytes) => ([("content-type", "application/octet-stream")], bytes).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[tokio::main]
async fn main() {
    let port = std::env::var("WH_PORT").unwrap_or_else(|_| "7801".into());
    let app = Router::new()
        .route("/", get(|| async { Html(include_str!("../static/index.html")) }))
        .route("/ws", get(ws_handler))
        .route("/history", get(history));
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.unwrap();
    println!("listening on http://127.0.0.1:{port}");
    axum::serve(listener, app).await.unwrap();
}
