//! Forwarded ports (a laptop's `localhost:<port>` reachable as `localhost:<host>` on this
//! computer): the defaults from a devcontainer's `forwardPorts`, the effective list of a laptop
//! and the check of a list the user typed in "Ports…".
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-forward-ports.md`.

use serde_json::Value;

use crate::state::PortForward;

/// The ports a devcontainer config asks to forward, in order, without duplicates: numbers in
/// 1..=65535 and strings `"<n>"`, `"localhost:<n>"` or `"127.0.0.1:<n>"`. A string naming another
/// host (`"db:5432"`, a compose service) is skipped: only the laptop itself is forwarded.
pub fn devcontainer_ports(merged: &Value) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    let Some(Value::Array(items)) = merged.get("forwardPorts") else {
        return out;
    };
    for item in items {
        let port = match item {
            Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
            Value::String(s) => {
                let s = s.trim();
                let (host, port) = match s.rsplit_once(':') {
                    Some((h, p)) => (h, p),
                    None => ("localhost", s),
                };
                let local = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1";
                if local {
                    port.trim().parse::<u16>().ok()
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(p) = port.filter(|p| *p > 0)
            && !out.contains(&p)
        {
            out.push(p);
        }
    }
    out
}

/// A laptop's forwarded ports: what the user set, else the devcontainer's, each on the same port
/// of this computer.
pub fn effective(set: Option<&[PortForward]>, devcontainer: &[u16]) -> Vec<PortForward> {
    match set {
        Some(list) => list.to_vec(),
        None => devcontainer
            .iter()
            .map(|p| PortForward::new(*p, *p))
            .collect(),
    }
}

/// Checks a list typed in "Ports…": every port in 1..=65535, no port of this computer twice.
/// The plain message names the first problem.
pub fn check(list: &[PortForward]) -> Result<(), String> {
    for (i, f) in list.iter().enumerate() {
        if f.port == 0 || f.host == 0 {
            return Err("A port is a number from 1 to 65535.".into());
        }
        if list[..i].iter().any(|g| g.host == f.host) {
            return Err(format!(
                "Port {} of this computer is used twice; each forward needs its own.",
                f.host
            ));
        }
    }
    Ok(())
}
