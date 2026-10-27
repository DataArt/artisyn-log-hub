# PoC — OKF usage analysis on real sessions: cost, speed, usefulness

Task: [2026-10-27-okf-usage-tab](../../tasks/todo/2026-10-27-okf-usage-tab/requirements.md)
(FR-19, FR-20) and [2026-10-27-kb-completeness-deep](../../tasks/todo/2026-10-27-kb-completeness-deep/requirements.md),
which took the analysis over.

## Question

Run the post-turn KB usage analysis the way the hook worker would (`claude -p`, `sonnet`,
`--no-session-persistence`) on real sessions of this repo. How much does one run cost, how long
does it take, and is the result useful — iterate on the prompt and the input until it is.

## How to run

From this folder (needs a logged-in `claude` CLI; spends real credits):

```sh
node select.mjs                      # list local sessions with KB stats and approximate cost
node run.mjs <id-prefix> [...]       # analyse these sessions; outputs land in out-runs/ (ignored)
```

`extract.mjs` reads a local transcript tree (root + `subagents/*.jsonl`) from
`~/.claude/projects/<repo>/` — the same sessions local prod holds — and builds FR-22 inputs from it.
The PoC uses `--output-format stream-json --verbose` instead of the worker's `json` only to list
which files the model read; cost and timing fields are the same.

## Usefulness criteria (each run is judged against these)

1. **Nothing lost** — the whole task context reaches the model: inline, or a context file the
   model reads to its last line (checked in `<id>.tools.txt`).
2. **Every KB read judged** — each KB file each agent read gets a verdict, against that agent's
   own task.
3. **Grounded misses** — every `missed` path exists in the KB, names a section, and the reason
   ties it to something the session actually did or asked.
4. **Actionable index hints** — a hint names the index line to add or change; spot-checked
   against `docs/knowledgebase/index.md`.
5. **No anachronism** — a miss must not rely on KB text written after the session.
6. **Cost and time** — under about $1 and 5 minutes per run.
7. **KB quality, not session cost** (added for v4d) — findings are about granularity and
   findability; an article read by several agents is not a finding.

## Iterations

| Version | Change | Folder |
|---|---|---|
| v1 | `index.md` + outline of every KB file in the prompt | `out-runs/v1-outline/` |
| v2 | only `index.md`; the model reads KB files itself, moderately curious | `out-runs/v2-index/` |
| v3 | task context never cut — over the 60 KB cap it goes to a file the model reads in full; tracker lookup only counts MCP / `gh` / `curl` calls; reading a little code allowed | `out-runs/v3-file/` |
| v4a | no transcript text: user prompts (filtered) + session facts from the session view's own analyser (`facts.ts` → `buildBashView`) + KB indexes; every KB read gets a verdict; `gaps` added (`run4.mjs`, `prompt-v4.md`) | `out-runs/v4a/` |
| v4b | KB as of session start (`git archive` of the last commit before it, outside the repo — also no repo `CLAUDE.md`/rules/hooks in the model's context); facts over guesses; separate `cost: ok\|excessive` per read; a read file can be `missed` only by section; gaps must be checked against the KB (`prompt-v4b.md`, `KB_AT_SESSION=1`) | `out-runs/v4b/`, `out-runs/v4b-final/` |

| v4c | per agent: each sub-agent's own spawn prompt is its task, its reads are judged against it (stopped before finishing — the cost axis was the wrong goal) | — |
| v4d | goal = KB quality, not cost; per-agent facts incl. the order of first KB accesses and article sizes; each read judged on `verdict`, `granularity` (`too_coarse`/`too_fine`) and `findability` (`index`/`search`/`given`/`linked`); `kbFixes` list (`prompt-v4d.md`, `PER_AGENT=1`) | `out-runs/v4d/` |

| v4e | every finding gets a `cause` (`entry_point` / `index_line` / `granularity` / `agent_choice`) with the index line quoted; `kbFixes` with `kind` + `keywords`, separate `entryFixes`; deterministic filter (no split under 20 KB, no index fix whose keywords the line already has) (`prompt-v4e.md`) | `out-runs/v4e/` |
| v4f | the harness as of session start (`CLAUDE.md`, rules, skills) under `harness/` in the snapshot; read the file before proposing an entry fix; an `entry_point` still gets its index line checked (`prompt-v4f.md`) | `out-runs/v4f/` |

Run the latest: `PROMPT=prompt-v4f.md KB_AT_SESSION=1 PER_AGENT=1 node run4.mjs <tag> <id-prefix> [...]`
(needs `bun`).

## Result

**Outcome: the LLM analysis does not belong in the per-turn hook path; it becomes an on-demand,
local Opus skill** (task `2026-10-27-kb-completeness-deep`), and the OKF tab keeps only the
deterministic facts and verdict (task `2026-10-27-okf-usage-tab`, FR-19). Reasons, from the runs:

- **Cost**: one run per session cost $0.45–0.90 and 4–7 min (v4d–v4f, Sonnet) — too much to run
  after every turn of every session.
- **Stability**: with one combined prompt, a fix to one class of findings removed another. v4e's
  cause split stopped the wrong "split this 8 KB article" fix (`server-conventions.md` became
  `agent_choice` — its index line already names the perf section); v4f's harness access stopped
  "add a rule to CLAUDE.md" fixes for a rule that already exists — but then the entry-point class
  disappeared entirely, and the `hook-system-overview.md` index-line miss found in v4b was lost in
  v4e and v4f. Hence the skill's design: specialised passes in parallel, one per class of findings,
  merged deterministically.

| Run | e88adad0 | 0edba12b | 89206502 | 92f0ad24 |
|---|---|---|---|---|
| v4d | $0.61 · 234 s | $0.52 · 212 s | $0.45 · 186 s | $0.50 · 283 s |
| v4e | $0.59 · 266 s | $0.70 · 260 s | $0.62 · 293 s | $0.59 · 340 s |
| v4f | $0.45 · 255 s | $0.79 · 388 s | $0.61 · 256 s | $0.90 · 426 s |

**Findings checked against the repo** (what the skill must keep finding):
- 100–170 KB monoliths read for 0.5–5 KB at a time: `api-reference.md` 171 KB,
  `client-component-map.md` 161 KB, `db-tables.md` 141 KB, `server-endpoint-map.md` 110 KB.
- `otel-cost-selection.md` has no line in `index.md` (found independently by three sessions).
- `hook-system-overview.md` already documented PostToolUse's `tool_use_id` while a session built a
  PoC to find it out; its index line names no payload fields.
- `hook-installation.md`'s index line lacks the installer-build words the article covers.
- Many agents — main and sub-agents — go to KB articles by grep without the index, although
  `CLAUDE.md` says to start from it.
- Fixed later by other work (confirms the analysis saw real holes): the new algorithm docs missing
  from `algorithms/README.md`; the undocumented tool-call SKIP list.
- Wrong recommendation (fixed by the cause split): split `server-conventions.md` (8 KB; its index
  line already names the section).

**What carried over into the skill's design**: no transcript text — user prompts plus the session
analyser's per-agent facts (`facts.ts` → `buildBashView`); each sub-agent judged against its own
prompt; KB and harness as of session start, outside the repo; facts over guesses; goal = KB quality,
not cost; causes; deterministic merge and filter.

**Dropped on the way**: outlines of every file in the prompt (v1, broke the 60 KB cap); transcript
text (v2/v3; cut long sessions); regex extraction (double-counted multi-file Bash bytes, took
`<task-notification>` for prompts); a `cost` axis and tree-wide judging (v4b; sub-agents are
atomic tasks, cost is not KB quality).
