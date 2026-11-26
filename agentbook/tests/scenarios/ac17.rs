//! AC-17 (FR-10): the first launch lists each dependency with name, version and size; a checksum
//! mismatch and a connection cut mid-download leave no file in use and end in the plain message
//! with Retry; Retry finishes; the second launch downloads nothing. Also: the single-instance
//! lock, and a folder without a devcontainer working while only the CLI is missing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use agentbook_core::pins::{DEVCONTAINERS_CLI_VERSION, NODE_VERSION};
use agentbook_core::state::EquipmentRef;
use agentbook_engine::{
    ActionState, Command, DependencyId, DependencyState, EngineStartError, Snapshot,
};

use crate::server::Fault;
use crate::stand::{Stand, StepResult, ensure};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

/// The data folder later steps (AC-6) reuse, with every dependency in place.
pub fn data_dir(stand: &Stand) -> PathBuf {
    stand.root.join("data")
}

fn dep_state(s: &Snapshot, id: DependencyId) -> Option<DependencyState> {
    s.dependency(id).map(|d| d.state.clone())
}

/// No file of the CLI is in use: no extracted folder, no archive, no part file.
fn no_cli_files(data: &Path) -> StepResult {
    let deps = data.join("deps");
    let cli_dir = deps.join(format!("devcontainers-cli-{DEVCONTAINERS_CLI_VERSION}"));
    ensure(!cli_dir.exists(), format!("{} exists", cli_dir.display()))?;
    let leftovers: Vec<String> = std::fs::read_dir(&deps)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("cli-") || n.ends_with(".part") || n.ends_with(".tmp"))
                .collect()
        })
        .unwrap_or_default();
    ensure(
        leftovers.is_empty(),
        format!("half-downloaded files left: {leftovers:?}"),
    )
}

pub fn run(stand: &Stand) -> StepResult {
    stand.fill_cache()?;
    let data = data_dir(stand);
    let cli_file = format!("cli-{DEVCONTAINERS_CLI_VERSION}.tgz");

    // A folder without a devcontainer and its laptop, for the "only the CLI is missing" check.
    let plain = stand.root.join("plain-notes");
    stand.write_files(&plain, &[("notes.txt", "plain notes\n")])?;
    let folder = stand.folder(&plain, EquipmentRef::standard());
    let laptop = stand.laptop(&folder, "Notes");
    let laptop_id = laptop.id.clone();
    stand.edit_state(&data, |s| {
        s.folders.push(folder);
        s.laptops.push(laptop);
    })?;

    println!("  AC-17: first launch lists the dependencies");
    stand.server.set_fault(&cli_file, Some(Fault::Corrupt));
    let engine = stand.engine(&data)?;
    stand.wait_snapshot(
        &engine,
        Duration::from_secs(60),
        "the first dependency check",
        |s| {
            s.dependencies.len() == 3
                && dep_state(s, DependencyId::Node) == Some(DependencyState::Missing)
                && dep_state(s, DependencyId::DevcontainersCli) == Some(DependencyState::Missing)
        },
    )?;
    let snap = engine.snapshot();
    for d in &snap.dependencies {
        ensure(
            !d.name.is_empty() && !d.version.is_empty() && d.size > 0,
            format!("dependency without name, version or size: {d:?}"),
        )?;
    }
    ensure(
        snap.dependency(DependencyId::Node)
            .map(|d| d.version.as_str())
            == Some(NODE_VERSION),
        "Node is not listed with its pinned version",
    )?;

    println!("  AC-17: single-instance lock");
    match stand.engine(&data) {
        Err(e) if e.contains(&EngineStartError::AlreadyRunning.to_string()) => {}
        Err(e) => return Err(format!("a second engine failed differently: {e}")),
        Ok(_) => return Err("a second engine started on the same data folder".into()),
    }

    println!("  AC-17: checksum mismatch");
    let id = engine.run(Command::DownloadDependencies);
    let view = stand.wait(&engine, id, DOWNLOAD_TIMEOUT)?;
    let ActionState::Failed { message } = &view.state else {
        return Err(format!(
            "download with a corrupted CLI did not fail: {view:?}"
        ));
    };
    ensure(
        message.contains("did not match its checksum") && message.contains("Retry"),
        format!("unexpected mismatch message: {message}"),
    )?;
    let snap = engine.snapshot();
    ensure(
        matches!(
            dep_state(&snap, DependencyId::DevcontainersCli),
            Some(DependencyState::Failed(_))
        ),
        "the CLI is not marked failed",
    )?;
    ensure(
        dep_state(&snap, DependencyId::Node) == Some(DependencyState::Ready),
        format!(
            "Node is not ready: {:?}",
            snap.dependency(DependencyId::Node)
        ),
    )?;
    ensure(
        dep_state(&snap, DependencyId::StandardEquipment) == Some(DependencyState::Ready),
        format!(
            "the standard Equipment is not ready: {:?}",
            snap.dependency(DependencyId::StandardEquipment)
        ),
    )?;
    no_cli_files(&data)?;

    println!("  AC-17: a folder without a devcontainer works while the CLI is missing");
    let id = engine.run(Command::GetEquipment {
        laptop: laptop_id.clone(),
    });
    let view = stand.wait(&engine, id, DOWNLOAD_TIMEOUT)?;
    ensure(
        view.state == ActionState::Done,
        format!(
            "standard laptop failed: {:?}\n{}",
            view.state,
            view.log_tail.join("\n")
        ),
    )?;
    let c = stand.running_container(&laptop_id)?;
    let (code, out) = stand.exec(
        &c.id,
        "0",
        "cat /usr/local/share/agentbook/libc; ls /work/plain-notes",
    )?;
    ensure(
        code == 0 && out.contains("glibc") && out.contains("notes.txt"),
        format!("standard laptop content: {out}"),
    )?;

    println!("  AC-17: connection cut mid-download");
    stand.server.set_fault(&cli_file, Some(Fault::Cut));
    let id = engine.run(Command::DownloadDependencies);
    let view = stand.wait(&engine, id, DOWNLOAD_TIMEOUT)?;
    let ActionState::Failed { message } = &view.state else {
        return Err(format!(
            "download with a cut connection did not fail: {view:?}"
        ));
    };
    ensure(
        message.contains("Could not download") && message.contains("Retry"),
        format!("unexpected cut message: {message}"),
    )?;
    no_cli_files(&data)?;

    println!("  AC-17: Retry");
    stand.server.set_fault(&cli_file, None);
    let id = engine.run(Command::DownloadDependencies);
    let view = stand.wait(&engine, id, DOWNLOAD_TIMEOUT)?;
    ensure(
        view.state == ActionState::Done,
        format!("Retry failed: {:?}", view.state),
    )?;
    let snap = engine.snapshot();
    ensure(
        snap.dependencies
            .iter()
            .all(|d| d.state == DependencyState::Ready),
        format!("not every dependency is ready: {:?}", snap.dependencies),
    )?;
    drop(engine);

    println!("  AC-17: the second launch downloads nothing");
    let before = stand.server.total_requests();
    let engine = stand.engine(&data)?;
    stand.wait_snapshot(
        &engine,
        Duration::from_secs(60),
        "every dependency ready",
        |s| {
            s.dependencies
                .iter()
                .all(|d| d.state == DependencyState::Ready)
        },
    )?;
    let id = engine.run(Command::DownloadDependencies);
    let view = stand.wait(&engine, id, Duration::from_secs(120))?;
    ensure(
        view.state == ActionState::Done,
        format!("second launch download: {:?}", view.state),
    )?;
    ensure(
        stand.server.total_requests() == before,
        "the second launch downloaded again",
    )?;
    Ok(())
}
