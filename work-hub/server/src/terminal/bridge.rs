//! WebSocket ↔ `tmux attach` bridge (D11).
//!
//! The exec runs `sh -c "tty; exec tmux attach -d -t <s>"` with a TTY. Its first output line is the
//! client's pty; on disconnect the bridge runs `tmux detach-client -t <pty>`, because closing a
//! TTY exec's stdin does not end `tmux attach` (PoC). Frames:
//!
//! | Direction | Frame | Meaning |
//! |---|---|---|
//! | client → server | binary | keystrokes |
//! | client → server | text `{"type":"resize","cols":n,"rows":n}` | resize (`resize_exec`) |
//! | server → client | binary | terminal output |
//! | server → client | text `{"type":"taken_over"}` | another tab took the session |
//! | server → client | text `{"type":"ended","loggedIn"?:bool}` | login / configure finished |
//! | server → client | text `{"type":"error","message":…}` | plain-language error |
//!
//! The caller checks ownership and the `Origin` ([`origin_allowed`]) before the upgrade and makes
//! sure the session exists; the bridge only attaches.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::http::HeaderMap;
use axum::http::header::{HOST, ORIGIN};
use bytes::Bytes;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use super::hub::{self, HubEvent};
use super::recording::{self, RecordingSource};
use super::tmux::{self, Session};
use crate::auth::mailer::DEV_PUBLIC_BASE_URL;
use crate::config::{Config, RunEnv};
use crate::docker::exec;
use crate::state::AppState;

/// How long the attach may take to print its pty.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(15);
/// After a login / configure session's attach ends, how long the bridge waits for the watcher's
/// `ended` (configure commits the container first, which can take a while).
const ENDED_WAIT: Duration = Duration::from_secs(600);

/// What the bridge attaches to.
#[derive(Debug, Clone)]
pub struct BridgeTarget {
    /// The container the session lives in.
    pub container: String,
    /// The workspace's container user.
    pub user: String,
    pub session: Session,
    /// `chat` only: synced on attach and detach, resizes recorded.
    pub recording: Option<RecordingSource>,
}

/// A client text frame.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Resize { cols: u16, rows: u16 },
}

type WsSink = SplitSink<WebSocket, Message>;

/// The JSON text frame of a hub event.
fn event_frame(ev: &HubEvent) -> serde_json::Value {
    match ev {
        HubEvent::TakenOver => json!({"type": "taken_over"}),
        HubEvent::Ended { logged_in: Some(v) } => json!({"type": "ended", "loggedIn": v}),
        HubEvent::Ended { logged_in: None } => json!({"type": "ended"}),
        HubEvent::Error(message) => json!({"type": "error", "message": message}),
    }
}

async fn send_json(sink: &mut WsSink, v: serde_json::Value) -> bool {
    sink.send(Message::Text(v.to_string().into())).await.is_ok()
}

async fn send_error(sink: &mut WsSink, message: &str) {
    let _ = send_json(sink, json!({"type": "error", "message": message})).await;
}

/// What one turn of the main loop saw.
enum Step {
    Client(Option<Result<Message, axum::Error>>),
    Output(Option<Bytes>),
    Event(Option<HubEvent>),
}

/// Runs the bridge until the browser goes away, the session is taken over or the attach ends.
pub async fn run(st: AppState, socket: WebSocket, target: BridgeTarget) {
    let key = hub::key(&target.container, target.session);
    let (conn_id, mut events) = st.terminals.register(key.clone());
    let (mut sink, mut client) = socket.split();

    if let Some(rec) = &target.recording {
        recording::sync_logged(&st, rec).await;
    }

    let attached = attach(&st, &target).await;
    let (mut tty, pty, rest) = match attached {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "{}: attaching to {} failed: {e}",
                target.container,
                target.session.as_str()
            );
            send_error(&mut sink, "The terminal couldn't be opened. Try again.").await;
            let _ = sink.send(Message::Close(None)).await;
            st.terminals.unregister(&key, conn_id);
            return;
        }
    };

    let resizer = tty.resizer();
    let mut output_ended = false;
    let mut close_socket = true;
    if !rest.is_empty() && sink.send(Message::Binary(rest)).await.is_err() {
        close_socket = false;
    } else {
        loop {
            let step = tokio::select! {
                m = client.next() => Step::Client(m),
                o = tty.output.next() => Step::Output(o),
                e = events.recv() => Step::Event(e),
            };
            match step {
                Step::Client(None) | Step::Client(Some(Err(_))) => {
                    close_socket = false;
                    break;
                }
                Step::Client(Some(Ok(msg))) => match msg {
                    Message::Binary(bytes) => {
                        if let Err(e) = tty.input.write_all(&bytes).await {
                            tracing::debug!("terminal input failed: {e}");
                            break;
                        }
                    }
                    Message::Text(text) => {
                        if let Ok(ClientFrame::Resize { cols, rows }) =
                            serde_json::from_str::<ClientFrame>(text.as_str())
                        {
                            resize(&st, &target, &resizer, cols, rows).await;
                        }
                    }
                    Message::Close(_) => {
                        close_socket = false;
                        break;
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                },
                Step::Output(Some(bytes)) => {
                    if sink.send(Message::Binary(bytes)).await.is_err() {
                        close_socket = false;
                        break;
                    }
                }
                Step::Output(None) => {
                    output_ended = true;
                    break;
                }
                Step::Event(None) => break,
                Step::Event(Some(ev)) => {
                    let taken = ev == HubEvent::TakenOver;
                    if !send_json(&mut sink, event_frame(&ev)).await {
                        close_socket = false;
                        break;
                    }
                    if taken {
                        break;
                    }
                }
            }
        }
    }

    // A login / configure session ended: wait for the watcher's `ended` before closing.
    if output_ended && close_socket && target.session != Session::Chat {
        wait_for_end(&mut sink, &mut client, &mut events).await;
    }

    let _ = tty.input.shutdown().await;
    if !output_ended
        && let Err(e) = tmux::detach_client(&st.docker, &target.container, &target.user, &pty).await
    {
        tracing::debug!("detach-client {pty} failed: {e}");
    }
    st.terminals.unregister(&key, conn_id);
    if close_socket {
        let _ = sink.send(Message::Close(None)).await;
    }
    if let Some(rec) = &target.recording {
        recording::sync_logged(&st, rec).await;
    }
}

/// Starts the attach exec and reads its first line (the pty). Returns the exec, the pty and any
/// terminal output that came in the same chunk.
async fn attach(
    st: &AppState,
    target: &BridgeTarget,
) -> Result<(exec::TtyExec, String, Bytes), String> {
    let mut tty = exec::exec_tty(
        &st.docker,
        &target.container,
        &target.user,
        &tmux::attach_argv(target.session),
        &[],
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut head: Vec<u8> = Vec::new();
    let read = async {
        while !head.contains(&b'\n') {
            match tty.output.next().await {
                Some(chunk) => head.extend_from_slice(&chunk),
                None => return Err("the attach ended before it started".to_string()),
            }
        }
        Ok(())
    };
    match tokio::time::timeout(ATTACH_TIMEOUT, read).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("the attach did not start in time".into()),
    }
    let nl = head.iter().position(|b| *b == b'\n').unwrap_or(head.len());
    let pty = String::from_utf8_lossy(&head[..nl]).trim().to_string();
    if !pty.starts_with("/dev/") {
        return Err(format!("unexpected attach output {pty:?}"));
    }
    let rest = Bytes::copy_from_slice(head.get(nl + 1..).unwrap_or_default());
    Ok((tty, pty, rest))
}

async fn resize(
    st: &AppState,
    target: &BridgeTarget,
    tty: &exec::TtyResizer,
    cols: u16,
    rows: u16,
) {
    if cols == 0 || rows == 0 {
        return;
    }
    if let Err(e) = tty.resize(cols, rows).await {
        tracing::debug!("terminal resize failed: {e}");
        return;
    }
    if let Some(rec) = &target.recording
        && let Err(e) = recording::record_resize(st, rec, cols, rows).await
    {
        tracing::warn!("recording resize of {} failed: {e}", rec.workstream_id);
    }
}

async fn wait_for_end(
    sink: &mut WsSink,
    client: &mut futures_util::stream::SplitStream<WebSocket>,
    events: &mut mpsc::Receiver<HubEvent>,
) {
    let wait = async {
        loop {
            tokio::select! {
                m = client.next() => match m {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                    Some(Ok(_)) => {}
                },
                e = events.recv() => match e {
                    Some(ev) => {
                        let _ = send_json(sink, event_frame(&ev)).await;
                        if matches!(ev, HubEvent::Ended { .. } | HubEvent::TakenOver) {
                            return;
                        }
                    }
                    None => return,
                },
            }
        }
    };
    let _ = tokio::time::timeout(ENDED_WAIT, wait).await;
}

/// The serialized origin (`scheme://host[:port]`) of an absolute URL.
fn origin_of(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    match u.origin() {
        o @ url::Origin::Tuple(..) => Some(o.ascii_serialization()),
        url::Origin::Opaque(_) => None,
    }
}

/// D11: a terminal WebSocket needs an `Origin` equal to the request's own origin (same host and
/// port as the `Host` header) or to `PUBLIC_BASE_URL`. Outside production the Vite dev client's
/// origin is accepted too, as the mailer uses it as the fallback base. A missing `Origin` fails.
pub fn origin_allowed(headers: &HeaderMap, config: &Config) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(origin) = origin_of(origin.trim()) else {
        return false;
    };
    // Same origin: the Origin's authority equals the Host header.
    if let Some(host) = headers.get(HOST).and_then(|v| v.to_str().ok())
        && let Ok(u) = url::Url::parse(&origin)
    {
        let authority = match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => String::new(),
        };
        if !authority.is_empty() && authority.eq_ignore_ascii_case(host.trim()) {
            return true;
        }
    }
    if let Some(base) = config.auth.public_base_url.as_deref().and_then(origin_of)
        && base == origin
    {
        return true;
    }
    if config.env != RunEnv::Production
        && let Some(dev) = origin_of(DEV_PUBLIC_BASE_URL)
        && dev == origin
    {
        return true;
    }
    false
}
