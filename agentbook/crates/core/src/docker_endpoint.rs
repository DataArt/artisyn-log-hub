//! Docker endpoint resolution (FR-9). bollard's defaults ignore Docker contexts, so the engine
//! resolves the endpoint itself: `DOCKER_HOST`, then the current context, then the default pipe
//! or socket. Reading the files is the caller's job; this module only decides.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-docker-endpoint.md`.

use serde_json::Value;

use crate::equipment::sha256_hex;

/// The Windows default engine pipe.
pub const WINDOWS_DEFAULT_PIPE: &str = r"\\.\pipe\docker_engine";

/// The system-wide Unix socket (tried after the per-user one).
pub const UNIX_SYSTEM_SOCKET: &str = "/var/run/docker.sock";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointKind {
    /// A Windows named pipe; `address` is `\\.\pipe\<name>`.
    Pipe,
    /// A Unix socket; `address` is its path.
    Unix,
    /// TCP to this computer; `address` is the original URL.
    Tcp,
    /// A Docker engine inside a WSL distro, reached through `docker system dial-stdio` run in
    /// it; `address` is the distro name. The engine sees host folders under the distro's
    /// automount root (`/mnt/c/...`), see `paths::wsl_path`.
    Wsl,
}

impl EndpointKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pipe => "pipe",
            Self::Unix => "unix",
            Self::Tcp => "tcp",
            Self::Wsl => "wsl",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub kind: EndpointKind,
    pub address: String,
}

/// The resolved candidates, in the order to try them (more than one only for the macOS default).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    /// `DOCKER_HOST`, `context:<name>` or `default`.
    pub source: String,
    pub candidates: Vec<Endpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointError {
    /// `tcp://` to another host or `ssh://`: that engine cannot see this computer's folders
    /// ("AgentBook needs a Docker engine on this computer").
    NotLocal(String),
    /// A scheme the tool does not speak.
    Unsupported(String),
}

/// What the resolution reads.
#[derive(Debug, Clone, Default)]
pub struct EndpointInput<'a> {
    pub docker_host: Option<&'a str>,
    pub docker_context: Option<&'a str>,
    /// `~/.docker/config.json`, when it exists.
    pub config_json: Option<&'a str>,
    /// The user's home folder (for the per-user macOS socket).
    pub home: &'a str,
    pub windows: bool,
}

/// The folder of a context under `~/.docker/contexts/meta/`: sha256 of its name, lowercase hex.
pub fn context_dir_name(context: &str) -> String {
    sha256_hex(context.as_bytes())
}

fn is_local_host(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

/// Parses an endpoint URL (`npipe://`, `unix://`, `tcp://`, `http://`, `https://`, `ssh://`,
/// and AgentBook's own `wsl://<distro>` for a Docker engine inside that WSL distro).
pub fn parse_host(url: &str) -> Result<Endpoint, EndpointError> {
    let url = url.trim();
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| EndpointError::Unsupported(url.to_string()))?;
    match scheme.to_ascii_lowercase().as_str() {
        "npipe" => Ok(Endpoint {
            kind: EndpointKind::Pipe,
            address: rest.replace('/', "\\"),
        }),
        "unix" => Ok(Endpoint {
            kind: EndpointKind::Unix,
            address: rest.to_string(),
        }),
        "tcp" | "http" | "https" => {
            let authority = rest.split('/').next().unwrap_or("");
            let authority = authority.rsplit('@').next().unwrap_or(authority);
            let host = if authority.starts_with('[') {
                authority.split(']').next().unwrap_or("").to_string() + "]"
            } else {
                authority.split(':').next().unwrap_or("").to_string()
            };
            if is_local_host(&host) {
                Ok(Endpoint {
                    kind: EndpointKind::Tcp,
                    address: url.to_string(),
                })
            } else {
                Err(EndpointError::NotLocal(url.to_string()))
            }
        }
        "wsl" if !rest.trim_matches('/').is_empty() => Ok(Endpoint {
            kind: EndpointKind::Wsl,
            address: rest.trim_matches('/').to_string(),
        }),
        "ssh" => Err(EndpointError::NotLocal(url.to_string())),
        _ => Err(EndpointError::Unsupported(url.to_string())),
    }
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// Resolves the endpoint. `read_meta(dir)` returns the text of
/// `~/.docker/contexts/meta/<dir>/meta.json`, when it exists.
///
/// 1. `DOCKER_HOST`, when set and not blank.
/// 2. The context: `DOCKER_CONTEXT`, else `currentContext` of `config.json`; `default` means no
///    context. Its `meta.json` → `Endpoints.docker.Host`. A missing or unreadable meta falls
///    through to 3.
/// 3. The default: the Windows pipe, then a Docker engine inside any WSL distro (a `Wsl`
///    candidate with no distro); elsewhere `<home>/.docker/run/docker.sock` then
///    `/var/run/docker.sock`.
pub fn resolve(
    input: &EndpointInput<'_>,
    read_meta: impl Fn(&str) -> Option<String>,
) -> Result<Resolution, EndpointError> {
    if let Some(host) = non_empty(input.docker_host) {
        return Ok(Resolution {
            source: "DOCKER_HOST".into(),
            candidates: vec![parse_host(host)?],
        });
    }
    let from_config = input
        .config_json
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| {
            v.get("currentContext")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let context = non_empty(input.docker_context)
        .map(str::to_string)
        .or_else(|| non_empty(from_config.as_deref()).map(str::to_string));
    if let Some(name) = context.filter(|n| n != "default") {
        let host = read_meta(&context_dir_name(&name))
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| {
                v.pointer("/Endpoints/docker/Host")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        if let Some(host) = non_empty(host.as_deref()) {
            return Ok(Resolution {
                source: format!("context:{name}"),
                candidates: vec![parse_host(host)?],
            });
        }
    }
    let candidates = if input.windows {
        vec![
            Endpoint {
                kind: EndpointKind::Pipe,
                address: WINDOWS_DEFAULT_PIPE.into(),
            },
            // No distro named: the platform looks for a WSL distro running a Docker engine.
            Endpoint {
                kind: EndpointKind::Wsl,
                address: String::new(),
            },
        ]
    } else {
        vec![
            Endpoint {
                kind: EndpointKind::Unix,
                address: format!(
                    "{}/.docker/run/docker.sock",
                    input.home.trim_end_matches('/')
                ),
            },
            Endpoint {
                kind: EndpointKind::Unix,
                address: UNIX_SYSTEM_SOCKET.into(),
            },
        ]
    };
    Ok(Resolution {
        source: "default".into(),
        candidates,
    })
}
