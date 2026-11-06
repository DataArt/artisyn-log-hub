# OKF tab

An **OKF knowledge base** is a folder of Markdown articles for coding agents whose `index.md`
starts with an `okf_version:` front-matter line. The **OKF** tabs show how the agents of your
sessions used such a knowledge base (KB): which articles they read, how much of them went into
their context, how they found them — and whether an article actually helped, with one concrete
change to make to the KB next to every problem.

Everything on these tabs is counted from the session transcripts and the KB list the hook sends
with each session. Nothing is judged by a language model.

## Two sections: A (verified) and B (heuristic)

Both OKF tabs are split in two titled sections:

- **A · How the KB was navigated (verified)** — structure, counted exactly from the agents'
  tool calls: the verdict card with its **Checks**, the findings, how agents reached the KB and
  the KB folder cards / KPI tiles. These numbers can be recomputed by hand.
- **B · Did the articles help? (heuristic — check by hand)** — value signals: what agents did
  *after* reading an article (followed its code paths, kept searching, searched without reading
  it). They are proxies — Log Hub cannot know what a search was about — so open the agent and
  judge the search patterns yourself. The section title says "N signals to check" when any signal
  fired, otherwise "nothing to check".

### Checks

Under the verdict, the card lists one line per structure check, also when the check found
nothing, with the counted value and the threshold: **✓** passed, **!** a finding (with its **→**
action line), **–** could not run (and why, e.g. no KB snapshot or a KB folder too small).

| Check | Tab | What it counts | Finding when |
|---|---|---|---|
| **KB used** | session | agents that read the KB, of all agents | no agent opened the KB |
| **Way in** | session | agents that started from `index.md`, found their article by search, or had the path in their task | — (information) |
| **Targeted reading** | session | the highest share of a KB folder's articles one agent read | more than 25 % — the agent read the KB wholesale instead of finding one article (more than 50 % is a mess) |
| **Upkeep** | session | agents that edited an article they read (those reads are left out) | — (information) |
| **KB sessions** | repository | sessions that read the KB, of the period's sessions | none did; below 5 the level is "Not enough data" |
| **KB flood** | repository | the KB folder most often read wholesale (> 25 % of its articles in one session) | in 3 or more sessions — the index does not route |
| **Always read** | repository | the most-read article and its share of KB sessions | 80 % or more — it belongs in always-loaded context (`CLAUDE.md`) |
| **Coarse article** | repository | the article of 50 KB or more read whole with the smallest part actually needed | readers need under 10 % of it, in 5 or more sessions — split it |

The numbers are the defaults; see [Thresholds](#thresholds). The session tab ends the block with
a line pointing to the repository OKF tab, where the checks that need many sessions run.

## Repository OKF tab

Open a repository and pick **OKF** (between **Reports** and **OTEL**). From top to bottom:

- **Filter strip** — period, branches, users, attributes, **KB folder** (one or all) and
  **Bytes / Calls** for the read heat. Every filter is kept in the page address.
- **No OKF analysis yet** banner — shown when some sessions of the period were recorded before
  your server learned the value signals; see [No OKF analysis yet](#no-okf-analysis-yet).
- **Section A** — the **verdict card**: one line (OK, Something to fix, Mess, KB not used, Not
  enough data), the subtitle "access, layout and value proxies", the [Checks](#checks), and the
  structure findings, worst first. The level also counts the value-signal findings, which are
  listed under section B (the subtitle says how many). Each finding has a
  second muted line starting with **→**: the change to make (see [Actions](#actions)). Grey
  findings are information only and never change the verdict. A **custom thresholds** chip lists
  the settings that differ from the defaults; **default thresholds ⚙** opens them (see
  [Thresholds](#thresholds)).
- **KPI tiles** (section A) — KB files, files not read in the period, sessions that touched the
  KB (plus the number of **upkeep-only** sessions, not counted), sessions that started from
  `index.md` and the median file share per session.
- **Section B** — the **Pointer yield** and **Articles with routing misses** tiles and the
  value-signal findings (routing miss, searched after reading, dead pointers, catalog), each with
  its **→** action line.
- **KB tree** — KB folder → file, with the read heat, writes, and the columns:
  - **Paths followed k / n** — of the *n* reads of the article that showed the agent a new code
    path, *k* had that path opened afterwards;
  - **Searched after reading** — agents that kept searching the article's code after reading it, and their
    searches — a search of a file the article points to, or of a folder that holds one (folders
    near the repository root, such as `server/src/`, are too wide and do not count);
  - **Searched without reading X / Y** — *X* agents searched the article's code at least three
    times without ever opening the article, out of *Y* agents that searched there at all;
  - markers: `routing miss`, `1 partial read (line range)` / `N partial reads` (reads of a
    line range, not the whole file),
    `catalog N`, `N dead` (pointers nobody follows), `upkeep ×N`, `stale · now X KB` (the article
    changed since most of the counted sessions), `not read`, plus the older `hot`, `coarse` and
    `folder scan`. A legend under the tree explains them.
- **File share histogram** — how much of a KB folder each session read, only for KB folders of
  at least the configured number of files (the caption says "KB folders of ≥ N files").
- **Hot files** — the most read articles, with their **Yield**.

On a wide screen the histogram, hot files, upkeep and not-read lists sit in a column beside the
tree; on a narrower one they move below it, so the tree's columns never need sideways scrolling.
- **Upkeep** — articles read by an agent that also edited them; see [Upkeep](#upkeep).
- **Not read** — KB files no session of the period read (information only).

Opened from **My Repos**, the tab shows your own sessions. Opened from a team, it shows the
sessions of the team members you may see; KB files the author's git ignores never appear there.

## Article drill-down

Click an article's name in the tree to open its page; **← back to the tree** returns. It shows:

- **Header** — the size, whether the counted sessions saw the current version of the file, and
  the reads: "whole N · § section N · upkeep N excluded", plus the reads that were cut to a
  preview, empty or failed and are not counted.
- **Value signals** strip — yield "k / n reads", searched after "N agents · N searches", routing
  miss "X of Y agents", dead pointers "N dead of M shown" and catalog "N area files". A signal
  with no data shows "—".
- **Pointers** — every code path the article showed the agents, with "✓ followed ×k" or
  "· shown ×n, never followed". Dead pointers come first; one that no session ever touched is
  tagged "path not found in any session". The first 17 rows show, then **Show all**.
- **Routing miss** and **Searched after** blocks — the top five search patterns the agents used
  and the action; the routing-miss block also lists the agents that missed the article, with the
  start of their task (hidden where your team role hides prompts — the patterns are always
  shown).
- **Catalog** block and **Same finding on other articles**.

When no session has read the current version yet, the article's code area comes from an older
version and the page says so.

## Session OKF tab

The **OKF** tab of a session (under **Harness & context**, or **More ▾ → Effects**) covers the
session and all its sub-agents:

Agents are named the same way everywhere on the tab: `main` is the session itself, and each
sub-agent is `1.N · <description>` — numbered in the order the agents started, named by the
description its parent gave it, else by the start of its task, else by a short id.

- **Section A** — the **verdict card**: the session verdict (upkeep excluded), the
  [Checks](#checks), the findings with their **→** action lines, **Read · top 5** with a "1 partial read (line range)" / "N partial reads" chip on
  articles read by line range and a muted **Upkeep** line, and how each agent reached the KB
  (`via index.md`, `via search`, `path given in its task`).
- **KB folder cards** (section A) — one per KB folder the session opened, with "N of M articles
  read" and the bytes that went into context; the KB folders nobody opened are listed on one line
  under them.
- **Section B** — the **Value signals (heuristic)** tile — **Code paths followed**, **Searched
  without reading**, **Searched after reading** (counted per agent and article, e.g. "2 agents
  kept searching after reading") and **Dead pointers** of the whole session tree, each with a
  one-line explanation under it — and a legend of how to check each signal by hand. Under
  **Searched without reading** and **Searched after reading**, **Check by hand: show an agent's
  trail** opens the trail of the first agent behind the number.
- **Agent trail** (section B, once an agent is selected) — every KB and code call of that agent
  in order, numbered `#1`, `#2`, …, grouped into episodes that start at a KB article read. Under
  a read: the new code paths the article showed — the ones the agent used, each "opened at #N" or
  "searched at #N", then a folded "N more not opened · show" (or "N code paths, none opened ·
  show") that lists the rest as "never opened"; then "after reading: N searches in its area, M
  files opened". A code path is a back-ticked repo path in the article (`server/src/app.ts`,
  `package.json`); back-ticked names such as `Logger.error`, `process.env`, `upsert()` or a
  version like `2.31.0` do not count. Each search shows its
  full pattern and whether it **found** something or **nothing found**; a read or search in the
  code area of an article the agent read earlier is highlighted ("in area of …"). The agent is
  in the page address, so a trail can be bookmarked or shared; **×** closes it.
- **KB tree** — KB folder → file with the read heat and the columns **Code paths followed**
  (k / n) and **Searched after reading**; edits to the KB show as the `upkeep` / `own edit`
  markers. A legend under the tree explains the columns and markers. Each folder lists the
  articles read in this session first; the rest fold into one "N articles not read in this
  session · show" row. **code paths shown · N agents** on an article opens one row per agent with
  the new code paths the article showed it, ✓ for the ones it opened, and how many paths its own
  task already named (those do not count as new). An article the agent never opened but whose
  code it searched shows a "searched without reading · N searches" row with the action.
- **Agents** panel (beside the tree on a wide screen, below it otherwise) — per agent: its name,
  how it reached the KB, its task, KB reads, and **paths followed**, **searched w/o reading**,
  **edited KB** and **code searches**. Click an agent to show only its reads in the tree (articles
  it did not read are hidden then) and its trail in section B.
- "Events truncated" — a very long agent had more code accesses than Log Hub keeps; its signals
  may be incomplete.
- At the bottom, the command for a deeper analysis that runs locally in Claude Code:
  `/log-hub-hooks:kb-analysis <session id>`.

## Actions

Each finding names one change to the KB:

| Finding | What to do |
|---|---|
| Coarse article | Split the article at its headings, or add section pointers to `index.md`. |
| Always read | Move the article's facts into `index.md` / `CLAUDE.md`. |
| KB flood | The index lines of the bundle do not route — sharpen the one-line descriptions. |
| Searched after reading | Add the facts the agents searched for to the article, or a section pointer to them. |
| Routing miss | Mention the searched topics in the article's `index.md` line (or in `CLAUDE.md` routing). |
| Dead pointers | Remove the paths, or write each as a full repo-relative path next to the fact it serves. |
| Catalog | Check the list of code paths: paths that a search finds in seconds need not be listed. |

### Searched after reading vs routing misses — how to check by hand

- **Searched after reading**: an agent read article X and then still searched the code area of X.
  The article probably lacked the fact. Open the agent's **trail** (the link under the tile on the
  session OKF tab, or **Agent trail** next to the agent in the article drill-down's **Searched
  after reading** block): the read of X opens an episode, and the highlighted searches after it
  are the ones counted. Read each pattern: a search for something X names (a function, a file it
  points to) means X lacks that fact or says it too vaguely — a gap in the article; a search for
  something X does not cover is normal work and no fault of X. **Nothing found** searches are
  often guesses at a name the article could have given. Fix: add the missing fact to X.
- **Routing miss**: an agent searched the code area of X and never opened X. The miss row (session
  OKF tab) and the **Routing miss** block (article drill-down) list the searched patterns; each
  missing agent has an **Agent trail** link (and a **Bash tab** link). In the trail, check that
  no read of X comes before those searches, and whether the searches were about X's topic. Fix:
  make X easy to find, e.g. a line in the catalog or `index.md`.
- **Code paths followed / dead pointers**: in the trail, the paths under each article read say
  where (and whether) the agent opened them.

A finding marked **stale** was computed over sessions that saw an older version of the file;
re-check it after a few sessions on the current version.

## Upkeep

When an agent reads an article it also edits, it is maintaining the KB, not looking something
up. Those reads are left out of the read totals, shares, hot files, the verdict and every value
signal, and are listed separately in the **Upkeep** panel (repository) or the **Upkeep** line
(session). A session whose only KB activity is upkeep is not counted as a KB session.

## Thresholds

The limits behind the findings are settings of the repository: **Settings → Analysis → OKF
thresholds**. The table shows each setting with its default, its value and what it affects, in
two groups — verdict and value signals. **Code roots** lists the folders that hold this
repository's code (an article's code area is built from the paths under them); set it to your
repository's own folders.

- **Save for this repo** writes only the values that differ from the defaults; **Reset to
  defaults** removes them; in your personal view **Copy from team settings** fills the form from
  the team's values.
- A personal value wins over the team's; without one, the team's value applies, then the default.
- Changing thresholds takes effect at once — no recompute is needed.
- The **Not settings** footer lists the fixed limits (list sizes, the 200-character pattern cut,
  the per-agent event cap).
- In a team view only the team owner can change them.

## No OKF analysis yet

Sessions recorded before your Log Hub server was upgraded to the value signals have read counts
but no pointers, searches or section reads. The repository tab then shows "X of Y sessions in
this period have no OKF analysis yet". The repository owner (or the team owner in a team view)
sees a **Recompute all sessions** link, which re-reads the stored transcripts; nothing has to be
uploaded again.
