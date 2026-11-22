//! `wh-git-ctl` in the sidecar (plan D3, D5): the only channel from the server to the git proxy.
//! Commands run as user `lighttpd` with `docker exec`. Secrets travel only on stdin, so neither
//! stdin nor stdout is ever logged; only the command name and the exit code / stderr are.

use std::time::Duration;

use bytes::Bytes;

use crate::docker::exec::{self, ExecOutput};
use crate::docker::{DockerError, names};
use crate::error::ApiError;
use crate::state::{AppState, ProxyStatus};

/// The control script inside the sidecar image.
pub const CTL: &str = "/usr/local/bin/wh-git-ctl";
/// The user every control command runs as (it owns `/run/wh` and `/srv/git`).
pub const CTL_USER: &str = "lighttpd";
/// Default timeout of one control command (D2).
pub const CTL_TIMEOUT: Duration = Duration::from_secs(120);

/// Runs `wh-git-ctl <args…>` when the proxy is ready; 503 `git_proxy_not_ready` otherwise (and
/// when the sidecar container is gone or stopped). A non-zero exit code is not an error here:
/// inspect [`ExecOutput::exit_code`].
pub async fn ctl(
    st: &AppState,
    args: &[&str],
    stdin: Option<Bytes>,
    timeout: Duration,
) -> Result<ExecOutput, ApiError> {
    if *st.git_proxy.status.read().await != ProxyStatus::Ok {
        return Err(ApiError::git_proxy_not_ready());
    }
    ctl_raw(st, args, stdin, timeout).await
}

/// [`ctl`] without the readiness gate: for the startup task, `push_all` and the sync helpers,
/// which tolerate failure.
pub(crate) async fn ctl_raw(
    st: &AppState,
    args: &[&str],
    stdin: Option<Bytes>,
    timeout: Duration,
) -> Result<ExecOutput, ApiError> {
    let container = names::git_proxy_container(&st.config.instance);
    let mut argv = Vec::with_capacity(args.len() + 1);
    argv.push(CTL.to_string());
    argv.extend(args.iter().map(|a| a.to_string()));
    match exec::exec_capture(&st.docker, &container, CTL_USER, &argv, stdin, timeout).await {
        Ok(out) => Ok(out),
        // No sidecar container, or it is not running.
        Err(DockerError::NotFound(_) | DockerError::Conflict(_)) => {
            Err(ApiError::git_proxy_not_ready())
        }
        Err(e) => Err(e.into()),
    }
}

/// [`ctl_raw`] that also fails on a non-zero exit code (the stderr of `wh-git-ctl` holds only
/// its own short error messages, never stdin).
pub(crate) async fn ctl_raw_ok(
    st: &AppState,
    args: &[&str],
    stdin: Option<Bytes>,
) -> Result<ExecOutput, ApiError> {
    let out = ctl_raw(st, args, stdin, CTL_TIMEOUT).await?;
    if out.success() {
        Ok(out)
    } else {
        let cmd = args.first().copied().unwrap_or("");
        Err(ApiError::internal(format!(
            "git proxy `{cmd}` exited with code {}: {}",
            out.exit_code,
            out.stderr_str().trim()
        )))
    }
}
