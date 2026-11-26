//! The Equipment pipeline (FR-7, verified in PoC `2026-11-25-2146-devcontainer-laptop-layer`).
//!
//! - **Project Equipment:** `devcontainer build` builds the project's image
//!   (`agentbook-eq:<confighash>`, cached by the config hash); the laptop layer is built on top
//!   through the engine with the layer entrypoint appended to the `devcontainer.metadata` label
//!   (`agentbook-laptop:<basehash>-<layerv>`); `devcontainer up --override-config` runs it with
//!   only the keys the label lacks plus the tool's run args and mounts. Compose configs get one
//!   tool compose file and the per-laptop `COMPOSE_PROJECT_NAME`.
//! - **Standard Equipment:** the layer on `agentbook-std:<v>`, the container created through the
//!   API with the same run args, mounts and labels.
//!
//! Every container is a *generation* (`artisyn.agentbook.gen`). Update laptop and the
//! recreate-type actions create the next generation and drop the old one only after it started;
//! on failure the old one is started again (compose: `up` again with the previous generation's
//! override config, kept in `laptops/<id>/gen/<n>/`). The home volume is always kept.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agentbook_core::equipment::{clears_ccd_cli, config_hash, sha256_hex};
use agentbook_core::host_exposure::{self, Exposure};
use agentbook_core::override_config::{self, GivenMount, ToolRun, home_volume};
use agentbook_core::paths::{given_container_paths, shared_container_path, strip_verbatim};
use agentbook_core::ssh_user::{self, SshUser};
use agentbook_core::state::{EquipmentKind, Folder, Laptop, Libc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::action::Action;
use crate::assets::{layer, standard};
use crate::devcontainer::DevcontainerCli;
use crate::docker::containers::{self, RunSpec};
use crate::docker::{Docker, images, label_filter, volumes};
use crate::engine::{Ctx, EngineError, EngineResult, INSTANCE_LABEL};
use crate::snapshot::{ExposureView, FolderEquipment};

pub const LABEL_ROOT: &str = "artisyn.agentbook";
pub const LABEL_LAPTOP: &str = "artisyn.agentbook.laptop";
pub const LABEL_FOLDER: &str = "artisyn.agentbook.folder";
pub const LABEL_GEN: &str = "artisyn.agentbook.gen";
/// The label docker compose puts on every container, volume and network of a project.
pub const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";

/// The plain message when the standard Equipment image is missing.
pub const STANDARD_MISSING_MESSAGE: &str = "The standard Equipment is not ready yet. Download \
     the dependencies (Retry on the first-launch screen) and try again.";

const STEPS: u32 = 4;
const EXEC_TIMEOUT: Duration = Duration::from_secs(60);

/// A project's selected devcontainer config, read through the CLI.
#[derive(Debug, Clone)]
pub(crate) struct Project {
    pub config_abs: PathBuf,
    pub config_dir: PathBuf,
    pub merged: Value,
}

impl Project {
    pub fn compose(&self) -> bool {
        self.merged.get("dockerComposeFile").is_some()
    }
}

/// A folder's Equipment as of now.
#[derive(Debug, Clone)]
pub(crate) struct Prepared {
    pub folder: Folder,
    pub project: Option<Project>,
    pub hash: String,
    pub exposures: Vec<Exposure>,
    pub ssh_user: SshUser,
    /// The project's variable defaults (`containerEnv`, then `remoteEnv`).
    pub defaults: Vec<(String, String)>,
    /// The devcontainer's `forwardPorts` (the default forwarded ports of its laptops).
    pub forward_ports: Vec<u16>,
}

/// One generation's record (`laptops/<id>/gen/<n>/meta.json`): what the container was created
/// from, so a recreate or a rollback reuses the same images and config.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct GenMeta {
    pub generation: u64,
    /// The layered image (`agentbook-laptop:…`).
    pub image: String,
    /// The project image under the layer (`agentbook-eq:…`), for project Equipment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eq_image: Option<String>,
    pub equipment_hash: String,
    pub libc: String,
    pub ssh_user: String,
    pub home: String,
    pub project: bool,
    pub compose: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One generation's record plus its merged config (project Equipment).
#[derive(Debug, Clone)]
pub(crate) struct Generation {
    pub meta: GenMeta,
    pub merged: Option<Value>,
}

/// A host path as Docker and the CLI get it (no Windows verbatim prefix).
pub(crate) fn path_str(p: &Path) -> String {
    strip_verbatim(&p.to_string_lossy())
}

/// The folder and laptop records from the state.
pub(crate) fn find_laptop(ctx: &Ctx, laptop_id: &str) -> EngineResult<(Folder, Laptop)> {
    let state = ctx.state();
    let laptop = state
        .laptops
        .iter()
        .find(|l| l.id == laptop_id)
        .cloned()
        .ok_or_else(|| EngineError(format!("There is no laptop {laptop_id}.")))?;
    let folder = state
        .folders
        .iter()
        .find(|f| f.id == laptop.folder_id)
        .cloned()
        .ok_or_else(|| EngineError(format!("The laptop {laptop_id} has no shared folder.")))?;
    Ok((folder, laptop))
}

// ---------------------------------------------------------------------------------------------
// Prepare: config hash, host exposure, SSH user
// ---------------------------------------------------------------------------------------------

/// Paths in a config value: a string or an array of strings.
fn string_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// The Equipment source files: the selected config, every file in its folder, and the
/// Dockerfile and compose files it references, as (path relative to the shared folder, bytes).
fn source_files(shared: &Path, project: &Project, configuration: &Value) -> Vec<(String, Vec<u8>)> {
    let mut paths: Vec<PathBuf> = vec![project.config_abs.clone()];
    if let Ok(entries) = std::fs::read_dir(&project.config_dir) {
        for e in entries.flatten() {
            if e.file_type().is_ok_and(|t| t.is_file()) {
                paths.push(e.path());
            }
        }
    }
    let build = configuration.get("build");
    for dockerfile in [
        build.and_then(|b| b.get("dockerfile")),
        build.and_then(|b| b.get("dockerFile")),
        configuration.get("dockerFile"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    {
        paths.push(project.config_dir.join(dockerfile));
    }
    for compose in string_list(configuration.get("dockerComposeFile")) {
        paths.push(project.config_dir.join(compose));
    }
    paths
        .into_iter()
        .filter_map(|p| {
            let bytes = std::fs::read(&p).ok()?;
            let rel = p
                .strip_prefix(shared)
                .map(|r| r.to_path_buf())
                .unwrap_or_else(|_| p.clone());
            Some((path_str(&rel).replace('\\', "/"), bytes))
        })
        .collect()
}

/// Reads a folder's Equipment: the config hash, the host-exposure findings and the SSH user.
/// Project Equipment needs the devcontainer tools (`read-configuration`).
pub(crate) async fn prepare(
    ctx: &Arc<Ctx>,
    folder: &Folder,
    action: Option<&Action>,
) -> EngineResult<Prepared> {
    match &folder.equipment.kind {
        EquipmentKind::Standard => Ok(Prepared {
            folder: folder.clone(),
            project: None,
            hash: config_hash(&[], &standard::version(), &layer::version()),
            exposures: Vec::new(),
            ssh_user: ssh_user::resolve(None, None),
            defaults: Vec::new(),
            forward_ports: Vec::new(),
        }),
        EquipmentKind::Project => {
            let rel = folder.equipment.config.as_deref().ok_or_else(|| {
                EngineError("The folder's devcontainer config is not set.".into())
            })?;
            let shared = PathBuf::from(&folder.path);
            let config_abs = shared.join(rel);
            if !config_abs.is_file() {
                return Err(EngineError(format!(
                    "The devcontainer config {} was not found.",
                    config_abs.display()
                )));
            }
            let config_dir = config_abs
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| shared.clone());
            let cli = DevcontainerCli::locate(ctx).await?;
            let rc = cli
                .read_configuration(&folder.path, &config_abs, action)
                .await?;
            let project = Project {
                config_abs,
                config_dir,
                merged: rc.merged.clone(),
            };
            let files = source_files(&shared, &project, &rc.configuration);
            let hash = config_hash(&files, &standard::version(), &layer::version());
            let get = |k: &str| rc.merged.get(k).and_then(Value::as_str).map(str::to_string);
            let ssh_user = ssh_user::resolve(
                get("remoteUser").as_deref(),
                get("containerUser").as_deref(),
            );
            Ok(Prepared {
                folder: folder.clone(),
                exposures: host_exposure::detect(&rc.merged),
                defaults: crate::vars::project_defaults(&rc.merged),
                forward_ports: agentbook_core::ports::devcontainer_ports(&rc.merged),
                project: Some(project),
                hash,
                ssh_user,
            })
        }
        EquipmentKind::Other(kind) => Err(EngineError(format!(
            "This folder uses Equipment \"{kind}\" from a newer AgentBook. Update AgentBook."
        ))),
    }
}

fn folder_equipment(result: &EngineResult<Prepared>) -> FolderEquipment {
    match result {
        Ok(p) => FolderEquipment {
            hash: Some(p.hash.clone()),
            exposures: p
                .exposures
                .iter()
                .map(ExposureView::from_exposure)
                .collect(),
            error: None,
            defaults: p.defaults.clone(),
            forward_ports: p.forward_ports.clone(),
        },
        Err(e) => FolderEquipment {
            hash: None,
            exposures: Vec::new(),
            error: Some(e.0.clone()),
            defaults: Vec::new(),
            forward_ports: Vec::new(),
        },
    }
}

fn record_check(ctx: &Ctx, folder_id: &str, equipment: FolderEquipment) {
    ctx.update_snapshot(|s| {
        if let Some(f) = s.folders.iter_mut().find(|f| f.folder.id == folder_id) {
            f.equipment = equipment;
        }
    });
    ctx.refresh_views();
}

/// Equipment changed and host exposure (FR-7), at start and before every Open: recomputes each
/// folder's hash (one folder when `only` is set) and the laptops' Equipment state.
pub(crate) async fn check_all(ctx: &Arc<Ctx>, only: Option<&str>) {
    let state = ctx.state();
    for folder in state
        .folders
        .iter()
        .filter(|f| only.is_none_or(|o| o == f.id))
    {
        let result = prepare(ctx, folder, None).await;
        record_check(ctx, &folder.id, folder_equipment(&result));
    }
}

// ---------------------------------------------------------------------------------------------
// Build: project image (or the standard one), laptop layer, libc
// ---------------------------------------------------------------------------------------------

/// What [`build`] produced.
#[derive(Debug, Clone)]
pub(crate) struct Built {
    pub image: String,
    pub eq_image: Option<String>,
    pub libc: Libc,
}

/// The base image's `devcontainer.metadata` array plus the layer's entrypoint entry.
fn metadata_with_entry(base: Option<&String>) -> String {
    let entry: Value = serde_json::from_str(layer::METADATA_ENTRY).unwrap_or(Value::Null);
    let mut items = match base.and_then(|s| serde_json::from_str::<Value>(s).ok()) {
        Some(Value::Array(a)) => a,
        Some(obj @ Value::Object(_)) => vec![obj],
        _ => Vec::new(),
    };
    items.push(entry);
    Value::Array(items).to_string()
}

async fn build(ctx: &Arc<Ctx>, prepared: &Prepared, action: &Action) -> EngineResult<Built> {
    let docker = ctx.docker().await?;
    let (base, eq_image) = match &prepared.project {
        None => {
            action.step(2, STEPS, "Getting the standard Equipment");
            let tag = standard::image_tag();
            if !images::exists(&docker, &tag).await? {
                return Err(EngineError(STANDARD_MISSING_MESSAGE.to_string()));
            }
            action.line(&format!("using {tag}"));
            (tag, None)
        }
        Some(project) => {
            action.step(2, STEPS, "Getting the project's Equipment");
            let eq = format!("agentbook-eq:{}", prepared.hash);
            if images::exists(&docker, &eq).await? {
                action.line(&format!("Using the cached Equipment {eq}"));
            } else {
                let cli = DevcontainerCli::locate(ctx).await?;
                // The CLI does not put --label on every kind of build, so it builds under a
                // temporary tag and the tool adds its labels in a one-line build on top.
                let tmp = format!("agentbook-eq-build:{}", prepared.hash);
                let result = cli
                    .build(
                        &prepared.folder.path,
                        &project.config_abs,
                        &tmp,
                        &ctx.base_labels(),
                        action,
                    )
                    .await?;
                let source = if images::exists(&docker, &tmp).await? {
                    tmp.clone()
                } else {
                    // A compose service without a build section: the CLI names its image.
                    string_list(result.get("imageName"))
                        .into_iter()
                        .next()
                        .ok_or_else(|| {
                            EngineError("The devcontainer build did not produce an image.".into())
                        })?
                };
                let context = images::context_tar(&[(
                    "Dockerfile".to_string(),
                    format!("FROM {source}\n").into_bytes(),
                    0o644,
                )])?;
                let labelled = images::build(
                    &docker,
                    images::BuildSpec {
                        tag: eq.clone(),
                        context,
                        build_args: Vec::new(),
                        labels: ctx.base_labels().into_iter().collect(),
                    },
                    |line| action.line(line),
                )
                .await;
                let _ = images::remove_tag(&docker, &tmp).await;
                labelled?;
            }
            (eq.clone(), Some(eq))
        }
    };

    action.step(3, STEPS, "Adding the laptop layer");
    let info = images::inspect(&docker, &base)
        .await?
        .ok_or_else(|| EngineError(format!("The image {base} is missing.")))?;
    let user_arg = if prepared.ssh_user.create {
        String::new()
    } else {
        prepared.ssh_user.user.clone()
    };
    let base_hash = sha256_hex(format!("{}\n{user_arg}", info.id).as_bytes());
    let tag = format!("agentbook-laptop:{}-{}", &base_hash[..16], layer::version());
    if images::exists(&docker, &tag).await? {
        action.line(&format!("Using the cached laptop layer {tag}"));
    } else {
        let context = images::context_tar(
            &layer::CONTEXT
                .iter()
                .map(|a| (a.name.to_string(), a.bytes(), a.mode()))
                .collect::<Vec<_>>(),
        )?;
        let mut args = vec![
            (layer::ARG_BASE.to_string(), base.clone()),
            (layer::ARG_SSH_USER.to_string(), user_arg),
        ];
        args.extend(ctx.platform.system_proxy().build_args());
        let mut labels: HashMap<String, String> = ctx.base_labels().into_iter().collect();
        labels.insert(
            "devcontainer.metadata".to_string(),
            metadata_with_entry(info.labels.get("devcontainer.metadata")),
        );
        let mut log = String::new();
        let built = images::build(
            &docker,
            images::BuildSpec {
                tag: tag.clone(),
                context,
                build_args: args,
                labels,
            },
            |line| {
                action.line(line);
                if log.len() < 1 << 20 {
                    log.push_str(line);
                    log.push('\n');
                }
            },
        )
        .await;
        if let Err(e) = built {
            if layer::is_unsupported_base(&log) {
                return Err(EngineError(layer::UNSUPPORTED_MESSAGE.to_string()));
            }
            return Err(EngineError(format!(
                "Adding the laptop layer failed ({}). See the log and press Retry.",
                e.plain_message()
            )));
        }
    }
    let files = containers::read_image_files(
        &docker,
        &tag,
        ctx.base_labels().into_iter().collect(),
        &[layer::LIBC_FILE],
    )
    .await?;
    let libc_text = files
        .into_iter()
        .next()
        .flatten()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .unwrap_or_default();
    action.line(&format!("libc: {libc_text}"));
    Ok(Built {
        image: tag,
        eq_image,
        libc: Libc::parse(&libc_text),
    })
}

// ---------------------------------------------------------------------------------------------
// Generations: records on disk, launch, replace
// ---------------------------------------------------------------------------------------------

fn write_generation(ctx: &Ctx, laptop_id: &str, generation: &Generation) -> EngineResult<()> {
    let dir = ctx.layout.gen_dir(laptop_id, generation.meta.generation);
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        let meta = serde_json::to_string_pretty(&generation.meta).map_err(std::io::Error::other)?;
        std::fs::write(dir.join("meta.json"), meta)?;
        if let Some(merged) = &generation.merged {
            let text = serde_json::to_string_pretty(merged).map_err(std::io::Error::other)?;
            std::fs::write(dir.join("merged.json"), text)?;
        }
        Ok(())
    };
    write().map_err(|e| EngineError(format!("cannot write {}: {e}", dir.display())))
}

pub(crate) fn read_generation(ctx: &Ctx, laptop_id: &str, generation: u64) -> Option<Generation> {
    if generation == 0 {
        return None;
    }
    let dir = ctx.layout.gen_dir(laptop_id, generation);
    let meta: GenMeta =
        serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).ok()?).ok()?;
    let merged = std::fs::read_to_string(dir.join("merged.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    Some(Generation { meta, merged })
}

/// Keeps only the record folders of `keep`.
fn prune_generations(ctx: &Ctx, laptop_id: &str, keep: &[u64]) {
    let root = ctx.layout.laptop_dir(laptop_id).join("gen");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Ok(n) = name.parse::<u64>()
            && !keep.contains(&n)
        {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn laptop_labels(ctx: &Ctx, laptop: &Laptop, generation: u64) -> Vec<(String, String)> {
    let mut labels = vec![
        (LABEL_ROOT.to_string(), "1".to_string()),
        (LABEL_LAPTOP.to_string(), laptop.id.clone()),
        (LABEL_FOLDER.to_string(), laptop.folder_id.clone()),
        (LABEL_GEN.to_string(), generation.to_string()),
    ];
    if let Some(instance) = ctx.instance() {
        labels.push((INSTANCE_LABEL.to_string(), instance.to_string()));
    }
    labels
}

/// The labels `devcontainer up` finds the generation's container by.
fn id_labels(ctx: &Ctx, laptop: &Laptop, generation: u64) -> Vec<(String, String)> {
    let mut labels = vec![
        (LABEL_LAPTOP.to_string(), laptop.id.clone()),
        (LABEL_GEN.to_string(), generation.to_string()),
    ];
    if let Some(instance) = ctx.instance() {
        labels.push((INSTANCE_LABEL.to_string(), instance.to_string()));
    }
    labels
}

/// The laptop's containers (every generation), found by label only.
pub(crate) async fn laptop_containers(
    docker: &Docker,
    laptop_id: &str,
) -> EngineResult<Vec<containers::ContainerListItem>> {
    Ok(containers::list_by_labels(docker, &label_filter(&[(LABEL_LAPTOP, laptop_id)])).await?)
}

/// Creates and starts one generation's container.
async fn launch(
    ctx: &Arc<Ctx>,
    folder: &Folder,
    laptop: &Laptop,
    generation: &Generation,
    action: &Action,
) -> EngineResult<()> {
    let (docker, endpoint) = ctx.docker_with_endpoint().await?;
    let meta = &generation.meta;
    let key_dir = ctx.layout.key_dir(&laptop.id);
    let bin_dir = ctx.layout.tool_files_dir();
    let state_dir = ctx.layout.folder_state_dir(&folder.id);
    for dir in [&key_dir, &bin_dir, &state_dir] {
        std::fs::create_dir_all(dir)
            .map_err(|e| EngineError(format!("cannot create {}: {e}", dir.display())))?;
    }
    // Keys exist before the first container, so sshd starts with them (the fingerprint then
    // never changes); the tool files are in the bin mount from the start.
    crate::ssh::ensure_keys(ctx, &laptop.id)?;
    crate::context::write_tool_files(ctx)?;
    let mut volume_labels: HashMap<String, String> =
        HashMap::from([(LABEL_LAPTOP.to_string(), laptop.id.clone())]);
    if let Some(instance) = ctx.instance() {
        volume_labels.insert(INSTANCE_LABEL.to_string(), instance.to_string());
    }
    volumes::ensure(&docker, &home_volume(&laptop.id), volume_labels).await?;

    let labels = laptop_labels(ctx, laptop, meta.generation);
    let given_hosts: Vec<&str> = laptop.given.iter().map(|g| g.path.as_str()).collect();
    let given: Vec<GivenMount> = given_container_paths(&given_hosts)
        .into_iter()
        .zip(&laptop.given)
        .map(|(target, g)| GivenMount {
            source: strip_verbatim(&g.path),
            target,
            read_only: g.read_only,
        })
        .collect();

    let shared_host = strip_verbatim(&folder.path);
    if !meta.project {
        let shared_target = shared_container_path(&shared_host, None);
        let mut binds = vec![
            (shared_host.clone(), shared_target.clone(), false),
            (
                path_str(&key_dir),
                override_config::KEY_MOUNT.to_string(),
                true,
            ),
            (
                path_str(&bin_dir),
                override_config::BIN_MOUNT.to_string(),
                true,
            ),
            (
                path_str(&state_dir),
                override_config::STATE_MOUNT.to_string(),
                true,
            ),
        ];
        binds.extend(
            given
                .iter()
                .map(|g| (g.source.clone(), g.target.clone(), g.read_only)),
        );
        // The engine's view of each host folder (a Docker engine inside WSL sees `/mnt/d/…`).
        for bind in &mut binds {
            bind.0 = crate::docker::engine_path(&endpoint, &bind.0).map_err(EngineError)?;
        }
        let spec = RunSpec {
            name: format!("agentbook-{}-{}", laptop.id, meta.generation),
            image: meta.image.clone(),
            entrypoint: Some(vec![layer::ENTRYPOINT.to_string()]),
            cmd: Some(vec!["sleep".into(), "infinity".into()]),
            labels: labels.into_iter().collect(),
            binds,
            volumes: vec![(home_volume(&laptop.id), meta.home.clone())],
            tmpfs: vec![override_config::RUN_TMPFS.to_string()],
            ports: vec![("127.0.0.1".to_string(), laptop.port, 22)],
            working_dir: Some(shared_target),
        };
        let id = containers::create_and_start(&docker, &spec).await?;
        action.line(&format!("started container {}", &id[..id.len().min(12)]));
        return Ok(());
    }

    let merged = generation
        .merged
        .as_ref()
        .ok_or_else(|| EngineError("The laptop's devcontainer record is missing.".into()))?;
    let gen_dir = ctx.layout.gen_dir(&laptop.id, meta.generation);
    std::fs::create_dir_all(&gen_dir)
        .map_err(|e| EngineError(format!("cannot create {}: {e}", gen_dir.display())))?;
    let compose_file = gen_dir.join("agentbook-compose.yml");
    let run = ToolRun {
        laptop_id: laptop.id.clone(),
        image: meta.image.clone(),
        shared_host_path: shared_host.clone(),
        config_dir: meta.config_dir.clone().unwrap_or_default(),
        port: laptop.port,
        home: meta.home.clone(),
        key_dir: path_str(&key_dir),
        bin_dir: path_str(&bin_dir),
        state_dir: path_str(&state_dir),
        given,
        labels,
        compose_file: path_str(&compose_file),
    };
    let generated = override_config::generate(merged, &run);
    let override_file = gen_dir.join("devcontainer.json");
    let write = || -> std::io::Result<()> {
        let text =
            serde_json::to_string_pretty(&generated.config).map_err(std::io::Error::other)?;
        std::fs::write(&override_file, text)?;
        if let Some(compose) = &generated.compose {
            let text = serde_json::to_string_pretty(compose).map_err(std::io::Error::other)?;
            std::fs::write(&compose_file, text)?;
        }
        Ok(())
    };
    write().map_err(|e| EngineError(format!("cannot write {}: {e}", gen_dir.display())))?;
    let cli = DevcontainerCli::locate(ctx).await?;
    let up = cli
        .up(
            &folder.path,
            &override_file,
            &id_labels(ctx, laptop, meta.generation),
            generated.compose_project.as_deref(),
            action,
        )
        .await?;
    action.line(&format!(
        "started container {}",
        &up.container_id[..up.container_id.len().min(12)]
    ));
    Ok(())
}

/// Creates generation `next` and drops the old containers only once it runs. On failure the old
/// laptop keeps working: its containers are started again (compose: `up` with the previous
/// generation's record, whose images are kept until the new one succeeds).
async fn replace(
    ctx: &Arc<Ctx>,
    folder: &Folder,
    laptop: &Laptop,
    next: &Generation,
    previous: Option<&Generation>,
    action: &Action,
) -> EngineResult<()> {
    let docker = ctx.docker().await?;
    let gen_label = next.meta.generation.to_string();
    let old: Vec<_> = laptop_containers(&docker, &laptop.id)
        .await?
        .into_iter()
        .filter(|c| c.labels.get(LABEL_GEN) != Some(&gen_label))
        .collect();

    if next.meta.compose {
        // The CLI finds a compose laptop by its compose project and service, not by the id
        // labels, so the old primary container goes first (sidecars and their volumes stay).
        // Its record and images are kept: a failed `up` re-runs `up` with them.
        for c in &old {
            containers::remove(&docker, &c.id).await?;
        }
        if let Err(e) = launch(ctx, folder, laptop, next, action).await {
            remove_generation_containers(&docker, &laptop.id, &gen_label).await;
            match previous {
                Some(prev) => {
                    action.line("rolling back to the previous laptop");
                    if let Err(back) = launch(ctx, folder, laptop, prev, action).await {
                        action.line(&format!("rolling back failed: {back}"));
                    }
                }
                None => remove_compose_project(&docker, &laptop.id).await,
            }
            return Err(e);
        }
        return Ok(());
    }

    let was_running: Vec<String> = old
        .iter()
        .filter(|c| c.running())
        .map(|c| c.id.clone())
        .collect();
    for c in &old {
        containers::stop(&docker, &c.id).await?;
    }
    if let Err(e) = launch(ctx, folder, laptop, next, action).await {
        remove_generation_containers(&docker, &laptop.id, &gen_label).await;
        for id in &was_running {
            if let Err(start) = containers::start(&docker, id).await {
                action.line(&format!(
                    "starting the previous laptop again failed: {start}"
                ));
            }
        }
        return Err(e);
    }
    for c in &old {
        containers::remove(&docker, &c.id).await?;
    }
    Ok(())
}

async fn remove_generation_containers(docker: &Docker, laptop_id: &str, generation: &str) {
    let filter = label_filter(&[(LABEL_LAPTOP, laptop_id), (LABEL_GEN, generation)]);
    if let Ok(list) = containers::list_by_labels(docker, &filter).await {
        for c in list {
            let _ = containers::remove(docker, &c.id).await;
        }
    }
}

/// Every container of the laptop's compose project (sidecars included), by exact project label.
pub(crate) async fn remove_compose_project(docker: &Docker, laptop_id: &str) {
    let project = override_config::compose_project(laptop_id);
    let filter = label_filter(&[(COMPOSE_PROJECT_LABEL, project.as_str())]);
    if let Ok(list) = containers::list_by_labels(docker, &filter).await {
        for c in list {
            let _ = containers::remove(docker, &c.id).await;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/// Get equipment: builds and creates the laptop's first container (or Retry after a failed
/// first build). A laptop that already has a container is left as it is. The caller holds the
/// laptop lock.
pub(crate) async fn get_equipment_locked(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    action: &Action,
) -> EngineResult<()> {
    let docker = ctx.docker().await?;
    if !laptop_containers(&docker, laptop_id).await?.is_empty() {
        action.line("the laptop already has its Equipment");
        return Ok(());
    }
    rebuild(ctx, laptop_id, action).await
}

/// Builds (or reuses the cached images of) the folder's current Equipment and replaces the
/// laptop's container with the next generation. The caller holds the laptop lock.
pub(crate) async fn rebuild(ctx: &Arc<Ctx>, laptop_id: &str, action: &Action) -> EngineResult<()> {
    let (folder, laptop) = find_laptop(ctx, laptop_id)?;
    action.step(1, STEPS, "Checking the Equipment");
    let prepared = prepare(ctx, &folder, Some(action)).await;
    record_check(ctx, &folder.id, folder_equipment(&prepared));
    let prepared = prepared?;
    action.line(&format!("Equipment config hash {}", prepared.hash));
    for e in &prepared.exposures {
        action.line(&format!("warning: {}", ExposureView::from_exposure(e).text));
    }
    let built = build(ctx, &prepared, action).await?;

    action.step(4, STEPS, "Starting the laptop");
    let docker = ctx.docker().await?;
    let existing = laptop_containers(&docker, &laptop.id).await?;
    let highest = existing
        .iter()
        .filter_map(|c| c.labels.get(LABEL_GEN)?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let next_gen = laptop.generation.max(highest) + 1;
    let previous = read_generation(ctx, &laptop.id, laptop.generation);
    let next = Generation {
        meta: GenMeta {
            generation: next_gen,
            image: built.image.clone(),
            eq_image: built.eq_image.clone(),
            equipment_hash: prepared.hash.clone(),
            libc: built.libc.as_str().to_string(),
            ssh_user: prepared.ssh_user.user.clone(),
            home: prepared.ssh_user.home.clone(),
            project: prepared.project.is_some(),
            compose: prepared.project.as_ref().is_some_and(Project::compose),
            config_dir: prepared.project.as_ref().map(|p| path_str(&p.config_dir)),
            extra: Map::new(),
        },
        merged: prepared.project.as_ref().map(|p| p.merged.clone()),
    };
    write_generation(ctx, &laptop.id, &next)?;
    replace(ctx, &folder, &laptop, &next, previous.as_ref(), action).await?;

    // A libc switch (e.g. Debian → Alpine) clears the downloaded Claude Code CLI in the kept
    // volume, so Desktop fetches the matching build.
    if laptop.equipment_hash.is_some() && clears_ccd_cli(laptop.libc.as_ref(), &built.libc) {
        clear_ccd_cli(ctx, &laptop, &next.meta, action).await;
    }
    ctx.modify_state(|s| {
        if let Some(l) = s.laptops.iter_mut().find(|l| l.id == laptop.id) {
            l.generation = next_gen;
            l.equipment_hash = Some(prepared.hash.clone());
            l.libc = Some(built.libc.clone());
        }
    })?;
    prune_generations(ctx, &laptop.id, &[next_gen]);
    gc_images(ctx, action).await;
    Ok(())
}

/// Recreate-type actions (give folder, change mode, Locate folder, port reallocation): the same
/// create-new-then-drop-old path on the laptop's current images and record; the volume is kept.
/// A laptop with no record yet gets its Equipment built. Called by the laptop lifecycle, which
/// holds the laptop lock.
pub(crate) async fn recreate_locked(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    action: &Action,
) -> EngineResult<()> {
    let (folder, laptop) = find_laptop(ctx, laptop_id)?;
    let Some(current) = read_generation(ctx, &laptop.id, laptop.generation) else {
        return rebuild(ctx, laptop_id, action).await;
    };
    action.step(1, 1, "Restarting the laptop");
    let next_gen = laptop.generation + 1;
    let mut meta = current.meta.clone();
    meta.generation = next_gen;
    let next = Generation {
        meta,
        merged: current.merged.clone(),
    };
    write_generation(ctx, &laptop.id, &next)?;
    replace(ctx, &folder, &laptop, &next, Some(&current), action).await?;
    ctx.modify_state(|s| {
        if let Some(l) = s.laptops.iter_mut().find(|l| l.id == laptop.id) {
            l.generation = next_gen;
        }
    })?;
    prune_generations(ctx, &laptop.id, &[next_gen]);
    Ok(())
}

async fn clear_ccd_cli(ctx: &Arc<Ctx>, laptop: &Laptop, meta: &GenMeta, action: &Action) {
    let Ok(docker) = ctx.docker().await else {
        return;
    };
    let gen_label = meta.generation.to_string();
    let filter = label_filter(&[
        (LABEL_LAPTOP, laptop.id.as_str()),
        (LABEL_GEN, gen_label.as_str()),
    ]);
    let Ok(list) = containers::list_by_labels(&docker, &filter).await else {
        return;
    };
    let Some(container) = list.into_iter().find(|c| c.running()) else {
        return;
    };
    let dir = format!("{}/.claude/remote/ccd-cli", meta.home.trim_end_matches('/'));
    let argv = containers::sh(&format!("rm -rf '{dir}'"));
    match containers::exec(&docker, &container.id, "0", &argv, None, EXEC_TIMEOUT).await {
        Ok(out) if out.success() => action.line(&format!("libc changed: cleared {dir}")),
        Ok(out) => action.line(&format!("clearing {dir} failed: {}", out.stderr_str())),
        Err(e) => action.line(&format!("clearing {dir} failed: {e}")),
    }
}

/// Removes, by exact tag, the AgentBook images no laptop references any more: every laptop's
/// current layered and project image, every AgentBook container's image and the current
/// standard Equipment are kept. Images of a scenario stand are left to that stand.
pub(crate) async fn gc_images(ctx: &Arc<Ctx>, action: &Action) {
    let Ok(docker) = ctx.docker().await else {
        return;
    };
    let mut keep: HashSet<String> = HashSet::from([standard::image_tag()]);
    for laptop in ctx.state().laptops {
        if let Some(g) = read_generation(ctx, &laptop.id, laptop.generation) {
            keep.insert(g.meta.image.clone());
            if let Some(eq) = g.meta.eq_image {
                keep.insert(eq);
            }
        }
    }
    let Ok(all) = containers::list_by_labels(&docker, &label_filter(&[(LABEL_ROOT, "1")])).await
    else {
        return;
    };
    keep.extend(all.into_iter().map(|c| c.image));
    let mut filter = vec![(LABEL_ROOT, "1")];
    let instance = ctx.instance().map(str::to_string);
    if let Some(i) = instance.as_deref() {
        filter.push((INSTANCE_LABEL, i));
    }
    let Ok(list) = images::list_by_labels(&docker, &label_filter(&filter)).await else {
        return;
    };
    for image in list {
        if instance.is_none() && image.labels.contains_key(INSTANCE_LABEL) {
            continue;
        }
        for tag in image.tags {
            let ours = ["agentbook-eq:", "agentbook-laptop:", "agentbook-std:"]
                .iter()
                .any(|p| tag.starts_with(p));
            if ours && !keep.contains(&tag) {
                match images::remove_tag(&docker, &tag).await {
                    Ok(()) => action.line(&format!("removed the unused image {tag}")),
                    Err(e) => action.line(&format!("could not remove {tag}: {e}")),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers for the laptop lifecycle
// ---------------------------------------------------------------------------------------------

/// The shared folder's path in the laptop for this generation: the devcontainer's workspace
/// folder (as the override config sets it) or `/work/<folder name>`.
pub(crate) fn workspace_folder(folder: &Folder, generation: Option<&Generation>) -> String {
    let shared = strip_verbatim(&folder.path);
    let Some((meta, merged)) = generation.and_then(|g| g.merged.as_ref().map(|m| (&g.meta, m)))
    else {
        return shared_container_path(&shared, None);
    };
    if !meta.project {
        return shared_container_path(&shared, None);
    }
    let run = ToolRun {
        laptop_id: String::new(),
        image: meta.image.clone(),
        shared_host_path: shared,
        config_dir: meta.config_dir.clone().unwrap_or_default(),
        port: 0,
        home: meta.home.clone(),
        key_dir: String::new(),
        bin_dir: String::new(),
        state_dir: String::new(),
        given: Vec::new(),
        labels: Vec::new(),
        compose_file: String::new(),
    };
    override_config::generate(merged, &run).workspace_folder
}

/// The laptop's current generation record.
pub(crate) fn current_generation(ctx: &Ctx, laptop: &Laptop) -> Option<Generation> {
    read_generation(ctx, &laptop.id, laptop.generation)
}

/// The laptop's container that serves it: the current generation's, else the newest one.
pub(crate) async fn main_container(
    docker: &Docker,
    laptop: &Laptop,
) -> EngineResult<Option<containers::ContainerListItem>> {
    let mut list = laptop_containers(docker, &laptop.id).await?;
    let gen_of = |c: &containers::ContainerListItem| {
        c.labels
            .get(LABEL_GEN)
            .and_then(|g| g.parse::<u64>().ok())
            .unwrap_or(0)
    };
    list.sort_by_key(|c| std::cmp::Reverse(gen_of(c)));
    let current = laptop.generation;
    Ok(list
        .iter()
        .find(|c| gen_of(c) == current)
        .or_else(|| list.first())
        .cloned())
}

/// The compose sidecars of a compose laptop (every container of its compose project other than
/// the laptop's own).
async fn compose_containers(
    docker: &Docker,
    laptop_id: &str,
) -> EngineResult<Vec<containers::ContainerListItem>> {
    let project = override_config::compose_project(laptop_id);
    Ok(containers::list_by_labels(
        docker,
        &label_filter(&[(COMPOSE_PROJECT_LABEL, project.as_str())]),
    )
    .await?
    .into_iter()
    .filter(|c| !c.labels.contains_key(LABEL_LAPTOP))
    .collect())
}

/// Sleep: stops every container of the laptop (and its compose sidecars). The volume stays.
pub(crate) async fn stop_laptop(docker: &Docker, laptop_id: &str) -> EngineResult<()> {
    for c in laptop_containers(docker, laptop_id).await? {
        containers::stop(docker, &c.id).await?;
    }
    for c in compose_containers(docker, laptop_id).await? {
        containers::stop(docker, &c.id).await?;
    }
    Ok(())
}

/// Wake up: starts the compose sidecars, then the laptop's container. `false` when the laptop
/// has no container.
pub(crate) async fn start_laptop(docker: &Docker, laptop: &Laptop) -> EngineResult<bool> {
    let Some(main) = main_container(docker, laptop).await? else {
        return Ok(false);
    };
    for c in compose_containers(docker, &laptop.id).await? {
        if !c.running() {
            containers::start(docker, &c.id).await?;
        }
    }
    if !main.running() {
        containers::start(docker, &main.id).await?;
    }
    Ok(true)
}

/// The JSON a laptop's `devcontainer.metadata` label must end with (scenario checks).
pub fn layer_metadata_entry() -> Value {
    json!({"id": "agentbook-laptop", "entrypoint": layer::ENTRYPOINT})
}
