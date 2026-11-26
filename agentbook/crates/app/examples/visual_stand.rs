//! The visual-check stand (manual, not a test): runs the real AgentBook window against a real
//! engine on real Docker, with the home, `.ssh` and data folders redirected into the repo's
//! `tmp/agentbook-visual/` and every Docker object labelled `artisyn.agentbook.instance=visual`,
//! so the real `~/.ssh` and `%LOCALAPPDATA%\AgentBook` are never touched. "Open laptop" prints
//! the `claude://` link instead of opening Claude Desktop.
//!
//! `cargo run -p agentbook --example visual_stand` (from `agentbook/`): on first run it seeds
//! fixture folders — a folder with two `.claude/` setups and a git repo, a plain folder with a
//! non-ASCII name, a project folder whose Dockerfile fails, and a folder that is then deleted
//! (missing) — and opens the window.
//! `-- --clean` removes the stand's folders, laptops, Docker objects and Hidden values (the files
//! under `tmp/agentbook-visual/` stay; delete that folder by hand).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agentbook_engine::{Command, DesktopLauncher, Engine, EngineTestConfig};
use agentbook_platform::{
    DockerEndpoint, DockerEndpointError, FontFile, HostAutocrlf, OpensshVersion, Platform,
    PlatformError, ProxySettings,
};

const INSTANCE: &str = "visual";

/// The native platform with the home, `.ssh` and data folders inside the stand.
struct StandPlatform {
    inner: Arc<dyn Platform>,
    home: PathBuf,
    data: PathBuf,
}

impl Platform for StandPlatform {
    fn is_windows(&self) -> bool {
        self.inner.is_windows()
    }
    fn home_dir(&self) -> PathBuf {
        self.home.clone()
    }
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn ssh_dir(&self) -> PathBuf {
        self.home.join(".ssh")
    }
    fn docker_endpoint(&self) -> Result<DockerEndpoint, DockerEndpointError> {
        self.inner.docker_endpoint()
    }
    fn docker_dial_command(&self, endpoint: &DockerEndpoint) -> Option<std::process::Command> {
        self.inner.docker_dial_command(endpoint)
    }
    fn docker_keep_alive(&self, endpoint: &DockerEndpoint) -> Result<(), PlatformError> {
        self.inner.docker_keep_alive(endpoint)
    }
    fn find_program(&self, name: &str) -> Option<PathBuf> {
        self.inner.find_program(name)
    }
    fn openssh_version(&self) -> Option<OpensshVersion> {
        self.inner.openssh_version()
    }
    fn credential_get(&self, target: &str) -> Result<Option<String>, PlatformError> {
        self.inner.credential_get(target)
    }
    fn credential_set(&self, target: &str, value: &str) -> Result<(), PlatformError> {
        self.inner.credential_set(target, value)
    }
    fn credential_delete(&self, target: &str) -> Result<bool, PlatformError> {
        self.inner.credential_delete(target)
    }
    fn credential_list(&self, prefix: &str) -> Result<Vec<String>, PlatformError> {
        self.inner.credential_list(prefix)
    }
    fn ssh_keygen(&self, path: &Path, comment: &str) -> Result<(), PlatformError> {
        self.inner.ssh_keygen(path, comment)
    }
    fn restrict_private_key(&self, path: &Path) -> Result<(), PlatformError> {
        self.inner.restrict_private_key(path)
    }
    fn open_url(&self, url: &str) -> Result<(), PlatformError> {
        if url.starts_with("claude:") {
            println!("visual stand: would open {url}");
            return Ok(());
        }
        self.inner.open_url(url)
    }
    fn open_in_file_manager(&self, path: &Path) -> Result<(), PlatformError> {
        self.inner.open_in_file_manager(path)
    }
    fn pick_folder(&self) -> Option<PathBuf> {
        self.inner.pick_folder()
    }
    fn ui_fonts(&self) -> Vec<FontFile> {
        self.inner.ui_fonts()
    }
    fn host_git_autocrlf(&self) -> HostAutocrlf {
        self.inner.host_git_autocrlf()
    }
    fn system_proxy(&self) -> ProxySettings {
        self.inner.system_proxy()
    }
    fn prepare_command(&self, cmd: &mut std::process::Command) {
        self.inner.prepare_command(cmd);
    }
    fn clipboard_set(&self, text: &str) -> Result<(), PlatformError> {
        self.inner.clipboard_set(text)
    }
    fn clipboard_get(&self) -> Option<String> {
        self.inner.clipboard_get()
    }
}

/// Prints `claude://` links instead of opening Claude Desktop.
struct PrintLauncher;

impl DesktopLauncher for PrintLauncher {
    fn open(&self, url: &str) {
        println!("visual stand: would open Claude Desktop at {url}");
    }
}

fn write(path: &Path, text: &str) {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("create fixture folder");
    }
    std::fs::write(path, text).expect("write fixture file");
}

/// The stand folder: `<repo>/tmp/agentbook-visual`.
fn stand_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .expect("the repo root above agentbook/crates/app")
        .join("tmp")
        .join("agentbook-visual")
}

fn config() -> EngineTestConfig {
    let mut test = EngineTestConfig::new(INSTANCE);
    test.desktop_launcher = Some(Arc::new(PrintLauncher));
    test
}

fn seed(platform: Arc<dyn Platform>, data: &Path, folders: &Path) {
    let q3 = folders.join("q3-analysis");
    write(
        &q3.join("reports").join(".claude").join("CLAUDE.md"),
        "# reports\n",
    );
    write(
        &q3.join("repo-a").join(".claude").join("CLAUDE.md"),
        "# repo-a\n",
    );
    write(
        &q3.join("repo-a").join(".git").join("HEAD"),
        "ref: refs/heads/feature/q3\n",
    );
    write(&q3.join("repo-a").join("README.md"), "repo a\n");
    write(
        &q3.join("repo-b").join(".git").join("HEAD"),
        "ref: refs/heads/main\n",
    );
    let portal = folders.join("Проект 東京");
    write(&portal.join("notes.md"), "Документ\n");
    let broken = folders.join("broken-build");
    write(
        &broken.join(".devcontainer").join("devcontainer.json"),
        "{ \"build\": { \"dockerfile\": \"Dockerfile\" } }\n",
    );
    write(
        &broken.join(".devcontainer").join("Dockerfile"),
        "FROM busybox:1.37\nRUN echo installing extra tools && apt-get install -y jqq\n",
    );
    let gone = folders.join("old-budget");
    write(&gone.join("budget.md"), "budget\n");

    let engine = Engine::new(platform, Some(data.to_path_buf()), Some(config()))
        .expect("start the seeding engine");
    for path in [&q3, &portal, &broken, &gone] {
        let id = engine.run(Command::AddFolder {
            path: path.to_string_lossy().into_owned(),
            config: None,
            confirm_broad: false,
        });
        let done = engine.wait(id, Duration::from_secs(60));
        println!(
            "visual stand: added {} → {:?}",
            path.display(),
            done.map(|a| a.state)
        );
    }
    drop(engine);
    // The folder that moved: its card shows "folder not found".
    std::fs::remove_file(gone.join("budget.md")).ok();
    std::fs::remove_dir(&gone).ok();
}

fn clean(platform: Arc<dyn Platform>, data: &Path) {
    let engine = Engine::new(platform.clone(), Some(data.to_path_buf()), Some(config()))
        .expect("start the engine");
    std::thread::sleep(Duration::from_secs(3));
    for f in engine.snapshot().folders {
        let id = engine.run(Command::RemoveFolder {
            folder: f.folder.id.clone(),
        });
        let done = engine.wait(id, Duration::from_secs(120));
        println!(
            "visual stand: removed {} → {:?}",
            f.folder.path,
            done.map(|a| a.state)
        );
    }
    let prefix = config().credential_prefix;
    for target in platform.credential_list(&prefix).unwrap_or_default() {
        let _ = platform.credential_delete(&target);
    }
}

fn main() {
    let stand = stand_dir();
    let home = stand.join("home");
    let data = stand.join("data");
    let folders = stand.join("folders");
    std::fs::create_dir_all(home.join(".ssh")).expect("create the stand home");
    let platform: Arc<dyn Platform> = Arc::new(StandPlatform {
        inner: agentbook_platform::native(),
        home,
        data: data.clone(),
    });
    if std::env::args().any(|a| a == "--clean") {
        clean(platform, &data);
        return;
    }
    if !data.join("state.json").is_file() {
        seed(platform.clone(), &data, &folders);
    }
    if let Err(e) = agentbook_app::run_with(platform, Some(data), Some(config())) {
        eprintln!("visual stand: {e}");
    }
}
