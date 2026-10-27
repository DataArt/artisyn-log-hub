# PoC — OKF usage analysis on real sessions: cost, speed, usefulness

Task: [2026-10-27-okf-usage-tab](../../tasks/todo/2026-10-27-okf-usage-tab/requirements.md)
(FR-19 … FR-24).

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
| v4d | **adopted**: goal = KB quality, not cost; per-agent facts incl. the order of first KB accesses and article sizes; each read judged on `verdict`, `granularity` (`too_coarse`/`too_fine`) and `findability` (`index`/`search`/`given`/`linked`); `kbFixes` list (`prompt-v4d.md`, `PER_AGENT=1`) | `out-runs/v4d/` |

Run v4d: `PROMPT=prompt-v4d.md KB_AT_SESSION=1 PER_AGENT=1 node run4.mjs <tag> <id-prefix> [...]`
(needs `bun`).

## Result

**v4d is the design to adopt.** v4b already met criteria 1–6, but it judged cost (the owner's
correction: twelve atomic sub-agents reading one article is a cost, not a KB quality problem, and
each sub-agent must be judged against its own prompt). v4d on the four multi-agent sessions:

| Session | Agents | Cost | Time | Prompt | Agent+file reads judged | Key finding |
|---|---|---|---|---|---|---|
| e88adad0 | 23 | $0.61 | 234 s | 94 KB | 38/38 | 28 reads are `given` (reviewers got the path) — fine; new algorithm docs missing from the `algorithms/README.md` table; no own line for the modal in `client-component-map.md` |
| 0edba12b | 4 | $0.52 | 212 s | 38 KB | 15/15 | `server-conventions.md` mixes four unrelated topics; three perf agents never found its perf section → split |
| 89206502 | 9 | $0.45 | 186 s | 60 KB | 17/23 | no article on why the tool-call SKIP list drops Read/Edit/… — two agents re-derived it from code |
| 92f0ad24 | 3 | $0.50 | 283 s | 58 KB | 42/42 | 13 `too_coarse` reads of 100–170 KB monoliths (`db-tables.md`, `client-component-map.md`, `api-reference.md`, `server-endpoint-map.md`) where agents needed 0.5–5 KB → split or point index lines at sections |

- **Cost and time**: $0.45–0.61 and 3–4.7 min per run. The prompt grows with the sub-agent prompts
  (up to 94 KB for 23 agents), so the analysis branch needs a cap of ~200 KB; ~35 KB more input
  costs about $0.03.
- **Usefulness**: the findings are KB changes an owner can make — split monolithic articles, add
  section pointers to index lines, add missing index rows and articles. The same monoliths come up
  across unrelated sessions, which is what the repo-level "repeatedly too coarse" rule aggregates.
- **Earlier results still hold**: KB as of session start (no anachronisms), facts over guesses,
  running outside the repo (~8k tokens less per turn), no transcript text.
- **What did not work**: v1 (outlines of every file) broke the 60 KB cap; v2/v3 (transcript text)
  cut long sessions or needed a context file, and their regex extraction double-counted multi-file
  Bash bytes and mistook `<task-notification>` messages for prompts; v4a was anachronistic; v4b
  judged cost and the session tree as one task.
- **Residual**: a folder or glob "read" is sometimes left unjudged (17/23 in `89206502`);
  harmless. Instruction-only "little code" reads happen and are acceptable.

v4b numbers for reference (single-task view, 8 sessions): $0.16–0.67, 1–3.5 min — `out-runs/v4b*/summary.json`.
