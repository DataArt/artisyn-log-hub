//! AC-16 (FR-12): Variables of a devcontainer folder that declares `JIRA_URL` (a URL) and
//! `JIRA_PAT` (empty), checked in new ssh sessions:
//!
//! - the laptop shows "needs a value" for `JIRA_PAT` and still opens;
//! - a Hidden `JIRA_PAT` reaches new sessions with no container recreate, is in the credential
//!   store and in no host file, `ws` state file or CLAUDE.md (which names it);
//! - an override of `JIRA_URL` and "project default" again; an added variable (with quotes in
//!   its value);
//! - an "Only for one laptop" value for one laptop while the other keeps the folder-wide one;
//! - an env file removed behind the tool's back is written again by the poller.

use std::path::Path;
use std::time::{Duration, Instant};

use agentbook_core::paths::ssh_alias;
use agentbook_engine::{Command, Secret, VarEdit, VarInput};
use agentbook_platform::Platform;

use crate::ac6::{BUILD_TIMEOUT, ensure_dependencies};
use crate::ac17;
use crate::laptops::{T, add_folder, get_laptop, laptop_view};
use crate::stand::{Stand, StepResult, ensure};

const SECRET: &str = "pat-7f3c9e-folder-secret";
const LAPTOP_SECRET: &str = "pat-2b81d4-laptop-secret";

const DEVCONTAINER: &str = r#"{
  "name": "proj-vars",
  "image": "debian:bookworm-slim",
  "containerEnv": { "JIRA_URL": "https://jira.example.test", "JIRA_PAT": "" }
}
"#;

const JIRA_TOOL: &str = "// Reads JIRA_URL and JIRA_PAT (a fixture: it is not run here).\n\
const url = process.env.JIRA_URL;\nconst pat = process.env.JIRA_PAT;\n\
console.log(url && pat ? 'ok' : 'missing');\n";

fn hidden(name: &str, value: Option<&str>) -> VarEdit {
    VarEdit {
        name: name.to_string(),
        value: VarInput::Hidden(value.map(|v| Secret(v.to_string()))),
    }
}

fn plain(name: &str, value: &str) -> VarEdit {
    VarEdit {
        name: name.to_string(),
        value: VarInput::Plain(value.to_string()),
    }
}

/// Files under `dir` (skipping the downloaded dependencies) whose bytes contain `needle`.
fn files_containing(dir: &Path, needle: &[u8]) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() && e.file_name() != "deps" => stack.push(path),
                Ok(t) if t.is_file() => {
                    let bytes = std::fs::read(&path).unwrap_or_default();
                    if bytes.windows(needle.len()).any(|w| w == needle) {
                        found.push(path.display().to_string());
                    }
                }
                _ => {}
            }
        }
    }
    found
}

pub fn run(stand: &Stand) -> StepResult {
    if stand.wsl {
        println!(
            "  WSL: these checks (project defaults) need a project devcontainer, refused there (see ac6); skipped"
        );
        return Ok(());
    }

    let data = ac17::data_dir(stand);
    ensure_dependencies(stand, &data)?;
    let project = stand.root.join("proj-vars");
    stand.write_files(
        &project,
        &[
            (".devcontainer/devcontainer.json", DEVCONTAINER),
            ("tools/get-jira-ticket.js", JIRA_TOOL),
        ],
    )?;
    let engine = stand.engine(&data)?;
    let folder = add_folder(stand, &engine, &project)?;

    println!("  AC-16: a variable that needs a value; the laptop still opens");
    let a = get_laptop(
        stand,
        &engine,
        &folder,
        "Q3 reports",
        Vec::new(),
        BUILD_TIMEOUT,
    )?;
    let b = get_laptop(stand, &engine, &folder, "Other", Vec::new(), BUILD_TIMEOUT)?;
    let (aa, ab) = (ssh_alias(&a), ssh_alias(&b));
    let needs = laptop_view(&engine, &a)?.needs_value;
    ensure(needs == ["JIRA_PAT"], format!("needs a value: {needs:?}"))?;
    let rows = engine
        .snapshot()
        .folder(&folder)
        .map(|f| f.variables.clone())
        .unwrap_or_default();
    ensure(
        rows.iter().any(|r| {
            r.name == "JIRA_URL"
                && r.project_default.as_deref() == Some("https://jira.example.test")
        }) && rows.iter().any(|r| r.name == "JIRA_PAT" && r.needs_value),
        format!("Variables dialog rows: {rows:?}"),
    )?;

    println!("  AC-16: a Hidden value in new sessions, never in files");
    let container = stand.running_container(&a)?.id;
    stand.act_ok(
        &engine,
        Command::SetVariables {
            folder: folder.clone(),
            vars: vec![hidden("JIRA_PAT", Some(SECRET))],
            laptop_vars: Vec::new(),
        },
        T,
    )?;
    let out = stand.ssh_ok(&aa, "echo pat=$JIRA_PAT; echo url=$JIRA_URL")?;
    ensure(
        out.contains(&format!("pat={SECRET}")) && out.contains("url=https://jira.example.test"),
        format!("a new session: {out}"),
    )?;
    ensure(
        stand.running_container(&a)?.id == container,
        "a variable change recreated the container",
    )?;
    ensure(
        laptop_view(&engine, &a)?.needs_value.is_empty(),
        "the note stayed after the value was set",
    )?;
    let prefix = stand.test_config().credential_prefix;
    let stored = stand
        .platform
        .credential_get(&format!("{prefix}{folder}/JIRA_PAT"))
        .map_err(|e| e.to_string())?;
    ensure(
        stored.as_deref() == Some(SECRET),
        "the value is not in the credential store",
    )?;
    let leaks = files_containing(&stand.root, SECRET.as_bytes());
    ensure(
        leaks.is_empty(),
        format!("the hidden value is in host files: {leaks:?}"),
    )?;
    // CLAUDE.md lists the names as of the last Open: open again to refresh it.
    stand.act_ok(&engine, Command::Open { laptop: a.clone() }, T)?;
    let out = stand.ssh_ok(
        &aa,
        &format!(
            "grep -rl '{SECRET}' /opt/agentbook/state ~/.claude/CLAUDE.md || echo clean; \
             grep -c JIRA_PAT ~/.claude/CLAUDE.md"
        ),
    )?;
    ensure(
        out.contains("clean") && !out.contains("/opt/agentbook") && out.lines().last() != Some("0"),
        format!("the value leaked inside, or the name is missing: {out}"),
    )?;

    println!("  AC-16: override, project default again, an added variable");
    stand.act_ok(
        &engine,
        Command::SetVariables {
            folder: folder.clone(),
            vars: vec![
                hidden("JIRA_PAT", None),
                plain("JIRA_URL", "https://other.example.test"),
            ],
            laptop_vars: Vec::new(),
        },
        T,
    )?;
    let out = stand.ssh_ok(&aa, "echo url=$JIRA_URL")?;
    ensure(
        out.contains("url=https://other.example.test"),
        format!("override: {out}"),
    )?;
    stand.act_ok(
        &engine,
        Command::SetVariables {
            folder: folder.clone(),
            vars: vec![
                hidden("JIRA_PAT", None),
                plain("ADDED_ONE", "it's a 'quoted'\nvalue"),
            ],
            laptop_vars: Vec::new(),
        },
        T,
    )?;
    let out = stand.ssh_ok(&aa, "echo url=$JIRA_URL; printenv ADDED_ONE")?;
    ensure(
        out.contains("url=https://jira.example.test") && out.contains("it's a 'quoted'\nvalue"),
        format!("project default / added variable: {out}"),
    )?;

    println!("  a Variable added after the session started: ws env");
    // A session that started before ADDED_ONE existed: its environment lacks it.
    let out = stand.ssh_ok(
        &aa,
        "unset ADDED_ONE; ws env ls; echo ---; ws env run printenv ADDED_ONE; echo ---; \
         ws env get ADDED_ONE; echo; echo ---; /opt/agentbook/bin/prompt-hook; echo ---; \
         /opt/agentbook/bin/prompt-hook",
    )?;
    let parts: Vec<&str> = out.split("---").collect();
    ensure(
        parts.len() == 5
            && parts[0].contains("ADDED_ONE  (added after this session started")
            && parts[0].contains("JIRA_URL\n")
            && !parts[0].contains(SECRET)
            && parts[1].contains("it's a 'quoted'\nvalue")
            && parts[2].contains("it's a 'quoted'\nvalue")
            && parts[3].contains("Variables changed after this session started: ADDED_ONE (new)")
            && !parts[4].contains("Variables changed"),
        format!("ws env / prompt hook: {out}"),
    )?;

    println!("  AC-16: Only for one laptop");
    stand.act_ok(
        &engine,
        Command::SetVariables {
            folder: folder.clone(),
            vars: vec![
                hidden("JIRA_PAT", None),
                plain("ADDED_ONE", "it's a 'quoted'\nvalue"),
            ],
            laptop_vars: vec![(a.clone(), vec![hidden("JIRA_PAT", Some(LAPTOP_SECRET))])],
        },
        T,
    )?;
    let out_a = stand.ssh_ok(&aa, "echo pat=$JIRA_PAT")?;
    let out_b = stand.ssh_ok(&ab, "echo pat=$JIRA_PAT")?;
    ensure(
        out_a.contains(&format!("pat={LAPTOP_SECRET}")) && out_b.contains(&format!("pat={SECRET}")),
        format!("per-laptop value: a {out_a}, b {out_b}"),
    )?;

    println!("  AC-16: a missing env file is written again");
    let cb = stand.running_container(&b)?.id;
    let (code, out) = stand.exec(&cb, "0", "rm -f /run/agentbook/env/session.env")?;
    ensure(code == 0, format!("rm: {out}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let (code, _) = stand.exec(&cb, "0", "test -f /run/agentbook/env/session.env")?;
        if code == 0 {
            break;
        }
        if Instant::now() >= deadline {
            return Err("the poller did not write the env file again".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let out = stand.ssh_ok(&ab, "echo pat=$JIRA_PAT")?;
    ensure(
        out.contains(&format!("pat={SECRET}")),
        format!("after the rewrite: {out}"),
    )
}
