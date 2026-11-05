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
  Claude Code version, **Skill**, **MCP server**, **Effort**, **Fast mode**), interval (auto,
  5 min, 1 h, 1 day), stacked or 100 % view, and a cumulative line on the right axis. See
  [Grouping by skill, MCP server, effort and fast mode](#grouping-by-skill-mcp-server-effort-and-fast-mode).
- **Chart** — hover a bar for its parts sorted by value with their shares, the total and the
  cumulative value. Click a legend item to hide or show that series.
- **KPI tiles** — total cost, per day, per session, API calls, hidden cost and sessions, each with
  the change against the previous period of the same length; a second row with tokens by type,
  the cache read ratio and the cost per user. When Claude Code reports a plan, the total cost tile
  also shows the **Mix of plans** — see [Plan and notional cost](#plan-and-notional-cost).
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
  with the **Realtime data** badge and its notices. When Claude Code reports account details, an
  **Account:** row below it shows the plan, seat type, provider and custom API base URL, with a
  note on what the plan means for the amounts — see [Plan and notional cost](#plan-and-notional-cost).
- **Chart** — the same chart as on the repository tab, with a 5 min or 1 h interval. It can be
  stacked by structure, `query_source`, model, **Skill**, **MCP server**, **Effort** or
  **Fast mode** (see
  [Grouping by skill, MCP server, effort and fast mode](#grouping-by-skill-mcp-server-effort-and-fast-mode)).
- **KPI tiles** — OTEL cost, hidden cost, API calls, turns (and how many are still running),
  sub-agents and the time the session waited for you; a further row with tokens by type and the
  cache read ratio. The OTEL cost tile carries a `plan: <value>` chip when a plan is reported.
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
five people with the highest cost by name, the rest as "others (N)") and also by **Skill**,
**MCP server**, **Effort** or **Fast mode** (see
[Grouping by skill, MCP server, effort and fast mode](#grouping-by-skill-mcp-server-effort-and-fast-mode));
two rows of tiles, including the cost per active person, the number of repositories and the
**Mix of plans** on the total cost tile (see [Plan and notional cost](#plan-and-notional-cost));
the **Cost flow** from model to person
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

## Live view

The **Live** button in the top bar (next to **Home**) shows what is running right now, across
your own repositories and every team you belong to. A red dot on it means at least one session is
live; hover it for "Live now: N sessions · M agents · $x.xx" (or "Nothing live right now"). The
button checks every 10 seconds while the page is visible.

**Opening.** Click **Live** to open the Live window over the current page. It is kept in the page
address (`live=`), so **Back** closes it and a link to it opens the same node. Close it with ✕ or
Esc. Like the OTEL tabs, it uses OTEL data only.

**The tree** on the left: **Home** → each of your teams (by name) and **No team** (your own
repositories that are linked to none of your teams) → repositories → sessions (owner email on
the first line, the start of the first prompt on the second) → their agents (the main agent and
sub-agents). Live rows are shown normally; sessions and agents that stopped in the last 2 hours
stay, greyed with an **ended** chip. Click a row to show it in the middle; hover a row and click ⓘ
to open its details panel on the right. A session linked to two repositories appears under both;
parent totals count it once, and the breakdown says so in a footnote. When new data arrives, every
row whose cost went up flashes green for a moment, so you can see which session just ticked.

Drag the borders between the tree, the middle pane and the details panel to resize them; the
widths are remembered in your browser.

**The middle pane** for the selected node: KPI tiles (cost, running time, live sessions and
agents — or calls and model for an agent — and cost per minute), a chart carousel (cost, tokens, calls and cost by model,
cost by structure, cost by skill / MCP server, with traces on LLM and tool latency p50 / p95, and on
Home, a team or a repository three doughnuts side by side — cost or tokens by team, by repository
and by user; these count each session's totals since start once, under its first team and repository)
and a breakdown table of the node's children (cost, input, output, cache read and write, calls,
running time, last activity). Below the charts, a **Cost flow** diagram shows where the cost of
the last 2 hours went: from models to teams, users and sessions on Home, to users, repositories
and sessions for a team, and to users and sessions for a repository. For a session it is a
**Token flow** from models to its agents. Hover a band or a node for its value, share and calls.
A session's breakdown lists its agents, including finished ones
(up to 50, then "+N more"); a session row has **Open session ↗**, which opens that session in its
repository. An agent shows its latest 50 calls instead.

**The details panel** shows top users, models and repositories for a team, repository or Home;
the owner, start time, Claude Code version, first prompt, agents, top tools and latest events for
a session; and the model, top tools, events and calls for an agent. Team and repository panels
have an **Open OTEL tab ↗** link, a session panel an **Open session ↗** link.

**Since start and last 2 h.** Totals and running time cover the whole session ("since start"),
even when it has run for days; running time is wall-clock time from the first to the latest call,
shown like `45s`, `12m`, `3h 12m` or `2d 4h`. The charts, top models and top tools cover the last
2 hours in 5-minute steps; cost per minute covers the last 5 minutes.

**Updates and Pause.** The window refreshes every 5 seconds while it is visible. **Pause** freezes
it ("Paused at hh:mm:ss") until you click **Resume**. Like the OTEL tabs, it also stops after
10 minutes without any input and resumes on the next one. If the server cannot be reached, an
amber banner says "Connection lost — showing data from hh:mm:ss, retrying" and the last data stays
on screen.

**Ended sessions.** A session with no OTEL data for 10 minutes is no longer live. It stays in the
tree, greyed with an **ended** chip, for 2 hours after its last activity (longer if it is the node
you are looking at or its details panel is open), and its details say "No OTEL data for 10 min —
figures are final." Its cost still counts in the totals of its repository, team and Home, but not
in the live session and agent counts or in the header button. A link to a session that ended more
than 24 hours ago opens Home instead. With nothing in the tree, Home shows "Nothing is live right
now" and a link to [Enable OTEL and traces](#enable-otel-and-traces).

**Access.** You see the same sessions as on the OTEL tabs: your own, and in each team the
sessions its access rules let you see. In a team whose analytics you may not see (a
**restricted** team where you are not the owner or a manager) the team shows 🔒 and only your own
sessions. Where the team hides other members' prompts, their first prompt reads "prompt hidden" and
tool names read "masked"; costs and counts are still shown. Sessions that are not linked to any
repository are not shown.

**What is not shown.** API errors, user-prompt events and Claude Code metrics (lines of code,
commits, active time) are not part of the Live view, and there is no count of updates missed
while paused.

## Hidden calls

A **hidden** call is a model API call whose request id appears in no transcript of the session
tree — for example the grey next-prompt suggestion, progress summaries of sub-agents, or title
generation. These calls cost money but never show up in the session log. The OTEL tabs show them
in red in the chart and list them under **Hidden calls**. While a turn is still running, a call
can be counted as visible for a moment until its transcript arrives.

## Grouping by skill, MCP server, effort and fast mode

Newer Claude Code versions tag each model API call with what it was made for. The **stack by**
control of the repository, session and team tabs can split the chart by these tags:

- **Skill** — the skill that was active for the call (`skill.name`);
- **MCP server** — the MCP server whose tool led to the call (`mcp_server.name`);
- **Effort** — the reasoning effort of the call (`effort`);
- **Fast mode** — the speed setting of the call (`speed`).

Values are shown exactly as Claude Code sends them. Calls without the tag form one grey
**not reported** series; hover its ⓘ in the legend for the reason. A call is "not reported" when
the Claude Code version does not send that tag yet, when the setting was left at its default, or —
for skill and MCP server names — when `OTEL_LOG_TOOL_DETAILS=1` is not set (the installer sets
it). Older sessions, or sessions from an older Claude Code, show only the **not reported** series;
the totals are the same under every grouping.

## Plan and notional cost

Recent Claude Code versions (2.1.317 and newer) also report the account a session ran under: the
**plan** (for example `pro` or `max`), the seat type, the API provider and, when one is set, a
custom API base URL. Log Hub shows them on the session OTEL tab as the **Account:** row and as a
`plan: <value>` chip on the OTEL cost tile. Only the address part of the base URL is kept — user
names, passwords, query and fragment are removed — and in a team where prompts are hidden from
you, another member's base URL is not shown.

On a **subscription plan** Claude Code's `cost_usd` is a **list-price equivalent**: what the calls
would cost at API prices, not money that was billed. The session tab says so in a blue note, and
on the repository and team tabs the total cost tile lists the **Mix of plans** — for each plan the
number of sessions and their cost, with sessions that reported no plan as **not reported**. The
amounts themselves are not changed.

Sessions from an older Claude Code have no plan: they show no Account row, no chip and no note,
and count as **not reported** in the mix.

## Sub-agent cost from OTEL

In Claude Code before **2.1.307** a sub-agent's transcript can miss some of its API calls, so the
cost computed from such a transcript can be too low. For those sessions Log Hub takes a sub-agent's
cost from its OTEL calls whenever that is higher than the transcript cost. The sub-agent's cost
then reads **from OTEL**, and the session's cost breakdown shows **Sub-agents (from OTEL)**.
Session totals of older sessions can therefore be higher than before — on the session list, the
session header, analytics and reports alike. Sessions from 2.1.307 and newer, and sessions
without OTEL data, keep the transcript cost.

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
