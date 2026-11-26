//! Host-exposure detection (FR-7): what in a devcontainer's merged config hands the container a
//! piece of the host. The tool shows a warning naming each finding and does not block.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-host-exposure.md`.

use serde_json::Value;

/// One finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exposure {
    /// A bind mount that is not read-only (other than the workspace); the host source path.
    WritableBind(String),
    /// The Docker socket is mounted (read-only or not); the mount's source.
    DockerSocket(String),
    /// `privileged`.
    Privileged,
    /// `--network host` / `--net host`.
    HostNetwork,
    /// `--pid host`.
    HostPid,
}

impl Exposure {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::WritableBind(_) => "writable-bind",
            Self::DockerSocket(_) => "docker-socket",
            Self::Privileged => "privileged",
            Self::HostNetwork => "host-network",
            Self::HostPid => "host-pid",
        }
    }

    pub fn source(&self) -> Option<&str> {
        match self {
            Self::WritableBind(s) | Self::DockerSocket(s) => Some(s),
            _ => None,
        }
    }
}

/// A mount in a normalised form.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MountSpec {
    pub kind: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

/// Splits a `--mount`-style string on commas outside double quotes (CSV, `""` = a quote).
fn csv_fields(s: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut cur)),
            other => cur.push(other),
        }
    }
    fields.push(cur);
    fields
}

/// Parses a devcontainer / `docker --mount` mount string
/// (`type=bind,source=…,target=…,readonly`). The type defaults to `volume`, as in Docker.
pub fn parse_mount_string(s: &str) -> MountSpec {
    let mut m = MountSpec {
        kind: "volume".to_string(),
        ..MountSpec::default()
    };
    for field in csv_fields(s) {
        let field = field.trim();
        let (key, value) = match field.split_once('=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), Some(v.trim())),
            None => (field.to_ascii_lowercase(), None),
        };
        match key.as_str() {
            "type" => m.kind = value.unwrap_or("").to_ascii_lowercase(),
            "source" | "src" => m.source = value.unwrap_or("").to_string(),
            "target" | "destination" | "dst" => m.target = value.unwrap_or("").to_string(),
            "readonly" | "ro" => {
                m.read_only = !matches!(
                    value.map(str::to_ascii_lowercase).as_deref(),
                    Some("false" | "0")
                );
            }
            _ => {}
        }
    }
    m
}

/// A mount from the merged config: a string, or an object `{type, source, target}`.
fn mount_from_value(v: &Value) -> Option<MountSpec> {
    match v {
        Value::String(s) => Some(parse_mount_string(s)),
        Value::Object(o) => {
            let field = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let kind = field("type");
            Some(MountSpec {
                kind: if kind.is_empty() {
                    "volume".to_string()
                } else {
                    kind.to_ascii_lowercase()
                },
                source: field("source"),
                target: field("target"),
                read_only: o.get("readonly").and_then(Value::as_bool).unwrap_or(false),
            })
        }
        _ => None,
    }
}

/// Parses a `-v` / `--volume` value `src:dst[:opts]`. A source with a path separator is a bind
/// mount, a bare name is a named volume. A Windows drive (`C:\…` or `C:/…`) stays in the source.
pub fn parse_volume_arg(s: &str) -> MountSpec {
    let b = s.as_bytes();
    let drive = b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/');
    let (src, rest) = {
        let from = if drive { 2 } else { 0 };
        match s[from..].find(':') {
            Some(i) => (&s[..from + i], &s[from + i + 1..]),
            None => (s, ""),
        }
    };
    let (target, opts) = rest.split_once(':').unwrap_or((rest, ""));
    let bind = src.contains('/') || src.contains('\\');
    MountSpec {
        kind: if bind { "bind" } else { "volume" }.to_string(),
        source: src.to_string(),
        target: target.to_string(),
        read_only: opts.split(',').any(|o| o == "ro" || o == "readonly"),
    }
}

fn is_docker_socket(path: &str) -> bool {
    let p = path.trim().trim_end_matches(['/', '\\']);
    p.rsplit(['/', '\\']).next() == Some("docker.sock") || p.ends_with("docker_engine")
}

fn mount_finding(m: &MountSpec, workspace_folder: Option<&str>) -> Option<Exposure> {
    if is_docker_socket(&m.source) || is_docker_socket(&m.target) {
        return Some(Exposure::DockerSocket(m.source.clone()));
    }
    let workspace = workspace_folder.is_some_and(|wf| !wf.is_empty() && wf == m.target);
    (m.kind == "bind" && !m.read_only && !workspace)
        .then(|| Exposure::WritableBind(m.source.clone()))
}

/// Detects host exposure in a merged devcontainer config (`mounts`, `runArgs`, `privileged`,
/// `workspaceFolder`). Findings are in config order (mounts, then `privileged`, then `runArgs`),
/// each reported once. The workspace mount itself (`workspaceMount`, or a mount whose target is
/// `workspaceFolder`) is the shared folder and is not a finding.
pub fn detect(merged: &Value) -> Vec<Exposure> {
    let workspace_folder = merged.get("workspaceFolder").and_then(Value::as_str);
    let mut out: Vec<Exposure> = Vec::new();
    let mut add = |e: Option<Exposure>| {
        if let Some(e) = e
            && !out.contains(&e)
        {
            out.push(e);
        }
    };

    if let Some(Value::Array(mounts)) = merged.get("mounts") {
        for m in mounts.iter().filter_map(mount_from_value) {
            add(mount_finding(&m, workspace_folder));
        }
    }
    if merged.get("privileged").and_then(Value::as_bool) == Some(true) {
        add(Some(Exposure::Privileged));
    }

    let args: Vec<&str> = match merged.get("runArgs") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let arg = args[i];
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with('-') => (f, Some(v)),
            _ => (arg, None),
        };
        let takes_value = matches!(
            flag,
            "--network" | "--net" | "--pid" | "-v" | "--volume" | "--mount"
        );
        let value = if takes_value && inline.is_none() {
            i += 1;
            args.get(i).copied()
        } else {
            inline
        };
        match (flag, value) {
            ("--privileged", v) if v.is_none_or(|v| v != "false") => {
                add(Some(Exposure::Privileged))
            }
            ("--network" | "--net", Some("host")) => add(Some(Exposure::HostNetwork)),
            ("--pid", Some("host")) => add(Some(Exposure::HostPid)),
            ("-v" | "--volume", Some(v)) => {
                add(mount_finding(&parse_volume_arg(v), workspace_folder))
            }
            ("--mount", Some(v)) => add(mount_finding(&parse_mount_string(v), workspace_folder)),
            _ => {}
        }
        i += 1;
    }
    out
}
