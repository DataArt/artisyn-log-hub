# Implementation plan — Fix stale checks in the big pre-prod E2E test (GH-138)

## TL;DR

- Test-script only: everything changes under `.claude/skills/big-prod-e2e-test/`, plus one KB article and one existing build-script test file. No product code, no DB, no API, no new packages.
- `run.mjs`: the P11 git-root check, its P0 baseline (`ctx.gitStatusBefore`) and `gitStatusPaths()` are deleted; `AC_PHASES['FR-3']` becomes `['P0']`.
- `lib/node-lts.mjs`: the P5c container tarball also gets `./docs/algorithm-examples`.
- Three verifier prompt fragments are rewritten: `checks/systemContext.md` (Anatomy tab), `checks/bashTab.md` (detail-pane badge), `checks/denied.md` (badge inside the opened call's modal).
- `scenarios.mjs`: `expect.sysctx` changes shape to `{ skills: [{name, source}], files: [{pathSuffix, kind}], rules: [{pathSuffix, kind}] }` for S2 and S5.
- `lib/verify.mjs` call budgets: `systemContext` 7 → 8, `denied` 4 → 5 (S1/S4/L1 totals asserted in tests are unchanged).
- Done only after a manual `/big-prod-e2e-test` re-run exits 0 (costs real Claude credits; the user runs it).

## Reference

- Requirements: [requirements.md](requirements.md)
- Research archive: [research/findings-1.md](research/findings-1.md), analysis: [research/verifier-flows.md](research/verifier-flows.md)
- Failed run evidence: `D:\_work\Artisyn-LogHub\log_hub_big_test-20261112-090440\_report\`

All paths below are relative to the repo root; `SK` = `.claude/skills/big-prod-e2e-test/scripts`.

## Design Decisions

1. **`expect.sysctx` shape (shared by `scenarios.mjs`, `systemContext.md` and the test).** Three keys, all always present, empty list = asks for nothing:
   - `skills: [{ name, source }]` — `source` is a `data-source` value (`project` / `user` / `plugin`).
   - `files: [{ pathSuffix, kind }]` — `kind` is the Kind cell text (`claude-md` / `local-md` / `user-md` / `rule`).
   - `rules: [{ pathSuffix, kind: 'rule' }]` — same matching as `files`, but the row may sit in the loaded group or under the "On demand — 0 at start" header.
2. **Scenario values.** S2: `{ skills: [{ name: 'add-jsdoc', source: 'project' }], files: [], rules: [] }`. S5: `{ skills: [], files: [{ pathSuffix: 'CLAUDE.md', kind: 'claude-md' }], rules: [{ pathSuffix: '.claude/rules/cli-flags.md', kind: 'rule' }] }`.
3. **File matching needs both suffix and Kind**, because the suffix `CLAUDE.md` also matches `~/.claude/CLAUDE.md` (kind `user-md`).
4. **Anatomy tab UI contract (used by `systemContext.md`)** — confirmed in client code, no client change:
   - URL `{{SESSION_URL}}&tab=sysctx`.
   - Partition rows `[data-testid="anatomy-partition-row"][data-kind="skills"]` and `[data-kind="instruction-file"]`; a click selects and expands (add-only: clicking an open row keeps it open; do not use the chevron).
   - Skill rows `[data-testid="anatomy-skill-row"]` with `data-skill-name`, `data-source`; only the first 10 show until a button with text `Show all N skills` is pressed.
   - File rows `[data-testid="anatomy-file-row"]` with `data-path` (repo-relative, user files as `~/.claude/...`); the 2nd `td` is the Kind cell. Columns: Path, Kind, Git, File size, Loaded B, ≈ Tokens, Share. On-demand rows follow a header row reading "On demand — 0 at start".
5. **Bash badge rule (one rule for S1 and S8).** Read `[data-testid="bash-call-details"] [data-testid="tool-status-badge"]` of the opened call (the `bash-call-row` list item has only `tool-status-mark`). `ok` = badge contains `✓ ok` and not `✗ error`; `error` = contains `✗ error`. A `⚠ requested` / `⚠ denied` prefix is allowed.
6. **Denied flow.** On `&tab=logs` the `Write` call is already visible in the turn's Files section ("Code" group) as the `[data-testid="file-row"]` whose text contains `denied.target` from the expected block (S8: `denied.txt`; row shows `⊘ denied.txt` + `⚠ requested`). Click it → a `[role="dialog"]` modal (`ToolCallDetailModal`) opens with `[data-testid="tool-call-view"]`. Read `[role="dialog"] [data-testid="tool-call-view"] [data-testid="tool-status-badge"]` text and the `title` of its `⊘ rejected` span (expected `rejected by the user`), plus the result text. Pass = badge contains `⊘ rejected` AND (result contains "requested permissions" OR title non-empty). Row-level evidence alone → fail, reported in `observed`. `✗ error` → fail.
7. **Budgets** (`lib/verify.mjs` `CHECKS`): `systemContext` 7 → 8 (navigate, snapshot, 2 partition clicks, optional "Show all", evaluate, one retry); `denied` 4 → 5 (navigate, snapshot, click, evaluate in dialog, one retry); `bashTab` stays 5. Only S1 (40), S4 (36), L1 (14) totals are asserted in tests and none includes the changed checks.
8. **Git-root check dropped, not fixed** (owner decision): concurrent processes (morning-check / competitive-watch) write into the repo during the run.
9. **Node LTS tarball keeps `./docs/knowledgebase/algorithms`**: `scripts/algo-docs/load-examples.cjs:41-49` finds the root (no `.git` in the container) by that folder, then reads `docs/algorithm-examples/<name>.json` (line 188).
10. **FR-7 sweep result:** in `.claude/skills/big-prod-e2e-test/**` the only `sysctx-panel` / `sysctx-tab-*` / `sysctx-*-row` references are in `checks/systemContext.md`; matches under `docs/pocs/2026-10-27-1950-okf-analysis-cost/out-runs/` are historical outputs and stay. `SKILL.md` has no git-root text, so it does not change; no report template, `index.md` writer or AC description other than `run.mjs` and the KB P11 row names the git-root check.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `SK/run.mjs` | FR-2 | delete `gitStatusPaths` (186-190), `gitStatusBefore` in `ctx` (125; keep `devPortsBefore` at 124), its P0 assignment (221), the P11 FR-3 block (906-913); line 50 `'FR-3': ['P0']`; drop unused `run` import (16) |
| `SK/lib/node-lts.mjs` | FR-1 | `runAlgo` tar list (74-76) + doc comment (72) |
| `SK/lib/verify.mjs` | budgets | lines 48-49 per Design Decision 7 |
| `SK/prompts/checks/systemContext.md` | FR-3 | full rewrite, keeps `## Step / ## Judge / ## Fields` format parsed by `verify.mjs:126-140` |
| `SK/prompts/checks/bashTab.md` | FR-5 | third `## Step` bullet (badge reading) + Judge (b) |
| `SK/prompts/checks/denied.md` | FR-6 | Step + Judge rewrite, Fields `observed` hint |
| `SK/scenarios.mjs` | FR-4 | S2 line ~94, S5 line ~128, header comment lines 27-28 |
| `docs/knowledgebase/test/big-prod-e2e-test.md` | KB sync | P5c row (74), P11 row (81), check rows (114, 117, 118), troubleshooting (296-301, 313-317) |
| `scripts/__tests__/big-prod-e2e-test.test.js` | existing build-script test | line 833 assertion → new shape |

## Test coverage plan

- The project test policy allows three kinds (algorithm / API contract / scenario); this change touches none of them — it is test tooling, not product code. The only automated check affected is the existing build-script test `scripts/__tests__/big-prod-e2e-test.test.js` (run by `npm run test:scripts`, part of the fast `static` set): its S5 `expect.sysctx.rules` assertion (line 833) is updated to the new shape and extended in place to assert the S2 skills and S5 files from Design Decision 2. No new test file.
- The behavioural check is the manual `/big-prod-e2e-test` re-run (acceptance criteria): P5c `algo` ok on every line, no P11 git-root row, S2/S5 `systemContext`, S8 `bash` / `denied` pass, exit 0. It spends real Claude credits and takes 30-90 min, so the user starts it; it is not a chunk item.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Orchestrator libs (run.mjs, node-lts, verify budgets) | 5 | independent of prompts |
| 2 | Verifier prompts and scenario expectations | 6 | uses shape from Design Decision 1 |
| 3 | KB article sync | 4 | describes chunks 1-2 |
| 4 | Build-script test and verification | 4 | last |

### Chunk 1 — Orchestrator libs (run.mjs, node-lts, verify budgets)
- [ ] `SK/lib/node-lts.mjs` `runAlgo`: add `./docs/algorithm-examples` to the tar list after `./docs/knowledgebase/algorithms`; update the doc comment above it to name all four copied paths (Design Decision 9).
- [ ] `SK/run.mjs`: delete the `gitStatusPaths()` function (~186-190), the `gitStatusBefore: null` field in `ctx` (~125; keep `devPortsBefore`) and the P0 line assigning `ctx.gitStatusBefore` (~221).
- [ ] `SK/run.mjs` `p11Final`: delete the FR-3 "no new path in the git root" block (~906-913); keep the FR-4 dev-ports and FR-10 `index.md` checks unchanged.
- [ ] `SK/run.mjs`: change `AC_PHASES` entry (~50) to `'FR-3': ['P0']`; remove `run` from the `./lib/proc.mjs` import (~16) — its only call was in `gitStatusPaths`; keep `runAsync`.
- [ ] `SK/lib/verify.mjs` `CHECKS`: set the `systemContext` budget to 8 and the `denied` budget to 5 (Design Decision 7); leave fields, shots and expect keys unchanged.

### Chunk 2 — Verifier prompts and scenario expectations
- [ ] `SK/scenarios.mjs`: replace the S2 and S5 `expect.sysctx` objects with the values in Design Decision 2; extend the header comment's `expect` line to state the `sysctx` shape from Design Decision 1.
- [ ] Rewrite `## Step` of `SK/prompts/checks/systemContext.md`: open `{{SESSION_URL}}&tab=sysctx`, click the Skills partition row, press "Show all N skills" if shown, click the Instruction files partition row, read skill rows and file rows (path, Kind, loaded vs On-demand group) per Design Decision 4; screenshot `{{SHOT_SYSCTX}}` showing both open drill-downs.
- [ ] Rewrite `## Judge` and `## Fields` of `systemContext.md`: one-direction match per Design Decisions 1 and 3 (skill by name+source; file by `data-path` suffix + Kind; rule likewise in either group); `observed` lists skills with source and file rows with path, Kind and group; keep field id `systemContext` and screenshot `{{SHOT_REL}}/sysctx.png`.
- [ ] `SK/prompts/checks/bashTab.md`: Step — read the badge inside `[data-testid="bash-call-details"]` of the opened call and delete "a successful call shows no badge"; Judge (b) — delete "`ok` means no `tool-status-badge`" and apply the ok/error rule of Design Decision 5; leave (a), (c), (d), (e) and Fields as they are.
- [ ] Rewrite `## Step` and `## Judge` of `SK/prompts/checks/denied.md` per Design Decision 6 (click the `file-row` whose text contains `denied.target`, read the badge, `⊘ rejected` title and result inside `[role="dialog"]`); screenshot `{{SHOT_DENIED}}` showing the open modal; Fields `observed` hint: row badge; modal badge text; title; result text.
- [ ] Grep `.claude/skills/big-prod-e2e-test/` for `sysctx-panel`, `sysctx-tab-` and `sysctx-` row test ids; confirm zero matches remain (FR-7, Design Decision 10).

### Chunk 3 — KB article sync
- [ ] `docs/knowledgebase/test/big-prod-e2e-test.md` P5c row (~74): say the container gets `hook/`, `scripts/algo-docs`, `docs/knowledgebase/algorithms` and `docs/algorithm-examples`; P11 row (~81): remove "no new path in the git root"; set the front-matter `timestamp` to 2026-11-12.
- [ ] Same file, check table: `bashTab` row (~114) — status read from the opened call's detail-pane badge (`✓ ok` / `✗ error`); `systemContext` row (~117) — Anatomy tab (`&tab=sysctx`) skills and instruction-file drill-downs; `denied` row (~118) — `⊘ rejected` read in the opened call's modal.
- [ ] Same file, troubleshooting: in the `FR-NODE` entry (~296-301) add that `load-examples.cjs` throwing on a missing `docs/algorithm-examples/*.json` means the tar list in `runAlgo` misses a folder; in the S8 entry (~313-317) note the row shows only `⊘ denied.txt` + `⚠ requested`, the `⊘ rejected` label is in the modal.
- [ ] Same file: add a troubleshooting entry — S5 `systemContext` fails with `cli-flags` in neither Anatomy group → the rule is path-scoped (`paths: ["lib/**/*.js"]` in `fixtures/js-cli/dot-claude/rules/cli-flags.md`) and lands on the tab only when the session loaded it (Logs shows a `§ Rules cli-flags` chip, see research/verifier-flows.md); check that chip and the attempt stream before treating it as a product defect.

### Chunk 4 — Build-script test and verification
- [ ] `scripts/__tests__/big-prod-e2e-test.test.js` (~833): change the S5 assertion to `deepEqual` the whole `byId.S5.expect.sysctx` (spread inner objects) against the S5 value from Design Decision 2.
- [ ] Same test block: add a `deepEqual` of `byId.S2.expect.sysctx` against the S2 value from Design Decision 2.
- [ ] Run `npm run test:scripts` from the repo root; all tests pass, including `verifierCallBudget` S1 = 40, S4 = 36, L1 = 14.
- [ ] Run `adlc-lh:check-health` with `finalRun: false` (fast set); it must be green, and failures are fixed only in files listed in this plan.
