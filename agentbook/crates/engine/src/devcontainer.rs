//! The official `@devcontainers/cli`, run with the downloaded Node: `read-configuration` (the only
//! source of the merged config; the tool never parses JSONC itself), `build` and `up`. The CLI
//! gets `--docker-path` (the `docker` on PATH) and `DOCKER_HOST` set to the endpoint the engine
//! resolved, so it talks to the same engine. Its log lines are streamed into the action log.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::action::Action;
use crate::deps::{self, TOOLS_MISSING_MESSAGE};
use crate::docker::docker_host_value;
use crate::engine::{Ctx, EngineError, EngineResult};

/// The devcontainer CLI hands Windows paths to `docker`, which a Docker engine inside WSL cannot
/// mount.
pub const WSL_PROJECT_MESSAGE: &str = "A project's own devcontainer is not supported yet with a \
     Docker engine inside WSL. Use the Standard Equipment for this folder, or Docker Desktop / \
     Rancher Desktop.";

pub(crate) struct DevcontainerCli {
    ctx: Arc<Ctx>,
    node: PathBuf,
    script: PathBuf,
    docker: PathBuf,
    docker_host: String,
}

/// What `read-configuration --include-merged-configuration` reports.
#[derive(Debug, Clone)]
pub(crate) struct ReadConfiguration {
    /// The selected config as written (variables substituted).
    pub configuration: Value,
    /// The config merged with the image and Feature metadata.
    pub merged: Value,
}

/// What `up` reports on success.
#[derive(Debug, Clone)]
pub(crate) struct UpResult {
    pub container_id: String,
}

impl DevcontainerCli {
    /// The CLI with its Node, the `docker` command and the endpoint; the plain message when any
    /// is missing.
    pub async fn locate(ctx: &Arc<Ctx>) -> EngineResult<Self> {
        if !deps::devcontainer_tools_ready(ctx) {
            return Err(EngineError(TOOLS_MISSING_MESSAGE.to_string()));
        }
        let (_, endpoint) = ctx.docker_with_endpoint().await?;
        if endpoint.kind == agentbook_platform::EndpointKind::Wsl {
            return Err(EngineError(WSL_PROJECT_MESSAGE.to_string()));
        }
        let docker = ctx.docker_cli()?;
        Ok(Self {
            ctx: ctx.clone(),
            node: deps::node_exe(ctx),
            script: deps::cli_script(ctx),
            docker,
            docker_host: docker_host_value(&endpoint),
        })
    }

    /// Runs the CLI; stderr (its log) and stdout go to `action` line by line. Returns the exit
    /// success and the stdout text.
    async fn run(
        &self,
        args: Vec<OsString>,
        env: &[(String, String)],
        action: Option<&Action>,
    ) -> EngineResult<(bool, String)> {
        let mut std_cmd = std::process::Command::new(&self.node);
        std_cmd
            .arg(&self.script)
            .args(&args)
            .arg("--docker-path")
            .arg(&self.docker)
            .env("DOCKER_HOST", &self.docker_host)
            .env_remove("DOCKER_CONTEXT")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            std_cmd.env(k, v);
        }
        self.ctx.platform.prepare_command(&mut std_cmd);
        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| EngineError(format!("cannot start the devcontainer CLI: {e}")))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out_task = async {
            let mut text = String::new();
            if let Some(out) = stdout {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(a) = action {
                        a.line(&line);
                    }
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            text
        };
        let err_task = async {
            if let Some(err) = stderr {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(a) = action {
                        a.line(&line);
                    }
                }
            }
        };
        let (text, ()) = tokio::join!(out_task, err_task);
        let status = child
            .wait()
            .await
            .map_err(|e| EngineError(format!("the devcontainer CLI did not finish: {e}")))?;
        Ok((status.success(), text))
    }

    /// `read-configuration --include-merged-configuration` for `config` in `workspace`.
    pub async fn read_configuration(
        &self,
        workspace: &str,
        config: &Path,
        action: Option<&Action>,
    ) -> EngineResult<ReadConfiguration> {
        let args = vec![
            "read-configuration".into(),
            "--workspace-folder".into(),
            workspace.into(),
            "--config".into(),
            config.as_os_str().to_os_string(),
            "--include-merged-configuration".into(),
            "--log-format".into(),
            "text".into(),
        ];
        let (ok, stdout) = self.run(args, &[], None).await?;
        let result = last_json(&stdout);
        match result {
            Some(v) if ok && v.get("configuration").is_some() => Ok(ReadConfiguration {
                configuration: v.get("configuration").cloned().unwrap_or(Value::Null),
                merged: v.get("mergedConfiguration").cloned().unwrap_or(Value::Null),
            }),
            other => {
                if let Some(a) = action {
                    a.line(stdout.trim());
                }
                Err(EngineError(format!(
                    "The devcontainer configuration {} could not be read{}.",
                    config.display(),
                    error_suffix(other.as_ref())
                )))
            }
        }
    }

    /// `build` of the project's image, tagged `image_name`, with `labels` on the image.
    pub async fn build(
        &self,
        workspace: &str,
        config: &Path,
        image_name: &str,
        labels: &[(String, String)],
        action: &Action,
    ) -> EngineResult<Value> {
        let mut args: Vec<OsString> = vec![
            "build".into(),
            "--workspace-folder".into(),
            workspace.into(),
            "--config".into(),
            config.as_os_str().to_os_string(),
            "--image-name".into(),
            image_name.into(),
            "--log-format".into(),
            "text".into(),
        ];
        for (k, v) in labels {
            args.push("--label".into());
            args.push(format!("{k}={v}").into());
        }
        let (ok, stdout) = self.run(args, &[], Some(action)).await?;
        match last_json(&stdout) {
            Some(v) if ok && outcome_ok(&v) => Ok(v),
            other => Err(EngineError(format!(
                "Building the devcontainer failed{}. See the log and press Retry.",
                error_suffix(other.as_ref())
            ))),
        }
    }

    /// `up` with the generated override config; `id_labels` find the container.
    pub async fn up(
        &self,
        workspace: &str,
        override_config: &Path,
        id_labels: &[(String, String)],
        compose_project: Option<&str>,
        action: &Action,
    ) -> EngineResult<UpResult> {
        let mut args: Vec<OsString> = vec![
            "up".into(),
            "--workspace-folder".into(),
            workspace.into(),
            "--override-config".into(),
            override_config.as_os_str().to_os_string(),
            "--log-format".into(),
            "text".into(),
        ];
        for (k, v) in id_labels {
            args.push("--id-label".into());
            args.push(format!("{k}={v}").into());
        }
        let env: Vec<(String, String)> = compose_project
            .map(|p| vec![("COMPOSE_PROJECT_NAME".to_string(), p.to_string())])
            .unwrap_or_default();
        let (ok, stdout) = self.run(args, &env, Some(action)).await?;
        match last_json(&stdout) {
            Some(v) if ok && outcome_ok(&v) => Ok(UpResult {
                container_id: v
                    .get("containerId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            }),
            other => Err(EngineError(format!(
                "Starting the laptop failed{}. See the log and press Retry.",
                error_suffix(other.as_ref())
            ))),
        }
    }
}

fn outcome_ok(v: &Value) -> bool {
    v.get("outcome").and_then(Value::as_str) == Some("success")
}

/// `: <message>` from the CLI's error result, when it has one.
fn error_suffix(v: Option<&Value>) -> String {
    let Some(v) = v else {
        return String::new();
    };
    let message = v
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if message.is_empty() {
        String::new()
    } else {
        format!(": {message}")
    }
}

/// The last stdout line that is a JSON object (the CLI's result).
fn last_json(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .or_else(|| serde_json::from_str::<Value>(stdout.trim()).ok())
}
