# 2026-11-12: Fix Stale Checks in the Big Pre-Prod E2E Test

**Status:** todo
**Priority:** medium
**Type:** bug
**Module(s):** big-prod-e2e-test (`.claude/skills/big-prod-e2e-test/`)
**Owner:** denis.tsyplakov
**Created:** 2026-11-12
**Tracker:** GH-138 https://github.com/DataArt/artisyn-log-hub/issues/138

## Description

Fix big-prod-e2e-test test-script defects found in run `log_hub_big_test-20261112-090440`
(overall FAIL, exit 1, no product defects). All 7 failures are stale test-script checks:

1. **FR-NODE (P5c):** hook algo tests fail on every Node LTS (18.19.0 / 22 / 24 / 26) because
   `.claude/skills/big-prod-e2e-test/scripts/lib/node-lts.mjs:75-76` tars only `./hook
   ./scripts/algo-docs ./docs/knowledgebase/algorithms` — the rows moved to
   `docs/algorithm-examples/*.json` (commit 582ff31), so `scripts/algo-docs/load-examples.cjs`
   throws. The cjs / esm / no-package.json hook smokes pass on every version.
2. **FR-3 (P11 "no new paths in git root"):** false positive — `docs/product-kb/competitive-watch/seen.md`
   and `sources.md` were modified by a concurrent process (competitive-watch / morning-check)
   during the run; the test never touches them.
3. **S2 `systemContext`** and 4. **S5 `systemContext`:** `prompts/checks/systemContext.md` still
   targets `sysctx-panel` / `sysctx-tab-*` / `sysctx-*-row`, removed by
   `2026-10-29-sysctx-anatomy-tab` (`docs/knowledgebase/sysctx-anatomy-tab.md`;
   `tests/scenarios/view/s-sess-03.spec.ts:530` asserts the panel is gone). Gap: no check
   confirmed that `add-jsdoc` (S2) and `CLAUDE.md` / `cli-flags` (S5) actually appear on the
   Anatomy tab.
5. **S8 `bash`:** `prompts/checks/bashTab.md` says a successful call has no badge, but the
   expanded `ToolCallView` shows `✓ ok` (`<StatusBadge showOk/>`,
   `client/src/viewer/pages/repository/session-log/tool-call-view/ToolCallView.tsx:96`) — intended
   UI. The verifier also judged it inconsistently (S1 saw the same `✓ ok` and passed).
6. **S8 `denied`:** `prompts/checks/denied.md` expects `⊘ rejected` on the row badge; the file
   row shows `⊘ denied.txt` + `⚠ requested` (row badges carry only permission flags,
   `prompt-turn-helpers.tsx:254-272`), and the `⊘ rejected` label is only in the expanded
   `ToolCallView`. The verifier never expanded the call. The product classified the call
   correctly (`toolDenialKind:"user-rejected"`).

Evidence: `D:\_work\Artisyn-LogHub\log_hub_big_test-20261112-090440\_report\` (`index.md`,
`report.json`, `S2/`, `S5/`, `S8/verdict.json`), `_state/node-lts.json`.

## Functional Requirements

- FR-1: The P5c Node LTS container gets every file the hook algorithm tests read, including
  `docs/algorithm-examples/`, so `npm test` in `hook/` runs the same as on the host.
- FR-2: The P11 "no new path in the git root" check is removed: the P11 `ac('FR-3', 'P11', …)`
  call, the P0 `ctx.gitStatusBefore` baseline and `gitStatusPaths` in `run.mjs` go, and so do the
  P11 line in `docs/knowledgebase/test/big-prod-e2e-test.md` and any mention in the skill's
  `SKILL.md`. FR-3 keeps only its P0 check (the run dir is created where expected); its phase
  map entry in `run.mjs:50` becomes `['P0']`.
- FR-3: `prompts/checks/systemContext.md` opens `{{SESSION_URL}}&tab=sysctx`, expands the
  Skills and Instruction files drilldowns by clicking `anatomy-partition-row[data-kind]`, and
  presses "Show all" when the skill list is cut short. Matching:
  - skill: `anatomy-skill-row[data-skill-name=<name>][data-source=<source>]`;
  - instruction file: an `anatomy-file-row` whose `data-path` ends with the expected suffix and
    whose Kind cell equals the expected kind (`claude-md` / `local-md` / `user-md` / `rule`);
  - rule: an `anatomy-file-row` with Kind `rule` whose `data-path` ends with the expected suffix,
    in either the loaded group or the "On demand" group.
  The `## Judge` and `## Fields` sections use the same keys as `expect.sysctx`.
- FR-4: The S2 and S5 `expect.sysctx` blocks in `scripts/scenarios.mjs` (lines ~94, ~128) are
  rewritten in Anatomy terms and stay positive checks: S2 skills
  `{ name: 'add-jsdoc', source: 'project' }`; S5 files
  `{ pathSuffix: 'CLAUDE.md', kind: 'claude-md' }` and rules
  `{ pathSuffix: '.claude/rules/cli-flags.md', kind: 'rule' }`.
- FR-5: `prompts/checks/bashTab.md` reads the `tool-status-badge` in the opened call's detail pane,
  not the `bash-call-row` list item. `status: ok` means the badge contains `✓ ok` and not
  `✗ error`. `status: error` means it contains `✗ error`. A permission prefix such as
  `⚠ requested` is allowed.
- FR-6: `prompts/checks/denied.md` tells the verifier to expand the denied `Write` call and read
  `[data-testid="tool-call-view"] [data-testid="tool-status-badge"]`, not the file row's own
  badge. The check passes when that badge contains `⊘ rejected` (substring match, permission
  prefix allowed) **and** the existing second condition holds: the result text contains
  "requested permissions" or the label's `title` is not empty. Row-level `⊘ denied.txt` /
  `⚠ requested` alone is reported in `observed` but fails. `✗ error` fails.
- FR-7: Any other check prompt or orchestrator selector that still targets the removed
  `sysctx-panel` UI is updated in the same way.

## Acceptance Criteria

- [ ] P5c: `algo` is `ok` on every Node LTS line in `_state/node-lts.json`; FR-NODE passes.
- [ ] The report no longer has a P11 git-root check; FR-3 is judged by its P0 check only.
- [ ] S2 and S5 `systemContext` pass and their verdicts name the rows found on the Anatomy tab.
- [ ] S8 `bash` passes with `✓ ok` shown on the successful call; S1 and S8 verdicts are judged
      by the same rule.
- [ ] S8 `denied` passes and its verdict cites the `⊘ rejected` label from the expanded call.
- [ ] A re-run of `/big-prod-e2e-test` finishes with exit 0 with no product code changed.
- [ ] `docs/knowledgebase/test/big-prod-e2e-test.md` matches the updated checks.

## Steps to Reproduce

1. Run `/big-prod-e2e-test` on `main` at 7bf1356.
2. Open `_report/index.md` of the run.

**Expected:** PASS, exit 0.
**Actual:** FAIL, exit 1 — FR-NODE, FR-3, S2 / S5 `systemContext`, S8 `bash` / `denied` fail.

## Open Questions

_None._

## Common sense considerations

- The git-root check is dropped rather than fixed (owner decision): no reliable way to separate the run's own writes from concurrent processes.
- `expect.sysctx` for S2/S5 is rewritten in Anatomy terms; `systemContext.md` Judge/Fields use the same keys.
- `CLAUDE.md` is matched by `data-path` suffix + Kind `claude-md` (the Anatomy tab has no "Project" label).
- Rule `cli-flags` passes in either the loaded or the on-demand group (path-scoped, placement depends on what the session read).
- `systemContext.md` spells out the navigation steps (tab URL, partition-row clicks, "Show all").
- `bashTab.md` reads the detail-pane badge with one ok/error rule; permission prefixes allowed.
- `denied.md` reads only the expanded `tool-call-view` badge, substring `⊘ rejected`, row-level evidence alone fails, the second condition stays.

## Notes

<!-- Append timestamped notes here as work progresses -->
