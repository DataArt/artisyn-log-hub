//! AC-7a (FR-4, FR-4a, FR-4b) and AC-6 over ssh: laptops on different bases, connected with
//! their aliases as Desktop does.
//!
//! - a plain Debian image and an Alpine image both connect;
//! - `remoteUser: root` connects as root with the key, a password login is refused, and a file
//!   it creates in the shared folder can be renamed and deleted on the host;
//! - a scratch-based devcontainer gets the plain "cannot add the laptop layer" message (its own
//!   step, `ac7a-scratch`);
//! - after `docker restart` from outside the tool the alias connects with the same host key;
//! - AC-6: a project tool installed off the default `PATH` works in an ssh session.

use agentbook_core::paths::ssh_alias;
use agentbook_engine::Command;
use agentbook_engine::docker::{containers, images};

use crate::ac6::{BUILD_TIMEOUT, DEBIAN_DOCKERFILE, INDEX_JS, ensure_dependencies};
use crate::ac17;
use crate::laptops::{add_folder, get_laptop, known_hosts, laptop_view, password_refused};
use crate::stand::{Stand, StepResult, ensure};

const CONFIG: &str = ".devcontainer/devcontainer.json";

fn image_json(name: &str, image: &str, extra: &str) -> String {
    format!("{{\n  \"name\": \"{name}\",\n  \"image\": \"{image}\"{extra}\n}}\n")
}

pub fn run(stand: &Stand) -> StepResult {
    if stand.wsl {
        println!(
            "  WSL: image devcontainers need a project devcontainer, refused there (see ac6); skipped"
        );
        return Ok(());
    }

    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;
    let deb = stand.root.join("img-debian");
    stand.write_files(
        &deb,
        &[
            (
                CONFIG,
                &image_json("img-debian", "debian:bookworm-slim", ""),
            ),
            ("index.js", INDEX_JS),
        ],
    )?;
    let alp = stand.root.join("img-alpine");
    stand.write_files(
        &alp,
        &[
            (CONFIG, &image_json("img-alpine", "alpine:3.20", "")),
            ("index.js", INDEX_JS),
        ],
    )?;
    let root = stand.root.join("img-root");
    stand.write_files(
        &root,
        &[
            (
                CONFIG,
                &image_json(
                    "img-root",
                    "debian:bookworm-slim",
                    ",\n  \"remoteUser\": \"root\"",
                ),
            ),
            ("index.js", INDEX_JS),
        ],
    )?;
    let tool = stand.root.join("img-tool");
    stand.write_files(
        &tool,
        &[
            (
                CONFIG,
                "{\n  \"name\": \"img-tool\",\n  \"build\": { \"dockerfile\": \"Dockerfile\" },\n  \"containerEnv\": { \"PROJ_MODE\": \"one\" }\n}\n",
            ),
            (".devcontainer/Dockerfile", DEBIAN_DOCKERFILE),
            ("index.js", INDEX_JS),
        ],
    )?;
    let engine = stand.engine(&data)?;

    println!("  AC-7a: Debian and Alpine connect");
    let f_deb = add_folder(stand, &engine, &deb)?;
    let l_deb = get_laptop(stand, &engine, &f_deb, "Debian", Vec::new(), BUILD_TIMEOUT)?;
    let out = stand.ssh_ok(
        &ssh_alias(&l_deb),
        "cat /etc/os-release; id -un; ls /work/img-debian",
    )?;
    ensure(
        out.contains("Debian") && out.contains("claude") && out.contains("index.js"),
        format!("Debian laptop: {out}"),
    )?;
    let f_alp = add_folder(stand, &engine, &alp)?;
    let l_alp = get_laptop(stand, &engine, &f_alp, "Alpine", Vec::new(), BUILD_TIMEOUT)?;
    let out = stand.ssh_ok(&ssh_alias(&l_alp), "cat /etc/os-release; id -un; ws whoami")?;
    ensure(
        out.contains("Alpine")
            && out.contains("claude")
            && out.contains("I'm on laptop \"Alpine\""),
        format!("Alpine laptop: {out}"),
    )?;

    println!("  AC-7a: remoteUser root");
    let f_root = add_folder(stand, &engine, &root)?;
    let l_root = get_laptop(stand, &engine, &f_root, "Root", Vec::new(), BUILD_TIMEOUT)?;
    let out = stand.ssh_ok(
        &ssh_alias(&l_root),
        "id -u; echo by-root > /work/img-root/root-made.txt; ls ~/.claude",
    )?;
    ensure(
        out.lines().next().map(str::trim) == Some("0") && out.contains("CLAUDE.md"),
        format!("root laptop: {out}"),
    )?;
    password_refused(stand, laptop_view(&engine, &l_root)?.laptop.port, "root")?;
    let made = root.join("root-made.txt");
    let renamed = root.join("root-renamed.txt");
    ensure(
        std::fs::read_to_string(&made).is_ok_and(|t| t.contains("by-root")),
        "the root-made file is not readable on the host",
    )?;
    std::fs::write(&made, "edited on the host\n").map_err(|e| format!("edit: {e}"))?;
    std::fs::rename(&made, &renamed).map_err(|e| format!("rename: {e}"))?;
    std::fs::remove_file(&renamed).map_err(|e| format!("delete: {e}"))?;

    println!("  AC-7a: docker restart keeps the host key");
    let known = known_hosts(stand, &l_deb);
    let c = stand.running_container(&l_deb)?;
    stand
        .rt
        .block_on(containers::restart(&stand.docker, &c.id))
        .map_err(|e| e.to_string())?;
    stand.ssh_ok(&ssh_alias(&l_deb), "true")?;
    ensure(
        known_hosts(stand, &l_deb) == known,
        "the known_hosts file changed",
    )?;

    println!("  AC-6: a project tool off the default PATH over ssh");
    let f_tool = add_folder(stand, &engine, &tool)?;
    let l_tool = get_laptop(stand, &engine, &f_tool, "Tool", Vec::new(), BUILD_TIMEOUT)?;
    let out = stand.ssh_ok(
        &ssh_alias(&l_tool),
        "command -v projtool; projtool; echo mode=$PROJ_MODE",
    )?;
    ensure(
        out.contains("/opt/projtool/bin/projtool")
            && out.contains("projtool-ok")
            && out.contains("mode=one"),
        format!("project tool over ssh: {out}"),
    )
}

/// AC-7a: a devcontainer on a scratch-based image (built here: the devcontainer CLI cannot read a
/// Dockerfile whose base is `scratch` itself) gets the plain "cannot add the laptop layer"
/// message and no container.
pub fn run_scratch(stand: &Stand) -> StepResult {
    if stand.wsl {
        println!(
            "  WSL: image devcontainers need a project devcontainer, refused there (see ac6); skipped"
        );
        return Ok(());
    }

    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;
    let tag = format!("agentbook-scn-scratch:{}", stand.instance);
    let context = images::context_tar(&[
        (
            "Dockerfile".to_string(),
            b"FROM scratch\nCOPY marker.txt /marker.txt\n".to_vec(),
            0o644,
        ),
        ("marker.txt".to_string(), b"scratch\n".to_vec(), 0o644),
    ])
    .map_err(|e| e.to_string())?;
    stand
        .rt
        .block_on(images::build(
            &stand.docker,
            images::BuildSpec {
                tag: tag.clone(),
                context,
                build_args: Vec::new(),
                labels: stand.test_config_labels(),
            },
            |_| {},
        ))
        .map_err(|e| format!("building the scratch image: {e}"))?;
    let scratch = stand.root.join("img-scratch");
    stand.write_files(
        &scratch,
        &[
            (CONFIG, &image_json("img-scratch", &tag, "")),
            ("index.js", INDEX_JS),
        ],
    )?;
    let engine = stand.engine(&data)?;
    println!("  AC-7a: a scratch image gets the plain message");
    let f_scratch = add_folder(stand, &engine, &scratch)?;
    let view = stand.act(
        &engine,
        Command::GetLaptop {
            folder: f_scratch.clone(),
            name: "Scratch".into(),
            given: Vec::new(),
            copy_from: None,
            confirm_broad: false,
        },
        BUILD_TIMEOUT,
    )?;
    let message = match &view.state {
        agentbook_engine::ActionState::Failed { message } => message.clone(),
        other => return Err(format!("a scratch image did not fail: {other:?}")),
    };
    ensure(
        message.contains("cannot add the laptop layer"),
        format!("scratch image: {message}\n{}", view.log_tail.join("\n")),
    )?;
    let laptop = view.laptop.clone().unwrap_or_default();
    ensure(
        stand.containers_of(&laptop).is_empty(),
        "a failed layer left a container",
    )
}
