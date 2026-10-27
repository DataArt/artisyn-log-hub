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
2. **Every KB read judged** — each file the session read gets a verdict; an own-edit re-read loop
   (like `e88adad0`, 1.1 MB) is named, not skipped.
3. **Grounded misses** — every `missed` path exists in the KB, names a section, and the reason
   ties it to something the session actually did or asked.
4. **Actionable index hints** — a hint names the index line to add or change; spot-checked
   against `docs/knowledgebase/index.md`.
5. **No anachronism** — a miss must not rely on KB text written after the session.
6. **Cost and time** — under about $1 and 4 minutes per run.

## Iterations

| Version | Change | Folder |
|---|---|---|
| v1 | `index.md` + outline of every KB file in the prompt | `out-runs/v1-outline/` |
| v2 | only `index.md`; the model reads KB files itself, moderately curious | `out-runs/v2-index/` |
| v3 | task context never cut — over the 60 KB cap it goes to a file the model reads in full; tracker lookup only counts MCP / `gh` / `curl` calls; reading a little code allowed | `out-runs/v3-file/` |
| v4a | no transcript text: user prompts (filtered) + session facts from the session view's own analyser (`facts.ts` → `buildBashView`) + KB indexes; every KB read gets a verdict; `gaps` added (`run4.mjs`, `prompt-v4.md`) | `out-runs/v4a/` |
| v4b | KB as of session start (`git archive` of the last commit before it, outside the repo — also no repo `CLAUDE.md`/rules/hooks in the model's context); facts over guesses; separate `cost: ok\|excessive` per read; a read file can be `missed` only by section; gaps must be checked against the KB (`prompt-v4b.md`, `KB_AT_SESSION=1`) | `out-runs/v4b/`, `out-runs/v4b-final/` |

Run v4b: `PROMPT=prompt-v4b.md KB_AT_SESSION=1 node run4.mjs <tag> <id-prefix> [...]` (needs `bun`).

## Result

**v4b is useful; adopt its input and output shape.** Eight real sessions of $5–114 each (four
used while iterating, four unseen for the final check):

| Run | Session | Cost | Time | Turns | KB reads judged |
|---|---|---|---|---|---|
| v4b | 6a5f98ce | $0.16 | 56 s | 1 | 3/3 |
| v4b | 0edba12b | $0.43 | 148 s | 10 | 8/8 |
| v4b | e88adad0 | $0.49 | 191 s | 11 | 11/11 |
| v4b | 92f0ad24 | $0.67 | 204 s | 15 | 21/22 |
| final | 34ec7880 | $0.46 | 88 s | 9 | 5/5 |
| final | 3a5d7262 | $0.37 | 157 s | 6 | 2/2 |
| final | 9dbf2d1e | $0.50 | 126 s | 13 | 6/9 |
| final | 89206502 | $0.62 | 149 s | 7 | 17/17 |

- **Cost and time**: $0.16–0.67 and 1–3.5 min per run, whatever the session size (the prompt is
  26–39 KB even for a $114 session). The fixed `claude -p` overhead dominates; running outside the
  repo cut the first-turn cache creation from ~34k to ~26k tokens.
- **Usefulness**: every criterion met. Examples a KB owner can act on: `89206502` built a PoC to
  learn whether PostToolUse carries `tool_use_id` while `hook-system-overview.md` already said so
  (906 bytes of it were read); `0edba12b` skipped the `server-conventions.md` section its own
  requirements cited; `e88adad0` — the 1.1 MB outlier — is correctly diagnosed as 12 agents each
  reading a doc created in that session (`cost: excessive`), not as own-edit re-reads; two
  unrelated sessions (`5b0a1634`, `9dbf2d1e`) independently point at the missing
  `otel-cost-selection.md` index line (confirmed: absent from `index.md`).
- **What did not work**: v1 (outlines of every file) broke the 60 KB cap; v2/v3 (transcript text)
  cut long sessions or needed a context file, and their regex extraction double-counted multi-file
  Bash bytes and mistook `<task-notification>` messages for prompts; without a KB-as-of-session view
  (v4a) misses and gaps were anachronistic, and without "facts over guesses" the model invented
  own-edit re-reads.
- **Residual**: a folder or glob "read" is sometimes left unjudged (criterion 2: 6/9 in
  `9dbf2d1e`); harmless. Instruction-only "little code" reads happen and are acceptable.
