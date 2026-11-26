//! Containers: creating a standard-Equipment laptop through the API, start / stop / remove by
//! exact name or id, listing by label, `docker exec` with captured output, and reading small
//! files out of an image without starting it.

use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::models::{
    ContainerCreateBody, HostConfig, Mount, MountType, PortBinding, RestartPolicy,
    RestartPolicyNameEnum,
};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, DownloadFromContainerOptionsBuilder,
    ListContainersOptionsBuilder, RemoveContainerOptionsBuilder, StopContainerOptionsBuilder,
};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use super::{Docker, DockerError, DockerResult, STOP_TIMEOUT};

/// What [`create_and_start`] runs.
#[derive(Debug, Clone, Default)]
pub struct RunSpec {
    pub name: String,
    pub image: String,
    pub entrypoint: Option<Vec<String>>,
    pub cmd: Option<Vec<String>>,
    pub labels: HashMap<String, String>,
    /// `(host path, target, read_only)` bind mounts, passed as native host paths.
    pub binds: Vec<(String, String, bool)>,
    /// `(volume, target)` named volume mounts.
    pub volumes: Vec<(String, String)>,
    /// tmpfs mount points.
    pub tmpfs: Vec<String>,
    /// `(host ip, host port, container port)` TCP publishes.
    pub ports: Vec<(String, u16, u16)>,
    pub working_dir: Option<String>,
}

fn bind_string(source: &str, target: &str, read_only: bool) -> String {
    if read_only {
        format!("{source}:{target}:ro")
    } else {
        format!("{source}:{target}")
    }
}

/// Creates and starts a container. Returns its id. When the start fails the created container
/// is removed again.
pub async fn create_and_start(docker: &Docker, spec: &RunSpec) -> DockerResult<String> {
    let mut exposed: Vec<String> = Vec::new();
    let mut port_bindings = HashMap::new();
    for (ip, host_port, port) in &spec.ports {
        let key = format!("{port}/tcp");
        exposed.push(key.clone());
        port_bindings.insert(
            key,
            Some(vec![PortBinding {
                host_ip: Some(ip.clone()),
                host_port: Some(host_port.to_string()),
            }]),
        );
    }
    let mounts: Vec<Mount> = spec
        .volumes
        .iter()
        .map(|(v, t)| Mount {
            target: Some(t.clone()),
            source: Some(v.clone()),
            typ: Some(MountType::VOLUME),
            read_only: Some(false),
            ..Default::default()
        })
        .collect();
    let body = ContainerCreateBody {
        image: Some(spec.image.clone()),
        entrypoint: spec.entrypoint.clone(),
        cmd: spec.cmd.clone(),
        labels: Some(spec.labels.clone()),
        working_dir: spec.working_dir.clone(),
        exposed_ports: Some(exposed),
        host_config: Some(HostConfig {
            binds: Some(
                spec.binds
                    .iter()
                    .map(|(s, t, ro)| bind_string(s, t, *ro))
                    .collect(),
            ),
            mounts: Some(mounts),
            tmpfs: Some(
                spec.tmpfs
                    .iter()
                    .map(|t| (t.clone(), String::new()))
                    .collect(),
            ),
            port_bindings: Some(port_bindings),
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::NO),
                maximum_retry_count: None,
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    let options = CreateContainerOptionsBuilder::default()
        .name(&spec.name)
        .build();
    let created = docker.create_container(Some(options), body).await?;
    if let Err(e) = docker.start_container(&created.id, None).await {
        let e = DockerError::from(e);
        let _ = remove(docker, &created.id).await;
        return Err(e);
    }
    Ok(created.id)
}

/// Starts a stopped container (already running is fine).
pub async fn start(docker: &Docker, id: &str) -> DockerResult<()> {
    match docker.start_container(id, None).await {
        Ok(()) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Stops a container. Already stopped or missing is fine.
pub async fn stop(docker: &Docker, id: &str) -> DockerResult<()> {
    let options = StopContainerOptionsBuilder::default()
        .t(STOP_TIMEOUT.as_secs() as i32)
        .build();
    match docker.stop_container(id, Some(options)).await {
        Ok(()) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            other => Err(other),
        },
    }
}

/// Removes a container by exact id or name, with force. Missing is fine; volumes are kept.
pub async fn remove(docker: &Docker, id: &str) -> DockerResult<()> {
    let options = RemoveContainerOptionsBuilder::default().force(true).build();
    match docker.remove_container(id, Some(options)).await {
        Ok(()) => Ok(()),
        Err(e) => match DockerError::from(e) {
            DockerError::NotFound(_) => Ok(()),
            DockerError::Conflict(msg) if msg.contains("already in progress") => Ok(()),
            other => Err(other),
        },
    }
}

/// One container found by [`list_by_labels`].
#[derive(Debug, Clone)]
pub struct ContainerListItem {
    pub id: String,
    pub name: String,
    pub image: String,
    /// `running`, `exited`, `created`, …
    pub state: String,
    pub labels: HashMap<String, String>,
}

impl ContainerListItem {
    pub fn running(&self) -> bool {
        self.state == "running"
    }
}

/// Every container (running or not) matching a label filter.
pub async fn list_by_labels(
    docker: &Docker,
    filter: &HashMap<String, Vec<String>>,
) -> DockerResult<Vec<ContainerListItem>> {
    let options = ListContainersOptionsBuilder::default()
        .all(true)
        .filters(filter)
        .build();
    let list = docker.list_containers(Some(options)).await?;
    Ok(list
        .into_iter()
        .map(|c| ContainerListItem {
            id: c.id.unwrap_or_default(),
            name: c
                .names
                .unwrap_or_default()
                .into_iter()
                .next()
                .map(|n| n.trim_start_matches('/').to_string())
                .unwrap_or_default(),
            image: c.image.unwrap_or_default(),
            state: c.state.map(|s| s.to_string()).unwrap_or_default(),
            labels: c.labels.unwrap_or_default(),
        })
        .collect())
}

/// The result of [`exec`].
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

    /// `Ok(self)` on exit code 0, else [`DockerError::Exit`].
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

/// `sh -c '<script>'`.
pub fn sh(script: &str) -> Vec<String> {
    vec!["sh".into(), "-c".into(), script.into()]
}

/// Runs `argv` as `user` without a TTY and collects its output. `stdin` is fed as exactly its
/// length (`head -c`), because closing the write half does not reach the process over the
/// Docker Desktop named pipe (Work Hub's recipe). A non-zero exit is not an error here.
pub async fn exec(
    docker: &Docker,
    container: &str,
    user: &str,
    argv: &[String],
    stdin: Option<Bytes>,
    timeout: Duration,
) -> DockerResult<ExecOutput> {
    let cmd = match &stdin {
        Some(data) => {
            let mut out = vec![
                "sh".to_string(),
                "-c".to_string(),
                "head -c \"$0\" | \"$@\"".to_string(),
                data.len().to_string(),
            ];
            out.extend(argv.iter().cloned());
            out
        }
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
        let (_written, read) = tokio::join!(writer, reader);
        let mut out = read?;
        let inspect = docker.inspect_exec(&exec.id).await?;
        out.exit_code = inspect.exit_code.unwrap_or(-1);
        Ok(out)
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(r) => r,
        Err(_) => Err(DockerError::Timeout(format!("exec {}", argv.join(" ")))),
    }
}

/// Restarts a container (the scenario suite's "`docker restart` from outside").
pub async fn restart(docker: &Docker, id: &str) -> DockerResult<()> {
    let options = bollard::query_parameters::RestartContainerOptionsBuilder::default()
        .t(STOP_TIMEOUT.as_secs() as i32)
        .build();
    docker.restart_container(id, Some(options)).await?;
    Ok(())
}

/// The container's environment (`Config.Env`) as name/value pairs, in order.
pub async fn env(docker: &Docker, id: &str) -> DockerResult<Vec<(String, String)>> {
    let inspect = docker.inspect_container(id, None).await?;
    Ok(inspect
        .config
        .and_then(|c| c.env)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|kv| {
            kv.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect())
}

/// Extracts an uncompressed tar into `dir` in the container (which must exist), through the
/// archive endpoint. Entries keep the owner set in their headers.
pub async fn upload_tar(docker: &Docker, id: &str, dir: &str, tar: Vec<u8>) -> DockerResult<()> {
    let options = bollard::query_parameters::UploadToContainerOptionsBuilder::default()
        .path(dir)
        .build();
    docker
        .upload_to_container(id, Some(options), bollard::body_full(Bytes::from(tar)))
        .await?;
    Ok(())
}

/// Reads small regular files out of an image without running it: a container is created (never
/// started), each path fetched through the archive endpoint, and the container removed again.
/// A missing file is `None`.
pub async fn read_image_files(
    docker: &Docker,
    image: &str,
    labels: HashMap<String, String>,
    paths: &[&str],
) -> DockerResult<Vec<Option<Vec<u8>>>> {
    let body = ContainerCreateBody {
        image: Some(image.to_string()),
        entrypoint: Some(vec!["/bin/true".into()]),
        cmd: Some(vec![]),
        labels: Some(labels),
        ..Default::default()
    };
    let created = docker
        .create_container(
            None::<bollard::query_parameters::CreateContainerOptions>,
            body,
        )
        .await?;
    let mut out = Vec::with_capacity(paths.len());
    let mut failure = None;
    for path in paths {
        match read_file(docker, &created.id, path).await {
            Ok(v) => out.push(v),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    let _ = remove(docker, &created.id).await;
    match failure {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

async fn read_file(docker: &Docker, container: &str, path: &str) -> DockerResult<Option<Vec<u8>>> {
    let options = DownloadFromContainerOptionsBuilder::default()
        .path(path)
        .build();
    let mut stream = docker.download_from_container(container, Some(options));
    let mut tar_bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(b) => tar_bytes.extend_from_slice(&b),
            Err(e) => {
                return match DockerError::from(e) {
                    DockerError::NotFound(_) => Ok(None),
                    other => Err(other),
                };
            }
        }
    }
    let mut archive = tar::Archive::new(tar_bytes.as_slice());
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.header().entry_type().is_file() {
            let mut data = Vec::new();
            entry.read_to_end(&mut data)?;
            return Ok(Some(data));
        }
    }
    Ok(None)
}
