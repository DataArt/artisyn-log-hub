# OTEL tab

Claude Code reports every model API call it makes — and, with traces on, every step of a turn —
through OpenTelemetry (OTEL). The hook's local OTEL receiver forwards that telemetry to Log Hub,
and the **OTEL** tabs show it: what a session, a repository or a team spent, on which models and
call sources, including calls that never appear in a transcript.

All amounts on these tabs are **Claude Code's own per-call estimate** (`cost_usd`). They can
differ slightly from the cost Log Hub computes from transcripts and its price table, which the
other tabs show.

## Repository OTEL tab

Open a repository and pick **OTEL** (between **OKF** and **Settings**). From top to bottom:

- **Realtime data** badge and notices — see [The realtime channel](#the-realtime-channel).
- **Filter strip** — period (24 h, 7 d, 30 d, 90 d or a custom range of days), model, Claude
  Code version and calls (all, hidden only, in transcript), with the live indicator and a
  **Pause** button at the end.
- **Chart controls** — metric (cost, calls, tokens), stack by (structure, `query_source`, model,
  Claude Code version), interval (auto, 5 min, 1 h, 1 day), stacked or 100 % view, and a
  cumulative line on the right axis.
- **Chart** — hover a bar for its parts sorted by value with their shares, the total and the
  cumulative value. Click a legend item to hide or show that series.
- **KPI tiles** — total cost, per day, per session, API calls, hidden cost and sessions, each with
  the change against the previous period of the same length; a second row with tokens by type,
  the cache read ratio and the cost per user.
- **Cost structure & hidden calls** — the share of each `query_source` (click a row to isolate it
  in the chart) and the hidden calls.
- **Cost flow** — how the cost splits from model to branch (and to user, when the repository is
  opened from a team).
- **query_source breakdown** — calls, sessions, cost, share, hidden share and the context : output
  ratio per source. A **new** chip marks a source Log Hub does not know yet.
- **Sessions** — the 200 newest sessions of the period; click a row to open that session's OTEL tab. An **unconfirmed** chip marks a
  session with calls that arrived in realtime and are not yet confirmed.

The tab re-reads its data every 30 seconds while the period includes now. Every filter and
control is kept in the page address, so a view can be bookmarked or shared.

Opened from **My Repos**, the tab shows your own sessions. Opened from a team, it shows the
sessions of the team members you may see, and the cost flow gains a user column; in a
**restricted** team only the owner and managers see the tab there (see
[Team OTEL tab](#team-otel-tab)).

## Session OTEL tab

The **OTEL** tab of a session (the rightmost session tab) covers the session and all of its
sub-agents. From top to bottom:

- **Header** — the cost source, the hook version that sent the data and whether traces are on,
  with the **Realtime data** badge and its notices.
- **Chart** — the same chart as on the repository tab, with a 5 min or 1 h interval.
- **KPI tiles** — OTEL cost, hidden cost, API calls, turns (and how many are still running),
  sub-agents and the time the session waited for you; a further row with tokens by type and the
  cache read ratio.
- **Cost by source** — the share of each `query_source`.
- **Trace navigator** — step through the turns with **‹ Turn n of N ›**, ordered by **Start**,
  **Cost** or **Slowest**. Each turn shows its start, duration, cost, hidden cost, model calls,
  depth, waiting time and output tokens, and a **Time** bar that splits the turn into waiting for
  you, model, tool and other time (each moment counted once).
- **Minimap and waterfall** — every span of the turn on a time line, indented by its parent, with
  its duration and its cost including everything below it (Σ). Sub-agent rows carry
  `agent <id>`; hidden calls are red. A call the next-prompt suggestion made after the turn is
  shown next to the turn it belongs to. A turn whose top row has not arrived yet shows as
  **turn in progress**. Rows received in realtime and not yet confirmed have a dotted left border.
- **Details panel** — click a row for its request id, `query_source`, agent, model, tokens, cache,
  cost and context, and **show all raw** attributes. In a team where prompts are hidden from you,
  another member's raw attributes say "hidden for your role".

While the session runs, the tab asks for new data every 5 seconds and briefly highlights what is
new: a **NEW** tag on added rows, a flash on the Σ values above them, an outline on the changed
tile and bar, and a **↓ N new spans below** pill when new rows are out of view. It stops asking
when the page is hidden, after 10 minutes without input, when the session has ended, or when you
press **Pause**; **Resume** catches up at once.

## Team OTEL tab

A team page has an **OTEL** tab over all of the team's repositories and people. From top to
bottom: a filter strip (period, repositories, people, model, calls) with the live indicator and
**Pause**; the **Realtime data** badge and notices; the chart, stacked by person by default (the
five people with the highest cost by name, the rest as "others (N)"); two rows of tiles, including
the cost per active person and the number of repositories; the **Cost flow** from model to person
to repository (switch **Repository / Branch** to see the branch of each session as well); a
**People** table and a **Repositories** table.

- Click a person in the **People** table to filter the whole tab to that person; the people picker
  still lists everyone.
- Click **open OTEL ›** in the **Repositories** table to open that repository's OTEL tab in the team
  view.

Who sees it:

- in a **transparent** team, every member;
- in a **restricted** team, the owner and managers only. Other members (including an ADLC trainer
  who is not a manager) do not see the tab on the team page nor the OTEL tab of a team
  repository, and a direct link shows "No access". They still see their own data in the OTEL tab
  of the repository under **My Repos**.

A session linked to two of the team's repositories is counted once in the totals, the chart, the
tiles, the People table and the cost flow, and once per repository in the Repositories table (its
footer says so).

## Hidden calls

A **hidden** call is a model API call whose request id appears in no transcript of the session
tree — for example the grey next-prompt suggestion, progress summaries of sub-agents, or title
generation. These calls cost money but never show up in the session log. The OTEL tabs show them
in red in the chart and list them under **Hidden calls**. While a turn is still running, a call
can be counted as visible for a moment until its transcript arrives.

## The realtime channel

The hook sends OTEL data to Log Hub on two channels:

- **Realtime** — while a session runs, the hook forwards new calls and spans every few seconds,
  so the tabs update almost live. It is best-effort: nothing is stored on disk for it.
- **Regular upload** — the hook's OTEL files, uploaded at the end of each turn as before. This is
  the durable copy; it confirms the realtime data and fills anything the realtime channel missed.

The notices above the chart say where the data stands:

- **Unconfirmed** — calls received in realtime and not yet confirmed by the regular upload. Totals
  may still change a little.
- **Delayed** — the regular upload is late (for example the machine went to sleep). Missing data is
  filled when it arrives.
- **Gap** — some realtime data was missed (connection problems). It is filled from the regular
  upload.
- **Filled** — data the realtime channel missed has just been filled from the regular upload.

A gap caused by a restart of the hook's receiver is not detected, but the regular upload still
fills it.

To turn the realtime channel off, set `"otelRealtime": false` in `.artisyn/config/log-hub.json`.
The tabs then update after each turn instead.

## What Log Hub collects and how

**Signals.** Claude Code exports three OTEL signals:

- **logs** — one event per model API call (model, tokens, cache, `cost_usd`, `query_source`) and
  per tool call. Tool names and parameters come with `OTEL_LOG_TOOL_DETAILS=1`;
- **metrics** — counters such as cost, tokens and active time;
- **traces** — the spans of each turn (model calls, tool calls, their timing), only when you opt
  in (see [Enable OTEL and traces](#enable-otel-and-traces)).

No prompt or response content is collected through OTEL: Log Hub does not set the keys that would
add prompt text to the telemetry. Prompts reach Log Hub only through the transcripts the hook
uploads anyway (see [Data Collection & Upload](data-collection.md)).

**The path.** Since hook **2.30.0** the data takes this route:

1. Claude Code sends its telemetry to a **local receiver** on `127.0.0.1` — one receiver per OS
   user, on a port picked once at install time (a random port from 25000–65535, remembered in
   `~/.artisyn/otel/port.json`). The receiver starts with the first Claude Code session that needs
   it, serves every repository of that user, and stops after 10 minutes without data.
2. The receiver sorts the records per repository and writes them as chunks into that
   repository's `.artisyn/ai_work_dir/`. A session's records go to the repository the session
   registered with; records that arrive first are held for up to 5 minutes until the session
   registers, or are routed by the `artisyn.repo` tag (a hash of the repository path, never the path
   itself).
3. The hook uploads the chunks at the end of each turn, and the receiver also forwards new records
   over the realtime channel while the session runs (see [The realtime channel](#the-realtime-channel)).

Hooks before 2.30.0 started one receiver per repository; they keep working side by side with the
shared one.

**The settings the installer writes.** Claude Code's telemetry keys go into an `env` block:

| Key | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `none` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `http://127.0.0.1:<port>/v1/logs` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `http://127.0.0.1:<port>/v1/metrics` |
| `OTEL_LOG_TOOL_DETAILS` | `1` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `10000` |
| with traces: `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `1`, `otlp`, `http://127.0.0.1:<port>/v1/traces` |

They are written to two files:

- **`~/.claude/settings.json`** (your user settings; `$CLAUDE_CONFIG_DIR/settings.json` when that
  variable is set). Claude Code **2.1.282** and newer read telemetry keys only from user or managed
  settings — see [Claude Code 2.1.282 change](#claude-code-21282-change). The installer checks the
  file first and refuses to write when it is not valid JSON or a known key has a wrong type, keeps
  the previous content in `~/.claude/settings.json.artisyn-bak`, and never changes a value you set
  yourself. When it replaces or forwards your own collector settings it leaves a short
  `_artisynOtel` note in the file saying what it changed.
- **`.claude/settings.local.json`** of the project (gitignored), a mirror of the same keys on the
  same port for older Claude Code versions, which still read project settings. It also carries
  `OTEL_RESOURCE_ATTRIBUTES` with the `artisyn.repo` tag, keeping any attributes you already had.

**If Claude Code already sends OTEL elsewhere.** When your user settings or environment already
point Claude Code at another collector, the installer asks what to do (answer it with
`--otel-existing=proxy|keep|replace` in a non-interactive run; the answer is remembered until your
collector settings change):

- **proxy** (recommended) — Claude Code sends to the Log Hub receiver, which writes its copy and
  forwards every request unchanged, with your headers, to your collector. Only OTLP/HTTP JSON
  collectors can be forwarded; for a `grpc` or `http/protobuf` collector the installer asks for an
  OTLP/HTTP address of the same collector, or offers keep or replace.
- **keep** — your collector stays as it is and Log Hub writes no telemetry keys; the OTEL tabs stay
  empty for you (reason **OTEL is not configured**). This is the default of a non-interactive run.
- **replace** — the data goes only to Log Hub; your collector keys are removed.

Your original keys are saved in `~/.artisyn/otel/forward.json` and restored exactly when you
uninstall the hook from your last repository. With proxy or replace your collector sees a slightly
different stream than before: tool details are on (`OTEL_LOG_TOOL_DETAILS=1`), metrics are exported
every 10 seconds (`OTEL_METRIC_EXPORT_INTERVAL=10000`), and trace spans are added when traces are
on.

## Enable OTEL and traces

The hook turns OTEL on when it is installed or upgraded: the installer writes Claude Code's OTEL
settings into your user settings `~/.claude/settings.json` and into the project's
`.claude/settings.local.json` (see [What Log Hub collects and how](#what-log-hub-collects-and-how)).
A project installed before OTEL support starts sending OTEL after the next **upgrade** — see
[Connecting a Repository](connect-repository.md). Restart Claude Code after an install or upgrade:
a running session keeps the settings it started with.

If you answered **keep** to the existing-collector question, nothing goes to Log Hub. Run the
installer again with `--otel-existing=proxy` or `--otel-existing=replace` to change that.

## Claude Code 2.1.282 change

From version **2.1.282** on, Claude Code ignores telemetry keys (`CLAUDE_CODE_ENABLE_TELEMETRY`,
`OTEL_*`) in the project files `.claude/settings.json` and `.claude/settings.local.json`. They take
effect only in **user** settings (`~/.claude/settings.json`) or in **managed** settings set by an
admin. Older versions still read them from the project files.

Hooks before 2.30.0 wrote the keys only into `.claude/settings.local.json`, so with Claude Code
2.1.282 or newer such a project sends no OTEL at all. What to do:

1. Upgrade the hook to 2.30.0 or newer, or re-run the installer — it writes the keys into
   `~/.claude/settings.json`. The project mirror stays for older Claude Code versions.
2. Restart Claude Code.

The session tab then says **OTEL keys are only in project settings** for sessions that ran before
the fix. When the hook cannot tell the Claude Code version, it assumes the new behaviour.
`claude doctor` lists the project keys Claude Code ignores by name.

Claude Code's own documentation of these settings (online, optional):
<https://code.claude.com/docs/en/monitoring-usage>.

## Admin-managed OTEL

An organization can set Claude Code's telemetry centrally through **managed settings**: a
`managed-settings.json` file installed on the machine, an OS policy (Windows group policy or
registry, a macOS configuration profile through MDM), or server-managed settings from the Claude
admin console. Managed settings win over every other settings file **by design**: when they send
telemetry to another collector (**OTEL is managed by your organization**) or turn it off
(**Telemetry is disabled by your organization**), there is nothing you can change on your machine,
and re-running the installer does not help. The installer detects this, writes no user telemetry
keys and says `OTEL is managed by your organization — OTEL tabs are unavailable, everything else
works`.

Still works:

- sessions, prompts, tools and files;
- attribution;
- Log Hub cost (computed from transcripts and the price table).

Not available:

- the OTEL tabs;
- traces;
- telemetry cost reconciliation (Claude Code's own per-call cost);
- utility-call cost — the cost of calls that never appear in a transcript, so session cost is
  marked as excluding them.

When the managed settings pin only some signals (for example only logs), the others still reach
Log Hub and the tab shows partial data.

The only route is your admin: managed settings can point Claude Code at a collector that forwards
to Log Hub, or leave telemetry to user settings. Send them the
[OTEL admin guide](otel-admin-guide.md).

Traces (the waterfall of the session tab) are a separate opt-in. The installer asks
`Also export Claude Code traces (enhanced telemetry beta) to Log Hub? [Y/n]`; answer it with
`--otel-traces=yes` or `--otel-traces=no` in a non-interactive run. An upgrade keeps your earlier
answer. Without traces the charts, tiles and hidden calls still work; only the waterfall is
missing.

## Upgrade the hook for live updates

Live updates need hook **2.29.0** or newer. With an older hook the tabs show
"Data updates slowly — update the hook": the data arrives only with the regular upload at the end
of each turn, and a session has no traces. Upgrade the hook with the **Upgrade Hooks** card on the
Install tab or the **Copy upgrade cmd** button on the Hook State page.

When the hook is new enough but the tabs still say
"Data updates slowly — the hook's realtime channel is off or cannot reach the server", check that
`otelRealtime` is not `false` and that the machine can reach the Log Hub server.

## Troubleshooting: OTEL tab is empty

Since hook 2.30.0 the hook reports, at the end of each turn, why a session has no (or only part of
its) OTEL data, and the session tab shows that reason with a link here. The repository and team
OTEL tabs count the sessions without OTEL per reason; click a reason chip to list those sessions.

Where to look, for every reason:

- `/status` in Claude Code — the settings sources Claude Code uses;
- `claude doctor` — settings problems, including ignored project keys and managed settings;
- `claude --debug` — start a session with it to see OTEL export errors;
- `.artisyn/ai_work_dir/hook.log` in your project — the hook's `otel` warnings at session start
  and an `otel-status state=… reason=…` line per turn;
- `~/.artisyn/otel/receiver.log` — the shared receiver's log: what it received per repository
  (`ingest repo=…`), rejected requests and its idle stops.

### OTEL is managed by your organization

Reason `managed-endpoint`. Managed settings send at least one signal to another collector. Check:
`claude doctor` reports managed settings. Fix: none on your side — see
[Admin-managed OTEL](#admin-managed-otel) and ask your admin.

### Telemetry is disabled by your organization

Reason `managed-disabled`. Managed settings turn telemetry, or every exporter Log Hub needs, off.
Check and fix: as above — only the admin can change it.

### OTEL keys are only in project settings

Reason `project-only`. The Log Hub keys are in `.claude/settings.local.json` but not in
`~/.claude/settings.json`, and Claude Code is 2.1.282 or newer (or its version is unknown).
Check: `claude doctor` lists the ignored keys; `hook.log` has a `project-only` warning. Fix: re-run
the installer (or upgrade the hook) and restart Claude Code — see
[Claude Code 2.1.282 change](#claude-code-21282-change).

### OTEL is not configured

Reason `not-configured`. No Log Hub endpoint is in effect: the keys are missing from your user
settings, or you chose **keep** for an existing collector. Check: `/status`, and the `env` block of
`~/.claude/settings.json`. Fix: re-run the installer (choose **proxy** or **replace** if it asks
about an existing collector) and restart Claude Code — see
[Enable OTEL and traces](#enable-otel-and-traces).

### The local OTEL receiver was not reachable

Reason `receiver-down`. The hook could not reach the receiver, or another program holds its port
(`hook.log` then says `otel port-conflict port=<n>`). Check: `hook.log` and
`~/.artisyn/otel/receiver.log`. Fix: a new Claude Code session usually starts the receiver again.
For a port conflict, re-run the installer with `--otel-port <n>` (a free port) and restart Claude
Code. To restart the receiver with the installed code, run the installer with
`--restart-otel-receiver`.

### No OTEL data — cause not determined

Reason `unknown`. The settings look right but nothing arrived, or the receiver is too old to report
per-session counts. Check, in this order: `/status` (are the Log Hub endpoints in effect?),
`claude --debug` (export errors), `receiver.log` (did anything arrive for this repository?). Fix:
restart Claude Code after an install or upgrade; upgrade the hook; if it persists, re-run the
installer.

### OTEL tab is empty

No reason at all: the session was uploaded by a hook older than 2.30.0, which does not report why
(the tab says **No OTEL data for this session**). With Claude Code 2.1.282 or newer such a hook
sends no OTEL (see [Claude Code 2.1.282 change](#claude-code-21282-change)). Fix: upgrade the hook
and restart Claude Code; new sessions then report their reason. Imported sessions never have OTEL
data (see [Imported sessions](#imported-sessions)).

## Imported sessions

Sessions imported from an export file carry no OTEL data; their OTEL tab shows
"No OTEL data for this session". All other tabs work as usual.
