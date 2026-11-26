//! `TestPlatform`: the native platform with the home, `.ssh` and data folders redirected into
//! the stand's folder under the repo's `tmp/`, so a scenario run never touches the real
//! `~/.ssh` or `%LOCALAPPDATA%\AgentBook`. Everything else (Docker endpoint, OpenSSH, the
//! credential store, programs on PATH) is the real one.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use agentbook_platform::{
    DockerEndpoint, DockerEndpointError, FontFile, HostAutocrlf, OpensshVersion, Platform,
    PlatformError, ProxySettings,
};

pub struct TestPlatform {
    inner: Arc<dyn Platform>,
    home: PathBuf,
    data: PathBuf,
}

impl TestPlatform {
    pub fn new(inner: Arc<dyn Platform>, home: PathBuf, data: PathBuf) -> Self {
        Self { inner, home, data }
    }
}

impl Platform for TestPlatform {
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
        Err(PlatformError::Other(format!(
            "scenario stands never open URLs ({url}); the fake Desktop launcher records them"
        )))
    }

    fn open_in_file_manager(&self, _path: &Path) -> Result<(), PlatformError> {
        Ok(())
    }

    fn pick_folder(&self) -> Option<PathBuf> {
        None
    }

    fn ui_fonts(&self) -> Vec<FontFile> {
        Vec::new()
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
}
