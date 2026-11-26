//! The laptop lifecycle (FR-1, FR-1a, FR-2, FR-4, FR-6, FR-8, FR-11): shared folders (add, the
//! one-time `.claude/` choice, Locate folder…, Remove folder) and laptops (Get a laptop, Another
//! laptop like this, Open, Sleep, Wake up, Rename, give / change / remove a given folder, Remove
//! laptop). Every action on one laptop holds its lock; every start ends in [`after_start`] (alias,
//! tool and state files, context push, Variables).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use agentbook_core::broad_folder::{self, Breadth};
use agentbook_core::claude_dir::{self, CLAUDE_DIR, ClaudeStart};
use agentbook_core::override_config::home_volume;
use agentbook_core::paths::{claude_link, strip_verbatim};
use agentbook_core::state::{EquipmentRef, Folder, Given, Laptop, State, id_from_bytes};
use serde_json::{Map, Value};

use crate::action::Action;
use crate::context::{self, PushTarget};
use crate::docker::{Docker, containers, docker_host_value, label_filter, volumes};
use crate::engine::{Ctx, EngineError, EngineResult};
use crate::equipment::{self, COMPOSE_PROJECT_LABEL};
use crate::files::host_path;
use crate::snapshot::RunState;
use crate::{ssh, vars};

/// Laptop ports are picked in this range (FR-4).
pub const PORT_RANGE: std::ops::RangeInclusive<u16> = 20_000..=29_999;

/// How deep the `.claude/` scan goes below the shared folder.
const CLAUDE_SCAN_DEPTH: usize = 8;

/// Recent folders kept in `state.json`.
const RECENT_KEEP: usize = 10;

/// A given folder chosen in a dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GivenInput {
    pub path: String,
    /// "View only".
    pub read_only: bool,
}

/// What "Another laptop like this" pre-fills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaptopDraft {
    pub folder: String,
    /// `<name> 2` (or the next free number).
    pub name: String,
    pub given: Vec<GivenInput>,
    /// The source laptop's "Only for one laptop" variables that will be copied: (name, hidden).
    pub copied_vars: Vec<(String, bool)>,
}

/// A change to a laptop's given folders (always recreates its container, volume kept).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GivenChange {
    Give { path: String, read_only: bool },
    SetMode { path: String, read_only: bool },
    Remove { path: String },
}

// ---------------------------------------------------------------------------------------------
// Ids, ports, paths
// ---------------------------------------------------------------------------------------------

/// 64 random bits from the std hasher's per-process random keys, the clock and a counter.
fn random_u64() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.write_u32(std::process::id());
    h.finish()
}

/// A new folder or laptop id, unique in the state.
pub(crate) fn new_id(state: &State) -> String {
    loop {
        let b = random_u64().to_be_bytes();
        let id = id_from_bytes([b[0], b[1], b[2], b[3], b[4]]);
        if !state.folders.iter().any(|f| f.id == id) && !state.laptops.iter().any(|l| l.id == id) {
            return id;
        }
    }
}

/// Whether nothing listens on `127.0.0.1:<port>` right now.
pub fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Whether the laptop's own port is free, allowing up to 2 s for the engine to let go of it
/// after a stop (a Docker engine inside WSL forwards ports to Windows through a relay that
/// releases a stopped container's port about half a second later).
async fn own_port_free(port: u16) -> bool {
    for _ in 0..8 {
        if port_free(port) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    port_free(port)
}

/// A random free loopback port in [`PORT_RANGE`] no laptop in the state uses.
pub(crate) fn allocate_port(state: &State) -> EngineResult<u16> {
    let (low, high) = (*PORT_RANGE.start(), *PORT_RANGE.end());
    let span = u32::from(high - low) + 1;
    let start = (random_u64() % u64::from(span)) as u32;
    for i in 0..span {
        let port = low + ((start + i) % span) as u16;
        if state.laptops.iter().any(|l| l.port == port) {
            continue;
        }
        if port_free(port) {
            return Ok(port);
        }
    }
    Err(EngineError(
        "No free port for the laptop's SSH connection was found (20000-29999).".into(),
    ))
}

/// Two host paths name the same folder (Windows: case-insensitive, `/` and `\` alike).
fn same_path(a: &str, b: &str, windows: bool) -> bool {
    let norm = |p: &str| {
        let p = strip_verbatim(p.trim());
        let p = if windows { p.replace('/', "\\") } else { p };
        let p = p.trim_end_matches(['/', '\\']).to_string();
        if windows { p.to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

/// Refuses a whole-disk, home or home-ancestor folder unless confirmed (FR-8).
fn check_broad(ctx: &Ctx, path: &str, confirmed: bool) -> EngineResult<()> {
    let home = host_path(&ctx.platform.home_dir());
    let breadth = broad_folder::classify(path, &home);
    if !breadth.needs_confirmation() || confirmed {
        return Ok(());
    }
    let what = match breadth {
        Breadth::DriveRoot => "a whole drive",
        Breadth::Home => "your whole home folder",
        _ => "a folder that contains your home folder",
    };
    Err(EngineError(format!(
        "{path} is {what}: the agent would see (nearly) your whole disk. Confirm to connect it \
         anyway."
    )))
}

/// The bind sources of a laptop that are missing, as plain messages naming them.
pub(crate) fn missing_sources(folder: &Folder, laptop: &Laptop) -> Vec<String> {
    let mut out = Vec::new();
    if !Path::new(&folder.path).is_dir() {
        out.push(format!(
            "The shared folder \"{}\" ({}) was not found. Use \"Locate folder…\" to point \
             AgentBook to its new place.",
            context::folder_name(folder),
            strip_verbatim(&folder.path)
        ));
    }
    for g in &laptop.given {
        if !Path::new(&g.path).is_dir() {
            out.push(format!(
                "The given folder {} was not found. Remove it from this laptop, or put it back.",
                strip_verbatim(&g.path)
            ));
        }
    }
    out
}

fn check_sources(folder: &Folder, laptop: &Laptop) -> EngineResult<()> {
    match missing_sources(folder, laptop).into_iter().next() {
        Some(m) => Err(EngineError(m)),
        None => Ok(()),
    }
}

/// The devcontainer configs of a folder (relative, `/`-separated), the default one first:
/// `.devcontainer/devcontainer.json`, `.devcontainer.json`, then `.devcontainer/<name>/devcontainer.json`.
pub fn devcontainer_configs(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for rel in [".devcontainer/devcontainer.json", ".devcontainer.json"] {
        if root.join(rel).is_file() {
            out.push(rel.to_string());
        }
    }
    if let Ok(entries) = std::fs::read_dir(root.join(".devcontainer")) {
        let mut subs: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| {
                root.join(".devcontainer")
                    .join(n)
                    .join("devcontainer.json")
                    .is_file()
            })
            .collect();
        subs.sort();
        out.extend(
            subs.into_iter()
                .map(|n| format!(".devcontainer/{n}/devcontainer.json")),
        );
    }
    out
}

/// Every `.claude` directory below `root` (relative paths), skipping `.git`, `node_modules`,
/// nested `.claude` and symlinks.
pub fn scan_claude_dirs(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let Ok(kind) = e.file_type() else { continue };
            if !kind.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if name == CLAUDE_DIR {
                out.push(path);
            } else if depth < CLAUDE_SCAN_DEPTH && claude_dir::scan_descends(&name) {
                walk(&e.path(), &path, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", 0, &mut out);
    out
}

/// The `.claude/` start candidates of a folder.
fn claude_candidates(root: &Path) -> Vec<String> {
    let dirs = scan_claude_dirs(root);
    let refs: Vec<&str> = dirs.iter().map(String::as_str).collect();
    claude_dir::candidates(&refs)
}

/// The first free "Laptop N" of a folder.
pub fn suggest_name(state: &State, folder_id: &str) -> String {
    let taken = |n: &str| {
        state
            .laptops
            .iter()
            .any(|l| l.folder_id == folder_id && l.name.trim().eq_ignore_ascii_case(n))
    };
    (1..)
        .map(|i| format!("Laptop {i}"))
        .find(|n| !taken(n))
        .unwrap_or_else(|| "Laptop".to_string())
}

/// "Another laptop like this": the dialog's pre-filled values.
pub fn like_this(state: &State, laptop_id: &str) -> Option<LaptopDraft> {
    let source = state.laptops.iter().find(|l| l.id == laptop_id)?;
    let taken = |n: &str| {
        state
            .laptops
            .iter()
            .any(|l| l.folder_id == source.folder_id && l.name.trim().eq_ignore_ascii_case(n))
    };
    let name = (2..)
        .map(|i| format!("{} {i}", source.name.trim()))
        .find(|n| !taken(n))
        .unwrap_or_default();
    Some(LaptopDraft {
        folder: source.folder_id.clone(),
        name,
        given: source
            .given
            .iter()
            .map(|g| GivenInput {
                path: g.path.clone(),
                read_only: g.read_only,
            })
            .collect(),
        copied_vars: source
            .laptop_vars
            .iter()
            .map(|v| {
                (
                    v.name.clone(),
                    v.value == agentbook_core::state::VarValue::Hidden,
                )
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------

/// FR-1: adds a shared folder (or picks the existing one with the same path), with its
/// Equipment (`config`, else the first devcontainer config found, else the standard one) and the
/// `.claude/` decision; several `.claude/` folders are asked once (`FolderView::claude_choices`).
pub(crate) async fn add_folder(
    ctx: &Arc<Ctx>,
    id: &str,
    path: &str,
    config: Option<String>,
    confirm_broad: bool,
    action: &Action,
) -> EngineResult<()> {
    let path = path.trim().to_string();
    if !Path::new(&path).is_dir() {
        return Err(EngineError(format!("The folder {path} was not found.")));
    }
    check_broad(ctx, &path, confirm_broad)?;
    let windows = ctx.platform.is_windows();
    let state = ctx.state();
    let remember_recent = |s: &mut State, p: &str| {
        s.recent.retain(|r| !same_path(r, p, windows));
        s.recent.insert(0, p.to_string());
        s.recent.truncate(RECENT_KEEP);
    };
    if let Some(existing) = state
        .folders
        .iter()
        .find(|f| same_path(&f.path, &path, windows))
    {
        action.set_folder(&existing.id);
        let p = existing.path.clone();
        return ctx.modify_state(|s| remember_recent(s, &p));
    }
    let root = PathBuf::from(&path);
    let (candidates, configs) = tokio::task::spawn_blocking(move || {
        (claude_candidates(&root), devcontainer_configs(&root))
    })
    .await
    .map_err(|e| EngineError(e.to_string()))?;
    let equipment = match config.or_else(|| configs.first().cloned()) {
        Some(c) => EquipmentRef::project(c),
        None => EquipmentRef::standard(),
    };
    let claude_dir = match claude_dir::decide(&candidates, None) {
        ClaudeStart::Root => Some(String::new()),
        ClaudeStart::Use(d) => Some(d),
        ClaudeStart::Ask(list) => {
            ctx.set_claude_choices(id, list);
            None
        }
    };
    let folder = Folder {
        id: id.to_string(),
        path: path.clone(),
        claude_dir,
        equipment,
        vars: Vec::new(),
        extra: Map::new(),
    };
    ctx.modify_state(|s| {
        s.folders.push(folder);
        remember_recent(s, &path);
    })?;
    context::write_folder_state(ctx, id)?;
    equipment::check_all(ctx, Some(id)).await;
    Ok(())
}

/// Looks for `.claude/` choices of folders that have none decided yet (at engine start).
pub(crate) async fn scan_pending_claude_dirs(ctx: &Arc<Ctx>) {
    for folder in ctx.state().folders {
        if folder.claude_dir.is_some() {
            continue;
        }
        let root = PathBuf::from(&folder.path);
        let candidates = tokio::task::spawn_blocking(move || claude_candidates(&root))
            .await
            .unwrap_or_default();
        if let ClaudeStart::Ask(list) = claude_dir::decide(&candidates, None) {
            ctx.set_claude_choices(&folder.id, list);
            ctx.refresh_views();
        }
    }
}

/// The answer to the one-time `.claude/` question, remembered for the folder.
pub(crate) fn choose_claude_dir(ctx: &Ctx, folder_id: &str, dir: &str) -> EngineResult<()> {
    ctx.modify_state(|s| {
        if let Some(f) = s.folders.iter_mut().find(|f| f.id == folder_id) {
            f.claude_dir = Some(dir.trim_matches('/').to_string());
        }
    })?;
    ctx.set_claude_choices(folder_id, Vec::new());
    ctx.refresh_views();
    Ok(())
}

/// Picks the folder's devcontainer config (`None`: the standard Equipment).
pub(crate) async fn choose_equipment(
    ctx: &Arc<Ctx>,
    folder_id: &str,
    config: Option<String>,
) -> EngineResult<()> {
    ctx.modify_state(|s| {
        if let Some(f) = s.folders.iter_mut().find(|f| f.id == folder_id) {
            f.equipment = match &config {
                Some(c) => EquipmentRef::project(c.clone()),
                None => EquipmentRef::standard(),
            };
        }
    })?;
    equipment::check_all(ctx, Some(folder_id)).await;
    Ok(())
}

/// "Locate folder…": points the folder to its new place and recreates its laptops with the new
/// bind path, volumes kept (project Equipment is prepared again: its config lives there too).
pub(crate) async fn locate_folder(
    ctx: &Arc<Ctx>,
    folder_id: &str,
    path: &str,
    confirm_broad: bool,
    action: &Action,
) -> EngineResult<()> {
    let path = path.trim().to_string();
    if !Path::new(&path).is_dir() {
        return Err(EngineError(format!("The folder {path} was not found.")));
    }
    check_broad(ctx, &path, confirm_broad)?;
    let state = ctx.state();
    let mut located = state
        .folders
        .iter()
        .find(|f| f.id == folder_id)
        .cloned()
        .ok_or_else(|| EngineError(format!("There is no folder {folder_id}.")))?;
    located.path = path.clone();
    let laptops: Vec<Laptop> = state
        .laptops
        .into_iter()
        .filter(|l| l.folder_id == folder_id)
        .collect();
    let docker = ctx.docker().await?;
    // FR-1a: every laptop that will be recreated mounts its given folders through binds, and a
    // missing bind source would come back as an empty stand-in directory — block before any
    // change, naming the folder.
    for laptop in &laptops {
        if equipment::laptop_containers(&docker, &laptop.id)
            .await?
            .is_empty()
        {
            continue;
        }
        if let Err(EngineError(m)) = check_sources(&located, laptop) {
            return Err(EngineError(format!("\"{}\": {m}", laptop.name)));
        }
    }
    ctx.modify_state(|s| {
        if let Some(f) = s.folders.iter_mut().find(|f| f.id == folder_id) {
            f.path = path.clone();
        }
    })?;
    context::write_folder_state(ctx, folder_id)?;
    equipment::check_all(ctx, Some(folder_id)).await;
    let mut failures = Vec::new();
    for laptop in laptops {
        let lock = ctx.laptop_lock(&laptop.id);
        let _guard = lock.lock().await;
        if equipment::laptop_containers(&docker, &laptop.id)
            .await?
            .is_empty()
        {
            continue;
        }
        action.line(&format!("recreating \"{}\"", laptop.name));
        let project = equipment::current_generation(ctx, &laptop).is_some_and(|g| g.meta.project);
        let result = if project {
            equipment::rebuild(ctx, &laptop.id, action).await
        } else {
            equipment::recreate_locked(ctx, &laptop.id, action).await
        };
        match result {
            Ok(()) => {
                if let Err(e) = after_start(ctx, &laptop.id, action).await {
                    failures.push(format!("{}: {e}", laptop.name));
                }
            }
            Err(e) => failures.push(format!("{}: {e}", laptop.name)),
        }
    }
    context::write_folder_state(ctx, folder_id)?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(EngineError(format!(
            "Some laptops could not be recreated: {}",
            failures.join("; ")
        )))
    }
}

/// "Remove folder": removes its laptops as Remove laptop does, then the folder's record, its
/// tool data and its credentials. The folder on disk is never touched.
pub(crate) async fn remove_folder(
    ctx: &Arc<Ctx>,
    folder_id: &str,
    action: &Action,
) -> EngineResult<()> {
    let laptops: Vec<String> = ctx
        .state()
        .laptops
        .into_iter()
        .filter(|l| l.folder_id == folder_id)
        .map(|l| l.id)
        .collect();
    for id in laptops {
        remove_laptop(ctx, &id, action).await?;
    }
    vars::forget_credentials(ctx, folder_id, None);
    let dir = ctx.layout.folder_dir(folder_id);
    if dir.starts_with(ctx.layout.root())
        && dir != ctx.layout.root()
        && let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        action.line(&format!("could not remove {}: {e}", dir.display()));
    }
    ctx.modify_state(|s| s.folders.retain(|f| f.id != folder_id))?;
    ctx.set_claude_choices(folder_id, Vec::new());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Laptops
// ---------------------------------------------------------------------------------------------

/// FR-11 "Get a laptop" (and "Another laptop like this" with `copy_from`): records the laptop,
/// builds or reuses its Equipment, starts it with its given folders and opens Desktop on it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn get_laptop(
    ctx: &Arc<Ctx>,
    id: &str,
    folder_id: &str,
    name: &str,
    given: &[GivenInput],
    copy_from: Option<&str>,
    confirm_broad: bool,
    action: &Action,
) -> EngineResult<()> {
    let state = ctx.state();
    let folder = state
        .folders
        .iter()
        .find(|f| f.id == folder_id)
        .cloned()
        .ok_or_else(|| EngineError(format!("There is no folder {folder_id}.")))?;
    let windows = ctx.platform.is_windows();
    let mut given_list: Vec<Given> = Vec::new();
    for g in given {
        check_broad(ctx, &g.path, confirm_broad)?;
        if given_list
            .iter()
            .any(|x| same_path(&x.path, &g.path, windows))
        {
            continue;
        }
        given_list.push(Given {
            path: g.path.trim().to_string(),
            read_only: g.read_only,
            extra: Map::new(),
        });
    }
    let mut laptop = Laptop {
        id: id.to_string(),
        folder_id: folder_id.to_string(),
        name: match name.trim() {
            "" => suggest_name(&state, folder_id),
            n => n.to_string(),
        },
        port: allocate_port(&state)?,
        given: given_list,
        equipment_hash: None,
        libc: None,
        generation: 0,
        laptop_vars: Vec::new(),
        ports: None,
        extra: Map::new(),
    };
    check_sources(&folder, &laptop)?;
    if let Some(source) = copy_from.and_then(|c| state.laptops.iter().find(|l| l.id == c)) {
        let ctx2 = ctx.clone();
        let (fid, src, to) = (folder_id.to_string(), source.clone(), id.to_string());
        laptop.laptop_vars =
            tokio::task::spawn_blocking(move || vars::copy_laptop_vars(&ctx2, &fid, &src, &to))
                .await
                .map_err(|e| EngineError(e.to_string()))?;
    }
    ctx.modify_state(|s| s.laptops.push(laptop))?;
    context::write_folder_state(ctx, folder_id)?;
    let lock = ctx.laptop_lock(id);
    let _guard = lock.lock().await;
    equipment::get_equipment_locked(ctx, id, action).await?;
    after_start(ctx, id, action).await?;
    open_desktop(ctx, id).await
}

/// "Open laptop" (`desktop`) and "Wake up": checks the bind sources and the Equipment, starts the
/// laptop (building it when it has no container yet; on a port clash it moves to a new port and
/// is recreated, with a one-line note), refreshes everything in it and opens Desktop.
pub(crate) async fn open(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    desktop: bool,
    action: &Action,
) -> EngineResult<()> {
    let lock = ctx.laptop_lock(laptop_id);
    let _guard = lock.lock().await;
    let (folder, laptop) = equipment::find_laptop(ctx, laptop_id)?;
    check_sources(&folder, &laptop)?;
    equipment::check_all(ctx, Some(&folder.id)).await;
    let docker = ctx.docker().await?;
    let main = equipment::main_container(&docker, &laptop).await?;
    let running = main.as_ref().is_some_and(|c| c.running());
    if !running {
        if !own_port_free(laptop.port).await {
            let port = allocate_port(&ctx.state())?;
            let note = format!(
                "Port {} was taken by another program, so this laptop moved to port {port}.",
                laptop.port
            );
            action.line(&note);
            ctx.modify_state(|s| {
                if let Some(l) = s.laptops.iter_mut().find(|l| l.id == laptop_id) {
                    l.port = port;
                }
            })?;
            ctx.set_note(laptop_id, Some(note));
            if main.is_some() {
                equipment::recreate_locked(ctx, laptop_id, action).await?;
            }
        }
        let (_, laptop) = equipment::find_laptop(ctx, laptop_id)?;
        if !equipment::start_laptop(&docker, &laptop).await? {
            equipment::get_equipment_locked(ctx, laptop_id, action).await?;
        }
    }
    after_start(ctx, laptop_id, action).await?;
    if desktop {
        open_desktop(ctx, laptop_id).await?;
    }
    Ok(())
}

/// Opens `claude://code/new?ssh_host=sbx-<id>&ssh_folder=<Claude's start folder>`.
async fn open_desktop(ctx: &Arc<Ctx>, laptop_id: &str) -> EngineResult<()> {
    let (folder, laptop) = equipment::find_laptop(ctx, laptop_id)?;
    let generation = equipment::current_generation(ctx, &laptop);
    let mut start = equipment::workspace_folder(&folder, generation.as_ref());
    if let Some(dir) = folder.claude_dir.as_deref().filter(|d| !d.is_empty()) {
        start = format!("{}/{}", start.trim_end_matches('/'), dir.trim_matches('/'));
    }
    let url = claude_link(&laptop.id, &start);
    if let Some(launcher) = ctx.test.as_ref().and_then(|t| t.desktop_launcher.clone()) {
        launcher.open(&url);
        return Ok(());
    }
    let platform = ctx.platform.clone();
    tokio::task::spawn_blocking(move || platform.open_url(&url))
        .await
        .map_err(|e| EngineError(e.to_string()))?
        .map_err(|e| EngineError(format!("Claude Desktop could not be opened: {e}")))
}

/// Everything after the laptop's container (re)started: its alias, the tool and state files, the
/// context push and the Variables. The caller holds the laptop lock.
pub(crate) async fn after_start(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    action: &Action,
) -> EngineResult<()> {
    let (folder, laptop) = equipment::find_laptop(ctx, laptop_id)?;
    let generation = equipment::current_generation(ctx, &laptop);
    let docker = ctx.docker().await?;
    let main = equipment::main_container(&docker, &laptop)
        .await?
        .filter(|c| c.running())
        .ok_or_else(|| EngineError("The laptop did not start.".into()))?;
    ssh::ensure_keys(ctx, laptop_id)?;
    let user = generation
        .as_ref()
        .map(|g| g.meta.ssh_user.clone())
        .unwrap_or_else(|| agentbook_core::ssh_user::TOOL_USER.to_string());
    ssh::write_alias(ctx, laptop_id, laptop.port, &user)?;
    context::write_tool_files(ctx)?;
    ctx.set_run(laptop_id, RunState::Working, None);
    context::write_folder_state(ctx, &folder.id)?;
    context::push(
        ctx,
        &docker,
        &PushTarget {
            folder: &folder,
            laptop: &laptop,
            generation: generation.as_ref(),
            container: &main.id,
        },
        action,
    )
    .await?;
    vars::deliver(ctx, &docker, &main.id, &folder, &laptop).await
}

/// "Get equipment" (Retry) and "Update laptop" from the card, followed by [`after_start`]
/// (logged, not failed: the laptop itself is ready).
pub(crate) async fn equipment_action(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    update: bool,
    action: &Action,
) -> EngineResult<()> {
    let lock = ctx.laptop_lock(laptop_id);
    let _guard = lock.lock().await;
    if update {
        equipment::rebuild(ctx, laptop_id, action).await?;
    } else {
        equipment::get_equipment_locked(ctx, laptop_id, action).await?;
    }
    if let Err(e) = after_start(ctx, laptop_id, action).await {
        action.line(&format!("refreshing the laptop failed: {e}"));
    }
    Ok(())
}

/// "Sleep": stops the laptop's container (and compose sidecars); the volume stays.
pub(crate) async fn sleep(ctx: &Arc<Ctx>, laptop_id: &str) -> EngineResult<()> {
    let lock = ctx.laptop_lock(laptop_id);
    let _guard = lock.lock().await;
    let (folder, _) = equipment::find_laptop(ctx, laptop_id)?;
    let docker = ctx.docker().await?;
    equipment::stop_laptop(&docker, laptop_id).await?;
    ctx.set_run(laptop_id, RunState::Sleeping, Some(0));
    context::write_folder_state(ctx, &folder.id)
}

/// "Rename": display only; the alias and the container keep the id. A duplicate name in the
/// folder is saved (the card shows a note).
pub(crate) fn rename(ctx: &Ctx, laptop_id: &str, name: &str) -> EngineResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(EngineError("A laptop needs a name.".into()));
    }
    let (folder, _) = equipment::find_laptop(ctx, laptop_id)?;
    ctx.modify_state(|s| {
        if let Some(l) = s.laptops.iter_mut().find(|l| l.id == laptop_id) {
            l.name = name.to_string();
        }
    })?;
    context::write_folder_state(ctx, &folder.id)
}

/// "Ports…": stores the laptop's forwarded ports (`None`: the devcontainer's again) and brings
/// its tunnels in line at once; the container is not touched.
pub(crate) async fn set_ports(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    ports: Option<Vec<agentbook_core::state::PortForward>>,
) -> EngineResult<()> {
    if let Some(list) = &ports {
        agentbook_core::ports::check(list).map_err(EngineError)?;
    }
    let lock = ctx.laptop_lock(laptop_id);
    let _guard = lock.lock().await;
    let (folder, _) = equipment::find_laptop(ctx, laptop_id)?;
    ctx.modify_state(|s| {
        if let Some(l) = s.laptops.iter_mut().find(|l| l.id == laptop_id) {
            l.ports = ports.clone();
        }
    })?;
    let (_, laptop) = equipment::find_laptop(ctx, laptop_id)?;
    let working = ctx.read_snapshot(|s| {
        s.laptop(laptop_id)
            .is_some_and(|l| l.run == RunState::Working)
    });
    crate::tunnels::reconcile(ctx, laptop_id, &ctx.forwards_of(&laptop), working);
    context::write_folder_state(ctx, &folder.id)?;
    ctx.refresh_views();
    Ok(())
}

/// Give a folder, change its mode or remove it (FR-8): the container is recreated with the new
/// mounts and the volume kept. On failure the old given folders are put back.
pub(crate) async fn change_given(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    change: &GivenChange,
    confirm_broad: bool,
    action: &Action,
) -> EngineResult<()> {
    let lock = ctx.laptop_lock(laptop_id);
    let _guard = lock.lock().await;
    let (folder, laptop) = equipment::find_laptop(ctx, laptop_id)?;
    let windows = ctx.platform.is_windows();
    let mut given = laptop.given.clone();
    match change {
        GivenChange::Give { path, read_only } => {
            check_broad(ctx, path, confirm_broad)?;
            if !Path::new(path).is_dir() {
                return Err(EngineError(format!("The folder {path} was not found.")));
            }
            if given.iter().any(|g| same_path(&g.path, path, windows)) {
                return Err(EngineError(format!(
                    "The laptop already has the folder {path}."
                )));
            }
            given.push(Given {
                path: path.trim().to_string(),
                read_only: *read_only,
                extra: Map::new(),
            });
        }
        GivenChange::SetMode { path, read_only } => {
            let g = given
                .iter_mut()
                .find(|g| same_path(&g.path, path, windows))
                .ok_or_else(|| EngineError(format!("The laptop has no folder {path}.")))?;
            g.read_only = *read_only;
        }
        GivenChange::Remove { path } => {
            let before = given.len();
            given.retain(|g| !same_path(&g.path, path, windows));
            if given.len() == before {
                return Err(EngineError(format!("The laptop has no folder {path}.")));
            }
        }
    }
    let old = laptop.given.clone();
    let set = |list: Vec<Given>| {
        ctx.modify_state(move |s| {
            if let Some(l) = s.laptops.iter_mut().find(|l| l.id == laptop_id) {
                l.given = list;
            }
        })
    };
    set(given)?;
    let docker = ctx.docker().await?;
    if !equipment::laptop_containers(&docker, laptop_id)
        .await?
        .is_empty()
    {
        let (_, updated) = equipment::find_laptop(ctx, laptop_id)?;
        if let Err(e) = check_sources(&folder, &updated) {
            set(old)?;
            return Err(e);
        }
        if let Err(e) = equipment::recreate_locked(ctx, laptop_id, action).await {
            set(old)?;
            context::write_folder_state(ctx, &folder.id)?;
            return Err(e);
        }
        after_start(ctx, laptop_id, action).await?;
    }
    context::write_folder_state(ctx, &folder.id)
}

/// FR-6 "Remove laptop": its containers (compose: `docker compose down -v` with the same files),
/// its volume, alias, keys, generation records and credentials, then the record. The shared and
/// given folders are never touched.
pub(crate) async fn remove_laptop(
    ctx: &Arc<Ctx>,
    laptop_id: &str,
    action: &Action,
) -> EngineResult<()> {
    let lock = ctx.laptop_lock(laptop_id);
    let _guard = lock.lock().await;
    let (folder, laptop) = equipment::find_laptop(ctx, laptop_id)?;
    let docker = ctx.docker().await?;
    let generation = equipment::current_generation(ctx, &laptop);
    if generation.as_ref().is_some_and(|g| g.meta.compose) {
        compose_down(ctx, &docker, &laptop, action).await?;
    }
    for c in equipment::laptop_containers(&docker, laptop_id).await? {
        containers::remove(&docker, &c.id).await?;
    }
    volumes::remove(&docker, &home_volume(laptop_id)).await?;
    ssh::remove_alias(ctx, laptop_id)?;
    let ctx2 = ctx.clone();
    let (fid, lid) = (folder.id.clone(), laptop_id.to_string());
    let _ = tokio::task::spawn_blocking(move || {
        vars::forget_credentials(&ctx2, &fid, Some(&lid));
    })
    .await;
    let dir = ctx.layout.laptop_dir(laptop_id);
    if dir.starts_with(ctx.layout.root())
        && dir != ctx.layout.root()
        && let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        action.line(&format!("could not remove {}: {e}", dir.display()));
    }
    ctx.modify_state(|s| s.laptops.retain(|l| l.id != laptop_id))?;
    context::write_folder_state(ctx, &folder.id)?;
    equipment::gc_images(ctx, action).await;
    Ok(())
}

/// `docker compose -p agentbook-<id> -f … down -v` with the files of the laptop's override
/// config; anything left (e.g. a project compose file no longer there) is removed by the
/// compose project label.
async fn compose_down(
    ctx: &Arc<Ctx>,
    docker: &Docker,
    laptop: &Laptop,
    action: &Action,
) -> EngineResult<()> {
    let cli = ctx.docker_cli()?;
    let project = agentbook_core::override_config::compose_project(&laptop.id);
    let override_file = ctx
        .layout
        .gen_dir(&laptop.id, laptop.generation)
        .join("devcontainer.json");
    let files: Vec<String> = std::fs::read_to_string(&override_file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("dockerComposeFile").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let (_, endpoint) = ctx.docker_with_endpoint().await?;
    let mut cmd = std::process::Command::new(&cli);
    cmd.arg("compose").arg("-p").arg(&project);
    for f in &files {
        cmd.arg("-f").arg(f);
    }
    cmd.args(["down", "-v", "--remove-orphans"])
        .env("DOCKER_HOST", docker_host_value(&endpoint))
        .env_remove("DOCKER_CONTEXT")
        .stdin(std::process::Stdio::null());
    ctx.platform.prepare_command(&mut cmd);
    let output = tokio::process::Command::from(cmd)
        .output()
        .await
        .map_err(|e| EngineError(format!("cannot run docker compose: {e}")))?;
    for line in String::from_utf8_lossy(&output.stderr).lines() {
        action.line(line);
    }
    if !output.status.success() {
        action.line("docker compose down failed; removing the compose project by its label");
    }
    // Whatever is left of the project, by its exact label.
    equipment::remove_compose_project(docker, &laptop.id).await;
    let filter = label_filter(&[(COMPOSE_PROJECT_LABEL, project.as_str())]);
    for v in volumes::list_by_labels(docker, &filter)
        .await
        .unwrap_or_default()
    {
        let _ = volumes::remove(docker, &v).await;
    }
    let options = bollard::query_parameters::ListNetworksOptionsBuilder::default()
        .filters(&filter)
        .build();
    if let Ok(nets) = docker.list_networks(Some(options)).await {
        for n in nets {
            if let Some(id) = n.id {
                let _ = docker.remove_network(&id).await;
            }
        }
    }
    Ok(())
}
