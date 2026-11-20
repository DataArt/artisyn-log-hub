//! Claude Code adapter (D7). The only module that knows Claude's commands and files.

use serde_json::{Map, Value, json};

use super::AgentAdapter;

/// Appended to the system prompt of the configure session.
pub const CONFIGURE_PROMPT: &str = "This session configures the container of this workspace. Do what the user asks: install tools, libraries and settings into the container (you may use sudo). Do not change the project files in /workspace/repo.";

pub struct ClaudeAdapter;

impl AgentAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn login_files(&self) -> &'static [&'static str] {
        &[".claude/.credentials.json"]
    }

    /// The long-lived (1-year) token flow: same browser sign-in and pasted code as
    /// `claude auth login`, but it prints a token instead of writing a login that refreshes
    /// (and so invalidates every copy of it).
    fn login_command(&self) -> Vec<String> {
        argv(&["claude", "setup-token"])
    }

    fn status_command(&self) -> Vec<String> {
        argv(&["claude", "auth", "status"])
    }

    /// Exit 0 and a JSON object with `loggedIn: true` on stdout.
    fn parse_status(&self, exit_code: i64, stdout: &str) -> bool {
        if exit_code != 0 {
            return false;
        }
        status_json(stdout)
            .and_then(|v| v.get("loggedIn").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn start_command(&self, session_id: &str) -> Vec<String> {
        argv(&["claude", "--session-id", session_id])
    }

    /// `claude --resume` fails when the session never wrote a transcript; then a new chat starts
    /// with the same id, so the next resume finds it.
    fn resume_command(&self, session_id: &str) -> Vec<String> {
        argv(&[
            "sh",
            "-c",
            "claude --resume \"$1\" || exec claude --session-id \"$1\"",
            "_",
            session_id,
        ])
    }

    fn configure_command(&self) -> Vec<String> {
        argv(&["claude", "--append-system-prompt", CONFIGURE_PROMPT])
    }

    /// Light theme, onboarding done and every workdir trusted, so the chat opens straight away.
    fn profile_patch(&self, workdirs: &[&str]) -> Value {
        let projects: Map<String, Value> = workdirs
            .iter()
            .map(|dir| {
                (
                    (*dir).to_string(),
                    json!({
                        "hasTrustDialogAccepted": true,
                        "hasCompletedProjectOnboarding": true,
                    }),
                )
            })
            .collect();
        json!({
            "theme": "light",
            "hasCompletedOnboarding": true,
            "projects": projects,
        })
    }

    fn copy_extra_keys(&self) -> &'static [&'static str] {
        &["oauthAccount"]
    }

    fn profile_file(&self) -> &'static str {
        ".claude.json"
    }

    fn display_name(&self) -> &'static str {
        "Claude"
    }

    fn logout_command(&self) -> Vec<String> {
        argv(&["claude", "auth", "logout"])
    }

    /// The image pins the CLI; without this the CLI downloads a newer copy (~350 MB) into the
    /// home of every workstream on its first start.
    fn container_env(&self) -> &'static [(&'static str, &'static str)] {
        &[("DISABLE_AUTOUPDATER", "1")]
    }

    /// Self-updated CLI copies and caches. Kept: the login, settings, plugins and the session
    /// transcripts under `.claude/projects` (needed by `--resume` on reopen).
    /// While it generates, Claude Code's status line ends with "esc to interrupt".
    fn busy_markers(&self) -> &'static [&'static str] {
        &["esc to interrupt"]
    }

    /// `~/.claude/projects/<workdir with "/" → "-">/<session id>.jsonl`.
    fn transcript_file(&self, home: &str, workdir: &str, session_id: &str) -> Option<String> {
        Some(format!(
            "{home}/.claude/projects/{}/{session_id}.jsonl",
            workdir.replace('/', "-")
        ))
    }

    /// The last conversation record decides: `system`/`turn_duration` (written right after the
    /// final answer) or the user record "[Request interrupted by user]" end a turn; a prompt, a
    /// tool result or an unfinished assistant message mean the turn is running.
    fn turn_running(&self, transcript_tail: &str) -> Option<bool> {
        for line in transcript_tail.lines().rev() {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match entry.get("type").and_then(Value::as_str) {
                Some("system") => {
                    if entry.get("subtype").and_then(Value::as_str) == Some("turn_duration") {
                        return Some(false);
                    }
                }
                Some("assistant") => {
                    let stop = entry
                        .pointer("/message/stop_reason")
                        .and_then(Value::as_str);
                    return Some(stop != Some("end_turn"));
                }
                Some("user") => {
                    if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    let text = match entry.pointer("/message/content") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Array(parts)) => parts
                            .iter()
                            .filter_map(|p| p.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join(""),
                        _ => String::new(),
                    };
                    return Some(!text.starts_with("[Request interrupted"));
                }
                _ => {}
            }
        }
        None
    }

    fn token_env(&self) -> Option<&'static str> {
        Some("CLAUDE_CODE_OAUTH_TOKEN")
    }

    /// `sk-ant-oat01-…` (108 characters today) after "Your OAuth token".
    fn token_from_login_output(&self, output: &str) -> Option<String> {
        let start = output.rfind("sk-ant-oat")?;
        let token: String = output[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        (token.len() >= 40).then_some(token)
    }

    fn disposable_home_paths(&self) -> &'static [&'static str] {
        &[
            ".local/share/claude",
            ".local/bin/claude",
            ".local/state/claude",
            ".claude/cache",
            ".cache",
        ]
    }
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_string()).collect()
}

/// The status JSON: the whole trimmed stdout, or the outermost `{…}` when the CLI printed
/// something around it.
fn status_json(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end < start {
        return None;
    }
    serde_json::from_str(&trimmed[start..=end]).ok()
}
