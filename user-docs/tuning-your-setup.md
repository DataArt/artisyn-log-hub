# Tuning Your Setup

The value of Log Hub comes from a loop: run sessions → look at what each part of your harness
did to their quality, cost, speed, autonomy and safety → adjust your setup → compare the next
sessions. This article covers the "adjust" step.

## Repository settings

Everything below lives in the repository's **Settings** tab. On a team repository these are
managed by the team owner (others see them read-only, marked "Managed by team owner"); on a
personal view you can save your own overrides for File Categories and Analysis. Effective values
resolve personal → team → built-in default.

### Display

**Hide hook-service sessions** — keeps the hook's internal background sessions out of your list.
On by default; a per-user view preference.

### File Categories

Define how files are grouped in file statistics — e.g. `docs`, `tests`, `config` — each as a set
of regular-expression patterns over file paths. Anything unmatched falls into the built-in
**code** category. A live **"Test a file path"** field and a regexp cheat sheet help you get the
patterns right.

Patterns are matched against paths **relative to the repository root** — write `^docs/`, not
`/home/me/project/docs/`. The root comes from the hook's git info (a linked worktree counts too),
so the same patterns work on every teammate's machine and OS. A file read from **outside** the
repository keeps its full absolute path (e.g. `/home/me/other-project/docs/x.md`), so a
repo-relative pattern like `^docs/` does not catch it.

Why it matters: categories drive the file sections of the session Logs view, the
**Files & Tools** analytics, and the Advisor's file-usage picture. With good categories you can
see at a glance whether a session burned its budget reading documentation or actual code.

### Analysis

- **High cache-creation threshold (tokens per turn)** — turns writing at least this many cache
  tokens get attributed to a cause (compaction or file re-read) in the **Cache Read Ratio**
  report's "Why was cache creation high?" section. Default 25,000.
- **Turn-End Cost Advisor** — the checkbox that turns automatic per-turn cost advice on, plus a
  **Minimum session cost (USD)** field (default $0.10).
- **OKF thresholds** — the levels behind the [OKF tab](okf-tab.md)'s verdict and value signals,
  as a table of each setting with its default, its value and what it affects, in two groups
  (verdict, value signals). **codeRoots** lists the folders that hold this repository's code
  (default `server/`, `client/`, `hook/`, `scripts/`, `packages/`, `tests/`); an article's code
  area is built from the paths under them, so set it to your repository's own folders — type a
  folder and press Enter or **Add**. **Save for this repo** writes only the values that differ
  from the defaults, **Reset to defaults** removes them, and in your personal view **Copy from
  team settings** fills the form from the team's values. Changes apply at once, with no
  recompute. See [OKF tab → Thresholds](okf-tab.md#thresholds).

### Monitored Tools

The CLI tools (e.g. `psql`, `gh`) whose calls the hook wraps, so their input and full output
show up on the **Tools/MCP** tab — MCP servers are recorded without any setup. Each row has the
tool name and an on/off switch; **Pause all wrapping** stops the hook wrapping anything while
keeping the list. A monitored tool is always recorded in full. The personal view edits your own
list, the team view the team's list (team owner only). The **Monitored tools** button on the
Tools/MCP tab opens this tab. Shells, the agent's own tools and shell builtins cannot be monitored.

### Session Attribution

Team-only. Define up to 12 attributes the AI fills in for every session — the defaults are
**Jira Ticket** (Text), **Workflow Stages** (Text list), and **Has Correction** (Yes/No). Each
attribute has a key, a label, a type, and a plain-language prompt describing what to extract.
A key and type are locked once saved, because historical values depend on them.

Tune the attributes to match how your team wants to slice the data — ticket keys, work type,
review outcomes. Keep the extraction prompts specific; the AI only sees your prompts and the
changed-file list, so ask for things visible there. Each evaluation is a small extra LLM call
(typically 1–5¢) — the **Attribution Usage** report tracks that spend.

### Budgets

A daily, weekly or monthly spend budget with the thresholds that raise a notice (75 %, 90 % and
100 % by default). On a personal repository you set it yourself; on a team repository, and for
the whole team on the team page's **Settings** tab, the team owner and managers set it. A budget
does not stop anyone; it makes the **Spend** tab show the spend against it, the forecast and the
cost slices, and it tells the people who manage it when a threshold is crossed. See
[Budgets](budgets.md).

### Maintenance and Import/Export

- **Recompute all sessions** — refreshes all statistics from the stored logs; use it after
  category or pricing changes.
- **Import/Export** — move sessions between servers, or export session statistics.

## Hook configuration

Per-project hook options live in `.artisyn/config/log-hub.json` (shared, committable) and
`log-hub.local.json` (personal, gitignored — this is where the API key goes). Notable knobs:
context labels to tag every session (e.g. team or environment), upload timeouts, and the
analyzer's model/timeout choices. See [Data Collection & Upload](data-collection.md) and
[the install guide](../hook/INSTALL_HOOK.md) for details.

## Acting on the Advisor's advice

The Advisor tab names concrete cost drivers per session; the session's other tabs show what the
rest of the harness did. Common patterns and what to do:

| Log Hub points at… | What to change |
|---|---|
| Large fixed context (CLAUDE.md, rules, skills, MCP tool schemas) | Open **System context anatomy** — it shows what Claude loads at startup and how many tokens each part costs. Trim CLAUDE.md and remove stale rules. **Harness usage** lists every harness element with its usage count and token share; disable MCP servers and skills that are never used. |
| A knowledge base the agents do not use, or use without effect | Open the **OKF** tab — it shows which articles the agents read, which led them to the code and which change to make to the KB next to every problem. |
| An MCP server or CLI tool that fails or is never useful | Open **Tools/MCP** — it lists the MCP calls and the calls of monitored CLI tools, with their failures. Fix or remove the server, or narrow which of its tools the agent may use. |
| Heavy file reading / re-reading | Check the **Cache Read Ratio** report's causes. Split oversized files; point the AI at specific files instead of letting it scan. |
| Frequent compactions / peak context near the window | Prefer smaller, focused tasks and fresh sessions over one marathon session. |
| A few sessions dominating spend | Open the **Executive Summary**'s Top 5 most expensive sessions and read their logs — the pattern is usually visible in the Context Growth chart. |

## Closing the loop

After a change, give it a few sessions and compare: the **Cost** and **Cache Read Ratio** views
with a 1w preset before/after, the per-engineer table in the **Executive Summary** week over
week, and the tab that showed the problem (System context anatomy, OKF, Tools/MCP) on the next
sessions. A team budget keeps the loop honest over time: the **Spend** tab's **Previous period**
tile and cost slices show whether this week or month costs less than the last one, and the
forecast warns before a period runs over. Tuning is never finished — attribute definitions, file categories, and the harness all
drift as the project evolves, so revisit them when the reports start looking noisy.
