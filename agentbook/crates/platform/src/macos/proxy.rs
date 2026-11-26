//! The macOS proxy settings (System Settings > Network > Proxies) as `scutil --proxy` prints
//! them: `HTTPEnable` / `HTTPProxy` / `HTTPPort`, the same for `HTTPS`, and `ExceptionsList`.
//! Read only when no `HTTP(S)_PROXY` variable is set. A PAC file (`ProxyAutoConfigEnable`) is not
//! evaluated.

use std::collections::HashMap;
use std::process::{Command, Stdio};

use crate::ProxySettings;

/// The scalar keys and the exceptions list of `scutil --proxy` output.
fn parse(text: &str) -> (HashMap<String, String>, Vec<String>) {
    let mut values = HashMap::new();
    let mut exceptions = Vec::new();
    let mut in_exceptions = false;
    for line in text.lines().map(str::trim) {
        if in_exceptions {
            if line.starts_with('}') {
                in_exceptions = false;
            } else if let Some((_, v)) = line.split_once(" : ") {
                exceptions.push(v.trim().to_string());
            }
            continue;
        }
        let Some((key, value)) = line.split_once(" : ") else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key == "ExceptionsList" && value.starts_with("<array>") {
            in_exceptions = true;
        } else {
            values.insert(key.to_string(), value.to_string());
        }
    }
    (values, exceptions)
}

fn server(values: &HashMap<String, String>, scheme: &str) -> Option<String> {
    if values.get(&format!("{scheme}Enable")).map(String::as_str) != Some("1") {
        return None;
    }
    let host = values.get(&format!("{scheme}Proxy"))?;
    if host.is_empty() {
        return None;
    }
    Some(match values.get(&format!("{scheme}Port")) {
        Some(port) if !port.is_empty() => format!("http://{host}:{port}"),
        _ => format!("http://{host}"),
    })
}

pub fn scutil_proxy() -> Option<ProxySettings> {
    let output = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let (values, exceptions) = parse(&String::from_utf8_lossy(&output.stdout));
    let http = server(&values, "HTTP");
    let https = server(&values, "HTTPS");
    if http.is_none() && https.is_none() {
        return None;
    }
    let mut no_proxy: Vec<String> = vec!["localhost".into(), "127.0.0.1".into()];
    for e in exceptions
        .iter()
        .map(|e| e.trim_start_matches('*').to_string())
    {
        if !e.is_empty() && !no_proxy.contains(&e) {
            no_proxy.push(e);
        }
    }
    Some(ProxySettings {
        http,
        https,
        no_proxy: Some(no_proxy.join(",")),
    })
}
