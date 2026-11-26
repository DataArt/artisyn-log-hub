//! Given folders on the go, moved folders and removal, on the standard Equipment:
//!
//! - AC-7: giving a folder to a running laptop recreates it (volume kept) and the folder is there
//!   in the next session; View only makes writes fail; removing it takes it away; `ws mounts`
//!   follows; the prompt hook prints the connected-folders line once after a change; nothing
//!   else of the host is visible; a drive root or the home folder needs a confirmation;
//! - AC-13: both folders are listed; a folder moved away is marked missing, Open refuses with a
//!   message naming it, and Locate folder… recreates its laptop with the volume kept;
//! - AC-9: Remove laptop removes its container, volume, alias, known_hosts and credentials and
//!   leaves the shared and given folders byte-identical and the folder listed with no laptops;
//!   Remove folder takes it off the list and leaves it on disk.

use std::time::Duration;

use agentbook_core::override_config::home_volume;
use agentbook_core::paths::ssh_alias;
use agentbook_engine::docker::volumes;
use agentbook_engine::{Command, RunState, Secret, VarEdit, VarInput};
use agentbook_platform::Platform;

use crate::ac6::ensure_dependencies;
use crate::ac17;
use crate::laptops::{T, add_folder, alias_block, get_laptop, known_hosts, laptop_view};
use crate::stand::{Stand, StepResult, ensure};

pub fn run(stand: &Stand) -> StepResult {
    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;
    let shared = stand.root.join("proj-g");
    stand.write_files(&shared, &[("index.js", crate::ac6::INDEX_JS)])?;
    let outside = stand.root.join("outside");
    stand.write_files(&outside, &[("existing.txt", "outside\n")])?;
    let other = stand.root.join("proj-h");
    stand.write_files(&other, &[("readme.txt", "project h\n")])?;
    let h_given = stand.root.join("h-given");
    stand.write_files(&h_given, &[("data.txt", "given to h\n")])?;

    let engine = stand.engine(&data)?;
    let f_g = add_folder(stand, &engine, &shared)?;
    let g = get_laptop(stand, &engine, &f_g, "G", Vec::new(), T)?;
    let ag = ssh_alias(&g);

    println!("  AC-7: give a folder to a running laptop");
    stand.ssh_ok(&ag, "echo keep > ~/keep")?;
    let generation = laptop_view(&engine, &g)?.laptop.generation;
    stand.act_ok(
        &engine,
        Command::GiveFolder {
            laptop: g.clone(),
            path: outside.to_string_lossy().into_owned(),
            read_only: false,
            confirm_broad: false,
        },
        T,
    )?;
    ensure(
        laptop_view(&engine, &g)?.laptop.generation == generation + 1,
        "giving a folder did not recreate the laptop",
    )?;
    let out = stand.ssh_ok(
        &ag,
        "cat ~/keep; cat /work/given/outside/existing.txt; echo new > /work/given/outside/new.txt; \
         ws mounts; /opt/agentbook/bin/prompt-hook",
    )?;
    ensure(
        out.contains("keep") && out.contains("outside\n") && out.contains("read and write"),
        format!("after giving a folder: {out}"),
    )?;
    let listed = stand.ssh_ok(&ag, "ls -A /work; echo --; ls -A /work/given")?;
    ensure(
        listed.lines().map(str::trim).collect::<Vec<_>>() == ["given", "proj-g", "--", "outside"],
        format!("the laptop sees more than its connected folders: {listed}"),
    )?;
    ensure(
        outside.join("new.txt").is_file(),
        "the write is not on the host",
    )?;
    std::fs::remove_file(outside.join("new.txt")).map_err(|e| e.to_string())?;

    println!("  AC-7: View only, then remove");
    stand.act_ok(
        &engine,
        Command::SetGivenMode {
            laptop: g.clone(),
            path: outside.to_string_lossy().into_owned(),
            read_only: true,
        },
        T,
    )?;
    let out = stand.ssh_ok(
        &ag,
        "/opt/agentbook/bin/prompt-hook; /opt/agentbook/bin/prompt-hook; \
         (echo w > /work/given/outside/w.txt) 2>/dev/null || echo ro-ok; ws mounts",
    )?;
    ensure(
        out.matches("Connected folders changed").count() == 1
            && out.contains("/work/given/outside (View only)")
            && out.contains("ro-ok")
            && out.contains("given folder, View only"),
        format!("after View only: {out}"),
    )?;
    stand.act_ok(
        &engine,
        Command::RemoveGiven {
            laptop: g.clone(),
            path: outside.to_string_lossy().into_owned(),
        },
        T,
    )?;
    let out = stand.ssh_ok(
        &ag,
        "test -e /work/given/outside || echo gone; ws mounts; cat ~/keep",
    )?;
    ensure(
        out.contains("gone") && out.contains("no given folders") && out.contains("keep"),
        format!("after removing the folder: {out}"),
    )?;

    println!("  AC-7: a drive root or the home folder needs a confirmation");
    for path in [
        "C:\\".to_string(),
        stand.platform.home_dir().to_string_lossy().into_owned(),
    ] {
        let message = stand.act_fails(
            &engine,
            Command::GiveFolder {
                laptop: g.clone(),
                path: path.clone(),
                read_only: false,
                confirm_broad: false,
            },
            T,
        )?;
        ensure(
            message.contains("whole disk") && message.contains("Confirm"),
            format!("{path}: {message}"),
        )?;
    }

    println!("  AC-13: two folders; a moved folder; Locate folder…");
    let f_h = add_folder(stand, &engine, &other)?;
    let h = get_laptop(
        stand,
        &engine,
        &f_h,
        "H",
        vec![agentbook_engine::GivenInput {
            path: h_given.to_string_lossy().into_owned(),
            read_only: false,
        }],
        T,
    )?;
    let snap = engine.snapshot();
    ensure(
        snap.folder(&f_g).is_some() && snap.folder(&f_h).is_some(),
        "the home list misses a folder",
    )?;
    stand.act_ok(&engine, Command::Sleep { laptop: g.clone() }, T)?;
    let moved = stand.root.join("proj-g-moved");
    std::fs::rename(&shared, &moved).map_err(|e| format!("moving the folder: {e}"))?;
    stand.wait_snapshot(
        &engine,
        Duration::from_secs(30),
        "the folder to show missing",
        |s| {
            s.folder(&f_g).is_some_and(|f| f.missing)
                && s.laptop(&g).is_some_and(|l| !l.missing_sources.is_empty())
        },
    )?;
    let message = stand.act_fails(&engine, Command::Open { laptop: g.clone() }, T)?;
    ensure(
        message.contains("proj-g") && message.contains("Locate folder"),
        format!("Open on a moved folder: {message}"),
    )?;
    let generation = laptop_view(&engine, &g)?.laptop.generation;
    stand.act_ok(
        &engine,
        Command::LocateFolder {
            folder: f_g.clone(),
            path: moved.to_string_lossy().into_owned(),
            confirm_broad: false,
        },
        T,
    )?;
    let v = laptop_view(&engine, &g)?;
    ensure(
        v.laptop.generation == generation + 1 && v.run == RunState::Working,
        format!(
            "Locate folder did not recreate the laptop: {:?} {:?}",
            v.laptop.generation, v.run
        ),
    )?;
    let out = stand.ssh_ok(&ag, "cat ~/keep; ls /work/proj-g-moved")?;
    ensure(
        out.contains("keep") && out.contains("index.js"),
        format!("after Locate folder: {out}"),
    )?;
    ensure(
        !engine.snapshot().folder(&f_g).is_some_and(|f| f.missing),
        "the folder still shows missing",
    )?;

    println!("  AC-9: Remove laptop, then Remove folder");
    stand.act_ok(
        &engine,
        Command::SetVariables {
            folder: f_h.clone(),
            vars: Vec::new(),
            laptop_vars: vec![(
                h.clone(),
                vec![VarEdit {
                    name: "H_TOKEN".into(),
                    value: VarInput::Hidden(Some(Secret("h-secret".into()))),
                }],
            )],
        },
        T,
    )?;
    stand.ssh_ok(&ssh_alias(&h), "echo inside > ~/home.txt")?;
    let shared_digest = stand.tree_digest(&other);
    let given_digest = stand.tree_digest(&h_given);
    let prefix = stand.test_config().credential_prefix;
    let creds = |p: &str| stand.platform.credential_list(p).unwrap_or_default();
    ensure(
        !creds(&format!("{prefix}{f_h}/{h}/")).is_empty(),
        "the laptop's hidden value is not in the credential store",
    )?;
    stand.act_ok(&engine, Command::RemoveLaptop { laptop: h.clone() }, T)?;
    ensure(
        stand.containers_of(&h).is_empty(),
        "the container is still there",
    )?;
    let volume = stand
        .rt
        .block_on(volumes::exists(&stand.docker, &home_volume(&h)))
        .map_err(|e| e.to_string())?;
    ensure(!volume, "the volume is still there")?;
    ensure(
        alias_block(stand, &h).is_empty() && known_hosts(stand, &h).is_empty(),
        "the alias is still there",
    )?;
    ensure(
        !alias_block(stand, &g).is_empty(),
        "removing one laptop removed another's alias",
    )?;
    ensure(
        creds(&format!("{prefix}{f_h}/{h}/")).is_empty(),
        "the laptop's credentials are still there",
    )?;
    ensure(
        stand.tree_digest(&other) == shared_digest && stand.tree_digest(&h_given) == given_digest,
        "Remove laptop changed the shared or given folder",
    )?;
    let snap = engine.snapshot();
    ensure(
        snap.folder(&f_h).is_some() && snap.laptop(&h).is_none(),
        "the folder left the list or the laptop stayed",
    )?;
    stand.act_ok(
        &engine,
        Command::RemoveFolder {
            folder: f_h.clone(),
        },
        T,
    )?;
    ensure(
        engine.snapshot().folder(&f_h).is_none(),
        "Remove folder kept the folder on the list",
    )?;
    ensure(
        other.is_dir() && stand.tree_digest(&other) == shared_digest,
        "Remove folder touched the folder on disk",
    )?;
    ensure(
        !data.join("folders").join(&f_h).exists(),
        "the folder's tool data is still there",
    )?;
    Ok(())
}
