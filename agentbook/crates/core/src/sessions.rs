//! Attached-session count (FR-4): established TCP connections to the laptop's sshd, read from
//! `cat /proc/net/tcp /proc/net/tcp6` inside the container (needs only `sh` and `cat`).
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-session-count.md`.

/// The container port sshd listens on.
pub const SSHD_PORT: u16 = 22;

/// The `st` value of an established socket.
const ESTABLISHED: &str = "01";

/// Counts sockets in state `01` (ESTABLISHED) whose local port is `port`, over the concatenated
/// `/proc/net/tcp` and `/proc/net/tcp6` text. Header lines and lines that do not parse are
/// skipped. Each line is one socket, so a client with two SSH connections counts twice.
pub fn count_established(proc_net_tcp: &str, port: u16) -> u32 {
    let count = proc_net_tcp
        .lines()
        .filter(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (Some(sl), Some(local), Some(state)) =
                (fields.first(), fields.get(1), fields.get(3))
            else {
                return false;
            };
            if !sl.ends_with(':') || *state != ESTABLISHED {
                return false;
            }
            local
                .rsplit_once(':')
                .and_then(|(_, p)| u16::from_str_radix(p, 16).ok())
                == Some(port)
        })
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}
