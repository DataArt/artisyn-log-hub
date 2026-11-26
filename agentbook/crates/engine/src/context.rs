//! Context for Claude (FR-4, FR-4a, FR-4b):
//!
//! - `tool-files/` (`ws`, `prompt-hook`, the `agentbook-ws` skill), rewritten by the running tool
//!   version and mounted read-only at `/opt/agentbook/bin`;
//! - the per-folder state files `folders/<fid>/state/{folder.json, laptops/<id>.json}`, mounted
//!   read-only at `/opt/agentbook/state` and replaced by write-then-rename, so `ws` sees a rename
//!   or a state change without a restart;
//! - the push on every Open into the laptop's home volume: `~/.claude/CLAUDE.md` (whole, tool-owned),
//!   the `UserPromptSubmit` hook entry merged into `~/.claude/settings.json` by its command path,
//!   the host's `~/.claude/{skills,agents,commands}` replacing entries of the same name (then the
//!   reserved `agentbook-ws` skill), never `.credentials.json`, and the git defaults in
//!   `~/.gitconfig` (`core.fileMode`, the effective `core.autocrlf`, `safe.directory`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agentbook_core::paths::{given_container_paths, host_basename, strip_verbatim};
use agentbook_core::state::{
    CONTAINER_STATE_SCHEMA_VERSION, Folder, FolderInfo, GivenInfo, Laptop, LaptopInfo,
};
use serde_json::{Map, Value, json};

use crate::action::Action;
use crate::assets::{claude_md, tools};
use crate::docker::{Docker, containers};
use crate::engine::{Ctx, EngineError, EngineResult};
use crate::equipment::{self, Generation};
use crate::files::{sh_quote, write_atomic};
use crate::snapshot::RunState;
use crate::vars;

const EXEC_TIMEOUT: Duration = Duration::from_secs(120);

/// The host's Claude settings folders copied into every laptop on Open.
pub const COPIED_DIRS: [&str; 3] = ["skills", "agents", "commands"];

/// Never copied, at any depth.
pub const NEVER_COPIED: &str = ".credentials.json";

/// Writes the tool files when their content differs (bin mount: `ws`, `prompt-hook`; the skill).
pub(crate) fn write_tool_files(ctx: &Ctx) -> EngineResult<()> {
    let root = ctx.layout.tool_files_dir();
    let mut files: Vec<(PathBuf, Vec<u8>)> = tools::BIN
        .iter()
        .map(|a| (root.join(a.name), a.bytes()))
        .collect();
    files.extend(tools::SKILL.iter().map(|a| {
        (
            root.join("skills").join(tools::SKILL_DIR).join(a.name),
            a.bytes(),
        )
    }));
    for (path, bytes) in files {
        if std::fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
            continue;
        }
        write_atomic(&path, &bytes)
            .map_err(|e| EngineError(format!("cannot write {}: {e}", path.display())))?;
    }
    Ok(())
}

/// The shared folder's display name.
pub fn folder_name(folder: &Folder) -> String {
    host_basename(&folder.path)
}

/// Given folders as the laptop sees them: (container path, host path, read only).
pub fn given_mounts(laptop: &Laptop) -> Vec<(String, String, bool)> {
    let hosts: Vec<&str> = laptop.given.iter().map(|g| g.path.as_str()).collect();
    given_container_paths(&hosts)
        .into_iter()
        .zip(&laptop.given)
        .map(|(c, g)| (c, strip_verbatim(&g.path), g.read_only))
        .collect()
}

fn to_json_bytes<T: serde::Serialize>(v: &T) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    text.into_bytes()
}

/// Rewrites a folder's state files from the state and the snapshot (run states, variable
/// names); removes the files of laptops that are gone.
pub(crate) fn write_folder_state(ctx: &Ctx, folder_id: &str) -> EngineResult<()> {
    let state = ctx.state();
    let Some(folder) = state.folders.iter().find(|f| f.id == folder_id) else {
        return Ok(());
    };
    let laptops: Vec<&Laptop> = state
        .laptops
        .iter()
        .filter(|l| l.folder_id == folder_id)
        .collect();
    let (runs, defaults): (HashMap<String, RunState>, Vec<(String, String)>) =
        ctx.read_snapshot(|s| {
            (
                s.laptops
                    .iter()
                    .map(|l| (l.laptop.id.clone(), l.run))
                    .collect(),
                s.folder(folder_id)
                    .map(|f| f.equipment.defaults.clone())
                    .unwrap_or_default(),
            )
        });
    let dir = ctx.layout.folder_state_dir(folder_id);
    let generation = laptops
        .iter()
        .find_map(|l| equipment::current_generation(ctx, l));
    let info = FolderInfo {
        schema_version: CONTAINER_STATE_SCHEMA_VERSION,
        name: folder_name(folder),
        shared_path_in_container: equipment::workspace_folder(folder, generation.as_ref()),
        host_path: strip_verbatim(&folder.path),
        extra: Map::new(),
    };
    let write = |path: &Path, bytes: Vec<u8>| -> EngineResult<()> {
        if std::fs::read(path).ok().as_deref() == Some(bytes.as_slice()) {
            return Ok(());
        }
        write_atomic(path, &bytes)
            .map_err(|e| EngineError(format!("cannot write {}: {e}", path.display())))
    };
    write(&dir.join("folder.json"), to_json_bytes(&info))?;
    let laptops_dir = dir.join("laptops");
    std::fs::create_dir_all(&laptops_dir)
        .map_err(|e| EngineError(format!("cannot create {}: {e}", laptops_dir.display())))?;
    for l in &laptops {
        let given = given_mounts(l)
            .into_iter()
            .map(|(container, host, ro)| GivenInfo {
                container,
                host,
                mode: if ro { "view-only" } else { "read-write" }.to_string(),
                extra: Map::new(),
            })
            .collect();
        let info = LaptopInfo {
            schema_version: CONTAINER_STATE_SCHEMA_VERSION,
            id: l.id.clone(),
            name: l.name.clone(),
            state: runs
                .get(&l.id)
                .copied()
                .unwrap_or_default()
                .state_word()
                .to_string(),
            given,
            vars: vars::names(&vars::effective(&defaults, folder, Some(l))),
            ports: ctx
                .forwards_of(l)
                .into_iter()
                .map(|f| agentbook_core::state::PortInfo {
                    port: f.port,
                    host: f.host,
                    extra: Map::new(),
                })
                .collect(),
            extra: Map::new(),
        };
        write(
            &laptops_dir.join(format!("{}.json", l.id)),
            to_json_bytes(&info),
        )?;
    }
    if let Ok(entries) = std::fs::read_dir(&laptops_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            if !laptops.iter().any(|l| l.id == id) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

/// Adds the files under `dir` to the tar as `prefix/<relative path>`, skipping
/// `.credentials.json` and symlinks.
fn add_dir(
    builder: &mut tar::Builder<Vec<u8>>,
    dir: &Path,
    prefix: &str,
    owner: (u64, u64),
) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == NEVER_COPIED {
            continue;
        }
        let kind = e.file_type()?;
        let path = format!("{prefix}/{name}");
        if kind.is_dir() {
            add_dir_entry(builder, &path, owner)?;
            add_dir(builder, &e.path(), &path, owner)?;
        } else if kind.is_file() {
            let data = std::fs::read(e.path())?;
            add_file(builder, &path, &data, owner)?;
        }
    }
    Ok(())
}

fn add_dir_entry(
    builder: &mut tar::Builder<Vec<u8>>,
    path: &str,
    owner: (u64, u64),
) -> std::io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Directory);
    header.set_size(0);
    header.set_mode(0o755);
    header.set_uid(owner.0);
    header.set_gid(owner.1);
    header.set_mtime(0);
    builder.append_data(&mut header, format!("{path}/"), std::io::empty())
}

fn add_file(
    builder: &mut tar::Builder<Vec<u8>>,
    path: &str,
    data: &[u8],
    owner: (u64, u64),
) -> std::io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_uid(owner.0);
    header.set_gid(owner.1);
    header.set_mtime(0);
    builder.append_data(&mut header, path, data)
}

/// `settings.json` with the prompt hook entry merged in by its command path; the user's other
/// keys and hooks stay. `None` when the existing file is not a JSON object (left alone).
pub fn merge_settings(existing: Option<&str>) -> Option<String> {
    let mut root = match existing.map(str::trim).filter(|t| !t.is_empty()) {
        None => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(m)) => m,
            _ => return None,
        },
    };
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let list = hooks
        .as_object_mut()?
        .entry("UserPromptSubmit")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    let list = list.as_array_mut()?;
    let present = list.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hs| {
                hs.iter().any(|h| {
                    h.get("command").and_then(Value::as_str) == Some(tools::PROMPT_HOOK_COMMAND)
                })
            })
    });
    if !present {
        list.push(json!({
            "hooks": [{"type": "command", "command": tools::PROMPT_HOOK_COMMAND}]
        }));
    }
    let mut text = serde_json::to_string_pretty(&Value::Object(root)).ok()?;
    text.push('\n');
    Some(text)
}

/// What [`push`] needs about the laptop.
pub(crate) struct PushTarget<'a> {
    pub folder: &'a Folder,
    pub laptop: &'a Laptop,
    pub generation: Option<&'a Generation>,
    pub container: &'a str,
}

async fn root_exec(docker: &Docker, container: &str, script: &str) -> EngineResult<String> {
    let out = containers::exec(
        docker,
        container,
        "0",
        &containers::sh(script),
        None,
        EXEC_TIMEOUT,
    )
    .await?
    .check()?;
    Ok(out.stdout_str())
}

/// The context push of one Open (see the module doc).
pub(crate) async fn push(
    ctx: &Arc<Ctx>,
    docker: &Docker,
    t: &PushTarget<'_>,
    action: &Action,
) -> EngineResult<()> {
    let (user, home) = t
        .generation
        .map(|g| (g.meta.ssh_user.clone(), g.meta.home.clone()))
        .unwrap_or_else(|| ("claude".to_string(), "/home/claude".to_string()));
    let home = home.trim_end_matches('/').to_string();
    let claude = format!("{home}/.claude");

    // The host's folders to copy, and the names in them (replaced in the laptop).
    let host_claude = ctx.platform.home_dir().join(".claude");
    let mut replaced: Vec<String> = vec![format!("skills/{}", tools::SKILL_DIR)];
    for dir in COPIED_DIRS {
        if let Ok(entries) = std::fs::read_dir(host_claude.join(dir)) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name != NEVER_COPIED {
                    replaced.push(format!("{dir}/{name}"));
                }
            }
        }
    }

    // 1. Folders, the replaced entries removed, owner ids and the current settings.json.
    let mut script = format!(
        "set -e; C={}; U={}; mkdir -p \"$C/skills\" \"$C/agents\" \"$C/commands\"; ",
        sh_quote(&claude),
        sh_quote(&user)
    );
    for r in &replaced {
        script.push_str(&format!("rm -rf \"$C\"/{}; ", sh_quote(r)));
    }
    script.push_str(
        "chown \"$U\" \"$C\" \"$C/skills\" \"$C/agents\" \"$C/commands\" 2>/dev/null || true; \
         id -u \"$U\"; id -g \"$U\"; echo ---; cat \"$C/settings.json\" 2>/dev/null || true",
    );
    let out = root_exec(docker, t.container, &script).await?;
    let (ids, settings) = out.split_once("---\n").unwrap_or((out.as_str(), ""));
    let mut id_lines = ids.lines().map(|l| l.trim().parse::<u64>().unwrap_or(0));
    let owner = (id_lines.next().unwrap_or(0), id_lines.next().unwrap_or(0));

    // 2. One tar: CLAUDE.md, settings.json, the host folders, then the ws skill.
    let generation_ref = t.generation;
    let shared_path = equipment::workspace_folder(t.folder, generation_ref);
    let defaults = ctx
        .read_snapshot(|s| s.folder(&t.folder.id).map(|f| f.equipment.defaults.clone()))
        .unwrap_or_default();
    let md = claude_md::render(&claude_md::Context {
        laptop_name: t.laptop.name.clone(),
        shared_folder_name: folder_name(t.folder),
        shared_path,
        shared_host_path: strip_verbatim(&t.folder.path),
        home: home.clone(),
        given: given_mounts(t.laptop)
            .into_iter()
            .map(|(container, host, read_only)| claude_md::GivenFolder {
                container,
                host,
                read_only,
            })
            .collect(),
        variable_names: vars::names(&vars::effective(&defaults, t.folder, Some(t.laptop))),
    });
    let mut builder = tar::Builder::new(Vec::new());
    let io = |e: std::io::Error| EngineError(format!("cannot pack the laptop's context: {e}"));
    add_file(&mut builder, "CLAUDE.md", md.as_bytes(), owner).map_err(io)?;
    let existing = (!settings.trim().is_empty()).then_some(settings);
    match merge_settings(existing) {
        Some(text) => {
            add_file(&mut builder, "settings.json", text.as_bytes(), owner).map_err(io)?
        }
        None => action.line("~/.claude/settings.json in the laptop is not valid JSON; left as is"),
    }
    for dir in COPIED_DIRS {
        let src = host_claude.join(dir);
        if src.is_dir() {
            add_dir(&mut builder, &src, dir, owner).map_err(io)?;
        }
    }
    let skill = format!("skills/{}", tools::SKILL_DIR);
    add_dir_entry(&mut builder, &skill, owner).map_err(io)?;
    for a in tools::SKILL {
        add_file(
            &mut builder,
            &format!("{skill}/{}", a.name),
            &a.bytes(),
            owner,
        )
        .map_err(io)?;
    }
    let tar = builder.into_inner().map_err(io)?;
    containers::upload_tar(docker, t.container, &claude, tar).await?;

    // 3. Ownership of what was written (some engines ignore tar owners), then git defaults.
    let mut chown = format!("C={}; U={}; ", sh_quote(&claude), sh_quote(&user));
    chown.push_str("chown \"$U\" \"$C/CLAUDE.md\" \"$C/settings.json\" 2>/dev/null; ");
    for r in &replaced {
        chown.push_str(&format!(
            "[ -e \"$C\"/{0} ] && chown -R \"$U\" \"$C\"/{0} 2>/dev/null; ",
            sh_quote(r)
        ));
    }
    chown.push_str("true");
    root_exec(docker, t.container, &chown).await?;

    let platform = ctx.platform.clone();
    let autocrlf = tokio::task::spawn_blocking(move || {
        platform
            .host_git_autocrlf()
            .effective(platform.is_windows())
    })
    .await
    .map_err(|e| EngineError(e.to_string()))?;
    let git = format!(
        "HOME={h}; export HOME; command -v git >/dev/null 2>&1 || exit 0; \
         git config --global core.fileMode false && \
         git config --global core.autocrlf {a} && \
         git config --global --replace-all safe.directory '*'",
        h = sh_quote(&home),
        a = autocrlf
    );
    let out = containers::exec(
        docker,
        t.container,
        &user,
        &containers::sh(&git),
        None,
        EXEC_TIMEOUT,
    )
    .await?;
    if !out.success() {
        return Err(EngineError(format!(
            "setting the laptop's git defaults failed: {}",
            out.stderr_str().trim()
        )));
    }
    Ok(())
}
