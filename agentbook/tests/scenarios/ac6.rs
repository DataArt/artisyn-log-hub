//! AC-6 (FR-7), build level: project Equipment built through the engine and checked with
//! `docker exec`.
//!
//! - a Dockerfile devcontainer that installs a tool off the default `PATH` gives the laptop that
//!   tool (through `base.env`, as SSH sessions see it), runs `postCreateCommand` once, carries the
//!   tool's labels, port and mounts; its first build shows the steps;
//! - its `docker.sock` mount is named in the host-exposure warning and the laptop still starts;
//! - a second laptop of the folder starts from the cached images;
//! - after `devcontainer.json` is edited the laptop shows "Equipment changed", and Update laptop
//!   recreates it with the volume kept;
//! - a broken Dockerfile during Update leaves the old container working; on a first build it
//!   leaves no container, with the log tail, and Retry works once it is fixed;
//! - Debian → Alpine: Update records the new libc and clears `~/.claude/remote/ccd-cli`, keeping
//!   the rest of the home folder;
//! - compose: the sidecar runs, and a failed Update rolls back to the previous generation.
//!
//! On a Docker engine inside WSL (`DOCKER_HOST=wsl://<distro>`) the folder's Equipment check
//! fails with the plain "not supported yet" message instead, and compose is skipped.
//!
//! Fixtures are plain-file / JS projects written here, with no `.claude/` folder.

use std::path::Path;
use std::time::Duration;

use agentbook_core::equipment::EquipmentState;
use agentbook_core::state::{EquipmentRef, Libc};
use agentbook_engine::docker::{containers, label_filter};
use agentbook_engine::{ActionState, ActionView, Command, Engine};

use crate::ac17;
use crate::stand::{Stand, StepResult, ensure};

pub const BUILD_TIMEOUT: Duration = Duration::from_secs(1800);

const DEBIAN_JSON: &str = r#"{
  "name": "proj-debian",
  "build": { "dockerfile": "Dockerfile" },
  "containerEnv": { "PROJ_MODE": "one" },
  "mounts": [ "source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind" ],
  "postCreateCommand": "echo created >> /tmp/postcreate.log"
}
"#;

const DEBIAN_JSON_EDITED: &str = r#"{
  "name": "proj-debian",
  "build": { "dockerfile": "Dockerfile" },
  "containerEnv": { "PROJ_MODE": "two" },
  "mounts": [ "source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind" ],
  "postCreateCommand": "echo created >> /tmp/postcreate.log"
}
"#;

pub const DEBIAN_DOCKERFILE: &str = "FROM debian:bookworm-slim\n\
RUN mkdir -p /opt/projtool/bin \\\n \
 && printf '#!/bin/sh\\necho projtool-ok\\n' > /opt/projtool/bin/projtool \\\n \
 && chmod 755 /opt/projtool/bin/projtool\n\
ENV PATH=/opt/projtool/bin:$PATH\n";

const BROKEN_LINE: &str = "RUN echo 'this build is broken on purpose' && exit 3\n";

pub const PACKAGE_JSON: &str =
    "{ \"name\": \"fixture\", \"version\": \"1.0.0\", \"private\": true }\n";
pub const INDEX_JS: &str = "console.log('fixture');\n";

const COMPOSE_JSON: &str = r#"{
  "name": "proj-compose",
  "dockerComposeFile": "compose.yml",
  "service": "app",
  "workspaceFolder": "/work/proj-compose",
  "postCreateCommand": "echo created >> /tmp/postcreate.log"
}
"#;

const COMPOSE_JSON_BROKEN: &str = r#"{
  "name": "proj-compose",
  "dockerComposeFile": "compose.yml",
  "service": "app",
  "workspaceFolder": "/work/proj-compose",
  "postCreateCommand": "echo broken-on-purpose && exit 7"
}
"#;

const COMPOSE_YML: &str = "services:\n  app:\n    image: debian:bookworm-slim\n    command: sleep infinity\n    volumes:\n      - ..:/work/proj-compose:cached\n  db:\n    image: alpine:3.20\n    command: sleep infinity\n";

fn image_json(image: &str) -> String {
    format!("{{\n  \"name\": \"proj-switch\",\n  \"image\": \"{image}\"\n}}\n")
}

fn run_action(stand: &Stand, engine: &Engine, cmd: Command) -> Result<ActionView, String> {
    let id = engine.run(cmd);
    stand.wait(engine, id, BUILD_TIMEOUT)
}

fn expect_done(view: &ActionView, what: &str) -> StepResult {
    ensure(
        view.state == ActionState::Done,
        format!("{what}: {:?}\n{}", view.state, view.log_tail.join("\n")),
    )
}

fn log_text(view: &ActionView) -> String {
    view.log_file
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

fn equipment_of(engine: &Engine, laptop: &str) -> Option<EquipmentState> {
    engine.snapshot().laptop(laptop).and_then(|l| l.equipment)
}

/// The workspace laptop runs as `claude`; checks run through `base.env` like an SSH session.
fn in_session(stand: &Stand, container: &str, script: &str) -> Result<String, String> {
    let (code, out) = stand.exec(
        container,
        "0",
        &format!(". /run/agentbook/base.env; {script}"),
    )?;
    ensure(code == 0, format!("`{script}` exited {code}: {out}"))?;
    Ok(out)
}

/// The dependencies in place (also when AC-6 runs on its own with `--only ac6`).
pub fn ensure_dependencies(stand: &Stand, data: &Path) -> StepResult {
    stand.fill_cache()?;
    let engine = stand.engine(data)?;
    let view = run_action(stand, &engine, Command::DownloadDependencies)?;
    expect_done(&view, "downloading the dependencies")
}

pub fn run(stand: &Stand) -> StepResult {
    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;

    let debian = stand.root.join("proj-debian");
    stand.write_files(
        &debian,
        &[
            (".devcontainer/devcontainer.json", DEBIAN_JSON),
            (".devcontainer/Dockerfile", DEBIAN_DOCKERFILE),
            ("package.json", PACKAGE_JSON),
            ("index.js", INDEX_JS),
        ],
    )?;
    let switch = stand.root.join("proj-switch");
    stand.write_files(
        &switch,
        &[
            (
                ".devcontainer/devcontainer.json",
                &image_json("debian:bookworm-slim"),
            ),
            ("index.js", INDEX_JS),
        ],
    )?;
    let config = ".devcontainer/devcontainer.json";
    let f_debian = stand.folder(&debian, EquipmentRef::project(config));
    let f_switch = stand.folder(&switch, EquipmentRef::project(config));
    let l1 = stand.laptop(&f_debian, "Q3 reports");
    let l2 = stand.laptop(&f_debian, "Second");
    let l3 = stand.laptop(&f_debian, "Third");
    let l4 = stand.laptop(&f_switch, "Switch");
    let [id1, id2, id3, id4] = [&l1.id, &l2.id, &l3.id, &l4.id].map(|s| s.clone());
    let fid_debian = f_debian.id.clone();
    let port1 = l1.port;
    stand.edit_state(&data, |s| {
        s.folders.extend([f_debian, f_switch]);
        s.laptops.extend([l1, l2, l3, l4]);
    })?;
    let engine = stand.engine(&data)?;

    println!("  AC-6: docker.sock warning at start");
    stand.wait_snapshot(
        &engine,
        Duration::from_secs(300),
        "the start-up Equipment check",
        |s| {
            s.folder(&fid_debian)
                .is_some_and(|f| f.equipment.hash.is_some() || f.equipment.error.is_some())
        },
    )?;
    let snap = engine.snapshot();
    let folder = snap.folder(&fid_debian).ok_or("folder missing")?;
    if stand.wsl {
        println!("  WSL: a project devcontainer is refused with the plain message");
        let error = folder.equipment.error.clone().unwrap_or_default();
        return ensure(
            error.contains("not supported yet with a Docker engine inside WSL"),
            format!("expected the WSL refusal, got {:?}", folder.equipment.error),
        );
    }
    ensure(
        folder.equipment.error.is_none(),
        format!("Equipment check failed: {:?}", folder.equipment.error),
    )?;
    ensure(
        folder
            .equipment
            .exposures
            .iter()
            .any(|e| e.kind == "docker-socket" && e.text.contains("docker.sock")),
        format!("no docker.sock warning: {:?}", folder.equipment.exposures),
    )?;
    ensure(
        equipment_of(&engine, &id1) == Some(EquipmentState::NotBuilt),
        "a new laptop is not 'not built'",
    )?;

    println!("  AC-6: first build of a Dockerfile devcontainer");
    let view = run_action(
        stand,
        &engine,
        Command::GetEquipment {
            laptop: id1.clone(),
        },
    )?;
    expect_done(&view, "first build")?;
    ensure(
        view.steps_total == 4 && view.step_index == 4,
        format!("steps not shown: {}/{}", view.step_index, view.steps_total),
    )?;
    let c1 = stand.running_container(&id1)?;
    for (k, v) in [
        ("artisyn.agentbook", "1"),
        ("artisyn.agentbook.laptop", id1.as_str()),
        ("artisyn.agentbook.gen", "1"),
        ("artisyn.agentbook.instance", stand.instance.as_str()),
    ] {
        ensure(
            c1.labels.get(k).map(String::as_str) == Some(v),
            format!("label {k} is {:?}", c1.labels.get(k)),
        )?;
    }
    let out = in_session(
        stand,
        &c1.id,
        "command -v projtool; projtool; echo mode=$PROJ_MODE",
    )?;
    ensure(
        out.contains("/opt/projtool/bin/projtool")
            && out.contains("projtool-ok")
            && out.contains("mode=one"),
        format!("project tool not visible to a session: {out}"),
    )?;
    let out = in_session(
        stand,
        &c1.id,
        "wc -l < /tmp/postcreate.log; id -un claude; ls /work/proj-debian; test -S /var/run/docker.sock && echo sock-ok; touch /opt/agentbook/bin/x 2>/dev/null || echo bin-ro",
    )?;
    ensure(
        out.lines().next().map(str::trim) == Some("1")
            && out.contains("claude")
            && out.contains("package.json")
            && out.contains("sock-ok")
            && out.contains("bin-ro"),
        format!("laptop content: {out}"),
    )?;
    let inspect = stand
        .rt
        .block_on(stand.docker.inspect_container(&c1.id, None))
        .map_err(|e| e.to_string())?;
    let binding = inspect
        .host_config
        .and_then(|h| h.port_bindings)
        .and_then(|p| p.get("22/tcp").cloned().flatten())
        .and_then(|b| b.into_iter().next())
        .ok_or("port 22 is not published")?;
    ensure(
        binding.host_ip.as_deref() == Some("127.0.0.1")
            && binding.host_port.as_deref() == Some(port1.to_string().as_str()),
        format!("port 22 published as {binding:?}"),
    )?;
    ensure(
        equipment_of(&engine, &id1) == Some(EquipmentState::Current),
        "the built laptop is not current",
    )?;

    println!("  AC-6: second laptop starts from the cache");
    let view = run_action(
        stand,
        &engine,
        Command::GetEquipment {
            laptop: id2.clone(),
        },
    )?;
    expect_done(&view, "cached start")?;
    let log = log_text(&view);
    ensure(
        log.contains("Using the cached Equipment") && log.contains("Using the cached laptop layer"),
        "the second laptop rebuilt instead of using the cache",
    )?;
    stand.running_container(&id2)?;

    println!("  AC-6: Equipment changed -> Update laptop keeps the volume");
    let (code, out) = stand.exec(
        &c1.id,
        "0",
        "mkdir -p /home/claude/.claude/remote/ccd-cli && echo keep > /home/claude/keep.txt",
    )?;
    ensure(code == 0, format!("writing to the volume: {out}"))?;
    stand.write_files(
        &debian,
        &[(".devcontainer/devcontainer.json", DEBIAN_JSON_EDITED)],
    )?;
    let view = run_action(
        stand,
        &engine,
        Command::CheckEquipment {
            folder: Some(fid_debian.clone()),
        },
    )?;
    expect_done(&view, "Equipment check")?;
    ensure(
        equipment_of(&engine, &id1) == Some(EquipmentState::Changed),
        format!(
            "expected 'Equipment changed', got {:?}",
            equipment_of(&engine, &id1)
        ),
    )?;
    let view = run_action(
        stand,
        &engine,
        Command::UpdateLaptop {
            laptop: id1.clone(),
        },
    )?;
    expect_done(&view, "Update laptop")?;
    let c1b = stand.running_container(&id1)?;
    ensure(
        c1b.id != c1.id && c1b.labels.get("artisyn.agentbook.gen").map(String::as_str) == Some("2"),
        "Update did not replace the container with generation 2",
    )?;
    let out = in_session(
        stand,
        &c1b.id,
        "cat /home/claude/keep.txt; echo mode=$PROJ_MODE; test -d /home/claude/.claude/remote/ccd-cli && echo ccd-kept",
    )?;
    ensure(
        out.contains("keep") && out.contains("mode=two") && out.contains("ccd-kept"),
        format!("after Update: {out}"),
    )?;
    ensure(
        equipment_of(&engine, &id1) == Some(EquipmentState::Current),
        "the updated laptop is not current",
    )?;

    println!("  AC-6: a broken Dockerfile during Update leaves the old laptop working");
    let dockerfile = debian.join(".devcontainer").join("Dockerfile");
    std::fs::write(&dockerfile, format!("{DEBIAN_DOCKERFILE}{BROKEN_LINE}"))
        .map_err(|e| e.to_string())?;
    let view = run_action(
        stand,
        &engine,
        Command::UpdateLaptop {
            laptop: id1.clone(),
        },
    )?;
    ensure(
        matches!(&view.state, ActionState::Failed { message } if message.contains("Retry")),
        format!("broken Update did not fail with Retry: {:?}", view.state),
    )?;
    ensure(
        !view.log_tail.is_empty(),
        "no log tail after a failed build",
    )?;
    let still = stand.running_container(&id1)?;
    ensure(still.id == c1b.id, "the old container was replaced")?;

    println!("  AC-6: a broken Dockerfile on a first build, then Retry");
    let view = run_action(
        stand,
        &engine,
        Command::GetEquipment {
            laptop: id3.clone(),
        },
    )?;
    ensure(
        matches!(view.state, ActionState::Failed { .. }) && !view.log_tail.is_empty(),
        format!("broken first build: {:?}", view.state),
    )?;
    ensure(
        stand.containers_of(&id3).is_empty(),
        "a broken first build left a container",
    )?;
    std::fs::write(&dockerfile, DEBIAN_DOCKERFILE).map_err(|e| e.to_string())?;
    let view = run_action(
        stand,
        &engine,
        Command::GetEquipment {
            laptop: id3.clone(),
        },
    )?;
    expect_done(&view, "Retry after a fixed Dockerfile")?;
    stand.running_container(&id3)?;

    libc_switch(stand, &engine, &switch, &id4)?;
    Ok(())
}

fn libc_switch(stand: &Stand, engine: &Engine, switch: &Path, id4: &str) -> StepResult {
    println!("  AC-6: Debian -> Alpine clears the CLI and keeps the volume");
    let view = run_action(
        stand,
        engine,
        Command::GetEquipment {
            laptop: id4.to_string(),
        },
    )?;
    expect_done(&view, "Debian laptop")?;
    let c = stand.running_container(id4)?;
    let (code, out) = stand.exec(
        &c.id,
        "0",
        "mkdir -p /home/claude/.claude/remote/ccd-cli && echo x > /home/claude/.claude/remote/ccd-cli/cli && echo keep > /home/claude/keep.txt",
    )?;
    ensure(code == 0, format!("writing to the volume: {out}"))?;
    stand.write_files(
        switch,
        &[(
            ".devcontainer/devcontainer.json",
            &image_json("alpine:3.20"),
        )],
    )?;
    let view = run_action(
        stand,
        engine,
        Command::UpdateLaptop {
            laptop: id4.to_string(),
        },
    )?;
    expect_done(&view, "Update to Alpine")?;
    let c = stand.running_container(id4)?;
    let out = in_session(
        stand,
        &c.id,
        "cat /usr/local/share/agentbook/libc; cat /home/claude/keep.txt; test -e /home/claude/.claude/remote/ccd-cli && echo ccd-left || echo ccd-cleared",
    )?;
    ensure(
        out.contains("musl") && out.contains("keep") && out.contains("ccd-cleared"),
        format!("after the libc switch: {out}"),
    )?;
    let libc = engine
        .snapshot()
        .laptop(id4)
        .and_then(|l| l.laptop.libc.clone());
    ensure(libc == Some(Libc::Musl), format!("recorded libc {libc:?}"))
}

/// AC-6, compose: the sidecar runs, lifecycle commands run once, and a failed Update rolls back
/// to the previous generation with the sidecar kept.
pub fn run_compose(stand: &Stand) -> StepResult {
    if stand.wsl {
        println!("  WSL: project devcontainers are refused (checked in ac6); compose skipped");
        return Ok(());
    }
    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;
    let compose = stand.root.join("proj-compose");
    stand.write_files(
        &compose,
        &[
            (".devcontainer/devcontainer.json", COMPOSE_JSON),
            (".devcontainer/compose.yml", COMPOSE_YML),
            ("index.js", INDEX_JS),
        ],
    )?;
    let folder = stand.folder(
        &compose,
        EquipmentRef::project(".devcontainer/devcontainer.json"),
    );
    let laptop = stand.laptop(&folder, "Compose");
    let id5 = laptop.id.clone();
    stand.edit_state(&data, |s| {
        s.folders.push(folder);
        s.laptops.push(laptop);
    })?;
    let engine = stand.engine(&data)?;
    compose_rollback(stand, &engine, &compose, &id5)
}

fn compose_rollback(stand: &Stand, engine: &Engine, compose: &Path, id5: &str) -> StepResult {
    println!("  AC-6: compose laptop with a sidecar, then a failed Update rolls back");
    let view = run_action(
        stand,
        engine,
        Command::GetEquipment {
            laptop: id5.to_string(),
        },
    )?;
    expect_done(&view, "compose laptop")?;
    let first_log = log_text(&view);
    let app = stand.running_container(id5)?;
    let project = format!("agentbook-{id5}");
    let sidecar_running = || -> bool {
        stand
            .rt
            .block_on(containers::list_by_labels(
                &stand.docker,
                &label_filter(&[
                    ("com.docker.compose.project", project.as_str()),
                    ("com.docker.compose.service", "db"),
                ]),
            ))
            .unwrap_or_default()
            .iter()
            .any(|c| c.running())
    };
    ensure(sidecar_running(), "the compose sidecar is not running")?;
    let out = in_session(
        stand,
        &app.id,
        "ls /work/proj-compose; wc -l < /tmp/postcreate.log",
    )?;
    ensure(
        out.contains("index.js") && out.lines().last().map(str::trim) == Some("1"),
        format!("compose workspace and postCreateCommand: {out}"),
    )?;

    stand.write_files(
        compose,
        &[(".devcontainer/devcontainer.json", COMPOSE_JSON_BROKEN)],
    )?;
    let view = run_action(
        stand,
        engine,
        Command::UpdateLaptop {
            laptop: id5.to_string(),
        },
    )?;
    ensure(
        matches!(view.state, ActionState::Failed { .. }),
        format!(
            "a failing postCreateCommand did not fail the Update: {:?}\n{first_log}\n----\n{}",
            view.state,
            log_text(&view)
        ),
    )?;
    let back = stand.running_container(id5)?;
    ensure(
        back.labels.get("artisyn.agentbook.gen").map(String::as_str) == Some("1"),
        format!(
            "not rolled back to generation 1: {:?}",
            back.labels.get("artisyn.agentbook.gen")
        ),
    )?;
    ensure(sidecar_running(), "the sidecar is gone after the rollback")?;
    let generation = engine.snapshot().laptop(id5).map(|l| l.laptop.generation);
    ensure(
        generation == Some(1),
        format!("recorded generation {generation:?}"),
    )
}
