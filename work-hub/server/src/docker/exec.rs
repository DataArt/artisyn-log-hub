//! Commands in running containers (D5 "Exec"). Every exec runs as the workspace's
//! `container_user`; callers pass it explicitly.

use std::pin::Pin;
use std::time::Duration;

use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecResults};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use tokio::io::{AsyncWrite, AsyncWriteExt};

use super::{Docker, DockerError, DockerResult};

/// git and listings.
pub const EXEC_TIMEOUT_DEFAULT: Duration = Duration::from_secs(60);
/// Agent status, tmux queries.
pub const EXEC_TIMEOUT_STATUS: Duration = Duration::from_secs(15);
/// Helper containers (user discovery).
pub const HELPER_RUN_TIMEOUT: Duration = Duration::from_secs(120);
/// The helper container that copies a volume.
pub const VOLUME_COPY_TIMEOUT: Duration = Duration::from_secs(600);
/// Building a devcontainer or the default image.
pub const IMAGE_BUILD_TIMEOUT: Duration = Duration::from_secs(1800);
/// Graceful stop before the Engine kills the container.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Most stderr kept in a [`DockerError::Exit`] of a stream.
const STDERR_KEEP: usize = 64 * 1024;

/// The result of [`exec_capture`].
#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    pub exit_code: i64,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.exit_code == 0
    }

    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_str(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }

    /// `Ok(self)` when the exit code is 0, else [`DockerError::Exit`] with the stderr.
    pub fn check(self) -> DockerResult<Self> {
        if self.success() {
            Ok(self)
        } else {
            Err(DockerError::Exit {
                code: self.exit_code,
                stderr: self.stderr_str(),
            })
        }
    }
}

fn describe(argv: &[String]) -> String {
    let mut s = argv.join(" ");
    if s.len() > 200 {
        let mut cut = 200;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push('…');
    }
    format!("exec `{s}`")
}

async fn exit_code(docker: &Docker, exec_id: &str) -> DockerResult<i64> {
    let inspect = docker.inspect_exec(exec_id).await?;
    inspect
        .exit_code
        .ok_or_else(|| DockerError::Failed("exec finished without an exit code".into()))
}

/// The argv that feeds exactly `len` bytes of the exec's stdin to `argv` and then gives it EOF:
/// `sh -c 'head -c "$0" | "$@"' <len> <argv...>`. Closing the write half of the attached stream
/// does not reach the process on every transport (it does not over the Windows named pipe of
/// Docker Desktop), so the end of the input is marked by its length instead.
fn with_sized_stdin(len: usize, argv: &[String]) -> Vec<String> {
    let mut out = vec![
        "sh".to_string(),
        "-c".to_string(),
        "head -c \"$0\" | \"$@\"".to_string(),
        len.to_string(),
    ];
    out.extend(argv.iter().cloned());
    out
}

/// Runs `argv` as `user` without a TTY, feeds `stdin` when given (the process sees EOF after it;
/// this needs `sh` and `head` in the image) and collects stdout and stderr. A non-zero exit code
/// is not an error here: inspect [`ExecOutput::exit_code`] or call [`ExecOutput::check`].
pub async fn exec_capture(
    docker: &Docker,
    container: &str,
    user: &str,
    argv: &[String],
    stdin: Option<Bytes>,
    timeout: Duration,
) -> DockerResult<ExecOutput> {
    let what = describe(argv);
    let cmd = match &stdin {
        Some(data) => with_sized_stdin(data.len(), argv),
        None => argv.to_vec(),
    };
    let run = async {
        let exec = docker
            .create_exec(
                container,
                CreateExecOptions::<String> {
                    attach_stdin: Some(stdin.is_some()),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(false),
                    cmd: Some(cmd),
                    user: Some(user.to_string()),
                    ..Default::default()
                },
            )
            .await?;
        let StartExecResults::Attached {
            mut output,
            mut input,
        } = docker.start_exec(&exec.id, None).await?
        else {
            return Err(DockerError::Failed("exec started detached".into()));
        };

        // Write stdin concurrently with reading, so a large input cannot deadlock against a
        // full output pipe.
        let writer = async move {
            if let Some(data) = stdin {
                input.write_all(&data).await?;
            }
            input.shutdown().await?;
            Ok::<(), std::io::Error>(())
        };
        let reader = async {
            let mut out = ExecOutput::default();
            while let Some(chunk) = output.next().await {
                match chunk? {
                    LogOutput::StdErr { message } => out.stderr.extend_from_slice(&message),
                    LogOutput::StdOut { message } | LogOutput::Console { message } => {
                        out.stdout.extend_from_slice(&message)
                    }
                    LogOutput::StdIn { .. } => {}
                }
            }
            Ok::<ExecOutput, DockerError>(out)
        };
        let (written, read) = tokio::join!(writer, reader);
        let mut out = read?;
        if let Err(e) = written {
            // The command may legitimately exit before reading all of its input.
            tracing::debug!("{what}: writing stdin failed: {e}");
        }
        out.exit_code = exit_code(docker, &exec.id).await?;
        Ok(out)
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(res) => res,
        Err(_) => Err(DockerError::Timeout(what)),
    }
}

/// A byte stream from a container.
pub type ByteStream = Pin<Box<dyn Stream<Item = DockerResult<Bytes>> + Send>>;

/// Runs `argv` as `user` without a TTY and streams its stdout (bundles, recordings). Stderr is
/// collected; when the command exits non-zero the stream ends with [`DockerError::Exit`]
/// carrying that stderr (e.g. git's "Refusing to create empty bundle").
pub async fn exec_stream_stdout(
    docker: &Docker,
    container: &str,
    user: &str,
    argv: &[String],
) -> DockerResult<ByteStream> {
    let exec = docker
        .create_exec(
            container,
            CreateExecOptions::<String> {
                attach_stdin: Some(false),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(false),
                cmd: Some(argv.to_vec()),
                user: Some(user.to_string()),
                ..Default::default()
            },
        )
        .await?;
    let StartExecResults::Attached { mut output, .. } = docker.start_exec(&exec.id, None).await?
    else {
        return Err(DockerError::Failed("exec started detached".into()));
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<DockerResult<Bytes>>(16);
    let docker = docker.clone();
    let exec_id = exec.id;
    tokio::spawn(async move {
        let mut stderr: Vec<u8> = Vec::new();
        while let Some(chunk) = output.next().await {
            match chunk {
                Ok(LogOutput::StdOut { message }) | Ok(LogOutput::Console { message }) => {
                    if tx.send(Ok(message)).await.is_err() {
                        return; // the consumer went away
                    }
                }
                Ok(LogOutput::StdErr { message }) => {
                    if stderr.len() < STDERR_KEEP {
                        stderr.extend_from_slice(&message);
                    }
                }
                Ok(LogOutput::StdIn { .. }) => {}
                Err(e) => {
                    let _ = tx.send(Err(e.into())).await;
                    return;
                }
            }
        }
        match exit_code(&docker, &exec_id).await {
            Ok(0) => {}
            Ok(code) => {
                let _ = tx
                    .send(Err(DockerError::Exit {
                        code,
                        stderr: String::from_utf8_lossy(&stderr).into_owned(),
                    }))
                    .await;
            }
            Err(e) => {
                let _ = tx.send(Err(e)).await;
            }
        }
    });

    Ok(Box::pin(futures_util::stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|item| (item, rx))
    })))
}

/// An interactive exec with a TTY (terminals, D11).
pub struct TtyExec {
    pub exec_id: String,
    /// Terminal output. Ends when the process exits or the connection breaks.
    pub output: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
    /// Keystrokes.
    pub input: Pin<Box<dyn AsyncWrite + Send>>,
    docker: Docker,
}

/// Resizes one TTY exec. Unlike [`TtyExec`] it is `Send + Sync`, so a future that holds a
/// reference to it across an await can run on a multi-threaded runtime (the WebSocket bridge).
#[derive(Clone)]
pub struct TtyResizer {
    exec_id: String,
    docker: Docker,
}

impl TtyResizer {
    /// Resizes the TTY (`resize_exec`).
    pub async fn resize(&self, cols: u16, rows: u16) -> DockerResult<()> {
        self.docker
            .resize_exec(
                &self.exec_id,
                ResizeExecOptions {
                    width: cols,
                    height: rows,
                },
            )
            .await?;
        Ok(())
    }
}

impl TtyExec {
    /// Resizes the TTY (`resize_exec`).
    pub async fn resize(&self, cols: u16, rows: u16) -> DockerResult<()> {
        self.resizer().resize(cols, rows).await
    }

    /// A `Send + Sync` handle that resizes this TTY.
    pub fn resizer(&self) -> TtyResizer {
        TtyResizer {
            exec_id: self.exec_id.clone(),
            docker: self.docker.clone(),
        }
    }

    /// The exit code once the process has ended (`None` while it runs).
    pub async fn exit_code(&self) -> DockerResult<Option<i64>> {
        let inspect = self.docker.inspect_exec(&self.exec_id).await?;
        Ok(if inspect.running == Some(true) {
            None
        } else {
            inspect.exit_code
        })
    }
}

/// Starts `argv` as `user` with a TTY and stdin attached. The env always has
/// `TERM=xterm-256color` and `LANG=C.UTF-8`; `env` (`KEY=value` pairs) adds to or overrides it.
pub async fn exec_tty(
    docker: &Docker,
    container: &str,
    user: &str,
    argv: &[String],
    env: &[(&str, &str)],
) -> DockerResult<TtyExec> {
    let mut vars: Vec<(String, String)> = vec![
        ("TERM".into(), "xterm-256color".into()),
        ("LANG".into(), "C.UTF-8".into()),
    ];
    for (k, v) in env {
        vars.retain(|(name, _)| name != k);
        vars.push(((*k).to_string(), (*v).to_string()));
    }
    let exec = docker
        .create_exec(
            container,
            CreateExecOptions::<String> {
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(true),
                env: Some(vars.into_iter().map(|(k, v)| format!("{k}={v}")).collect()),
                cmd: Some(argv.to_vec()),
                user: Some(user.to_string()),
                ..Default::default()
            },
        )
        .await?;
    let StartExecResults::Attached { output, input } = docker.start_exec(&exec.id, None).await?
    else {
        return Err(DockerError::Failed("exec started detached".into()));
    };
    let output = output
        .take_while(|chunk| {
            let keep = match chunk {
                Ok(_) => true,
                Err(e) => {
                    tracing::debug!("tty exec output ended: {e}");
                    false
                }
            };
            std::future::ready(keep)
        })
        .filter_map(|chunk| std::future::ready(chunk.ok().map(LogOutput::into_bytes)));
    Ok(TtyExec {
        exec_id: exec.id,
        output: Box::pin(output),
        input,
        docker: docker.clone(),
    })
}

/// `["sh", "-c", script]`.
pub fn sh(script: impl Into<String>) -> Vec<String> {
    vec!["sh".into(), "-c".into(), script.into()]
}

/// Builds an argv from string slices.
pub fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_string()).collect()
}
