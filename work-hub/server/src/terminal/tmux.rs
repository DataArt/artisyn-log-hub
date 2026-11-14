//! tmux sessions inside the containers (D11). One session per purpose:
//! `chat` in a workstream container (cwd `/workspace/worktree`), `login` and `configure` in the
//! workspace container (cwd `/workspace/repo`). Every command runs as the workspace's container
//! user, so all of them talk to that user's tmux server (socket under the tmpfs `/tmp`).
//!
//! A new session's pane first waits on `tmux wait-for go-<s>` and only then `exec`s the command,
//! so the recording (`pipe-pane`) is attached before the first byte of output (PoC). The image's
//! tmux config keeps `remain-on-exit on`, so a finished command leaves a dead pane behind
//! (`#{pane_dead}=1`) instead of the session disappearing.

use crate::docker::exec::{self, EXEC_TIMEOUT_STATUS, sh};
use crate::docker::{Docker, DockerResult};

/// Width and height of a new session before the first client resizes it.
pub const INITIAL_COLS: u16 = 120;
pub const INITIAL_ROWS: u16 = 32;

/// The tmux sessions Work Hub creates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Session {
    /// The agent chat of a workstream.
    Chat,
    /// The interactive agent login of a workspace.
    Login,
    /// The configure session of a workspace.
    Configure,
}

impl Session {
    pub fn as_str(self) -> &'static str {
        match self {
            Session::Chat => "chat",
            Session::Login => "login",
            Session::Configure => "configure",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "chat" => Some(Session::Chat),
            "login" => Some(Session::Login),
            "configure" => Some(Session::Configure),
            _ => None,
        }
    }

    /// tmux target of the session (exact name match).
    fn target(self) -> String {
        format!("={}", self.as_str())
    }

    /// tmux target of the session's (only) pane.
    fn pane_target(self) -> String {
        format!("={}:", self.as_str())
    }
}

/// Quotes one word for `sh` (single quotes; an embedded `'` becomes `'\''`).
pub fn shell_quote(word: &str) -> String {
    let safe = !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./=:,+@%".contains(&b));
    if safe {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// `argv` as one `sh` command line.
pub fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|w| shell_quote(w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The pane command: wait for the gate, then replace the shell with `argv`.
fn gated_command(session: Session, argv: &[String]) -> String {
    format!(
        "tmux wait-for go-{s}; exec {cmd}",
        s = session.as_str(),
        cmd = shell_join(argv)
    )
}

/// `pipe-pane -o` (opens a pipe only when the pane has none) appending to `record_to`.
fn pipe_pane_script(session: Session, record_to: &str) -> String {
    let cat = format!("cat >> {}", shell_quote(record_to));
    format!(
        "tmux pipe-pane -o -t {pane} {cat}",
        pane = shell_quote(&session.pane_target()),
        cat = shell_quote(&cat)
    )
}

/// `mkdir -p` of the directory of `record_to`.
fn mkdir_script(record_to: &str) -> String {
    match record_to.rfind('/') {
        Some(i) if i > 0 => format!("mkdir -p {} && ", shell_quote(&record_to[..i])),
        _ => String::new(),
    }
}

async fn run_script(
    docker: &Docker,
    container: &str,
    user: &str,
    script: String,
) -> DockerResult<exec::ExecOutput> {
    run_script_with(docker, container, user, script, None).await
}

async fn run_script_with(
    docker: &Docker,
    container: &str,
    user: &str,
    script: String,
    stdin: Option<bytes::Bytes>,
) -> DockerResult<exec::ExecOutput> {
    exec::exec_capture(
        docker,
        container,
        user,
        &sh(script),
        stdin,
        EXEC_TIMEOUT_STATUS,
    )
    .await
}

/// A secret for the agent process: `(env name, value)`. It goes to tmux through the exec's stdin
/// (`read` into a shell variable, then `-e NAME=…`), so it is never part of a command line that
/// Docker records, and never written to a file.
pub type SecretEnv<'a> = Option<(&'a str, &'a str)>;

/// Options of [`ensure_session`] / [`respawn`]: the pane log to record to and the agent secret.
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionOpts<'a> {
    pub record_to: Option<&'a str>,
    pub secret: SecretEnv<'a>,
}

/// The script prefix and the `-e` option for a secret; empty when there is none.
fn secret_parts(secret: SecretEnv<'_>) -> (String, String, Option<bytes::Bytes>) {
    match secret {
        Some((name, value)) if is_env_name(name) => (
            "IFS= read -r WH_SECRET; ".to_string(),
            format!("-e \"{name}=$WH_SECRET\" "),
            Some(bytes::Bytes::from(format!("{value}\n"))),
        ),
        _ => (String::new(), String::new(), None),
    }
}

fn is_env_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Creates the session unless it exists (D11): for a recorded session first `mkdir -p` of the
/// log's directory, then `new-session -d -x 120 -y 32 -c <cwd> "tmux wait-for go-<s>; exec <argv>"`,
/// then `pipe-pane -o 'cat >> <record_to>'` when recording, then `wait-for -S go-<s>`.
/// Returns `true` when this call created the session. Two concurrent calls are safe: the loser's
/// `new-session` fails on the duplicate name and it reports the existing session.
pub async fn ensure_session(
    docker: &Docker,
    container: &str,
    user: &str,
    session: Session,
    cwd: &str,
    argv: &[String],
    opts: SessionOpts<'_>,
) -> DockerResult<bool> {
    let SessionOpts { record_to, secret } = opts;
    let s = session.as_str();
    let target = shell_quote(&session.target());
    let (read_secret, env_opt, stdin) = secret_parts(secret);
    let mut script = format!(
        "{read_secret}tmux has-session -t {target} 2>/dev/null && {{ echo exists; exit 0; }}; "
    );
    if let Some(log) = record_to {
        script.push_str(&mkdir_script(log));
    }
    script.push_str(&format!(
        "tmux new-session -d -s {s} -x {INITIAL_COLS} -y {INITIAL_ROWS} -c {cwd} {env_opt}{cmd} || \
         {{ tmux has-session -t {target} 2>/dev/null && {{ echo exists; exit 0; }}; exit 1; }}; ",
        cwd = shell_quote(cwd),
        cmd = shell_quote(&gated_command(session, argv)),
    ));
    if let Some(log) = record_to {
        script.push_str(&pipe_pane_script(session, log));
        script.push_str("; ");
    }
    script.push_str(&format!("tmux wait-for -S go-{s}; echo created"));
    let out = run_script_with(docker, container, user, script, stdin)
        .await?
        .check()?;
    Ok(out.stdout_str().contains("created"))
}

/// True when the session exists.
pub async fn has_session(
    docker: &Docker,
    container: &str,
    user: &str,
    session: Session,
) -> DockerResult<bool> {
    let out = exec::exec_capture(
        docker,
        container,
        user,
        &exec::argv(&["tmux", "has-session", "-t", &session.target()]),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await?;
    Ok(out.success())
}

/// `#{pane_dead}` of the session's pane: `None` when the session does not exist.
pub async fn pane_dead(
    docker: &Docker,
    container: &str,
    user: &str,
    session: Session,
) -> DockerResult<Option<bool>> {
    let out = exec::exec_capture(
        docker,
        container,
        user,
        &exec::argv(&[
            "tmux",
            "display-message",
            "-p",
            "-t",
            &session.pane_target(),
            "#{pane_dead}",
        ]),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await?;
    if !out.success() {
        return Ok(None);
    }
    Ok(Some(out.stdout_str().trim() == "1"))
}

/// Restarts the pane's command with `respawn-pane -k` (a dead `chat` gets the resume command),
/// behind the same wait-for gate as a new session, re-attaching the recording when given.
pub async fn respawn(
    docker: &Docker,
    container: &str,
    user: &str,
    session: Session,
    argv: &[String],
    opts: SessionOpts<'_>,
) -> DockerResult<()> {
    let SessionOpts { record_to, secret } = opts;
    let s = session.as_str();
    let (read_secret, env_opt, stdin) = secret_parts(secret);
    let mut script = read_secret;
    if let Some(log) = record_to {
        script.push_str(&mkdir_script(log));
    }
    script.push_str(&format!(
        "tmux respawn-pane -k -t {pane} {env_opt}{cmd} && ",
        pane = shell_quote(&session.pane_target()),
        cmd = shell_quote(&gated_command(session, argv)),
    ));
    if let Some(log) = record_to {
        script.push_str(&pipe_pane_script(session, log));
        script.push_str("; ");
    }
    script.push_str(&format!("tmux wait-for -S go-{s}"));
    run_script_with(docker, container, user, script, stdin)
        .await?
        .check()?;
    Ok(())
}

/// Kills the session; a missing session is fine.
pub async fn kill(
    docker: &Docker,
    container: &str,
    user: &str,
    session: Session,
) -> DockerResult<()> {
    exec::exec_capture(
        docker,
        container,
        user,
        &exec::argv(&["tmux", "kill-session", "-t", &session.target()]),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await?;
    Ok(())
}

/// `#{window_activity}` of the session and the container's clock, both in Unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowActivity {
    pub last_activity: i64,
    pub now: i64,
}

impl WindowActivity {
    /// True when the window had output within `window` (the agent counts as busy, D10).
    pub fn within(&self, window: std::time::Duration) -> bool {
        self.now - self.last_activity <= window.as_secs() as i64
    }
}

/// The session window's last activity and the container's `date +%s`; `None` when the session
/// does not exist.
pub async fn window_activity(
    docker: &Docker,
    container: &str,
    user: &str,
    session: Session,
) -> DockerResult<Option<WindowActivity>> {
    let script = format!(
        "tmux display-message -p -t {pane} '#{{window_activity}}' && date +%s",
        pane = shell_quote(&session.pane_target())
    );
    let out = run_script(docker, container, user, script).await?;
    if !out.success() {
        return Ok(None);
    }
    let text = out.stdout_str();
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let last_activity = lines.next().and_then(|l| l.parse::<i64>().ok());
    let now = lines.next().and_then(|l| l.parse::<i64>().ok());
    Ok(match (last_activity, now) {
        (Some(last_activity), Some(now)) => Some(WindowActivity { last_activity, now }),
        _ => None,
    })
}

/// The visible text of the session's pane (`capture-pane -p`); `None` when the session does
/// not exist.
pub async fn capture_screen(
    docker: &Docker,
    container: &str,
    user: &str,
    session: Session,
) -> DockerResult<Option<String>> {
    let script = format!(
        "tmux capture-pane -p -J -t {pane}",
        pane = shell_quote(&session.pane_target())
    );
    let out = run_script(docker, container, user, script).await?;
    Ok(out.success().then(|| out.stdout_str()))
}

/// `tmux detach-client -t <pty>`: detaches exactly the client of one bridge (PoC fix: closing a
/// TTY exec's stdin does not end `tmux attach`).
pub async fn detach_client(
    docker: &Docker,
    container: &str,
    user: &str,
    pty: &str,
) -> DockerResult<()> {
    exec::exec_capture(
        docker,
        container,
        user,
        &exec::argv(&["tmux", "detach-client", "-t", pty]),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await?;
    Ok(())
}

/// The argv of the bridge's TTY exec: print the pty first, then attach (`-d` drops clients left
/// behind by an earlier connection or a crashed server).
pub fn attach_argv(session: Session) -> Vec<String> {
    sh(format!(
        "tty; exec tmux attach -d -t {}",
        shell_quote(&session.target())
    ))
}
