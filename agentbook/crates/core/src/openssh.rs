//! The OpenSSH version floor (FR-10): parses what `ssh -V` prints and checks it against 9.4.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-openssh-version.md`.

/// The lowest OpenSSH (major, minor) Claude Desktop's SSH remote works with on Windows.
pub const OPENSSH_FLOOR: (u32, u32) = (9, 4);

const MARKERS: [&str; 2] = ["OpenSSH_for_Windows_", "OpenSSH_"];

fn leading_number(s: &str) -> Option<(u32, &str)> {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    if end == 0 {
        return None;
    }
    Some((s[..end].parse().ok()?, &s[end..]))
}

/// The (major, minor) version in `ssh -V` output (`OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2`,
/// `OpenSSH_9.6p1 Ubuntu-3ubuntu13`). The first marker found wins, `OpenSSH_for_Windows_` before
/// `OpenSSH_`; the version is `<digits>.<digits>` right after it.
pub fn parse_version(output: &str) -> Option<(u32, u32)> {
    let rest = MARKERS
        .iter()
        .find_map(|m| output.find(m).map(|i| &output[i + m.len()..]))?;
    let (major, rest) = leading_number(rest)?;
    let (minor, _) = leading_number(rest.strip_prefix('.')?)?;
    Some((major, minor))
}

/// Whether the version meets [`OPENSSH_FLOOR`] (compared as numbers: 9.10 is above 9.4).
pub fn meets_floor(version: (u32, u32)) -> bool {
    version >= OPENSSH_FLOOR
}
