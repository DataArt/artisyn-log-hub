//! Doc-driven algorithm table tests (`npm run test:algo`).
//!
//! Each test loads the rows file of one `agentbook-*` algorithm doc,
//! `docs/algorithm-examples/agentbook-<name>.json` (format: `docs/knowledgebase/algorithms/README.md`),
//! runs every row against the real code in `agentbook-core` and reports every failing row at once.
//! The tests hold no numbers of their own. Work Hub's `work-hub/server/tests/algo.rs` is the
//! pattern.

use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::{Map, Value, json};

use agentbook_core::state::{Libc, VarOrigin, VarSetting, VarValue};
use agentbook_core::{
    autocrlf, broad_folder, claude_dir, docker_endpoint, equipment, host_exposure, openssh,
    override_config, paths, ports, sessions, ssh_user, state, variables,
};

// ---------------------------------------------------------------------------------------------
// Loader and helpers
// ---------------------------------------------------------------------------------------------

struct Row {
    id: String,
    input: Value,
    expected: Value,
}

/// `docs/algorithm-examples/<name>.json`, checked for the row shape (`id`, `input`, `expected`,
/// `note`), in file order.
fn load_rows(name: &str) -> Vec<Row> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/algorithm-examples")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let value: Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
    let Value::Array(items) = value else {
        panic!("{}: the rows file must be a JSON array", path.display());
    };
    assert!(!items.is_empty(), "{}: no rows", path.display());
    let mut seen = HashSet::new();
    items
        .into_iter()
        .enumerate()
        .map(|(i, item)| {
            let Value::Object(mut obj) = item else {
                panic!("{name} row {i}: not an object");
            };
            let id = match obj.remove("id") {
                Some(Value::String(s)) if !s.is_empty() => s,
                _ => panic!("{name} row {i}: missing string id"),
            };
            assert!(seen.insert(id.clone()), "{name}: duplicate id {id}");
            assert!(
                matches!(obj.get("note"), Some(Value::String(s)) if !s.trim().is_empty()),
                "{name} {id}: missing note"
            );
            let input = obj
                .remove("input")
                .unwrap_or_else(|| panic!("{name} {id}: missing input"));
            let expected = obj
                .remove("expected")
                .unwrap_or_else(|| panic!("{name} {id}: missing expected"));
            Row {
                id,
                input,
                expected,
            }
        })
        .collect()
}

/// Runs every row; `run` returns the actual output (or `Err` for a malformed row), which must
/// contain every key of `expected` with an equal value. Fails once, listing all failing rows.
fn run_table(name: &str, run: impl Fn(&Value) -> Result<Value, String>) {
    let rows = load_rows(name);
    let failures: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            let result = run(&row.input).and_then(|actual| expect_subset(&row.expected, &actual));
            result.err().map(|e| format!("  {}: {e}", row.id))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{name}: {} of {} rows failed\n{}",
        failures.len(),
        rows.len(),
        failures.join("\n")
    );
}

/// Every key of `expected` (an object) equals the same key of `actual` (`objectContaining`).
fn expect_subset(expected: &Value, actual: &Value) -> Result<(), String> {
    let (Value::Object(exp), Value::Object(act)) = (expected, actual) else {
        return if expected == actual {
            Ok(())
        } else {
            Err(format!("expected {expected}, got {actual}"))
        };
    };
    for (key, want) in exp {
        let got = act.get(key).unwrap_or(&Value::Null);
        if got != want {
            return Err(format!("{key}: expected {want}, got {got}"));
        }
    }
    Ok(())
}

fn op(input: &Value) -> &str {
    input.get("op").and_then(Value::as_str).unwrap_or("")
}

fn str_field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("input.{key} must be a string"))
}

fn opt_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn bool_field(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn str_list(v: &Value, key: &str) -> Vec<String> {
    match v.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// `[[name, value], …]` → pairs.
fn pairs(v: &Value, key: &str) -> Result<Vec<(String, String)>, String> {
    match v.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => a
            .iter()
            .map(|p| match p.as_array().map(Vec::as_slice) {
                Some([Value::String(n), Value::String(v)]) => Ok((n.clone(), v.clone())),
                _ => Err(format!("input.{key}: every entry must be [name, value]")),
            })
            .collect(),
        Some(_) => Err(format!("input.{key} must be an array")),
    }
}

/// A text given as a string, or as an array of lines joined with `\n`.
fn text(v: &Value, key: &str) -> Result<String, String> {
    match v.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Array(lines)) => Ok(lines
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n")),
        _ => Err(format!("input.{key} must be a string or an array of lines")),
    }
}

// ---------------------------------------------------------------------------------------------
// agentbook-state-file
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_state_file() {
    run_table("agentbook-state-file", |input| match op(input) {
        "load" | "roundtrip" => {
            let file_text = match input.get("file") {
                Some(file) => file.to_string(),
                None => str_field(input, "text")?.to_string(),
            };
            match state::parse_state(&file_text) {
                Err(_) => Ok(json!({"ok": false, "error": "invalid"})),
                Ok(loaded) => {
                    let mut out = json!({
                        "ok": true,
                        "readOnly": loaded.read_only,
                        "folders": loaded.state.folders.len(),
                        "laptops": loaded.state.laptops.len(),
                    });
                    if op(input) == "roundtrip" {
                        match state::write_state(&loaded) {
                            Ok(written) => {
                                let parsed: Value = serde_json::from_str(&written)
                                    .map_err(|e| format!("written state is not JSON: {e}"))?;
                                out["written"] = parsed;
                            }
                            Err(state::StateError::ReadOnly) => out["error"] = json!("read-only"),
                            Err(e) => return Err(e.to_string()),
                        }
                    }
                    Ok(out)
                }
            }
        }
        "id" => {
            let bytes: Vec<u8> = input
                .get("bytes")
                .and_then(Value::as_array)
                .ok_or("input.bytes must be an array")?
                .iter()
                .map(|b| {
                    b.as_u64()
                        .and_then(|n| u8::try_from(n).ok())
                        .ok_or("byte out of range")
                })
                .collect::<Result<_, _>>()?;
            let bytes: [u8; 5] = bytes.try_into().map_err(|_| "input.bytes needs 5 bytes")?;
            let id = state::id_from_bytes(bytes);
            Ok(json!({"valid": state::is_valid_id(&id), "id": id}))
        }
        "valid-id" => Ok(json!({"valid": state::is_valid_id(str_field(input, "id")?)})),
        other => Err(format!("unknown op {other:?}")),
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-claude-dir
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_claude_dir() {
    run_table("agentbook-claude-dir", |input| match op(input) {
        "descends" => Ok(json!({"descends": claude_dir::scan_descends(str_field(input, "name")?)})),
        "decide" => {
            let dirs = str_list(input, "dirs");
            let refs: Vec<&str> = dirs.iter().map(String::as_str).collect();
            let candidates = claude_dir::candidates(&refs);
            let decision = match claude_dir::decide(&candidates, opt_str(input, "remembered")) {
                claude_dir::ClaudeStart::Root => json!({"decision": "root"}),
                claude_dir::ClaudeStart::Use(f) => json!({"decision": "use", "folder": f}),
                claude_dir::ClaudeStart::Ask(c) => json!({"decision": "ask", "ask": c}),
            };
            let mut out = decision;
            out["candidates"] = json!(candidates);
            Ok(out)
        }
        other => Err(format!("unknown op {other:?}")),
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-container-paths
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_container_paths() {
    run_table("agentbook-container-paths", |input| match op(input) {
        "basename" => Ok(json!({"name": paths::host_basename(str_field(input, "host")?)})),
        "shared" => Ok(json!({
            "path": paths::shared_container_path(str_field(input, "host")?, opt_str(input, "workspaceFolder"))
        })),
        "given" => {
            let hosts = str_list(input, "hosts");
            let refs: Vec<&str> = hosts.iter().map(String::as_str).collect();
            Ok(json!({"paths": paths::given_container_paths(&refs)}))
        }
        "alias" => Ok(json!({"alias": paths::ssh_alias(str_field(input, "id")?)})),
        "link" => Ok(json!({
            "link": paths::claude_link(str_field(input, "id")?, str_field(input, "folder")?)
        })),
        "wsl" => Ok(json!({
            "path": paths::wsl_path(
                str_field(input, "host")?,
                str_field(input, "distro")?,
                str_field(input, "mountRoot")?
            )
        })),
        other => Err(format!("unknown op {other:?}")),
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-broad-folder
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_broad_folder() {
    run_table("agentbook-broad-folder", |input| {
        let b = broad_folder::classify(str_field(input, "path")?, str_field(input, "home")?);
        Ok(json!({"breadth": b.as_str(), "confirm": b.needs_confirmation()}))
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-variables
// ---------------------------------------------------------------------------------------------

fn settings(input: &Value, key: &str) -> Result<Vec<VarSetting>, String> {
    let Some(list) = input.get(key) else {
        return Ok(Vec::new());
    };
    list.as_array()
        .ok_or_else(|| format!("input.{key} must be an array"))?
        .iter()
        .map(|s| {
            let name = str_field(s, "name")?.to_string();
            let value = if bool_field(s, "hidden") {
                VarValue::Hidden
            } else {
                VarValue::Plain(str_field(s, "value")?.to_string())
            };
            Ok(VarSetting {
                name,
                value,
                origin: VarOrigin::parse(opt_str(s, "origin").unwrap_or("override")),
                extra: Map::new(),
            })
        })
        .collect()
}

fn value_json(v: &VarValue) -> Value {
    match v {
        VarValue::Plain(s) => json!(s),
        VarValue::Hidden => json!({"hidden": true}),
        VarValue::Other(raw) => json!({"other": raw.get("kind")}),
    }
}

#[test]
fn agentbook_variables() {
    run_table("agentbook-variables", |input| match op(input) {
        "hidden" => Ok(json!({"hidden": variables::starts_hidden(str_field(input, "name")?)})),
        "valid" => Ok(json!({"valid": variables::is_valid_name(str_field(input, "name")?)})),
        "credential" => Ok(json!({
            "target": variables::credential_target(
                str_field(input, "prefix")?,
                str_field(input, "folder")?,
                opt_str(input, "laptop"),
                str_field(input, "name")?,
            )
        })),
        "container-refs" => Ok(json!({
            "value": variables::resolve_container_env_refs(
                str_field(input, "value")?,
                &pairs(input, "containerEnv")?,
            )
        })),
        "resolve" => {
            let vars = variables::resolve(
                &pairs(input, "defaults")?,
                &pairs(input, "containerEnv")?,
                &settings(input, "folder")?,
                &settings(input, "laptop")?,
            );
            let vars: Vec<Value> = vars
                .iter()
                .map(|v| {
                    json!({
                        "name": v.name,
                        "value": value_json(&v.value),
                        "source": v.source.as_str(),
                        "editable": v.editable,
                        "needsValue": v.needs_value,
                    })
                })
                .collect();
            Ok(json!({"vars": vars}))
        }
        "env-file" => Ok(json!({"text": variables::render_env_file(&pairs(input, "vars")?)})),
        other => Err(format!("unknown op {other:?}")),
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-ssh-user
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_ssh_user() {
    run_table("agentbook-ssh-user", |input| {
        // `imageUser` is in some rows on purpose: the resolution must not read it.
        let u = ssh_user::resolve(
            opt_str(input, "remoteUser"),
            opt_str(input, "containerUser"),
        );
        Ok(json!({
            "user": u.user,
            "create": u.create,
            "home": u.home,
            "permitRootLogin": u.permit_root_login,
        }))
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-equipment
// ---------------------------------------------------------------------------------------------

fn hash_of(spec: &Value) -> Result<String, String> {
    let files = pairs(spec, "files")?
        .into_iter()
        .map(|(p, c)| (p, c.into_bytes()))
        .collect::<Vec<_>>();
    Ok(equipment::config_hash(
        &files,
        str_field(spec, "std")?,
        str_field(spec, "layer")?,
    ))
}

fn libc(v: Option<&str>) -> Option<Libc> {
    v.map(Libc::parse)
}

#[test]
fn agentbook_equipment() {
    run_table("agentbook-equipment", |input| match op(input) {
        "hash" => Ok(json!({"hash": hash_of(input)?})),
        "compare" => {
            let a = hash_of(input.get("a").ok_or("input.a missing")?)?;
            let b = hash_of(input.get("b").ok_or("input.b missing")?)?;
            Ok(json!({"same": a == b}))
        }
        "state" => Ok(json!({
            "state": equipment::equipment_state(opt_str(input, "recorded"), str_field(input, "current")?).as_str()
        })),
        "libc" => {
            let new = libc(opt_str(input, "new")).ok_or("input.new missing")?;
            Ok(
                json!({"clear": equipment::clears_ccd_cli(libc(opt_str(input, "recorded")).as_ref(), &new)}),
            )
        }
        other => Err(format!("unknown op {other:?}")),
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-host-exposure
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_host_exposure() {
    run_table("agentbook-host-exposure", |input| {
        let config = input.get("config").ok_or("input.config missing")?;
        let findings: Vec<Value> = host_exposure::detect(config)
            .iter()
            .map(|f| match f.source() {
                Some(s) => json!({"kind": f.kind(), "source": s}),
                None => json!({"kind": f.kind()}),
            })
            .collect();
        Ok(json!({"findings": findings}))
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-override-config
// ---------------------------------------------------------------------------------------------

fn tool_run(v: &Value) -> Result<override_config::ToolRun, String> {
    let given = match v.get("given") {
        None => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|g| {
                Ok(override_config::GivenMount {
                    source: str_field(g, "source")?.to_string(),
                    target: str_field(g, "target")?.to_string(),
                    read_only: bool_field(g, "readOnly"),
                })
            })
            .collect::<Result<_, String>>()?,
        Some(_) => return Err("run.given must be an array".into()),
    };
    Ok(override_config::ToolRun {
        laptop_id: str_field(v, "laptopId")?.into(),
        image: str_field(v, "image")?.into(),
        shared_host_path: str_field(v, "shared")?.into(),
        config_dir: str_field(v, "configDir")?.into(),
        port: v
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .ok_or("run.port must be a port number")?,
        home: str_field(v, "home")?.into(),
        key_dir: str_field(v, "keyDir")?.into(),
        bin_dir: str_field(v, "binDir")?.into(),
        state_dir: str_field(v, "stateDir")?.into(),
        given,
        labels: pairs(v, "labels")?,
        compose_file: str_field(v, "composeFile")?.into(),
    })
}

#[test]
fn agentbook_override_config() {
    run_table("agentbook-override-config", |input| {
        let merged = input.get("merged").ok_or("input.merged missing")?;
        let run = tool_run(input.get("run").ok_or("input.run missing")?)?;
        let o = override_config::generate(merged, &run);
        Ok(json!({
            "config": o.config,
            "compose": o.compose,
            "workspaceFolder": o.workspace_folder,
            "composeProject": o.compose_project,
        }))
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-autocrlf
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_autocrlf() {
    run_table("agentbook-autocrlf", |input| {
        Ok(json!({
            "value": autocrlf::effective(
                opt_str(input, "global"),
                opt_str(input, "system"),
                bool_field(input, "git"),
                bool_field(input, "windows"),
            )
        }))
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-docker-endpoint
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_docker_endpoint() {
    run_table("agentbook-docker-endpoint", |input| match op(input) {
        "dir" => Ok(json!({"dir": docker_endpoint::context_dir_name(str_field(input, "name")?)})),
        "resolve" => {
            let config_text = match input.get("configJson") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(v) => Some(v.to_string()),
                None => None,
            };
            let metas: Vec<(String, String)> = match input.get("metas") {
                Some(Value::Object(m)) => m
                    .iter()
                    .map(|(name, meta)| (docker_endpoint::context_dir_name(name), meta.to_string()))
                    .collect(),
                _ => Vec::new(),
            };
            let endpoint_input = docker_endpoint::EndpointInput {
                docker_host: opt_str(input, "dockerHost"),
                docker_context: opt_str(input, "dockerContext"),
                config_json: config_text.as_deref(),
                home: opt_str(input, "home").unwrap_or(""),
                windows: bool_field(input, "windows"),
            };
            let read_meta =
                |dir: &str| metas.iter().find(|(d, _)| d == dir).map(|(_, m)| m.clone());
            match docker_endpoint::resolve(&endpoint_input, read_meta) {
                Ok(r) => Ok(json!({
                    "source": r.source,
                    "candidates": r.candidates.iter()
                        .map(|c| json!({"kind": c.kind.as_str(), "address": c.address}))
                        .collect::<Vec<_>>(),
                })),
                Err(docker_endpoint::EndpointError::NotLocal(u)) => {
                    Ok(json!({"error": "not-local", "url": u}))
                }
                Err(docker_endpoint::EndpointError::Unsupported(u)) => {
                    Ok(json!({"error": "unsupported", "url": u}))
                }
            }
        }
        other => Err(format!("unknown op {other:?}")),
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-session-count
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_session_count() {
    run_table("agentbook-session-count", |input| {
        let port = match input.get("port") {
            Some(p) => p
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .ok_or("input.port must be a port number")?,
            None => sessions::SSHD_PORT,
        };
        Ok(json!({"count": sessions::count_established(&text(input, "text")?, port)}))
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-openssh-version
// ---------------------------------------------------------------------------------------------

#[test]
fn agentbook_openssh_version() {
    run_table("agentbook-openssh-version", |input| {
        let v = openssh::parse_version(str_field(input, "output")?);
        Ok(json!({
            "version": v.map(|(a, b)| format!("{a}.{b}")),
            "ok": v.is_some_and(openssh::meets_floor),
        }))
    });
}

// ---------------------------------------------------------------------------------------------
// agentbook-forward-ports
// ---------------------------------------------------------------------------------------------

fn forwards(v: Option<&Value>) -> Result<Vec<state::PortForward>, String> {
    serde_json::from_value(v.cloned().unwrap_or(Value::Array(Vec::new())))
        .map_err(|e| e.to_string())
}

fn forwards_json(list: &[state::PortForward]) -> Value {
    Value::Array(
        list.iter()
            .map(|f| json!({"port": f.port, "host": f.host}))
            .collect(),
    )
}

#[test]
fn agentbook_forward_ports() {
    run_table("agentbook-forward-ports", |input| match op(input) {
        "devcontainer" => Ok(json!({
            "ports": ports::devcontainer_ports(input.get("merged").unwrap_or(&Value::Null))
        })),
        "effective" => {
            let set = match input.get("set") {
                Some(v) => Some(forwards(Some(v))?),
                None => None,
            };
            let dc: Vec<u16> =
                serde_json::from_value(input.get("devcontainer").cloned().unwrap_or(json!([])))
                    .map_err(|e| e.to_string())?;
            Ok(json!({"ports": forwards_json(&ports::effective(set.as_deref(), &dc))}))
        }
        "check" => Ok(match ports::check(&forwards(input.get("list"))?) {
            Ok(()) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": e}),
        }),
        other => Err(format!("unknown op {other:?}")),
    });
}
