//! Docker endpoint resolution with probing: reads the environment and the Docker config files,
//! lets `agentbook_core::docker_endpoint::resolve` decide (`DOCKER_HOST`, then the current
//! context, then the default pipe or socket) and probes the candidates with an OS-specific check.
//! Every step is recorded in `probed`, so the prerequisites screen can say what was looked at.

use std::cell::RefCell;
use std::fmt;
use std::path::PathBuf;

use agentbook_core::docker_endpoint::{
    Endpoint, EndpointError, EndpointInput, EndpointKind, resolve,
};

/// The resolved and reachable endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerEndpoint {
    pub kind: EndpointKind,
    /// A pipe path (`\\.\pipe\docker_engine`), a socket path or a `tcp://` URL.
    pub address: String,
    /// `DOCKER_HOST`, `context:<name>` or `default`.
    pub source: String,
    /// What was read and probed, in order.
    pub probed: Vec<String>,
    /// For a `wsl` endpoint: the distro's automount root (`/mnt/`), under which the engine sees
    /// this computer's drives.
    pub wsl_mount_root: Option<String>,
}

/// What a successful probe learned about a candidate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probed {
    /// The address to use instead of the candidate's (a `wsl` candidate with no distro names the
    /// distro found).
    pub address: Option<String>,
    /// The WSL automount root, for a `wsl` endpoint.
    pub wsl_mount_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockerEndpointError {
    /// The endpoint is on another computer (or `ssh://`), so it cannot see this computer's folders.
    NotLocal { url: String, probed: Vec<String> },
    /// The endpoint uses a scheme AgentBook does not speak.
    Unsupported { url: String, probed: Vec<String> },
    /// No candidate answered: Docker is not installed or not running.
    NotRunning { probed: Vec<String> },
}

impl DockerEndpointError {
    pub fn probed(&self) -> &[String] {
        match self {
            Self::NotLocal { probed, .. }
            | Self::Unsupported { probed, .. }
            | Self::NotRunning { probed } => probed,
        }
    }
}

impl fmt::Display for DockerEndpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotLocal { url, .. } => write!(
                f,
                "AgentBook needs a Docker engine on this computer (Docker is set to {url})"
            ),
            Self::Unsupported { url, .. } => {
                write!(f, "AgentBook cannot talk to the Docker engine at {url}")
            }
            Self::NotRunning { .. } => f.write_str("Docker is not running on this computer"),
        }
    }
}

impl std::error::Error for DockerEndpointError {}

/// What the resolution reads from the environment.
#[derive(Debug, Clone, Default)]
pub struct DockerEnv {
    /// `DOCKER_HOST`.
    pub docker_host: Option<String>,
    /// `DOCKER_CONTEXT`.
    pub docker_context: Option<String>,
    /// The Docker config folder: `DOCKER_CONFIG`, else `<home>/.docker`.
    pub config_dir: PathBuf,
    /// The user's home folder.
    pub home: String,
    pub windows: bool,
}

fn non_blank(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

fn describe(e: &Endpoint) -> String {
    format!("{} {}", e.kind.as_str(), e.address)
}

/// Resolves the endpoint and returns the first candidate `probe` accepts (`Err` carries why a
/// candidate was rejected).
pub fn resolve_docker_endpoint(
    env: &DockerEnv,
    probe: impl Fn(&Endpoint) -> Result<Probed, String>,
) -> Result<DockerEndpoint, DockerEndpointError> {
    let mut probed = Vec::new();
    match non_blank(env.docker_host.as_deref()) {
        Some(host) => probed.push(format!("DOCKER_HOST={host}")),
        None => probed.push("DOCKER_HOST is not set".into()),
    }
    let config_path = env.config_dir.join("config.json");
    let config_json = std::fs::read_to_string(&config_path).ok();
    match non_blank(env.docker_context.as_deref()) {
        Some(context) => probed.push(format!("DOCKER_CONTEXT={context}")),
        None => probed.push(match &config_json {
            Some(_) => format!("read {}", config_path.display()),
            None => format!("{} not found", config_path.display()),
        }),
    }
    let input = EndpointInput {
        docker_host: env.docker_host.as_deref(),
        docker_context: env.docker_context.as_deref(),
        config_json: config_json.as_deref(),
        home: &env.home,
        windows: env.windows,
    };
    let metas = RefCell::new(Vec::new());
    let result = resolve(&input, |dir| {
        let path = env
            .config_dir
            .join("contexts")
            .join("meta")
            .join(dir)
            .join("meta.json");
        let text = std::fs::read_to_string(&path).ok();
        metas.borrow_mut().push(format!(
            "{} {}",
            path.display(),
            if text.is_some() { "read" } else { "not found" }
        ));
        text
    });
    probed.extend(metas.into_inner());
    let resolution = match result {
        Ok(r) => r,
        Err(EndpointError::NotLocal(url)) => {
            probed.push(format!("{url} is not on this computer"));
            return Err(DockerEndpointError::NotLocal { url, probed });
        }
        Err(EndpointError::Unsupported(url)) => {
            probed.push(format!("{url} is not a supported endpoint"));
            return Err(DockerEndpointError::Unsupported { url, probed });
        }
    };
    probed.push(format!("using {}", resolution.source));
    for candidate in resolution.candidates {
        match probe(&candidate) {
            Ok(found) => {
                let address = found.address.unwrap_or(candidate.address);
                let endpoint = Endpoint {
                    kind: candidate.kind,
                    address,
                };
                probed.push(format!("{}: answers", describe(&endpoint)));
                return Ok(DockerEndpoint {
                    kind: endpoint.kind,
                    address: endpoint.address,
                    source: resolution.source,
                    probed,
                    wsl_mount_root: found.wsl_mount_root,
                });
            }
            Err(why) => probed.push(format!("{}: {why}", describe(&candidate))),
        }
    }
    Err(DockerEndpointError::NotRunning { probed })
}

/// `host:port` of a `tcp://`, `http://` or `https://` URL (port 2375 when missing), for a
/// connection probe.
pub fn tcp_authority(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let authority = rest.split('/').next()?;
    let authority = authority.rsplit('@').next()?;
    if authority.is_empty() {
        return None;
    }
    let has_port = if authority.starts_with('[') {
        authority.contains("]:")
    } else {
        authority.contains(':')
    };
    if has_port {
        Some(authority.to_string())
    } else {
        let port = if scheme.eq_ignore_ascii_case("https") {
            2376
        } else {
            2375
        };
        Some(format!("{authority}:{port}"))
    }
}
