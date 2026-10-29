# Tuning Your Setup

The value of the Log Hub comes from a loop: run sessions → look at what they cost and why →
adjust your setup → compare the next sessions. This article covers the "adjust" step.

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

### Maintenance and Import/Export

- **Recompute all sessions** — refreshes all statistics from the stored logs; use it after
  category or pricing changes.
- **Import/Export** — move sessions between servers, or export session statistics.

## Hook configuration

Per-project hook options live in `.artisyn/config/log-hub.json` (shared, committable) and
`log-hub.local.json` (personal, gitignored — this is where the API key goes). Notable knobs:
context labels to tag every session (e.g. team or environment), upload timeouts, and the analyzer's model/timeout choices. See "Data Collection & Upload" and the
install guide for details.

## Acting on the Advisor's advice

The Advisor tab names concrete cost drivers per session. Common patterns and what to do:

| Advisor points at… | What to change |
|---|---|
| Large fixed context (CLAUDE.md, rules, skills, MCP tool schemas) | Trim CLAUDE.md, remove stale rules. Open **Harness Usage** — it lists every harness element with its usage count and token share; disable MCP servers and skills that are never used. |
| Heavy file reading / re-reading | Check the **Cache Read Ratio** report's causes. Split oversized files; point the AI at specific files instead of letting it scan. |
| Frequent compactions / peak context near the window | Prefer smaller, focused tasks and fresh sessions over one marathon session. |
| A few sessions dominating spend | Open the **Executive Summary**'s Top 5 most expensive sessions and read their logs — the pattern is usually visible in the Context Growth chart. |

## Closing the loop

After a change, give it a few sessions and compare: the **Cost** and **Cache Read Ratio** views
with a 1w preset before/after, and the per-engineer table in the **Executive Summary** week over
week. Tuning is never finished — attribute definitions, file categories, and the harness all
drift as the project evolves, so revisit them when the reports start looking noisy.
