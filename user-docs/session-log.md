# Session Log

The Session Log view displays a complete record of a single Claude Code session. Open it by clicking any row in the repository's session list.

## Views and tabs

A session has one row of tabs. It starts with the **View** select, which picks the few tabs that
answer one question and shows them in the row:

| View | Tabs in the row | Opens on |
|---|---|---|
| What happened | Summary, Logs, Bash, Timeline, Agent Tree, Change surface | Summary |
| Cost | Summary, Statistics, Call Tree, Context Growth, Dashboard, Advisor, OTEL | Statistics |
| Harness & context | System context anatomy, Context Usage, Harness usage, OKF, Info | System context anatomy |
| Failed tool call | Tools/MCP, Logs, Bash, Tool Heatmap, OTEL | Tools/MCP |
| All tabs | every tab | Summary |

- **Cost** is the view you start with. Log Hub remembers the last view you picked, per user, in
  this browser.
- Switching the view opens the tab in the **Opens on** column. A session link without a tab
  always opens **Summary**, whatever the view.
- Tabs a view does not show are under **More ▾** at the end of the row, under the headings
  Overview, Transcript, Cost & context and Effects. The same menu takes the tabs that do not fit
  on a narrow screen.
- When you open a tab that is not in the view (from More, a Summary card or a link), it shows at
  the end of the row after a divider, so you always see which tab is open.
- Tabs that have nothing to show for this session are left out, for example Advisor without an
  advisor result. Raw Logs is shown only to the session's owner.
- The view is part of the page address (`&lens=harness`), so a copied link opens the same view.
  Choosing a tab never changes the view.

The headings in **More ▾** group the tabs like this:

| Heading | Tabs |
|---|---|
| Overview | Summary, Info, Statistics, Advisor |
| Transcript | Logs, Bash, Raw Logs |
| Cost & context | Dashboard, Context Growth, Context Usage, Agent Tree, Timeline, Tool Heatmap, Call Tree, System context anatomy, Harness usage, OTEL |
| Effects | Change surface, Tools/MCP, OKF |

A red dot on **Tools/MCP** means an MCP server call of this session failed. Hover any tab for a
one-line description of what it shows.

The **Summary** tab ends with **Where to look next**: one card per tab worth a look, with its key
figure and **Open →**, and a row of questions (**Why so expensive?**, **What happened?**, **What
gets loaded?**, **Which tool failed?**) that switch to the matching view.

## Tabs

### Timeline

Shows each **prompt turn** in chronological order. Expand a turn to see:

- The user message and assistant response
- Tool calls made during the turn (file reads, bash commands, MCP calls, etc.)
- A call tree showing nested tool invocations

Every tool call is listed once, in the section it belongs to: **Files** (Read, Edit, Write,
MultiEdit, Glob), **Skills**, **Agents** or **Tools** (everything else). Click a row in Files,
Skills, Agents or Tools to open the call's details: its input, its full output and, for Bash, the
readable command view described under [Bash](#bash). Agent calls that never started a sub-agent
(for example "Concurrent subagent limit reached") are listed under Agents as compact rows. A Tools
row starts with the call's own one-line description when the agent gave one (Bash and PowerShell
calls usually do), followed by the rest of its input in grey.

#### Call status

Each call shows how it ended:

| Badge | Meaning |
|---|---|
| ✓ ok | The call ran and returned a result. |
| ✗ error | The call ran and failed (for example "String to replace not found"). Files and Skills rows show a red ✗; hover it for the error. |
| ⊘ rejected | The call never ran: the user said no, or a permission rule or auto mode blocked it. Hover the badge for the reason. Files and Skills rows show an amber ⊘. |
| ⏸ interrupted | The user interrupted the call while it was running. |
| output not captured | The log has no result for this call (the session ended or was compacted first). |
| ⚠ requested / ⚠ denied | Claude Code asked for permission to run this call / the permission was denied. |

Rejected, interrupted and uncaptured calls are not counted as failures on the Statistics tab.

### Bash

Every Bash command of the session — the main session and all its sub-agents — in the order they
ran. The tab label shows how many there are.

- **Left list:** one row per command with its number, start time, duration, status, a "changes N"
  chip when the command changed files, and a preview (the command's description, else its first
  statement). Commands run by a sub-agent carry the sub-agent's badge. Use ↑ / ↓ to move through
  the list; the selected command is kept in the page URL, so the link opens the same command.
- **Right pane:** the selected command, top to bottom:
  - the description, with `timeout` / background chips;
  - **WORKING DIR** — the directory of a leading `cd`, shown relative to the repository;
  - **FILES** — what the command touched: Changes, Reads, Runs (`npm run build`, `git status`, …)
    and inline scripts (`node -e`, heredocs into an interpreter), which are only noted, never
    analysed. Long lists are grouped by folder. This is a best-effort reading of the command, not
    a record of what happened on disk;
  - **COMMAND** — the command laid out as a short script: one statement per line, loop and `if`
    bodies indented, long `&&` / `|` chains broken after the operator, long heredocs folded
    behind a "▸ block n" toggle, with line numbers and syntax colours. **Formatted | Raw**
    switches to the original layout, and **Copy original** copies the command exactly as Claude
    ran it;
  - **OUTPUT** — the command's output, scrollable, with its size and token estimate.
- "Open sub-agent →" opens the sub-agent's own log for a sub-agent's command.

Paths under the repository root are shown relative to it. Commands that cannot be parsed (and
PowerShell commands) are shown as plain text.

### Charts

Each chart is a tab of its own: **Dashboard** (the key charts on one screen — click a card to open
the full chart tab), **Context Growth**, **Context Usage**, **Agent Tree**, **Timeline**, **Tool
Heatmap** and **Call Tree**. An older link that ends in `tab=charts` opens the chart you looked at
last (the dashboard the first time). The charts show:

- **Cost** — cumulative spend over time
- **Token usage** — input vs output tokens per turn
- **Work time** — active vs idle periods
- **Productivity** — lines added / removed per turn
- **Context growth** — how the context window grew turn by turn. Expand a turn to see its steps;
  the number on the right of a step is how much the context grew until the next step (`+20k`,
  `−3k`, or `—` for the last step). Click a step row (or focus it and press Enter) to open its
  details: every tool call of the step with its status, input and output — the largest result
  first — followed by the assistant's text.

### Info

Session metadata including:

| Field | Description |
|---|---|
| Model | The Claude model used (e.g. claude-sonnet-4-5) |
| Duration | Wall-clock time from first to last event |
| Files touched | Source files read or modified |
| MCP servers | External MCP servers invoked |
| Total cost | Estimated USD cost for the session |

### Raw Logs

The unprocessed JSONL log lines captured by the hook. Useful for debugging hook issues or writing custom analysis.

### System context anatomy

In the **Cost & context** group. It shows what Claude Code sent to the model **before you typed anything** — the
startup context of the session's first request — and how big each part of it was. The top of the
Logs tab shows the same total in one line, "Startup context · N tokens", with a **View anatomy →**
link to this tab.

- **Total** — the exact size of the first request in tokens (input + cache write + cache read, as
  the model reported it).
- **The bar** — the total split into coloured parts: the system prompt, the memory index
  (MEMORY.md), environment details, built-in tool names, MCP servers, subagent types, the skills
  listing, instruction files (CLAUDE.md and friends), system reminders and your first prompt.
  Hover a part for its size and share; click it (or its table row) to select it.
- **The table** — the same parts with bytes, ≈ tokens and share. Expand a part to see what it is
  made of: one row per skill, per file, per MCP server (with its status, tool count and the tools
  it loaded later on demand) or per prompt line. Only names, paths and sizes are shown — never
  the text of a file or prompt.

Every part except the total is an **estimate**: its size in bytes divided by a bytes-per-token
ratio for the model (shown under the total). Only the total is exact.

**Harness internals** (the hatched part) is what is left: tokens Claude Code sent in the first
request but did not write to the session log, so they cannot be split further. It is mostly the
definitions of the built-in and MCP tools, message wrapping, and the combined error of the
estimates above. If the estimates add up to more than the measured total, a warning shows the
difference and there is no Harness internals part.

The skills and files tables show where each item lives and its **git status**:

| Git status | Meaning |
|---|---|
| tracked | The file is committed to the repository. |
| untracked | The file is inside the repository but not added to git. |
| ignored | The file is inside the repository and ignored by `.gitignore`. |
| outside repo | The file lives outside the repository — your home folder (`~/.claude/…`), a plugin or an organisation-synced skill. |
| unknown | Log Hub has no git status for this file. |

Git status and file sizes on disk come from the hook. Git status needs **hook 2.28.0 or newer**;
with an older hook the tab says so and shows `unknown` (or `outside repo` for files clearly outside
the repository). Sessions recorded with a hook older than 2.22.0 have no file sizes on disk either.
A skill synced to you by your organisation is shown with the source **org-synced**.

## Navigation

Use the **back arrow** in the session header to return to the repository session list without losing your scroll position.
