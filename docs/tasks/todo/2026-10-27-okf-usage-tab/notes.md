# Notes — 2026-10-27-okf-usage-tab

## 2026-10-27 — moved from requirements.md

### Research on local prod (2026-10-27, one week, 70 root sessions of the log-hub repo)

- The KB (`docs/knowledgebase`, 82 articles, 2.19 MB ≈ 600k tokens) is read mainly through
  **Bash, in fragments**: 540 Bash calls mention it (`grep -n` 171, `sed -n X,Yp` 143, `cat` 85)
  against 105 Read calls, and 66 of those 105 Reads carry `offset`/`limit`. So line-range precision
  is needed, not file precision. The existing `knowledgebase` file category counts only Read and
  sees less than a fifth of the real usage.
- 49 of 70 sessions touched the KB; 53 of 82 articles were read at least once; **29 were never
  read** (all of `log-schema/`, `upload-queue.md`, `turn-end-cost-advisor.md`, …).
- No "read 60 % of the KB" case that week: at most 15 distinct articles (18 %) per session.
  `index.md` was read in 34 of 49 KB sessions.
- The 1.1 MB outlier (one `implement-deep` session, `algorithms/bash-command-view.md`, 61 edits):
  first read as repeated re-reads of one's own edit; the 2026-10-27 PoC (below) shows it was
  **12 sub-agents each reading the same ~100 KB doc in full before editing** — a doc created in that
  very session. Most of those agents were reviewers whose own prompt was to read that doc, so this
  is a cost, not a KB-quality problem: "read by N agents" is information only (FR-12).
- KB work happens largely inside sub-agents (38 Agent prompts in 16 sessions reference the KB), so
  every figure must be session-tree scoped.
- 41 articles were edited during the week.
- Suspicion to check first: in sub-agent logs, identical Reads appear in pairs with `\` vs `/`
  paths and the same result size — either a double upload of the sub-agent log or two agents.

### Detection timing (measured on this repo, Windows)

| Method | Time |
|---|---|
| fs walk skipping `node_modules`/`.git` (542 `.md`, 512-byte front-matter read of each `index.md`) | ~80 ms |
| `git check-ignore --stdin` on the found indexes only | ~70 ms |
| `git ls-files -co --exclude-standard` | ~35 ms |
| `git ls-files -o -i --exclude-standard` (ignored) | ~500 ms — not to be used |

Found: `docs/knowledgebase` (tracked, 82 files), `docs/kb-local` (ignored, 2 files),
`tmp/kb-baseline` (ignored, 44 files — a junk copy, hence the default `tmp/` exclusion). Nested
`log-schema/index.md` and `test/index.md` have no `okf_version` and belong to the parent bundle.

### Decision history

- Open questions resolved by the owner on 2026-10-27 (defaults accepted): no links outside the repo;
  bundle = the index folder; heatmap by bytes with a calls toggle; no global OKF; LLM analysis on
  `Stop` when there are new OKF accesses. Later the same day: the task context comes from the
  transcript (FR-22) rather than globs alone, and a task is often just a one-line question — the
  prompt alone is then the whole task, nothing is inferred; the model may read referenced documents
  only via the opt-in fallback (FR-22a), restricted by a prompt instruction alone — no
  `--disallowedTools` or `--max-turns` in the first version; an opt-in also analyses turns without
  KB reads (FR-21); the cost is stated next to the checkboxes (FR-19a).

## 2026-10-27 — PoC: the post-turn analysis on real sessions

[`docs/pocs/2026-10-27-1950-okf-analysis-cost/`](../../../pocs/2026-10-27-1950-okf-analysis-cost/README.md)
ran the analysis like the worker (`claude -p`, sonnet) on 8 real sessions of $5–114. Adopted
design (v4d): user prompts + the session analyser's facts **per agent** (each sub-agent judged
against its own spawn prompt) + KB indexes, no transcript text; KB judged as of session start;
facts over guesses; the goal is **KB quality, not cost** — each read gets `verdict`, `granularity`
and `findability`, plus `gaps` and `kbFixes`. Result on four multi-agent sessions: $0.45–0.61 and
3–4.7 min per run, prompt 38–94 KB (hence the 200 KB cap); the findings are KB changes — split
100–170 KB monoliths, add section pointers and missing index rows (README). Dropped on the way:
outlines in the prompt (break the 60 KB cap), transcript text (cut or a context file), regex
extraction (double-counted multi-file Bash bytes, took `<task-notification>` for prompts), a
`cost` axis and tree-wide judging (owner: sub-agents are atomic tasks; cost is not KB quality).
