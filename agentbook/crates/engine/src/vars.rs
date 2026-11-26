//! Variables (FR-12), engine side: the project defaults from the merged devcontainer config, the
//! Variables dialog's changes (Hidden values go only to the OS credential store) and the delivery
//! of each laptop's effective values to the tmpfs env file `/run/agentbook/env/session.env`,
//! which `session.sh` sources for every SSH session.
//!
//! The env file is written over `docker exec` stdin (never a host file, never the volume) on
//! Open, Wake up, after a change, after every recreate and when the poller finds a running laptop
//! without one (started outside the tool). Values never reach a log or the snapshot.

use std::sync::Arc;
use std::time::Duration;

use agentbook_core::state::{Folder, Laptop, VarOrigin, VarSetting, VarValue};
use agentbook_core::variables::{
    EffectiveVar, VarSource, credential_target, is_valid_name, render_env_file, resolve,
};
use bytes::Bytes;
use serde_json::{Map, Value};

use crate::docker::{Docker, containers};
use crate::engine::{Ctx, EngineError, EngineResult};
use crate::equipment::{self, Generation};
use crate::files::sh_quote;

const EXEC_TIMEOUT: Duration = Duration::from_secs(60);

/// The env file inside the laptop (fixed format, External surface).
pub const ENV_FILE: &str = "/run/agentbook/env/session.env";

/// A secret typed into the Variables dialog. Its `Debug` never shows the value.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// A value set in the Variables dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarInput {
    Plain(String),
    /// Hidden: `Some` stores a new value in the credential store; `None` keeps the stored one.
    Hidden(Option<Secret>),
}

/// One variable setting from the dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VarEdit {
    pub name: String,
    pub value: VarInput,
}

/// The project defaults of a merged devcontainer config: `containerEnv`, then `remoteEnv`
/// (string values only; a `null` in `remoteEnv` unsets and is skipped).
pub fn project_defaults(merged: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in ["containerEnv", "remoteEnv"] {
        if let Some(Value::Object(map)) = merged.get(key) {
            for (name, value) in map {
                if let Some(v) = value.as_str() {
                    out.push((name.clone(), v.to_string()));
                }
            }
        }
    }
    out
}

/// The defaults a laptop's container was created with (its generation), else the folder's.
fn defaults_of(
    generation: Option<&Generation>,
    folder_defaults: &[(String, String)],
) -> Vec<(String, String)> {
    match generation.and_then(|g| g.merged.as_ref()) {
        Some(merged) => project_defaults(merged),
        None => folder_defaults.to_vec(),
    }
}

/// The effective variables of a laptop without a container env (the snapshot's view; a
/// `${containerEnv:…}` default resolves to its default part only).
pub fn effective(
    defaults: &[(String, String)],
    folder: &Folder,
    laptop: Option<&Laptop>,
) -> Vec<EffectiveVar> {
    resolve(
        defaults,
        &[],
        &folder.vars,
        laptop.map(|l| l.laptop_vars.as_slice()).unwrap_or(&[]),
    )
}

/// Names of the editable variables (CLAUDE.md, the `ws` state files): names only, never values.
pub fn names(vars: &[EffectiveVar]) -> Vec<String> {
    vars.iter()
        .filter(|v| v.editable)
        .map(|v| v.name.clone())
        .collect()
}

/// The (name, value) pairs to deliver, with Hidden values read from the credential store.
fn values(
    ctx: &Ctx,
    folder: &Folder,
    laptop: &Laptop,
    vars: &[EffectiveVar],
) -> Vec<(String, String)> {
    let prefix = ctx.credential_prefix();
    vars.iter()
        .filter_map(|v| match &v.value {
            VarValue::Plain(s) => Some((v.name.clone(), s.clone())),
            VarValue::Hidden => {
                let laptop_id = (v.source == VarSource::Laptop).then_some(laptop.id.as_str());
                let target = credential_target(prefix, &folder.id, laptop_id, &v.name);
                ctx.platform
                    .credential_get(&target)
                    .ok()
                    .flatten()
                    .map(|value| (v.name.clone(), value))
            }
            VarValue::Other(_) => None,
        })
        .collect()
}

/// Writes the laptop's env file into its running container (`container`), owned by the SSH user
/// and readable only by it.
pub(crate) async fn deliver(
    ctx: &Arc<Ctx>,
    docker: &Docker,
    container: &str,
    folder: &Folder,
    laptop: &Laptop,
) -> EngineResult<()> {
    let generation = equipment::current_generation(ctx, laptop);
    let folder_defaults = ctx
        .read_snapshot(|s| s.folder(&folder.id).map(|f| f.equipment.defaults.clone()))
        .unwrap_or_default();
    let defaults = defaults_of(generation.as_ref(), &folder_defaults);
    let container_env = containers::env(docker, container).await?;
    let vars = resolve(&defaults, &container_env, &folder.vars, &laptop.laptop_vars);
    let ctx2 = ctx.clone();
    let (folder2, laptop2) = (folder.clone(), laptop.clone());
    // The credential store is a blocking OS call.
    let pairs = tokio::task::spawn_blocking(move || values(&ctx2, &folder2, &laptop2, &vars))
        .await
        .map_err(|e| EngineError(e.to_string()))?;
    let text = render_env_file(&pairs);
    let user = generation
        .as_ref()
        .map(|g| g.meta.ssh_user.clone())
        .unwrap_or_else(|| "root".to_string());
    let script = format!(
        "umask 077; mkdir -p /run/agentbook/env && chmod 755 /run/agentbook/env && \
         t=/run/agentbook/env/.session.env.$$ && cat > \"$t\" && \
         (chown {} \"$t\" 2>/dev/null || true) && mv -f \"$t\" {ENV_FILE}",
        sh_quote(&user)
    );
    containers::exec(
        docker,
        container,
        "0",
        &containers::sh(&script),
        Some(Bytes::from(text.into_bytes())),
        EXEC_TIMEOUT,
    )
    .await?
    .check()?;
    Ok(())
}

/// Turns the dialog's list into stored settings: Hidden values into the credential store (under
/// `laptop_id` when set), the rest as plain text. Removed or no-longer-hidden settings lose their
/// credential.
fn apply(
    ctx: &Ctx,
    folder_id: &str,
    laptop_id: Option<&str>,
    defaults: &[(String, String)],
    old: &[VarSetting],
    edits: &[VarEdit],
) -> EngineResult<Vec<VarSetting>> {
    let prefix = ctx.credential_prefix();
    let mut out: Vec<VarSetting> = Vec::new();
    for edit in edits {
        if !is_valid_name(&edit.name) {
            return Err(EngineError(format!(
                "\"{}\" is not a valid variable name: use letters, digits and _, not starting with \
                 a digit.",
                edit.name
            )));
        }
        if out.iter().any(|s| s.name == edit.name) {
            return Err(EngineError(format!(
                "The variable {} is listed twice.",
                edit.name
            )));
        }
        let target = credential_target(prefix, folder_id, laptop_id, &edit.name);
        let value = match &edit.value {
            VarInput::Plain(text) => VarValue::Plain(text.clone()),
            VarInput::Hidden(Some(secret)) => {
                ctx.platform
                    .credential_set(&target, &secret.0)
                    .map_err(|e| EngineError(format!("cannot store {}: {e}", edit.name)))?;
                VarValue::Hidden
            }
            VarInput::Hidden(None) => {
                let stored = ctx
                    .platform
                    .credential_get(&target)
                    .map_err(|e| EngineError(format!("cannot read {}: {e}", edit.name)))?;
                if stored.is_none() {
                    return Err(EngineError(format!(
                        "There is no stored value for {}; type it again.",
                        edit.name
                    )));
                }
                VarValue::Hidden
            }
        };
        let origin = if defaults.iter().any(|(n, _)| n == &edit.name) {
            VarOrigin::Override
        } else {
            VarOrigin::Added
        };
        let extra = old
            .iter()
            .find(|s| s.name == edit.name)
            .map(|s| s.extra.clone())
            .unwrap_or_else(Map::new);
        out.push(VarSetting {
            name: edit.name.clone(),
            value,
            origin,
            extra,
        });
    }
    // A value kind written by a newer AgentBook is not shown in the dialog, so it cannot be in
    // the edits: keep it as it was rather than dropping it (state.json is additive-only).
    for s in old {
        if matches!(s.value, VarValue::Other(_)) && !out.iter().any(|n| n.name == s.name) {
            out.push(s.clone());
        }
    }
    for s in old {
        let still_hidden = out
            .iter()
            .any(|n| n.name == s.name && n.value == VarValue::Hidden);
        if s.value == VarValue::Hidden && !still_hidden {
            let target = credential_target(prefix, folder_id, laptop_id, &s.name);
            let _ = ctx.platform.credential_delete(&target);
        }
    }
    Ok(out)
}

/// "Variables…": replaces the folder-wide settings and, for each listed laptop, its "Only for
/// one laptop" settings.
pub(crate) fn set_variables(
    ctx: &Ctx,
    folder_id: &str,
    folder_vars: &[VarEdit],
    laptop_vars: &[(String, Vec<VarEdit>)],
) -> EngineResult<()> {
    let state = ctx.state();
    let folder = state
        .folders
        .iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| EngineError(format!("There is no folder {folder_id}.")))?;
    let defaults = ctx
        .read_snapshot(|s| s.folder(folder_id).map(|f| f.equipment.defaults.clone()))
        .unwrap_or_default();
    let new_folder = apply(ctx, folder_id, None, &defaults, &folder.vars, folder_vars)?;
    let mut new_laptops = Vec::new();
    for (laptop_id, edits) in laptop_vars {
        let laptop = state
            .laptops
            .iter()
            .find(|l| &l.id == laptop_id && l.folder_id == folder_id)
            .ok_or_else(|| {
                EngineError(format!("There is no laptop {laptop_id} in this folder."))
            })?;
        new_laptops.push((
            laptop_id.clone(),
            apply(
                ctx,
                folder_id,
                Some(laptop_id),
                &defaults,
                &laptop.laptop_vars,
                edits,
            )?,
        ));
    }
    ctx.modify_state(|s| {
        if let Some(f) = s.folders.iter_mut().find(|f| f.id == folder_id) {
            f.vars = new_folder;
        }
        for (id, vars) in new_laptops {
            if let Some(l) = s.laptops.iter_mut().find(|l| l.id == id) {
                l.laptop_vars = vars;
            }
        }
    })
}

/// "Another laptop like this": the source laptop's "Only for one laptop" settings for the new
/// laptop, Hidden values copied in the credential store.
pub(crate) fn copy_laptop_vars(
    ctx: &Ctx,
    folder_id: &str,
    from: &Laptop,
    to_id: &str,
) -> Vec<VarSetting> {
    let prefix = ctx.credential_prefix();
    from.laptop_vars
        .iter()
        .filter_map(|s| {
            if s.value == VarValue::Hidden {
                let source = credential_target(prefix, folder_id, Some(&from.id), &s.name);
                let value = ctx.platform.credential_get(&source).ok().flatten()?;
                let target = credential_target(prefix, folder_id, Some(to_id), &s.name);
                ctx.platform.credential_set(&target, &value).ok()?;
            }
            Some(s.clone())
        })
        .collect()
}

/// Removes every credential under `<prefix><folderId>/` (whole folder) or
/// `<prefix><folderId>/<laptopId>/` (one laptop).
pub(crate) fn forget_credentials(ctx: &Ctx, folder_id: &str, laptop_id: Option<&str>) {
    let base = match laptop_id {
        Some(l) => format!("{}{folder_id}/{l}/", ctx.credential_prefix()),
        None => format!("{}{folder_id}/", ctx.credential_prefix()),
    };
    if let Ok(names) = ctx.platform.credential_list(&base) {
        for n in names {
            let _ = ctx.platform.credential_delete(&n);
        }
    }
}

/// The Variables dialog rows of a folder: every editable project default, folder-wide setting
/// and "Only for one laptop" setting, in that order of first appearance. Hidden values are only
/// marked, never read.
pub fn folder_rows(
    defaults: &[(String, String)],
    folder: &Folder,
    laptops: &[Laptop],
) -> Vec<crate::snapshot::FolderVariable> {
    use crate::snapshot::{FolderVariable, VarShown};
    let shown = |v: &VarValue| match v {
        VarValue::Plain(s) => Some(VarShown::Plain(s.clone())),
        VarValue::Hidden => Some(VarShown::Hidden),
        VarValue::Other(_) => None,
    };
    let mut names: Vec<String> = Vec::new();
    let mut add = |n: &str| {
        if !names.iter().any(|x| x == n) {
            names.push(n.to_string());
        }
    };
    for (n, v) in defaults {
        if !v.contains("${containerEnv:") {
            add(n);
        }
    }
    for s in &folder.vars {
        add(&s.name);
    }
    let mine: Vec<&Laptop> = laptops
        .iter()
        .filter(|l| l.folder_id == folder.id)
        .collect();
    for l in &mine {
        for s in &l.laptop_vars {
            add(&s.name);
        }
    }
    let effective = effective(defaults, folder, None);
    names
        .into_iter()
        .map(|name| FolderVariable {
            project_default: defaults
                .iter()
                .rev()
                .find(|(n, _)| n == &name)
                .map(|(_, v)| v.clone()),
            folder: folder
                .vars
                .iter()
                .find(|s| s.name == name)
                .and_then(|s| shown(&s.value)),
            laptops: mine
                .iter()
                .filter_map(|l| {
                    let s = l.laptop_vars.iter().find(|s| s.name == name)?;
                    Some((l.id.clone(), shown(&s.value)?))
                })
                .collect(),
            needs_value: effective.iter().any(|v| v.name == name && v.needs_value),
            name,
        })
        .collect()
}
