//! Doc-driven algorithm table tests (`npm run test:algo`).
//!
//! Each test loads the rows file of one algorithm doc, `docs/algorithm-examples/<name>.json`
//! (format: `docs/knowledgebase/algorithms/README.md`), runs every row against the real code and
//! reports every failing row at once. The tests hold no numbers of their own.
//!
//! - Work Hub's own docs: `workhub-names`, `workhub-repo-path`, `workhub-devcontainer-subset`.
//! - Log Hub's auth docs, run unchanged against the Rust ports: `password-policy`,
//!   `login-backoff`, `auth-startup-config`, `local-request-detection`. The rows' `NODE_ENV` is
//!   Work Hub's `WORK_HUB_ENV`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use work_hub_server::auth::backoff::{LoginBackoff, ManualClock};
use work_hub_server::auth::local_request::{
    FsProbe, is_local_address, is_trustable_private_ipv4, resolve_trusted_gateway,
};
use work_hub_server::auth::password_policy::apply_password_policy;
use work_hub_server::auth::startup::validate_auth_startup_config;
use work_hub_server::devcontainer::{self, ImageSource};
use work_hub_server::{names, repo_path};

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
        .join("../../docs/algorithm-examples")
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

/// Runs every row; `check` returns `Err(description)` for a failing row. Fails once, listing all.
fn run_table(name: &str, check: impl Fn(&Row) -> Result<(), String>) {
    let rows = load_rows(name);
    let failures: Vec<String> = rows
        .iter()
        .filter_map(|row| check(row).err().map(|e| format!("  {}: {e}", row.id)))
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
        return expect_equal(expected, actual);
    };
    for (key, want) in exp {
        if act.get(key) != Some(want) {
            return Err(format!("expected {expected}, got {actual}"));
        }
    }
    Ok(())
}

fn expect_equal(expected: &Value, actual: &Value) -> Result<(), String> {
    if expected == actual {
        Ok(())
    } else {
        Err(format!("expected {expected}, got {actual}"))
    }
}

fn str_field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("input.{key} must be a string"))
}

/// A row string: either literal, or `{"before"?, "repeat", "times", "after"?}` for long values.
fn text(v: &Value) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Object(o) => {
            let part = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("");
            let times = o
                .get("times")
                .and_then(Value::as_u64)
                .ok_or("repeat form needs a numeric 'times'")?;
            let times = usize::try_from(times).map_err(|e| e.to_string())?;
            Ok(format!(
                "{}{}{}",
                part("before"),
                part("repeat").repeat(times),
                part("after")
            ))
        }
        _ => Err(format!("not a string or repeat form: {v}")),
    }
}

// ---------------------------------------------------------------------------------------------
// Work Hub docs
// ---------------------------------------------------------------------------------------------

/// `docs/knowledgebase/algorithms/workhub-names.md`.
#[test]
fn workhub_names() {
    run_table("workhub-names", |row| {
        let raw = text(row.input.get("raw").ok_or("input.raw missing")?)?;
        let actual = match str_field(&row.input, "op")? {
            "validate" => match names::validate_display_name(&raw) {
                Ok(name) => json!({"ok": true, "name": name}),
                Err(message) => json!({"ok": false, "message": message}),
            },
            "key" => json!({"key": names::name_key(&raw)}),
            "branch" => {
                let taken: HashSet<String> = row
                    .input
                    .get("taken")
                    .and_then(Value::as_array)
                    .ok_or("input.taken must be an array")?
                    .iter()
                    .map(|t| t.as_str().map(str::to_string).ok_or("taken: not a string"))
                    .collect::<Result<_, _>>()?;
                json!({"branch": names::derive_branch(&raw, &taken)})
            }
            other => return Err(format!("unknown op {other}")),
        };
        expect_subset(&row.expected, &actual)
    });
}

/// `docs/knowledgebase/algorithms/workhub-repo-path.md`.
#[test]
fn workhub_repo_path() {
    run_table("workhub-repo-path", |row| {
        let path = text(row.input.get("path").ok_or("input.path missing")?)?;
        let actual = match repo_path::normalize(&path) {
            Ok(p) => json!({"ok": true, "path": p}),
            Err(e) => json!({"ok": false, "error": e.code}),
        };
        expect_subset(&row.expected, &actual)
    });
}

/// `docs/knowledgebase/algorithms/workhub-devcontainer-subset.md`.
#[test]
fn workhub_devcontainer_subset() {
    run_table("workhub-devcontainer-subset", |row| {
        let src = str_field(&row.input, "json")?;
        match devcontainer::parse(src) {
            Ok(spec) => {
                let source = match spec.source {
                    ImageSource::Default => json!({"kind": "default"}),
                    ImageSource::Image(image) => json!({"kind": "image", "image": image}),
                    ImageSource::Build {
                        dockerfile,
                        context,
                    } => json!({"kind": "build", "dockerfile": dockerfile, "context": context}),
                };
                let env: Map<String, Value> = spec
                    .container_env
                    .into_iter()
                    .map(|(k, v)| (k, Value::String(v)))
                    .collect();
                let actual = json!({
                    "ok": true,
                    "source": source,
                    "containerEnv": env,
                    "postCreate": spec.post_create,
                });
                expect_equal(&row.expected, &actual)
            }
            Err(message) => {
                if row.expected.get("ok") != Some(&Value::Bool(false)) {
                    return Err(format!("expected {}, got error {message:?}", row.expected));
                }
                let want = str_field(&row.expected, "error")?;
                if message.contains(want) {
                    Ok(())
                } else {
                    Err(format!("error {message:?} does not contain {want:?}"))
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Log Hub auth docs (Work Hub's Rust ports are twins)
// ---------------------------------------------------------------------------------------------

/// `docs/knowledgebase/algorithms/password-policy.md`.
#[test]
fn password_policy() {
    run_table("password-policy", |row| {
        let policy = row.input.get("policy").and_then(Value::as_str);
        let password = str_field(&row.input, "password")?;
        let actual = match apply_password_policy(policy, password) {
            Ok(()) => json!({"accepted": true}),
            Err(w) => json!({"accepted": false, "error": "weak_password", "message": w.message}),
        };
        expect_subset(&row.expected, &actual)
    });
}

/// `docs/knowledgebase/algorithms/login-backoff.md`: each row is a sequence of fail / check /
/// success / wait steps on a fresh limiter and a manual clock.
#[test]
fn login_backoff() {
    run_table("login-backoff", |row| {
        let clock = Arc::new(ManualClock::new());
        let backoff = LoginBackoff::new(true, clock.clone());
        let steps = row
            .input
            .get("steps")
            .and_then(Value::as_array)
            .ok_or("input.steps must be an array")?;
        let mut results = Vec::with_capacity(steps.len());
        for step in steps {
            let parts = step.as_array().ok_or("a step must be an array")?;
            let arg = |i: usize| {
                parts
                    .get(i)
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("step {step}: argument {i} must be a string"))
            };
            let result = match arg(0)? {
                "fail" => json!(backoff.record_failure(arg(1)?, arg(2)?)),
                "check" => match backoff.check(arg(1)?, arg(2)?) {
                    Ok(()) => Value::Null,
                    Err(t) => json!(t.retry_after_secs),
                },
                "success" => {
                    backoff.record_success(arg(1)?);
                    Value::Null
                }
                "wait" => {
                    let ms = parts
                        .get(1)
                        .and_then(Value::as_u64)
                        .ok_or_else(|| format!("step {step}: wait needs milliseconds"))?;
                    clock.advance(ms);
                    Value::Null
                }
                other => return Err(format!("unknown step {other}")),
            };
            results.push(result);
        }
        expect_equal(&row.expected, &json!({"results": results}))
    });
}

/// `docs/knowledgebase/algorithms/auth-startup-config.md`. Every variable is unset unless the row
/// sets it; the rows' `NODE_ENV` (default `test`, as in Log Hub's table test) is `WORK_HUB_ENV`,
/// and only the exact value `production` means production.
#[test]
fn auth_startup_config() {
    run_table("auth-startup-config", |row| {
        let env: HashMap<String, String> = row
            .input
            .get("env")
            .and_then(Value::as_object)
            .ok_or("input.env must be an object")?
            .iter()
            .map(|(k, v)| {
                v.as_str()
                    .map(|s| (k.clone(), s.to_string()))
                    .ok_or_else(|| format!("env.{k} must be a string"))
            })
            .collect::<Result<_, _>>()?;
        let is_production = env.get("NODE_ENV").map_or("test", String::as_str) == "production";
        let lookup = |name: &str| env.get(name).cloned();
        let outcome = validate_auth_startup_config(&lookup, is_production);
        let want_ok = row.expected.get("ok") == Some(&Value::Bool(true));
        match outcome {
            Ok(o) if want_ok => expect_equal(
                &row.expected,
                &json!({
                    "ok": true,
                    "AUTH_MODE": o.auth_mode.as_str(),
                    "PASSWORD_POLICY": o.password_policy,
                }),
            ),
            Ok(o) => Err(format!(
                "expected {}, got ok ({} / {})",
                row.expected,
                o.auth_mode.as_str(),
                o.password_policy
            )),
            Err(message) if !want_ok => {
                let want = str_field(&row.expected, "error")?;
                if message.contains(want) {
                    Ok(())
                } else {
                    Err(format!("error {message:?} does not contain {want:?}"))
                }
            }
            Err(message) => Err(format!("expected {}, got error {message:?}", row.expected)),
        }
    });
}

/// A fake machine for part B: files by path; `throws` makes every access fail.
struct FakeFs {
    files: BTreeMap<String, String>,
    throws: bool,
}

impl FsProbe for FakeFs {
    fn exists(&self, path: &str) -> Result<bool, String> {
        if self.throws {
            return Err(format!("EACCES: {path}"));
        }
        Ok(self.files.contains_key(path))
    }

    fn read(&self, path: &str) -> Result<Option<String>, String> {
        if self.throws {
            return Err(format!("EACCES: {path}"));
        }
        Ok(self.files.get(path).cloned())
    }
}

fn string_map(v: Option<&Value>, what: &str) -> Result<BTreeMap<String, String>, String> {
    v.and_then(Value::as_object)
        .ok_or_else(|| format!("input.{what} must be an object"))?
        .iter()
        .map(|(k, v)| {
            v.as_str()
                .map(|s| (k.clone(), s.to_string()))
                .ok_or_else(|| format!("{what}.{k} must be a string"))
        })
        .collect()
}

/// `docs/knowledgebase/algorithms/local-request-detection.md`: part A (`request`) with the trusted
/// gateway pinned by the row (headers are passed by the doc only to show they are ignored, and
/// the Rust check never sees them), part B (`gateway`, `private`) against a fake filesystem.
#[test]
fn local_request_detection() {
    run_table("local-request-detection", |row| {
        let input = &row.input;
        let actual = match str_field(input, "kind")? {
            "request" => {
                let remote = input.get("remoteAddress").and_then(Value::as_str);
                let gateway = input.get("trustedGateway").and_then(Value::as_str);
                json!({"local": is_local_address(remote, gateway)})
            }
            "gateway" => {
                let fs = FakeFs {
                    files: string_map(input.get("files"), "files")?,
                    throws: input.get("throws") == Some(&Value::Bool(true)),
                };
                let env = string_map(input.get("env"), "env")?;
                let lookup = |name: &str| env.get(name).cloned();
                let pid = input
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|p| u32::try_from(p).ok())
                    .ok_or("input.pid must be a u32")?;
                json!({"trustedGateway": resolve_trusted_gateway(&fs, &lookup, pid)})
            }
            "private" => {
                json!({"trusted": is_trustable_private_ipv4(str_field(input, "address")?)})
            }
            other => return Err(format!("unknown kind {other}")),
        };
        expect_equal(&row.expected, &actual)
    });
}
