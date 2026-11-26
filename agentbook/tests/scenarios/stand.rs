//! The scenario stand: one instance label, a folder under the repo's `tmp/` (fake home with its
//! own `.ssh`, data folders, fixture projects), the local file server and a Docker client.
//! Cleanup removes only what carries this stand's instance label (or the compose project of a
//! laptop it created), its own prefixed credentials and its own folder; the download cache next to
//! it is kept between runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agentbook_core::equipment::sha256_hex;
use agentbook_core::pins::{
    DEVCONTAINERS_CLI_SHA256, DEVCONTAINERS_CLI_VERSION, NODE_VERSION, node_linux_archive,
};
use agentbook_core::state::{
    EquipmentRef, Folder, Laptop, State, id_from_bytes, parse_state, render_state,
};
use agentbook_engine::docker::{self, Docker, containers, label_filter};
use agentbook_engine::{
    ActionState, ActionView, Command, DesktopLauncher, Engine, EngineTestConfig, INSTANCE_LABEL,
    Snapshot,
};
use agentbook_platform::Platform;
use bollard::query_parameters::{ListNetworksOptionsBuilder, RemoveImageOptionsBuilder};

use crate::platform::TestPlatform;
use crate::server::FileServer;

pub type StepResult = Result<(), String>;

/// Fails the step with `msg` unless `cond`.
pub fn ensure(cond: bool, msg: impl Into<String>) -> StepResult {
    if cond { Ok(()) } else { Err(msg.into()) }
}

/// The fake Desktop launcher: records every `claude://` link the engine opens.
#[derive(Default)]
pub struct Recorder {
    links: Mutex<Vec<String>>,
}

impl DesktopLauncher for Recorder {
    fn open(&self, url: &str) {
        self.links.lock().unwrap().push(url.to_string());
    }
}

impl Recorder {
    pub fn links(&self) -> Vec<String> {
        self.links.lock().unwrap().clone()
    }
}

pub struct Stand {
    pub launcher: Arc<Recorder>,
    pub instance: String,
    pub root: PathBuf,
    pub cache: PathBuf,
    pub server: FileServer,
    pub platform: Arc<TestPlatform>,
    pub rt: tokio::runtime::Runtime,
    pub docker: Docker,
    /// The bridge to a Docker engine inside WSL (`DOCKER_HOST=wsl://<distro>`), kept alive with the
    /// stand.
    _bridge: Option<docker::bridge::Bridge>,
    /// The engine is a Docker engine inside WSL (project devcontainers are refused there).
    pub wsl: bool,
    laptops: Mutex<Vec<String>>,
    counter: Mutex<u64>,
}

/// The repo root (`agentbook/crates/engine` is the test's manifest dir).
fn repo_root() -> PathBuf {
    // `absolute` resolves the `..` without the verbatim prefix `canonicalize` adds on Windows.
    std::path::absolute(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(".."),
    )
    .expect("repo root")
}

/// `project-env.json → tmpDir` is `tmp/`.
fn scenarios_dir() -> PathBuf {
    repo_root().join("tmp").join("agentbook-scenarios")
}

impl Stand {
    pub fn create() -> Result<Stand, String> {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let instance = format!("scn-{secs}-{}", std::process::id());
        let base = scenarios_dir();
        let root = base.join(&instance);
        if root.exists() {
            return Err(format!("{} already exists", root.display()));
        }
        let cache = base.join("cache");
        let home = root.join("home");
        std::fs::create_dir_all(home.join(".ssh")).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let native = agentbook_platform::native();
        let platform = Arc::new(TestPlatform::new(native, home.clone(), root.join("data")));
        let endpoint = platform
            .docker_endpoint()
            .map_err(|e| format!("no Docker engine: {e}"))?;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let (docker, bridge) = if platform.docker_dial_command(&endpoint).is_some() {
            let bridge = rt
                .block_on(docker::bridge::start(platform.clone(), &endpoint))
                .map_err(|e| e.to_string())?;
            let client = docker::connect_url(&bridge.url).map_err(|e| e.to_string())?;
            println!(
                "Docker engine in WSL {} through {}",
                endpoint.address, bridge.url
            );
            (client, Some(bridge))
        } else {
            (docker::connect(&endpoint).map_err(|e| e.to_string())?, None)
        };
        let server = FileServer::start(cache.clone()).map_err(|e| e.to_string())?;
        println!("stand {instance} in {}", root.display());
        Ok(Stand {
            launcher: Arc::new(Recorder::default()),
            instance,
            root,
            cache,
            server,
            platform,
            rt,
            docker,
            wsl: bridge.is_some(),
            _bridge: bridge,
            laptops: Mutex::new(Vec::new()),
            counter: Mutex::new(0),
        })
    }

    pub fn test_config(&self) -> EngineTestConfig {
        let mut config = EngineTestConfig::new(&self.instance);
        config.download_base = Some(self.server.base.clone());
        config.desktop_launcher = Some(self.launcher.clone());
        config
    }

    /// The labels images built by a step carry, so the stand removes them.
    pub fn test_config_labels(&self) -> HashMap<String, String> {
        HashMap::from([
            ("artisyn.agentbook".to_string(), "1".to_string()),
            (INSTANCE_LABEL.to_string(), self.instance.clone()),
        ])
    }

    /// Runs a command and waits for it (up to `timeout`).
    pub fn act(
        &self,
        engine: &Engine,
        cmd: Command,
        timeout: Duration,
    ) -> Result<ActionView, String> {
        let id = engine.run(cmd);
        self.wait(engine, id, timeout)
    }

    /// Runs a command that must succeed.
    pub fn act_ok(
        &self,
        engine: &Engine,
        cmd: Command,
        timeout: Duration,
    ) -> Result<ActionView, String> {
        let what = format!("{cmd:?}");
        let view = self.act(engine, cmd, timeout)?;
        match &view.state {
            ActionState::Done => Ok(view),
            other => Err(format!("{what}: {other:?}\n{}", view.log_tail.join("\n"))),
        }
    }

    /// Runs a command that must fail; returns its message.
    pub fn act_fails(
        &self,
        engine: &Engine,
        cmd: Command,
        timeout: Duration,
    ) -> Result<String, String> {
        let what = format!("{cmd:?}");
        let view = self.act(engine, cmd, timeout)?;
        match view.state {
            ActionState::Failed { message } => Ok(message),
            other => Err(format!("{what} did not fail: {other:?}")),
        }
    }

    /// The fake home's `.ssh` folder.
    pub fn ssh_dir(&self) -> PathBuf {
        self.platform.ssh_dir()
    }

    /// The tool-owned ssh config (`ssh -F`: the stand's `~/.ssh/config` Include points at the
    /// real home).
    pub fn ssh_config(&self) -> PathBuf {
        self.ssh_dir().join("agentbook").join("config")
    }

    fn ssh_command(&self, alias: &str) -> Result<std::process::Command, String> {
        let ssh = self.platform.find_program("ssh").ok_or("no ssh on PATH")?;
        let mut cmd = std::process::Command::new(ssh);
        cmd.arg("-F")
            .arg(self.ssh_config())
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"])
            .arg(alias)
            .stdin(std::process::Stdio::null());
        Ok(cmd)
    }

    /// Runs `script` over ssh with the laptop's alias (as Desktop connects); returns (exit code,
    /// stdout + stderr). Connection failures (exit 255) are retried for a while: sshd may still
    /// be starting.
    pub fn ssh(&self, alias: &str, script: &str) -> Result<(i32, String), String> {
        let deadline = Instant::now() + Duration::from_secs(40);
        loop {
            let out = self
                .ssh_command(alias)?
                .arg(script)
                .output()
                .map_err(|e| format!("ssh: {e}"))?;
            let code = out.status.code().unwrap_or(-1);
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if code != 255 || Instant::now() >= deadline {
                return Ok((code, text));
            }
            std::thread::sleep(Duration::from_millis(700));
        }
    }

    /// [`Stand::ssh`] that must exit 0; returns the output.
    pub fn ssh_ok(&self, alias: &str, script: &str) -> Result<String, String> {
        let (code, out) = self.ssh(alias, script)?;
        ensure(
            code == 0,
            format!("ssh {alias} `{script}` exited {code}: {out}"),
        )?;
        Ok(out)
    }

    /// An ssh session kept open (`sleep`), like an attached Desktop session.
    pub fn ssh_hold(&self, alias: &str, secs: u32) -> Result<std::process::Child, String> {
        self.ssh_command(alias)?
            .arg(format!("sleep {secs}"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("ssh: {e}"))
    }

    /// The system ssh with extra options and no alias config (password-login checks).
    pub fn ssh_raw(&self, args: &[String]) -> Result<(i32, String), String> {
        let ssh = self.platform.find_program("ssh").ok_or("no ssh on PATH")?;
        let out = std::process::Command::new(ssh)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("ssh: {e}"))?;
        Ok((
            out.status.code().unwrap_or(-1),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
        ))
    }

    /// Runs the host's git in `dir`; returns stdout.
    pub fn git(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .map_err(|e| format!("git: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git {args:?} in {}: {}",
                dir.display(),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// A git repo at `dir` with `files` committed on branch `main`.
    pub fn git_repo(&self, dir: &Path, files: &[(&str, &str)]) -> StepResult {
        self.write_files(dir, files)?;
        self.git(dir, &["-c", "init.defaultBranch=main", "init", "-q"])?;
        self.git(dir, &["-c", "core.autocrlf=false", "add", "-A"])?;
        self.git(
            dir,
            &[
                "-c",
                "user.name=AgentBook scenario",
                "-c",
                "user.email=scenario@agentbook.invalid",
                "-c",
                "core.autocrlf=false",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
        )?;
        Ok(())
    }

    /// A digest of every file (path and bytes) under `dir`: "byte-identical" checks.
    pub fn tree_digest(&self, dir: &Path) -> String {
        fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, Vec<u8>)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let path = format!("{rel}/{name}");
                match e.file_type() {
                    Ok(t) if t.is_dir() => walk(&e.path(), &path, out),
                    Ok(t) if t.is_file() => {
                        out.push((path, std::fs::read(e.path()).unwrap_or_default()))
                    }
                    _ => {}
                }
            }
        }
        let mut files = Vec::new();
        walk(dir, "", &mut files);
        files.sort();
        let mut buf = Vec::new();
        for (p, b) in files {
            buf.extend_from_slice(p.as_bytes());
            buf.push(0);
            buf.extend_from_slice(&b);
            buf.push(0);
        }
        sha256_hex(&buf)
    }

    /// Starts an engine on `data` (a folder under the stand).
    pub fn engine(&self, data: &Path) -> Result<Engine, String> {
        Engine::new(
            self.platform.clone(),
            Some(data.to_path_buf()),
            Some(self.test_config()),
        )
        .map_err(|e| format!("engine start: {e}"))
    }

    /// The files the downloads need, fetched once from the real hosts into the kept cache.
    pub fn fill_cache(&self) -> StepResult {
        let arch = self
            .rt
            .block_on(docker::engine_info(&self.docker))
            .map_err(|e| e.to_string())?
            .arch;
        let (linux, linux_sha) =
            node_linux_archive(&arch).ok_or(format!("unsupported engine arch {arch}"))?;
        let host = agentbook_engine::deps::host_node_archive()
            .ok_or("no host Node archive for this OS / CPU")?;
        let files = [
            (
                host.file.clone(),
                format!("https://nodejs.org/dist/{NODE_VERSION}/{}", host.file),
                host.sha256,
            ),
            (
                format!("cli-{DEVCONTAINERS_CLI_VERSION}.tgz"),
                format!(
                    "https://registry.npmjs.org/@devcontainers/cli/-/cli-{DEVCONTAINERS_CLI_VERSION}.tgz"
                ),
                DEVCONTAINERS_CLI_SHA256,
            ),
            (
                linux.clone(),
                format!("https://nodejs.org/dist/{NODE_VERSION}/{linux}"),
                linux_sha,
            ),
        ];
        let client = reqwest::Client::new();
        for (name, url, sha) in files {
            let dest = self.cache.join(&name);
            if dest.is_file() {
                continue;
            }
            println!("  caching {url}");
            self.rt
                .block_on(agentbook_engine::deps::download_verified(
                    &client,
                    &url,
                    &dest,
                    sha,
                    |_| {},
                ))
                .map_err(|e| format!("caching {name}: {e}"))?;
        }
        Ok(())
    }

    /// A fresh id (8 base32 characters) unique to this stand.
    pub fn new_id(&self) -> String {
        let mut c = self.counter.lock().unwrap();
        *c += 1;
        let h = sha256_hex(format!("{}-{}", self.instance, *c).as_bytes());
        let b = h.as_bytes();
        let byte = |i: usize| {
            u8::from_str_radix(std::str::from_utf8(&b[i * 2..i * 2 + 2]).unwrap(), 16).unwrap()
        };
        id_from_bytes([byte(0), byte(1), byte(2), byte(3), byte(4)])
    }

    /// A free loopback port in 20000–29999.
    pub fn free_port(&self) -> u16 {
        let seed = u16::from_str_radix(&self.new_id_hex()[..4], 16).unwrap_or(0);
        for i in 0..10_000u16 {
            let port = 20_000 + (seed.wrapping_add(i.wrapping_mul(7))) % 10_000;
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return port;
            }
        }
        29_999
    }

    fn new_id_hex(&self) -> String {
        sha256_hex(self.new_id().as_bytes())
    }

    /// A folder record (and its laptop ids remembered for compose cleanup).
    pub fn folder(&self, path: &Path, equipment: EquipmentRef) -> Folder {
        Folder {
            id: self.new_id(),
            path: path.to_string_lossy().into_owned(),
            claude_dir: Some(String::new()),
            equipment,
            vars: Vec::new(),
            extra: Default::default(),
        }
    }

    pub fn laptop(&self, folder: &Folder, name: &str) -> Laptop {
        let id = self.new_id();
        self.laptops.lock().unwrap().push(id.clone());
        Laptop {
            id,
            folder_id: folder.id.clone(),
            name: name.to_string(),
            port: self.free_port(),
            given: Vec::new(),
            equipment_hash: None,
            libc: None,
            generation: 0,
            laptop_vars: Vec::new(),
            extra: Default::default(),
        }
    }

    /// Changes `state.json` in `data` (the engine must not be running on it).
    pub fn edit_state(&self, data: &Path, f: impl FnOnce(&mut State)) -> StepResult {
        std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let path = data.join("state.json");
        let mut state = match std::fs::read_to_string(&path) {
            Ok(text) => parse_state(&text).map_err(|e| e.to_string())?.state,
            Err(_) => State::default(),
        };
        f(&mut state);
        std::fs::write(&path, render_state(&state)).map_err(|e| e.to_string())
    }

    /// Writes fixture files (relative path, text) under `dir`.
    pub fn write_files(&self, dir: &Path, files: &[(&str, &str)]) -> StepResult {
        for (rel, text) in files {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(())
    }

    /// The laptop's containers (all generations).
    pub fn containers_of(&self, laptop: &str) -> Vec<containers::ContainerListItem> {
        self.rt
            .block_on(containers::list_by_labels(
                &self.docker,
                &label_filter(&[("artisyn.agentbook.laptop", laptop)]),
            ))
            .unwrap_or_default()
    }

    /// The laptop's only running container, or why not.
    pub fn running_container(&self, laptop: &str) -> Result<containers::ContainerListItem, String> {
        let list = self.containers_of(laptop);
        let running: Vec<_> = list.iter().filter(|c| c.running()).cloned().collect();
        match running.as_slice() {
            [one] if list.len() == 1 => Ok(one.clone()),
            _ => Err(format!(
                "laptop {laptop}: expected one running container, found {:?}",
                list.iter()
                    .map(|c| (c.name.clone(), c.state.clone()))
                    .collect::<Vec<_>>()
            )),
        }
    }

    /// `docker exec` as `user`; returns (exit code, stdout + stderr).
    pub fn exec(&self, container: &str, user: &str, script: &str) -> Result<(i64, String), String> {
        let out = self
            .rt
            .block_on(containers::exec(
                &self.docker,
                container,
                user,
                &containers::sh(script),
                None,
                Duration::from_secs(60),
            ))
            .map_err(|e| e.to_string())?;
        Ok((
            out.exit_code,
            format!("{}{}", out.stdout_str(), out.stderr_str()),
        ))
    }

    /// Waits for an action; fails when it is still running after `timeout`.
    pub fn wait(&self, engine: &Engine, id: u64, timeout: Duration) -> Result<ActionView, String> {
        let view = engine
            .wait(id, timeout)
            .ok_or_else(|| format!("action {id} is unknown"))?;
        if !view.finished() {
            return Err(format!(
                "action {id} ({}) still running after {timeout:?}",
                view.kind
            ));
        }
        Ok(view)
    }

    /// Polls the snapshot until `cond` holds.
    pub fn wait_snapshot(
        &self,
        engine: &Engine,
        timeout: Duration,
        what: &str,
        cond: impl Fn(&Snapshot) -> bool,
    ) -> StepResult {
        let deadline = Instant::now() + timeout;
        loop {
            if cond(&engine.snapshot()) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("timed out waiting for {what}"));
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// Removes everything this stand created. Never touches objects without its labels.
    pub fn cleanup(&self) {
        println!("cleaning up stand {}", self.instance);
        let instance = label_filter(&[(INSTANCE_LABEL, self.instance.as_str())]);
        let laptops = self.laptops.lock().unwrap().clone();
        let docker = &self.docker;
        self.rt.block_on(async {
            let mut ids: Vec<String> = containers::list_by_labels(docker, &instance)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|c| c.id)
                .collect();
            let projects: Vec<String> = laptops.iter().map(|l| format!("agentbook-{l}")).collect();
            for p in &projects {
                let f = label_filter(&[("com.docker.compose.project", p.as_str())]);
                ids.extend(
                    containers::list_by_labels(docker, &f)
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .map(|c| c.id),
                );
            }
            for id in ids {
                let _ = containers::remove(docker, &id).await;
            }
            let mut volumes = docker::volumes::list_by_labels(docker, &instance)
                .await
                .unwrap_or_default();
            for p in &projects {
                let f = label_filter(&[("com.docker.compose.project", p.as_str())]);
                volumes.extend(
                    docker::volumes::list_by_labels(docker, &f)
                        .await
                        .unwrap_or_default(),
                );
                let options = ListNetworksOptionsBuilder::default()
                    .filters(&HashMap::from([(
                        "label".to_string(),
                        vec![format!("com.docker.compose.project={p}")],
                    )]))
                    .build();
                if let Ok(nets) = docker.list_networks(Some(options)).await {
                    for n in nets {
                        if let Some(id) = n.id {
                            let _ = docker.remove_network(&id).await;
                        }
                    }
                }
            }
            for v in volumes {
                let _ = docker::volumes::remove(docker, &v).await;
            }
            // Images: every tag first (layers before their bases), then the image ids.
            for _ in 0..3 {
                let images = docker::images::list_by_labels(docker, &instance)
                    .await
                    .unwrap_or_default();
                if images.is_empty() {
                    break;
                }
                for image in &images {
                    for tag in &image.tags {
                        let _ = docker::images::remove_tag(docker, tag).await;
                    }
                }
                for image in &images {
                    let options = RemoveImageOptionsBuilder::default().force(true).build();
                    let _ = docker.remove_image(&image.id, Some(options), None).await;
                }
            }
        });
        let prefix = self.test_config().credential_prefix;
        if let Ok(names) = self.platform.credential_list(&prefix) {
            for n in names {
                let _ = self.platform.credential_delete(&n);
            }
        }
        // Only this stand's own folder under tmp/agentbook-scenarios/ (never the cache).
        if self.root.starts_with(scenarios_dir())
            && self.root != scenarios_dir()
            && let Err(e) = std::fs::remove_dir_all(&self.root)
        {
            println!("could not remove {}: {e}", self.root.display());
        }
    }
}
