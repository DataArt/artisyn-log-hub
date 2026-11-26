//! The poller (FR-2, FR-4): every [`POLL_INTERVAL`] while the engine runs, it reads which laptops
//! are Working or Sleeping (by label, so a container stopped outside the tool shows Sleeping),
//! counts each Working laptop's attached sessions (established connections to sshd, from
//! `/proc/net/tcp{,6}`) and rewrites the env file of a running laptop that has none (one started
//! outside the tool). A run-state change is written to the folder's state files for `ws`. It also
//! notices Claude Desktop setting up Claude on a laptop it connects to for the first time.
//! A laptop an action holds (its lock) is skipped: the action sets its state, and a look taken
//! meanwhile would overwrite it with a stale one.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use agentbook_core::sessions::{SSHD_PORT, count_established};

use crate::docker::{containers, label_filter};
use crate::engine::{Ctx, INSTANCE_LABEL};
use crate::equipment::{LABEL_GEN, LABEL_LAPTOP, LABEL_ROOT};
use crate::snapshot::RunState;
use crate::{context, vars};

/// How often the poller looks.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

const EXEC_TIMEOUT: Duration = Duration::from_secs(10);

/// Printed by the session probe when the env file is missing.
const NO_ENV_MARKER: &str = "AGENTBOOK-NO-ENV";

/// Printed by the session probe, with the KB copied so far, while Claude Desktop sets up Claude.
const CLAUDE_SETUP_MARKER: &str = "AGENTBOOK-CLAUDE-SETUP-KB";

/// Claude Desktop's first connection to a laptop copies its server and the Claude Code CLI into
/// `~/.claude/remote` over SFTP (a few hundred MB) before it starts that server with `--serve`.
/// While an `sftp-server` runs and no `--serve` process does, the probe prints the size of every
/// `~/.claude/remote` so far. (`--serv[e]` keeps the probe's own command line from matching.)
const CLAUDE_SETUP_PROBE: &str = "sftp=$(grep -l '^sftp-server$' /proc/[0-9]*/comm 2>/dev/null | wc -l); \
     serve=$(grep -l -e '--serv[e]' /proc/[0-9]*/cmdline 2>/dev/null | wc -l); \
     if [ \"$sftp\" -gt 0 ] && [ \"$serve\" -eq 0 ]; then \
       du -sk /root/.claude/remote /home/*/.claude/remote 2>/dev/null | \
         awk '{ s += $1 } END { print \"AGENTBOOK-CLAUDE-SETUP-KB\", s + 0 }'; \
     fi";

/// The KB from the probe's setup line, when Claude Desktop is setting up Claude.
fn claude_setup_kb(text: &str) -> Option<u64> {
    text.lines()
        .find_map(|l| l.strip_prefix(CLAUDE_SETUP_MARKER))
        .and_then(|rest| rest.trim().parse().ok())
}

/// Polls until the runtime shuts down.
pub(crate) async fn run(ctx: Arc<Ctx>) {
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        tick(&ctx).await;
    }
}

/// One look at every laptop.
pub(crate) async fn tick(ctx: &Arc<Ctx>) {
    let Ok(docker) = ctx.docker().await else {
        return;
    };
    let mut filter = vec![(LABEL_ROOT, "1")];
    let instance = ctx.instance().map(str::to_string);
    if let Some(i) = instance.as_deref() {
        filter.push((INSTANCE_LABEL, i));
    }
    let state = ctx.state();
    let mut changed_folders: HashSet<String> = HashSet::new();
    let before: HashMap<String, RunState> = ctx.read_snapshot(|s| {
        s.laptops
            .iter()
            .map(|l| (l.laptop.id.clone(), l.run))
            .collect()
    });
    for laptop in &state.laptops {
        // An action on the laptop (Wake up, Locate folder, …) sets its state itself; a look taken
        // while it runs would be stale, so skip the laptop this time. Its containers are read
        // under the lock, after any action that held it.
        let lock = ctx.laptop_lock(&laptop.id);
        let Ok(_guard) = lock.try_lock() else {
            continue;
        };
        let mut laptop_filter = filter.clone();
        laptop_filter.push((LABEL_LAPTOP, laptop.id.as_str()));
        let Ok(list) = containers::list_by_labels(&docker, &label_filter(&laptop_filter)).await
        else {
            return;
        };
        let mut mine: Vec<&containers::ContainerListItem> = list
            .iter()
            .filter(|c| c.labels.get(LABEL_LAPTOP) == Some(&laptop.id))
            .collect();
        mine.sort_by_key(|c| {
            std::cmp::Reverse(
                c.labels
                    .get(LABEL_GEN)
                    .and_then(|g| g.parse::<u64>().ok())
                    .unwrap_or(0),
            )
        });
        let running = mine.iter().find(|c| c.running());
        let run = match (running, mine.is_empty()) {
            (Some(_), _) => RunState::Working,
            (None, false) => RunState::Sleeping,
            (None, true) => RunState::NotCreated,
        };
        let mut sessions = 0;
        let mut setup = None;
        if let Some(c) = running {
            let probe = format!(
                "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; [ -f {} ] || echo {NO_ENV_MARKER}; \
                 {CLAUDE_SETUP_PROBE}",
                vars::ENV_FILE
            );
            if let Ok(out) = containers::exec(
                &docker,
                &c.id,
                "0",
                &containers::sh(&probe),
                None,
                EXEC_TIMEOUT,
            )
            .await
            {
                let text = out.stdout_str();
                sessions = count_established(&text, SSHD_PORT);
                setup = claude_setup_kb(&text).filter(|_| sessions > 0);
                if text.contains(NO_ENV_MARKER) {
                    redeliver(ctx, &laptop.id, &c.id).await;
                }
            }
        }
        if before.get(&laptop.id).copied().unwrap_or_default() != run {
            changed_folders.insert(laptop.folder_id.clone());
        }
        ctx.set_run(&laptop.id, run, Some(sessions));
        ctx.set_claude_setup(&laptop.id, setup);
        crate::tunnels::reconcile(
            ctx,
            &laptop.id,
            &ctx.forwards_of(laptop),
            run == RunState::Working,
        );
    }
    let ids: Vec<&str> = state.laptops.iter().map(|l| l.id.as_str()).collect();
    ctx.tunnels.keep_laptops(&ids);
    for folder in changed_folders {
        let _ = context::write_folder_state(ctx, &folder);
    }
    ctx.refresh_views();
}

/// Writes the env file of a running laptop that has none. The caller holds the laptop's lock,
/// so no action is writing the file at the same time.
async fn redeliver(ctx: &Arc<Ctx>, laptop_id: &str, container: &str) {
    let state = ctx.state();
    let Some(laptop) = state.laptops.iter().find(|l| l.id == laptop_id) else {
        return;
    };
    let Some(folder) = state.folders.iter().find(|f| f.id == laptop.folder_id) else {
        return;
    };
    let Ok(docker) = ctx.docker().await else {
        return;
    };
    let _ = vars::deliver(ctx, &docker, container, folder, laptop).await;
}
