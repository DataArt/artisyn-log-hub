# OKF tab

An **OKF knowledge base** is a folder of Markdown articles for coding agents whose `index.md`
starts with an `okf_version:` front-matter line. The **OKF** tabs show how the agents of your
sessions used such a knowledge base (KB): which articles they read, how much of them went into
their context, how they found them — and whether an article actually helped, with one concrete
change to make to the KB next to every problem.

Everything on these tabs is counted from the session transcripts and the KB list the hook sends
with each session. Nothing is judged by a language model.

## Repository OKF tab

Open a repository and pick **OKF** (between **Reports** and **OTEL**). From top to bottom:

- **Filter strip** — period, branches, users, attributes, bundle (one KB folder or all) and
  **Bytes / Calls** for the read heat. Every filter is kept in the page address.
- **No OKF analysis yet** banner — shown when some sessions of the period were recorded before
  your server learned the value signals; see [No OKF analysis yet](#no-okf-analysis-yet).
- **Verdict card** — one line (OK, Something to fix, Mess, KB not used, Not enough data), the
  subtitle "access, layout and value proxies", and the findings, worst first. Each finding has a
  second muted line starting with **→**: the change to make (see [Actions](#actions)). Grey
  findings are information only and never change the verdict. A **custom thresholds** chip lists
  the settings that differ from the defaults; **default thresholds ⚙** opens them (see
  [Thresholds](#thresholds)).
- **KPI tiles** — KB files, files not read in the period, sessions that touched the KB (plus the
  number of **upkeep-only** sessions, not counted), sessions that started from `index.md`, the
  median file share per session, **Pointer yield** and **Articles with routing misses**.
- **KB tree** — bundle → folder → file, with the read heat, writes, and the columns:
  - **Yield k / n** — of the *n* reads of the article that showed the agent a new code path, *k*
    had that path opened afterwards;
  - **Expl. after** — agents that kept searching the article's code after reading it, and their
    searches;
  - **Route miss X / Y** — *X* agents searched the article's code at least three times without
    ever opening the article, out of *Y* agents that searched there at all;
  - markers: `routing miss`, `§ section reads ×N` (reads of a line range, not the whole file),
    `catalog N`, `N dead` (pointers nobody follows), `upkeep ×N`, `stale · now X KB` (the article
    changed since most of the counted sessions), `not read`, plus the older `hot`, `coarse` and
    `folder scan`. A legend under the tree explains them.
- **File share histogram** — how much of a bundle each session read, only for bundles of at
  least the configured number of files (the caption says "bundles of ≥ N files").
- **Hot files** — the most read articles, with their **Yield**.
- **Upkeep** — articles read by an agent that also edited them; see [Upkeep](#upkeep).
- **Not read** — KB files no session of the period read (information only).

Opened from **My Repos**, the tab shows your own sessions. Opened from a team, it shows the
sessions of the team members you may see; KB files the author's git ignores never appear there.

## Article drill-down

Click an article's name in the tree to open its page; **← back to the tree** returns. It shows:

- **Header** — the size, whether the counted sessions saw the current version of the file, and
  the reads: "whole N · § section N · upkeep N excluded", plus the reads that were cut to a
  preview, empty or failed and are not counted.
- **Value signals** strip — yield "k / n reads", searched after "agents · searches", routing
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

- **Verdict card** — the session verdict (upkeep excluded), the findings with their **→** action
  lines, **Read · top 5** with a `§ section ×N` chip on articles read by line range and a muted
  **Upkeep** line, and how each agent reached the KB (`✓ index`, `grep`, `given`).
- **Value signals** tile — the yield, routing misses, searched-after pairs and dead pointers of
  the whole session tree.
- **Bundle cards** and the **KB tree**, with the columns **Pointers used** (k / n) and **Expl.
  after**. Expand an agent's row to see the new code paths each article showed it, ✓ for the ones
  it opened, and how many paths its own prompt already named (those do not count as new). An
  article the agent never opened but whose code it searched shows a "routing miss · N searches"
  row with the action.
- **Agents** panel — per agent: task, entry, KB reads, **yield**, **routing misses**, **upkeep**
  and **searches**.
- "Events truncated" — a very long agent had more code accesses than Log Hub keeps; its signals
  may be incomplete.

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
