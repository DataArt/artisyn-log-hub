//! The laptop lifecycle on the standard Equipment, checked over ssh with each laptop's alias:
//!
//! - AC-2: a folder with two `.claude/` folders asks once; the answer is remembered after a
//!   restart and used for the Desktop link;
//! - AC-1: a folder with two git repos opens in one step (the link names the alias and the
//!   folder); its `.claude/` and the host's user skills are there, `.credentials.json` is not;
//!   a 4th and 5th laptop come with no note and no limit;
//! - AC-3: an edit inside shows on the host at once, `git status` matches, an install stays inside;
//! - AC-4a: an attached session is counted on its laptop only; `ws whoami` lists the others;
//!   Claude Desktop's first-time setup of Claude on the laptop shows on its card;
//! - AC-10: a rename reaches `ws whoami` and the prompt hook without a restart; a duplicate name
//!   is saved with a note; the alias never changes;
//! - AC-14: given folders chosen in Get a laptop are there from the first session, View only holds;
//! - AC-15: Another laptop like this copies given folders, modes and per-laptop variables, never
//!   the volume;
//! - AC-11: Sleep, Wake up (no Desktop), Open on a sleeping laptop, a stop outside the tool;
//! - AC-4: reopening keeps the host key and the volume;
//! - AC-12: SSH only on loopback, password login refused;
//! - AC-18: a port clash at Open moves the laptop and rewrites only its alias block;
//! - AC-19: a state file with unknown fields and old tool files: the laptop opens, `ws` works and
//!   the unknown fields survive a write.

use std::path::Path;
use std::time::Duration;

use agentbook_core::paths::{claude_link, ssh_alias};
use agentbook_engine::docker::containers;
use agentbook_engine::{
    ActionView, Command, Engine, GivenInput, LaptopView, RunState, Secret, VarEdit, VarInput,
};
use agentbook_platform::Platform;
use serde_json::Value;

use crate::ac6::ensure_dependencies;
use crate::ac17;
use crate::stand::{Stand, StepResult, ensure};

/// Standard-Equipment actions (no build).
pub const T: Duration = Duration::from_secs(600);

pub fn laptop_of(view: &ActionView) -> Result<String, String> {
    view.laptop
        .clone()
        .ok_or_else(|| "the action names no laptop".into())
}

pub fn folder_of(view: &ActionView) -> Result<String, String> {
    view.folder
        .clone()
        .ok_or_else(|| "the action names no folder".into())
}

pub fn laptop_view(engine: &Engine, id: &str) -> Result<LaptopView, String> {
    engine
        .snapshot()
        .laptop(id)
        .cloned()
        .ok_or_else(|| format!("laptop {id} is not in the snapshot"))
}

pub fn add_folder(stand: &Stand, engine: &Engine, path: &Path) -> Result<String, String> {
    let view = stand.act_ok(
        engine,
        Command::AddFolder {
            path: path.to_string_lossy().into_owned(),
            config: None,
            confirm_broad: false,
        },
        T,
    )?;
    folder_of(&view)
}

pub fn get_laptop(
    stand: &Stand,
    engine: &Engine,
    folder: &str,
    name: &str,
    given: Vec<GivenInput>,
    timeout: Duration,
) -> Result<String, String> {
    let view = stand.act_ok(
        engine,
        Command::GetLaptop {
            folder: folder.to_string(),
            name: name.to_string(),
            given,
            copy_from: None,
            confirm_broad: false,
        },
        timeout,
    )?;
    laptop_of(&view)
}

/// The laptop's block in the tool-owned ssh config.
pub fn alias_block(stand: &Stand, id: &str) -> String {
    let text = std::fs::read_to_string(stand.ssh_config()).unwrap_or_default();
    let alias = ssh_alias(id);
    let begin = format!("# >>> {alias}");
    let end = format!("# <<< {alias}");
    match (text.find(&begin), text.find(&end)) {
        (Some(a), Some(b)) => text[a..b + end.len()].to_string(),
        _ => String::new(),
    }
}

pub fn known_hosts(stand: &Stand, id: &str) -> String {
    std::fs::read_to_string(
        stand
            .ssh_dir()
            .join("agentbook")
            .join(format!("known_hosts_{}", ssh_alias(id))),
    )
    .unwrap_or_default()
}

pub fn wait_run(
    stand: &Stand,
    engine: &Engine,
    id: &str,
    run: RunState,
    timeout: Duration,
) -> StepResult {
    stand.wait_snapshot(engine, timeout, &format!("{id} to be {run:?}"), |s| {
        s.laptop(id).is_some_and(|l| l.run == run)
    })
}

/// Claude Desktop's first connection to a laptop, played inside it while a session is attached:
/// an `sftp-server` runs and `~/.claude/remote` grows (here 2 MB in root's home), so the card says
/// Claude is being set up; once a `--serve` process runs, it no longer does.
fn claude_setup(stand: &Stand, engine: &Engine, container: &str, id: &str) -> StepResult {
    println!("  Claude Desktop setting up Claude on a laptop is shown on its card");
    let start = "cp \"$(command -v sleep)\" /tmp/sftp-server && mkdir -p /root/.claude/remote \
                 && head -c 2097152 /dev/zero > /root/.claude/remote/blob \
                 && (nohup /tmp/sftp-server 120 >/dev/null 2>&1 &)";
    let (code, out) = stand.exec(container, "0", start)?;
    ensure(code == 0, format!("fake sftp-server: {out}"))?;
    let shown = stand.wait_snapshot(engine, Duration::from_secs(30), "the setup note", |s| {
        s.laptop(id)
            .is_some_and(|l| l.claude_setup_kb.is_some_and(|kb| kb >= 2048))
    });
    let serve = "(nohup sh -c 'sleep 120; :' --serve >/dev/null 2>&1 &)";
    let started = stand.exec(container, "0", serve);
    let gone = stand.wait_snapshot(
        engine,
        Duration::from_secs(30),
        "the setup note to go",
        |s| s.laptop(id).is_some_and(|l| l.claude_setup_kb.is_none()),
    );
    // `pkill` is not in every image: kill by the command names through /proc.
    let _ = stand.exec(
        container,
        "0",
        "for p in /proc/[0-9]*; do \
           if grep -q -e '^sftp-server$' \"$p/comm\" 2>/dev/null \
              || grep -q -e '--serv[e]' \"$p/cmdline\" 2>/dev/null; then kill \"${p#/proc/}\"; fi; \
         done; rm -rf /root/.claude/remote /tmp/sftp-server",
    );
    shown?;
    let (code, out) = started?;
    ensure(code == 0, format!("fake --serve: {out}"))?;
    gone
}

fn last_link(stand: &Stand) -> String {
    stand.launcher.links().last().cloned().unwrap_or_default()
}

pub fn run(stand: &Stand) -> StepResult {
    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;

    // Fixtures: the host's user-level Claude folder (fake home), a folder with two .claude/,
    // a folder with two git repos and plain files, and two folders to give.
    let home = stand.platform.home_dir();
    stand.write_files(
        &home.join(".claude"),
        &[
            (
                "skills/host-skill/SKILL.md",
                "---\nname: host-skill\ndescription: a user skill from the host\n---\nhost skill\n",
            ),
            ("agents/helper.md", "an agent\n"),
            (".credentials.json", "{\"secret\": \"never copied\"}\n"),
            (
                "skills/.credentials.json",
                "{\"secret\": \"never copied\"}\n",
            ),
        ],
    )?;
    let two = stand.root.join("two-claude");
    stand.write_files(
        &two,
        &[
            ("app1/.claude/settings.json", "{}\n"),
            ("app2/.claude/settings.json", "{}\n"),
            ("node_modules/dep/.claude/settings.json", "{}\n"),
            ("readme.txt", "two apps\n"),
        ],
    )?;
    let shared = stand.root.join("q3-work");
    stand.write_files(
        &shared,
        &[
            ("notes.txt", "plain notes\n"),
            (
                ".claude/skills/proj-skill/SKILL.md",
                "---\nname: proj-skill\ndescription: a project skill\n---\nproject skill\n",
            ),
        ],
    )?;
    stand.git_repo(
        &shared.join("repo-a"),
        &[("a.txt", "one\n"), ("index.js", crate::ac6::INDEX_JS)],
    )?;
    stand.git_repo(&shared.join("repo-b"), &[("b.txt", "two\n")])?;
    let mockups = stand.root.join("mock ups");
    stand.write_files(&mockups, &[("screen.txt", "a mockup\n")])?;
    let refs = stand.root.join("refs");
    stand.write_files(&refs, &[("ref.txt", "a reference\n")])?;

    let engine = stand.engine(&data)?;

    println!("  AC-2: two .claude/ folders ask once");
    let f_two = add_folder(stand, &engine, &two)?;
    let choices = engine
        .snapshot()
        .folder(&f_two)
        .map(|f| f.claude_choices.clone())
        .unwrap_or_default();
    ensure(
        choices == ["app1", "app2"],
        format!("expected the app1/app2 question, got {choices:?}"),
    )?;
    stand.act_ok(
        &engine,
        Command::ChooseClaudeDir {
            folder: f_two.clone(),
            dir: "app2".into(),
        },
        T,
    )?;
    let snap = engine.snapshot();
    let f = snap.folder(&f_two).ok_or("folder missing")?;
    ensure(
        f.claude_choices.is_empty() && f.folder.claude_dir.as_deref() == Some("app2"),
        format!("the answer is not remembered: {:?}", f.folder.claude_dir),
    )?;

    println!("  AC-1: a folder with two repos opens in one step");
    let f_q3 = add_folder(stand, &engine, &shared)?;
    let f = engine
        .snapshot()
        .folder(&f_q3)
        .cloned()
        .ok_or("folder missing")?;
    ensure(
        f.folder.claude_dir.as_deref() == Some("") && f.claude_choices.is_empty(),
        format!("one .claude/ at the root: {:?}", f.folder.claude_dir),
    )?;
    let links_before = stand.launcher.links().len();
    let id1 = get_laptop(stand, &engine, &f_q3, "", Vec::new(), T)?;
    let a1 = ssh_alias(&id1);
    ensure(
        laptop_view(&engine, &id1)?.laptop.name == "Laptop 1",
        "the first laptop is not \"Laptop 1\"",
    )?;
    ensure(
        stand.launcher.links().len() == links_before + 1
            && last_link(stand) == claude_link(&id1, "/work/q3-work"),
        format!("Desktop link: {}", last_link(stand)),
    )?;
    let out = stand.ssh_ok(&a1, "ws whoami")?;
    ensure(
        out.contains(
            "I'm on laptop \"Laptop 1\"; shared folder: q3-work; repo-a: main; repo-b: main",
        ),
        format!("ws whoami: {out}"),
    )?;
    let out = stand.ssh_ok(
        &a1,
        "id -un; ls /work/q3-work/.claude/skills; ls ~/.claude/skills; ls ~/.claude/agents; \
         test -e ~/.claude/.credentials.json || echo no-creds; \
         test -e ~/.claude/skills/.credentials.json || echo no-creds-2; \
         grep -c /opt/agentbook/bin/prompt-hook ~/.claude/settings.json; \
         grep -c 'Laptop 1' ~/.claude/CLAUDE.md; \
         git config --global core.fileMode; git config --global safe.directory; \
         git config --global core.autocrlf",
    )?;
    for want in [
        "claude",
        "proj-skill",
        "host-skill",
        "agentbook-ws",
        "helper.md",
        "no-creds",
        "no-creds-2",
        "false",
        "*",
    ] {
        ensure(
            out.contains(want),
            format!("laptop context lacks {want}: {out}"),
        )?;
    }
    // The laptop's core.autocrlf is the host git's effective value (the last line printed).
    let host_autocrlf = stand
        .platform
        .host_git_autocrlf()
        .effective(stand.platform.is_windows());
    ensure(
        out.trim_end().lines().last().map(str::trim) == Some(host_autocrlf),
        format!("laptop core.autocrlf is not the host's {host_autocrlf}: {out}"),
    )?;
    let mut ids = vec![id1.clone()];
    for n in 2..=5 {
        let id = get_laptop(stand, &engine, &f_q3, "", Vec::new(), T)?;
        let v = laptop_view(&engine, &id)?;
        ensure(
            v.laptop.name == format!("Laptop {n}") && v.note.is_none() && !v.duplicate_name,
            format!("laptop {n}: {:?} note {:?}", v.laptop.name, v.note),
        )?;
        ids.push(id);
    }
    for id in &ids {
        stand.ssh_ok(&ssh_alias(id), "true")?;
    }
    let id2 = ids[1].clone();
    let a2 = ssh_alias(&id2);
    for id in &ids[2..] {
        stand.act_ok(&engine, Command::RemoveLaptop { laptop: id.clone() }, T)?;
    }

    println!("  AC-3: live folder, git parity, installs stay inside");
    let inside = stand.ssh_ok(
        &a1,
        "printf 'inside\\n' >> /work/q3-work/repo-a/a.txt && git -C /work/q3-work/repo-a status --porcelain",
    )?;
    let host_text =
        std::fs::read_to_string(shared.join("repo-a").join("a.txt")).map_err(|e| e.to_string())?;
    ensure(host_text.contains("inside"), "the edit is not on the host")?;
    let host_status = stand.git(&shared.join("repo-a"), &["status", "--porcelain"])?;
    ensure(
        inside.trim() == host_status.trim() && host_status.trim() == "M a.txt",
        format!("git status differs: inside {inside:?}, host {host_status:?}"),
    )?;
    stand.git(&shared.join("repo-a"), &["checkout", "--", "a.txt"])?;
    let c1 = stand.running_container(&id1)?;
    let (code, out) = stand.exec(
        &c1.id,
        "0",
        "mkdir -p /opt/pkg && echo tool > /opt/pkg/tool",
    )?;
    ensure(code == 0, format!("install: {out}"))?;
    stand.ssh_ok(&a1, "test -f /opt/pkg/tool")?;
    ensure(
        !shared.join("opt").exists() && !shared.join("pkg").exists(),
        "an install inside reached the shared folder",
    )?;

    println!("  AC-4a: an attached session is counted on its laptop only");
    let mut hold = stand.ssh_hold(&a1, 90)?;
    let counted = stand.wait_snapshot(
        &engine,
        Duration::from_secs(30),
        "a session on laptop 1",
        |s| {
            s.laptop(&id1).is_some_and(|l| l.sessions >= 1)
                && s.laptop(&id2)
                    .is_some_and(|l| l.sessions == 0 && l.run == RunState::Working)
        },
    );
    let setup = claude_setup(stand, &engine, &c1.id, &id1);
    let whoami = stand.ssh_ok(&a1, "ws whoami");
    let _ = hold.kill();
    let _ = hold.wait();
    counted?;
    setup?;
    let whoami = whoami?;
    ensure(
        whoami.contains("\"Laptop 2\": Working") && whoami.contains("branch main"),
        format!("ws whoami misses the other laptop: {whoami}"),
    )?;
    stand.wait_snapshot(
        &engine,
        Duration::from_secs(30),
        "the session to close",
        |s| s.laptop(&id1).is_some_and(|l| l.sessions == 0),
    )?;

    println!("  AC-10: rename without a restart, duplicate names noted");
    let block = alias_block(stand, &id1);
    stand.act_ok(
        &engine,
        Command::Rename {
            laptop: id1.clone(),
            name: "Q3 reports".into(),
        },
        T,
    )?;
    let out = stand.ssh_ok(&a1, "ws whoami; /opt/agentbook/bin/prompt-hook")?;
    ensure(
        out.contains("I'm on laptop \"Q3 reports\"")
            && out
                .lines()
                .any(|l| l.starts_with("Q3 reports · repo-a: main")),
        format!("the rename is not seen inside: {out}"),
    )?;
    ensure(
        stand.running_container(&id1)?.id == c1.id && alias_block(stand, &id1) == block,
        "a rename touched the container or the alias",
    )?;
    stand.act_ok(
        &engine,
        Command::Rename {
            laptop: id2.clone(),
            name: "q3 reports".into(),
        },
        T,
    )?;
    ensure(
        laptop_view(&engine, &id1)?.duplicate_name && laptop_view(&engine, &id2)?.duplicate_name,
        "a duplicate name has no note",
    )?;
    stand.act_ok(
        &engine,
        Command::Rename {
            laptop: id2.clone(),
            name: "Laptop 2".into(),
        },
        T,
    )?;
    ensure(
        !laptop_view(&engine, &id1)?.duplicate_name,
        "the duplicate note stayed",
    )?;

    println!("  AC-14: given folders from the first session");
    let given = vec![
        GivenInput {
            path: mockups.to_string_lossy().into_owned(),
            read_only: false,
        },
        GivenInput {
            path: refs.to_string_lossy().into_owned(),
            read_only: true,
        },
    ];
    let mock = get_laptop(stand, &engine, &f_q3, "Mockups", given, T)?;
    let am = ssh_alias(&mock);
    ensure(
        laptop_view(&engine, &mock)?.laptop.generation == 1,
        "the laptop was restarted to give its folders",
    )?;
    let out = stand.ssh_ok(
        &am,
        "cat '/work/given/mock ups/screen.txt'; echo w > '/work/given/mock ups/new.txt' && echo rw-ok; \
         (echo w > /work/given/refs/new.txt) 2>/dev/null || echo ro-ok; ws mounts",
    )?;
    ensure(
        out.contains("a mockup")
            && out.contains("rw-ok")
            && out.contains("ro-ok")
            && out.contains("/work/given/refs")
            && out.contains("View only"),
        format!("given folders: {out}"),
    )?;
    ensure(
        mockups.join("new.txt").is_file(),
        "the write is not on the host",
    )?;
    std::fs::remove_file(mockups.join("new.txt")).map_err(|e| e.to_string())?;

    println!("  AC-15: Another laptop like this");
    stand.act_ok(
        &engine,
        Command::SetVariables {
            folder: f_q3.clone(),
            vars: Vec::new(),
            laptop_vars: vec![(
                mock.clone(),
                vec![VarEdit {
                    name: "JIRA_PAT".into(),
                    value: VarInput::Hidden(Some(Secret("pat-only-mockups".into()))),
                }],
            )],
        },
        T,
    )?;
    stand.ssh_ok(&am, "mkdir -p ~/.local && touch ~/.local/pkg-marker")?;
    let draft = engine.like_this(&mock).ok_or("no draft")?;
    ensure(
        draft.name == "Mockups 2"
            && draft.given.len() == 2
            && draft.given[1].read_only
            && draft.copied_vars == [("JIRA_PAT".to_string(), true)],
        format!("draft: {draft:?}"),
    )?;
    let view = stand.act_ok(
        &engine,
        Command::GetLaptop {
            folder: draft.folder.clone(),
            name: draft.name.clone(),
            given: draft.given.clone(),
            copy_from: Some(mock.clone()),
            confirm_broad: false,
        },
        T,
    )?;
    let mock2 = laptop_of(&view)?;
    let out = stand.ssh_ok(
        &ssh_alias(&mock2),
        "test -e ~/.local/pkg-marker && echo leaked || echo clean; ls /work/given; \
         (echo w > /work/given/refs/x) 2>/dev/null || echo ro-ok; echo pat=$JIRA_PAT",
    )?;
    ensure(
        out.contains("clean")
            && out.contains("mock ups")
            && out.contains("refs")
            && out.contains("ro-ok")
            && out.contains("pat=pat-only-mockups"),
        format!("Another laptop like this: {out}"),
    )?;
    ensure(
        stand.running_container(&mock2)?.id != stand.running_container(&mock)?.id,
        "the copy shares a container",
    )?;

    println!("  AC-11: Sleep, Wake up, Open, a stop outside the tool");
    stand.ssh_ok(&a2, "echo keep2 > ~/keep2")?;
    let links = stand.launcher.links().len();
    stand.act_ok(
        &engine,
        Command::Sleep {
            laptop: id2.clone(),
        },
        T,
    )?;
    ensure(
        laptop_view(&engine, &id2)?.run == RunState::Sleeping
            && stand.containers_of(&id2).iter().all(|c| !c.running()),
        "Sleep did not stop the laptop",
    )?;
    stand.act_ok(
        &engine,
        Command::WakeUp {
            laptop: id2.clone(),
        },
        T,
    )?;
    ensure(
        laptop_view(&engine, &id2)?.run == RunState::Working
            && stand.launcher.links().len() == links,
        "Wake up opened Desktop or did not wake",
    )?;
    ensure(
        stand.ssh_ok(&a2, "cat ~/keep2")?.contains("keep2"),
        "the volume lost its file",
    )?;
    stand.act_ok(
        &engine,
        Command::Sleep {
            laptop: id2.clone(),
        },
        T,
    )?;
    stand.act_ok(
        &engine,
        Command::Open {
            laptop: id2.clone(),
        },
        T,
    )?;
    ensure(
        stand.launcher.links().len() == links + 1 && last_link(stand).contains(&a2),
        "Open on a sleeping laptop did not open Desktop",
    )?;
    let c2 = stand.running_container(&id2)?;
    stand
        .rt
        .block_on(containers::stop(&stand.docker, &c2.id))
        .map_err(|e| e.to_string())?;
    wait_run(
        stand,
        &engine,
        &id2,
        RunState::Sleeping,
        Duration::from_secs(30),
    )?;
    stand.act_ok(
        &engine,
        Command::WakeUp {
            laptop: id2.clone(),
        },
        T,
    )?;

    println!("  AC-4: reopening keeps the host key and the volume");
    stand.ssh_ok(&a1, "echo keep1 > ~/keep1")?;
    let known = known_hosts(stand, &id1);
    stand.act_ok(
        &engine,
        Command::Sleep {
            laptop: id1.clone(),
        },
        T,
    )?;
    stand.act_ok(
        &engine,
        Command::Open {
            laptop: id1.clone(),
        },
        T,
    )?;
    ensure(
        known_hosts(stand, &id1) == known && !known.is_empty(),
        "the host key changed",
    )?;
    ensure(
        stand.ssh_ok(&a1, "cat ~/keep1")?.contains("keep1"),
        "the volume lost its file",
    )?;

    println!("  AC-12: loopback only, no password login");
    let c1 = stand.running_container(&id1)?;
    let inspect = stand
        .rt
        .block_on(stand.docker.inspect_container(&c1.id, None))
        .map_err(|e| e.to_string())?;
    let bindings: Vec<_> = inspect
        .host_config
        .and_then(|h| h.port_bindings)
        .and_then(|p| p.get("22/tcp").cloned().flatten())
        .unwrap_or_default();
    ensure(
        !bindings.is_empty()
            && bindings
                .iter()
                .all(|b| b.host_ip.as_deref() == Some("127.0.0.1")),
        format!("port 22 bindings: {bindings:?}"),
    )?;
    password_refused(stand, laptop_view(&engine, &id1)?.laptop.port, "claude")?;

    println!("  AC-18: a port clash moves the laptop, only its alias changes");
    stand.act_ok(
        &engine,
        Command::Sleep {
            laptop: id2.clone(),
        },
        T,
    )?;
    let old_port = laptop_view(&engine, &id2)?.laptop.port;
    let others: Vec<(String, String)> = [&id1, &mock, &mock2]
        .iter()
        .map(|id| (id.to_string(), alias_block(stand, id)))
        .collect();
    let known2 = known_hosts(stand, &id2);
    // A Docker engine inside WSL releases the stopped container's port on Windows a moment later.
    let mut taken = std::net::TcpListener::bind(("127.0.0.1", old_port));
    for _ in 0..20 {
        if taken.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
        taken = std::net::TcpListener::bind(("127.0.0.1", old_port));
    }
    let listener = taken.map_err(|e| format!("cannot take port {old_port}: {e}"))?;
    let opened = stand.act_ok(
        &engine,
        Command::Open {
            laptop: id2.clone(),
        },
        T,
    );
    drop(listener);
    opened?;
    let v2 = laptop_view(&engine, &id2)?;
    ensure(
        v2.laptop.port != old_port
            && v2
                .note
                .as_deref()
                .is_some_and(|n| n.contains(&old_port.to_string())),
        format!("port {} note {:?}", v2.laptop.port, v2.note),
    )?;
    ensure(
        alias_block(stand, &id2).contains(&format!("Port {}", v2.laptop.port)),
        "the alias was not rewritten",
    )?;
    for (id, block) in &others {
        ensure(
            &alias_block(stand, id) == block,
            format!("the alias of {id} changed"),
        )?;
    }
    ensure(known_hosts(stand, &id2) == known2, "the host key changed")?;
    ensure(
        stand.ssh_ok(&a2, "cat ~/keep2")?.contains("keep2"),
        "the volume lost its file",
    )?;

    println!("  AC-19: unknown state fields, older tool files");
    drop(engine);
    let state_file = data.join("state.json");
    let mut state: Value =
        serde_json::from_str(&std::fs::read_to_string(&state_file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    state["future_top"] = serde_json::json!({"kept": true});
    for f in state["folders"].as_array_mut().ok_or("no folders")? {
        f["future_folder"] = serde_json::json!("kept");
    }
    for l in state["laptops"].as_array_mut().ok_or("no laptops")? {
        l["future_laptop"] = serde_json::json!(42);
    }
    std::fs::write(&state_file, serde_json::to_string_pretty(&state).unwrap())
        .map_err(|e| e.to_string())?;
    std::fs::write(
        data.join("tool-files").join("ws"),
        "#!/bin/sh\necho old-ws\n",
    )
    .map_err(|e| e.to_string())?;
    let engine = stand.engine(&data)?;
    let snap = engine.snapshot();
    let f = snap.folder(&f_two).ok_or("folder missing after restart")?;
    ensure(
        f.claude_choices.is_empty() && f.folder.claude_dir.as_deref() == Some("app2"),
        "the .claude/ question came back after a restart",
    )?;
    stand.act_ok(
        &engine,
        Command::Rename {
            laptop: id1.clone(),
            name: "Q3 reports v2".into(),
        },
        T,
    )?;
    let written = std::fs::read_to_string(&state_file).map_err(|e| e.to_string())?;
    ensure(
        written.contains("future_top")
            && written.contains("future_folder")
            && written.contains("future_laptop"),
        "unknown fields were dropped on write",
    )?;
    stand.act_ok(
        &engine,
        Command::Open {
            laptop: id1.clone(),
        },
        T,
    )?;
    let out = stand.ssh_ok(&a1, "ws whoami")?;
    ensure(
        out.contains("I'm on laptop \"Q3 reports v2\"") && !out.contains("old-ws"),
        format!("ws after the upgrade: {out}"),
    )?;

    println!("  AC-2: the remembered .claude/ folder is Claude's start folder");
    get_laptop(stand, &engine, &f_two, "", Vec::new(), T)?;
    ensure(
        last_link(stand).ends_with("&ssh_folder=%2Fwork%2Ftwo-claude%2Fapp2"),
        format!("link: {}", last_link(stand)),
    )?;
    Ok(())
}

/// A password (or keyboard-interactive) login on the laptop's port is refused.
pub fn password_refused(stand: &Stand, port: u16, user: &str) -> StepResult {
    let empty = stand.root.join("ssh-empty-config");
    std::fs::write(&empty, "").map_err(|e| e.to_string())?;
    let known = stand.root.join("ssh-scratch-known-hosts");
    let args: Vec<String> = [
        "-F",
        &empty.to_string_lossy(),
        "-p",
        &port.to_string(),
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        &format!("UserKnownHostsFile={}", known.to_string_lossy()),
        &format!("{user}@127.0.0.1"),
        "true",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let (code, out) = stand.ssh_raw(&args)?;
    ensure(
        code == 255 && out.contains("Permission denied"),
        format!("a password login was not refused ({code}): {out}"),
    )
}

/// On a Docker engine inside WSL: connecting left AgentBook's keep-alive running in the distro
/// (WSL stops an idle distro about 15 s after its last `wsl.exe`, and the laptops with it; the
/// keep-alive keeps them up after AgentBook closes, as Docker Desktop keeps its engine up).
/// No-op on other engines. That the distro then really stays up with no client at all is in the
/// manual acceptance list: a test runner's job object ends the keep-alive with the test.
pub fn run_wsl_keep_alive(stand: &Stand) -> StepResult {
    if !stand.wsl {
        return Ok(());
    }
    println!("  WSL: the keep-alive runs in the distro");
    let distro = stand
        .platform
        .docker_endpoint()
        .map_err(|e| e.to_string())?
        .address;
    let out = std::process::Command::new("wsl.exe")
        .args(["-d", &distro, "-u", "root", "-e", "sh", "-c"])
        .arg("grep -ls 'agentbook-keep-aliv[e]' /proc/[0-9]*/cmdline | wc -l")
        .output()
        .map_err(|e| format!("cannot run wsl.exe: {e}"))?;
    let count: u32 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0);
    ensure(
        count >= 1,
        format!("no keep-alive in {distro}: {count} processes"),
    )
}

/// On a Docker engine inside WSL: a shared folder inside the distro keeps its Linux owner, so
/// the laptop's user takes that owner's uid/gid at start and can write there (before, `claude`
/// was uid 1001 and the distro user's folder, uid 1000, was read-only for it). No-op on other
/// engines, and when the distro's default user is root.
pub fn run_wsl_owner(stand: &Stand) -> StepResult {
    if !stand.wsl {
        return Ok(());
    }
    let distro = stand
        .platform
        .docker_endpoint()
        .map_err(|e| e.to_string())?
        .address;
    // A folder of the distro's default user, under /tmp (cleared when WSL restarts).
    let name = format!("agentbook-{}-owned", stand.instance);
    let out = std::process::Command::new("wsl.exe")
        .args(["-d", &distro, "-e", "sh", "-c"])
        .arg(format!("mkdir -p /tmp/{name} && stat -c %u /tmp/{name}"))
        .output()
        .map_err(|e| format!("cannot run wsl.exe: {e}"))?;
    let owner = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if owner.is_empty() || owner == "0" {
        println!("  WSL: the distro's default user is root; owner matching not checked");
        return Ok(());
    }
    println!("  WSL: a folder inside the distro (owner uid {owner}) is writable in the laptop");
    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;
    let engine = stand.engine(&data)?;
    let host = std::path::PathBuf::from(format!(r"\\wsl.localhost\{distro}\tmp\{name}"));
    let folder = add_folder(stand, &engine, &host)?;
    let id = get_laptop(stand, &engine, &folder, "", Vec::new(), T)?;
    let container = stand.running_container(&id)?.id;
    let (code, text) = stand.exec(
        &container,
        "claude",
        &format!("id -u; touch /work/{name}/written-by-laptop && echo write-ok"),
    )?;
    ensure(
        code == 0 && text.lines().next().map(str::trim) == Some(owner.as_str()),
        format!("the laptop user is not the folder's owner {owner}: {code} {text}"),
    )?;
    ensure(text.contains("write-ok"), format!("writing failed: {text}"))?;
    // The uid keeps one name: an image user that had it (`ubuntu`, uid 1000) moved aside.
    let (_, names) = stand.exec(
        &container,
        "claude",
        r#"whoami; stat -c %U "$HOME"; stat -c %U /work/*/written-by-laptop"#,
    )?;
    ensure(
        names.split_whitespace().all(|n| n == "claude"),
        format!("the uid is not named claude everywhere: {names}"),
    )
}
