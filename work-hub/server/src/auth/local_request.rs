//! Local-request detection — Rust port of Log Hub's `server/src/auth/utils/localhost.util.ts` and
//! `container-gateway.util.ts` (rules: `docs/knowledgebase/algorithms/local-request-detection.md`).
//!
//! Only the TCP peer address counts; `X-Forwarded-For` is never a security signal here. Inside a
//! container one more address is trusted: the container's own private default gateway.

use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;

use axum::http::HeaderMap;

use crate::auth::js;
use crate::auth::startup::TrustProxy;

/// Peer address as Node reports it: IPv4-mapped IPv6 keeps its `::ffff:` form.
pub fn peer_string(peer: Option<SocketAddr>) -> String {
    peer.map(|p| p.ip().to_string()).unwrap_or_default()
}

/// Part A: is a request from `remote_address` (the socket peer; `None` = missing) local, given
/// the process's trusted gateway?
pub fn is_local_address(remote_address: Option<&str>, trusted_gateway: Option<&str>) -> bool {
    let remote = remote_address.unwrap_or("");
    let normalized = remote.strip_prefix("::ffff:").unwrap_or(remote);
    if normalized == "127.0.0.1" || normalized == "::1" {
        return true;
    }
    trusted_gateway.is_some_and(|g| g == normalized)
}

/// [`is_local_address`] with this process's memoized trusted gateway.
pub fn is_local_request(peer: Option<SocketAddr>) -> bool {
    let remote = peer_string(peer);
    is_local_address(Some(&remote), trusted_gateway())
}

/// File access for part B. `Err` = the probe itself failed (resolution then yields no gateway).
pub trait FsProbe {
    fn exists(&self, path: &str) -> Result<bool, String>;
    fn read(&self, path: &str) -> Result<Option<String>, String>;
}

/// The real filesystem; any unreadable file counts as missing.
pub struct RealFsProbe;

impl FsProbe for RealFsProbe {
    fn exists(&self, path: &str) -> Result<bool, String> {
        Ok(std::path::Path::new(path).exists())
    }

    fn read(&self, path: &str) -> Result<Option<String>, String> {
        Ok(std::fs::read_to_string(path).ok())
    }
}

const MARKER_FILES: [&str; 4] = [
    "/.dockerenv",
    "/run/.containerenv",
    "/run/.toolboxenv",
    "/.dockerinit",
];

const CONTAINER_ENV_VARS: [&str; 9] = [
    "KUBERNETES_SERVICE_HOST",
    "ECS_CONTAINER_METADATA_URI",
    "ECS_CONTAINER_METADATA_URI_V4",
    "FLY_ALLOC_ID",
    "DYNO",
    "RENDER",
    "CODESPACES",
    "REMOTE_CONTAINERS",
    "DEVCONTAINER",
];

const CONTAINER_ENV_VALUES: [&str; 7] = [
    "docker",
    "podman",
    "oci",
    "lxc",
    "crio",
    "containerd",
    "systemd-nspawn",
];

const CGROUP_RUNTIME_WORDS: [&str; 10] = [
    "docker",
    "containerd",
    "kubepods",
    "libpod",
    "lxc",
    "garden",
    "crio",
    "ecs",
    "buildkit",
    "actions_job",
];

const BIND_SOURCE_HINTS: [&str; 4] = [
    "docker/containers",
    "containerd",
    "kubelet/pods",
    "containers/storage",
];

const HOST_INIT_NAMES: [&str; 7] = [
    "systemd",
    "init",
    "upstart",
    "openrc-init",
    "runit",
    "procd",
    "launchd",
];

struct MountInfoEntry {
    root: String,
    mount_point: String,
    fs_type: String,
    source: String,
}

fn split_ws(s: &str) -> Vec<&str> {
    s.split(js::is_js_whitespace)
        .filter(|p| !p.is_empty())
        .collect()
}

fn parse_mount_info(content: Option<&str>) -> Vec<MountInfoEntry> {
    let Some(content) = content else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in content.split('\n') {
        let Some(sep) = line.find(" - ") else {
            continue;
        };
        let left = split_ws(js::trim(&line[..sep]));
        let right = split_ws(js::trim(&line[sep + 3..]));
        if left.len() < 5 || right.len() < 2 {
            continue;
        }
        out.push(MountInfoEntry {
            root: left[3].to_string(),
            mount_point: left[4].to_string(),
            fs_type: right[0].to_string(),
            source: right[1].to_string(),
        });
    }
    out
}

fn has_bind_source_hint(v: &str) -> bool {
    BIND_SOURCE_HINTS.iter().any(|h| v.contains(h))
}

/// Raw environment lookup for part B (`None` = unset).
pub type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// Rule 5: any single containerization signal, cheapest first.
pub fn is_containerized(probe: &dyn FsProbe, env: EnvLookup, pid: u32) -> Result<bool, String> {
    for path in MARKER_FILES {
        if probe.exists(path)? {
            return Ok(true);
        }
    }
    if CONTAINER_ENV_VARS
        .iter()
        .any(|n| env(n).is_some_and(|v| !js::trim(&v).is_empty()))
    {
        return Ok(true);
    }
    let container = env("container").unwrap_or_default();
    if CONTAINER_ENV_VALUES.contains(&js::trim(&container).to_lowercase().as_str()) {
        return Ok(true);
    }
    if let Some(cgroup) = probe.read("/proc/1/cgroup")? {
        let lower = cgroup.to_lowercase();
        if CGROUP_RUNTIME_WORDS.iter().any(|w| lower.contains(w)) {
            return Ok(true);
        }
    }
    let mountinfo = probe.read("/proc/self/mountinfo")?;
    for m in parse_mount_info(mountinfo.as_deref()) {
        if m.mount_point == "/" && m.fs_type == "overlay" {
            return Ok(true);
        }
        if (m.mount_point == "/etc/hostname" || m.mount_point == "/etc/resolv.conf")
            && (has_bind_source_hint(&m.root) || has_bind_source_hint(&m.source))
        {
            return Ok(true);
        }
    }
    if let Some(comm) = probe.read("/proc/1/comm")? {
        let comm = js::trim(&comm);
        if !comm.is_empty() && !HOST_INIT_NAMES.contains(&comm) {
            return Ok(true);
        }
    }
    Ok(pid == 1)
}

/// Rule 6: the IPv4 default gateway from `/proc/net/route` (lowest metric, first on ties).
pub fn parse_default_gateway_ipv4(proc_net_route: Option<&str>) -> Option<String> {
    let content = proc_net_route?;
    if content.is_empty() {
        return None;
    }
    let mut best: Option<(String, f64)> = None;
    for line in content.split('\n') {
        let fields = split_ws(js::trim(line));
        if fields.len() < 7 {
            continue;
        }
        let (destination, gateway) = (fields[1], fields[2]);
        if destination != "00000000" {
            continue;
        }
        if gateway.len() != 8 || !gateway.bytes().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        if gateway == "00000000" {
            continue;
        }
        let metric = js::number(fields[6]);
        if !js::is_integer(metric) {
            continue;
        }
        if best.as_ref().is_some_and(|(_, m)| *m <= metric) {
            continue;
        }
        best = Some((hex_to_dotted_quad(gateway), metric));
    }
    best.map(|(addr, _)| addr)
}

/// `010011AC` -> `172.17.0.1` (little-endian hex).
fn hex_to_dotted_quad(hex: &str) -> String {
    let mut octets: Vec<String> = Vec::with_capacity(4);
    for i in (0..8).step_by(2) {
        let v = u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
        octets.insert(0, v.to_string());
    }
    octets.join(".")
}

/// Rule 7: a well-formed IPv4 address in 10/8, 172.16/12, 192.168/16 or 169.254/16.
pub fn is_trustable_private_ipv4(addr: &str) -> bool {
    let parts: Vec<&str> = addr.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u32; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|c| c.is_ascii_digit()) {
            return false;
        }
        let v: u32 = p.parse().unwrap_or(256);
        if v > 255 {
            return false;
        }
        octets[i] = v;
    }
    let (a, b) = (octets[0], octets[1]);
    a == 10
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
}

/// Part B: containerized + private default gateway, or `None`. Never fails.
pub fn resolve_trusted_gateway(probe: &dyn FsProbe, env: EnvLookup, pid: u32) -> Option<String> {
    match is_containerized(probe, env, pid) {
        Ok(true) => {}
        _ => return None,
    }
    let route = probe.read("/proc/net/route").ok()?;
    let gateway = parse_default_gateway_ipv4(route.as_deref())?;
    is_trustable_private_ipv4(&gateway).then_some(gateway)
}

static TRUSTED_GATEWAY: OnceLock<Option<String>> = OnceLock::new();

/// This process's trusted gateway, resolved once (warmed at startup).
pub fn trusted_gateway() -> Option<&'static str> {
    TRUSTED_GATEWAY
        .get_or_init(|| {
            let env = |n: &str| std::env::var(n).ok();
            resolve_trusted_gateway(&RealFsProbe, &env, std::process::id())
        })
        .as_deref()
}

/// The client address used as the backoff / rate-limit key: Express's `req.ip` — the socket peer,
/// or, with `TRUST_PROXY`, the first untrusted address walking `X-Forwarded-For` from the right
/// (list mode compares exact addresses). `unknown` when there is no peer.
pub fn client_ip(peer: Option<SocketAddr>, headers: &HeaderMap, trust: &TrustProxy) -> String {
    let Some(peer) = peer else {
        return "unknown".to_string();
    };
    let peer_ip = normalize_ip(peer.ip());
    if !trust.enabled() {
        return peer_ip;
    }
    // X-Forwarded-For entries left to right, over every header line in order.
    let forwarded: Vec<String> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|s| js::trim(s).to_string())
        .filter(|s| !s.is_empty())
        .collect();
    // [socket peer, nearest proxy's client, ..., left-most entry]
    let mut chain = vec![peer_ip];
    chain.extend(forwarded.into_iter().rev());
    for (i, addr) in chain.iter().enumerate().take(chain.len() - 1) {
        let trusted = match trust {
            TrustProxy::Off => false,
            TrustProxy::All => true,
            TrustProxy::Hops(n) => (i as u64) < u64::from(*n),
            TrustProxy::List(list) => list.iter().any(|t| t == addr),
        };
        if !trusted {
            return addr.clone();
        }
    }
    chain.last().cloned().unwrap_or_else(|| "unknown".into())
}

/// An IPv4-mapped IPv6 address as its IPv4 form (Express's `req.ip` after proxy-addr).
fn normalize_ip(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map_or_else(|| v6.to_string(), |v4| v4.to_string()),
        IpAddr::V4(v4) => v4.to_string(),
    }
}
