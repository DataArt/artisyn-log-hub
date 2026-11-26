//! Override-config generation (FR-7): the `--override-config` file the devcontainer CLI's `up`
//! gets for a project-Equipment laptop, and for compose configs the extra tool compose file.
//!
//! The layered image's `devcontainer.metadata` label already carries the project's lifecycle
//! commands, `containerEnv`/`remoteEnv`, users, features, mounts and the other image-metadata
//! keys, so the override holds only what the label lacks plus the tool's own run arguments and
//! mounts. Repeating a label-carried key runs `postCreateCommand` twice (PoC).
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-override-config.md`.

use serde_json::{Map, Value, json};

use crate::paths::shared_container_path;

/// In-container mount points of the tool's read-only mounts.
pub const KEY_MOUNT: &str = "/opt/agentbook/key";
pub const BIN_MOUNT: &str = "/opt/agentbook/bin";
pub const STATE_MOUNT: &str = "/opt/agentbook/state";
/// The tmpfs holding `base.env`, the key copies and the session env file.
pub const RUN_TMPFS: &str = "/run/agentbook";

/// Name of a laptop's home volume.
pub fn home_volume(laptop_id: &str) -> String {
    format!("agentbook-home-{laptop_id}")
}

/// Compose project name of a compose laptop (stable across Update, so sidecar volumes survive).
pub fn compose_project(laptop_id: &str) -> String {
    format!("agentbook-{laptop_id}")
}

/// A given folder mount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GivenMount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

/// What the tool adds to every laptop container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRun {
    pub laptop_id: String,
    /// The layered image (`agentbook-laptop:…`).
    pub image: String,
    /// Host path of the shared folder.
    pub shared_host_path: String,
    /// Host folder of the selected devcontainer config; relative compose files resolve against it.
    pub config_dir: String,
    pub port: u16,
    /// The SSH user's home folder (the home volume's mount point).
    pub home: String,
    /// Host folders of the key, tool-bin and per-folder state mounts.
    pub key_dir: String,
    pub bin_dir: String,
    pub state_dir: String,
    pub given: Vec<GivenMount>,
    /// Container labels, in order.
    pub labels: Vec<(String, String)>,
    /// Host path the tool compose file is written to (compose configs only).
    pub compose_file: String,
}

/// The generated files.
#[derive(Debug, Clone, PartialEq)]
pub struct Override {
    /// The override `devcontainer.json`.
    pub config: Value,
    /// The tool compose file (`agentbook-compose.yml`, written as JSON, which is valid YAML), for
    /// compose configs.
    pub compose: Option<Value>,
    /// The shared folder's path in the container (Claude's start folder is below it).
    pub workspace_folder: String,
    /// `COMPOSE_PROJECT_NAME` for the CLI, for compose configs.
    pub compose_project: Option<String>,
}

/// One `--mount` field, CSV-quoted when it holds a comma or a double quote.
fn csv_field(field: String) -> String {
    if field.contains(',') || field.contains('"') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field
    }
}

/// A devcontainer mount string: `source=…,target=…,type=<kind>[,readonly]`.
pub fn mount_string(kind: &str, source: &str, target: &str, read_only: bool) -> String {
    let mut fields = vec![
        csv_field(format!("source={source}")),
        csv_field(format!("target={target}")),
        format!("type={kind}"),
    ];
    if read_only {
        fields.push("readonly".to_string());
    }
    fields.join(",")
}

fn non_empty_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The `target=` of a mount string, if any.
fn mount_target(mount: &str) -> Option<String> {
    let target = crate::host_exposure::parse_mount_string(mount).target;
    let target = target.trim();
    (!target.is_empty()).then(|| target.to_string())
}

fn is_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with('/')
        || path.starts_with('\\')
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// Joins a compose file path from the config onto the config folder, unless it is absolute.
fn resolve_against(dir: &str, file: &str) -> String {
    if is_absolute(file) {
        return file.to_string();
    }
    let sep = if dir.contains('\\') { '\\' } else { '/' };
    let file = if sep == '\\' {
        file.replace('/', "\\")
    } else {
        file.to_string()
    };
    format!("{}{sep}{file}", dir.trim_end_matches(['/', '\\']))
}

/// The tool's mounts, in order: home volume, key, bin, state (read-only), then the given folders.
fn tool_mounts(run: &ToolRun) -> Vec<(String, String, String, bool)> {
    let mut m = vec![
        (
            "volume".to_string(),
            home_volume(&run.laptop_id),
            run.home.clone(),
            false,
        ),
        (
            "bind".to_string(),
            run.key_dir.clone(),
            KEY_MOUNT.to_string(),
            true,
        ),
        (
            "bind".to_string(),
            run.bin_dir.clone(),
            BIN_MOUNT.to_string(),
            true,
        ),
        (
            "bind".to_string(),
            run.state_dir.clone(),
            STATE_MOUNT.to_string(),
            true,
        ),
    ];
    for g in &run.given {
        m.push((
            "bind".to_string(),
            g.source.clone(),
            g.target.clone(),
            g.read_only,
        ));
    }
    m
}

/// Generates the override config from the merged devcontainer configuration.
///
/// Image / Dockerfile configs: `name` (when set), `image` = the layered image, `workspaceMount` /
/// `workspaceFolder` (rules in the doc), `runArgs` = the project's + `-p 127.0.0.1:<port>:22`,
/// `--tmpfs /run/agentbook`, one `--label k=v` per label; `mounts` = the tool's only.
///
/// Compose configs: `name`, `dockerComposeFile` = the project's files (resolved against the
/// config folder) + the tool compose file, `service`, `runServices` (when set) and
/// `workspaceFolder`; the tool compose file sets the primary service's image, port, tmpfs,
/// labels and volumes, with the home volume declared `external` (the engine creates it labelled).
pub fn generate(merged: &Value, run: &ToolRun) -> Override {
    let mut config = Map::new();
    if let Some(name) = merged.get("name").filter(|v| v.is_string()) {
        config.insert("name".into(), name.clone());
    }

    if merged.get("dockerComposeFile").is_some() {
        return generate_compose(merged, run, config);
    }

    config.insert("image".into(), json!(run.image));
    let project_wf = non_empty_str(merged, "workspaceFolder");
    let workspace_folder = match non_empty_str(merged, "workspaceMount") {
        Some(wm) => {
            config.insert("workspaceMount".into(), json!(wm));
            project_wf
                .map(str::to_string)
                .or_else(|| mount_target(wm))
                .unwrap_or_else(|| shared_container_path(&run.shared_host_path, None))
        }
        None => {
            let target = shared_container_path(&run.shared_host_path, project_wf);
            config.insert(
                "workspaceMount".into(),
                json!(mount_string("bind", &run.shared_host_path, &target, false)),
            );
            target
        }
    };
    config.insert("workspaceFolder".into(), json!(workspace_folder));

    let mut run_args: Vec<Value> = match merged.get("runArgs") {
        Some(Value::Array(a)) => a.iter().filter(|v| v.is_string()).cloned().collect(),
        _ => Vec::new(),
    };
    run_args.extend([
        json!("-p"),
        json!(format!("127.0.0.1:{}:22", run.port)),
        json!("--tmpfs"),
        json!(RUN_TMPFS),
    ]);
    for (k, v) in &run.labels {
        run_args.push(json!("--label"));
        run_args.push(json!(format!("{k}={v}")));
    }
    config.insert("runArgs".into(), Value::Array(run_args));

    let mounts: Vec<Value> = tool_mounts(run)
        .into_iter()
        .map(|(kind, s, t, ro)| json!(mount_string(&kind, &s, &t, ro)))
        .collect();
    config.insert("mounts".into(), Value::Array(mounts));

    Override {
        config: Value::Object(config),
        compose: None,
        workspace_folder,
        compose_project: None,
    }
}

fn generate_compose(merged: &Value, run: &ToolRun, mut config: Map<String, Value>) -> Override {
    let project_files: Vec<String> = match merged.get("dockerComposeFile") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    let mut files: Vec<Value> = project_files
        .iter()
        .map(|f| json!(resolve_against(&run.config_dir, f)))
        .collect();
    files.push(json!(run.compose_file));
    config.insert("dockerComposeFile".into(), Value::Array(files));

    let service = non_empty_str(merged, "service").unwrap_or("").to_string();
    config.insert("service".into(), json!(service));
    if let Some(rs) = merged.get("runServices").filter(|v| v.is_array()) {
        config.insert("runServices".into(), rs.clone());
    }

    let mut volumes: Vec<Value> = tool_mounts(run)
        .into_iter()
        .map(|(kind, source, target, ro)| {
            let mut v = json!({"type": kind, "source": source, "target": target});
            if ro {
                v["read_only"] = json!(true);
            }
            v
        })
        .collect();
    // The project's compose file mounts its own workspace when it names a workspaceFolder;
    // otherwise the tool mounts the shared folder at /work/<name>.
    let workspace_folder = match non_empty_str(merged, "workspaceFolder") {
        Some(wf) => wf.to_string(),
        None => {
            let target = shared_container_path(&run.shared_host_path, None);
            volumes.push(json!({"type": "bind", "source": run.shared_host_path, "target": target}));
            target
        }
    };
    config.insert("workspaceFolder".into(), json!(workspace_folder));

    let labels: Map<String, Value> = run
        .labels
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    let volume = home_volume(&run.laptop_id);
    let mut service_def = Map::new();
    service_def.insert("image".into(), json!(run.image));
    service_def.insert(
        "ports".into(),
        json!([format!("127.0.0.1:{}:22", run.port)]),
    );
    service_def.insert("tmpfs".into(), json!([RUN_TMPFS]));
    service_def.insert("labels".into(), Value::Object(labels));
    service_def.insert("volumes".into(), Value::Array(volumes));
    let mut services = Map::new();
    services.insert(service, Value::Object(service_def));
    let mut volume_defs = Map::new();
    volume_defs.insert(volume.clone(), json!({"name": volume, "external": true}));
    let compose = json!({"services": services, "volumes": volume_defs});

    Override {
        config: Value::Object(config),
        compose: Some(compose),
        workspace_folder,
        compose_project: Some(compose_project(&run.laptop_id)),
    }
}
