//! Coding-agent adapters (D7). The registry is keyed by `workspaces.agent`; only
//! [`claude`] names a concrete agent, everything else goes through [`AgentAdapter`].

pub mod claude;

/// Registry id of the agent every new workspace gets in the alpha.
pub const DEFAULT_AGENT: &str = "claude";

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;

/// What Work Hub needs to know about a coding agent.
pub trait AgentAdapter: Send + Sync {
    /// Registry key stored in `workspaces.agent`, e.g. `"claude"`.
    fn id(&self) -> &'static str;
    /// Files (relative to the container user's home) that hold the agent's login.
    fn login_files(&self) -> &'static [&'static str];
    /// Interactive login, run in the `login` tmux session.
    fn login_command(&self) -> Vec<String>;
    /// Non-interactive login check; its result goes to [`AgentAdapter::parse_status`].
    fn status_command(&self) -> Vec<String>;
    /// `true` when the status command says the agent is logged in.
    fn parse_status(&self, exit_code: i64, stdout: &str) -> bool;
    /// Starts a new chat with a fixed session id.
    fn start_command(&self, session_id: &str) -> Vec<String>;
    /// Resumes the chat, falling back to a new one with the same id when there is nothing to resume.
    fn resume_command(&self, session_id: &str) -> Vec<String>;
    /// The configure session's command (installs tools into the container).
    fn configure_command(&self) -> Vec<String>;
    /// JSON merged into the agent's profile file so it starts without first-run dialogs in `workdirs`.
    fn profile_patch(&self, workdirs: &[&str]) -> Value;
    /// Top-level keys of the source profile copied together with the login files.
    fn copy_extra_keys(&self) -> &'static [&'static str];
    /// The profile file, relative to the home directory.
    fn profile_file(&self) -> &'static str;
    /// Human name sent to the UI as `agentName`.
    fn display_name(&self) -> &'static str;
    /// Non-interactive logout, run in the workspace container (the workspace's login only).
    fn logout_command(&self) -> Vec<String>;
    /// Env every workspace and workstream container gets, under the definition's `containerEnv`
    /// (e.g. turning off the agent's self-update: the image pins its version).
    fn container_env(&self) -> &'static [(&'static str, &'static str)];
    /// Paths (relative to the home) the agent can download or rebuild again: deleted when a
    /// workstream is closed, so a closed workstream keeps only what cannot be restored.
    fn disposable_home_paths(&self) -> &'static [&'static str];
    /// Text the agent shows on its chat screen only while it is working on an answer (case
    /// insensitive). The agent redraws its screen all the time, so screen activity alone does
    /// not tell a working agent from an idle one. Empty: fall back to recent screen activity.
    fn busy_markers(&self) -> &'static [&'static str];
    /// The chat's transcript file (absolute, in the container), when the agent keeps one.
    fn transcript_file(&self, home: &str, workdir: &str, session_id: &str) -> Option<String>;
    /// From the end of the transcript: `Some(true)` while a turn is running (the agent is
    /// working on an answer), `Some(false)` when the last turn ended or was interrupted, `None`
    /// when the tail does not tell (then the screen markers decide).
    fn turn_running(&self, transcript_tail: &str) -> Option<bool>;
    /// The env variable that carries the agent's long-lived token. `Some`: the login is one
    /// token per user kept in the secret store (`secrets`, name [`token_secret`]) and passed to
    /// every agent process; the login command prints it. `None`: the login is the agent's own
    /// files in the home (`login_files`).
    fn token_env(&self) -> Option<&'static str>;
    /// The token in the login command's output (escape sequences included), if it printed one.
    fn token_from_login_output(&self, output: &str) -> Option<String>;
}

/// Secret-store name of an agent's token: `<agent id>-token`.
pub fn token_secret(agent: &dyn AgentAdapter) -> String {
    format!("{}-token", agent.id())
}

/// The definition's `containerEnv` over the adapter's [`AgentAdapter::container_env`].
pub fn with_agent_env(
    agent: &dyn AgentAdapter,
    env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = agent
        .container_env()
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    out.extend(env.iter().map(|(k, v)| (k.clone(), v.clone())));
    out
}

/// All known adapters by id.
pub struct AgentRegistry {
    adapters: BTreeMap<&'static str, Arc<dyn AgentAdapter>>,
}

impl AgentRegistry {
    /// The registry with every built-in adapter.
    pub fn new() -> Self {
        let mut registry = AgentRegistry {
            adapters: BTreeMap::new(),
        };
        registry.register(Arc::new(claude::ClaudeAdapter));
        registry
    }

    pub fn register(&mut self, adapter: Arc<dyn AgentAdapter>) {
        self.adapters.insert(adapter.id(), adapter);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.get(id).cloned()
    }

    /// Registered ids, sorted.
    pub fn ids(&self) -> Vec<&'static str> {
        self.adapters.keys().copied().collect()
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Deep-merges `patch` into `target`: objects merge key by key, any other value replaces.
/// A `target` that is not an object (e.g. a missing or broken profile) becomes one.
pub fn merge_json(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (key, pv) in p {
                match t.get_mut(key) {
                    Some(tv) if tv.is_object() && pv.is_object() => merge_json(tv, pv),
                    _ => {
                        t.insert(key.clone(), pv.clone());
                    }
                }
            }
        }
        (t, p) => *t = p.clone(),
    }
}
