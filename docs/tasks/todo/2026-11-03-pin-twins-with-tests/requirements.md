# 2026-11-03: Pin Cross-Package Twins and Prose-Only Rules With Tests

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook | server | client | scripts (tests and algorithm docs only)
**Owner:** denis.tsyplakov
**Created:** 2026-11-03
**Tracker:** GH-90 https://github.com/DataArt/artisyn-log-hub/issues/90

## Description

Owner, verbatim: «по "Что нашлось попутно в коде (не правил)" - заведи задачу».

Found during the 2026-11-03 KB tuning (trap inventory and the new twins registry
`docs/knowledgebase/twins-and-cross-cutting-rules.md`): several pieces of logic exist in more than
one package with nothing that fails when the copies drift, and one rule exists only as prose. The
hook copies matter most: hooks installed on users' machines lag the server, so a server-side change
silently diverges from what those hooks compute.

Findings:

1. Hook twins of server logic pinned by no test:
   - `REJECTION_MARKERS` / tool outcome — `server/src/logs/tool-stats.ts` (client twin pinned by
     `algorithms/tool-call-outcome.md`) vs hook `post-turn-analysis-worker.js` (hand port, third
     copy);
   - `KNOWN_TOP_LEVEL_DIRS`, `normaliseFilePath`, `classifyFile`, `computeToolResultBytes`, file
     stats by category — `server/src/logs/claude-extractor.ts` vs hook
     `post-turn-analysis-worker.js`;
   - `countPatchLines` — `server/src/logs/tool-stats.ts` (source of truth) vs hook
     `edit-result-counts.js` (`deriveEditResultCounts`).
2. The shared fixture `tests/fixtures/patch-line-counts.json`, named by the hook comment, is run by
   no test.
3. A server `builtin-tools.ts` comment says it mirrors `client/src/viewer/lib/tools/registry.ts`,
   which no longer exists; there is no drift check.
4. SemVer helpers (`parseVersion`, `compareVersions`, `maxVersion`) in `server/src/common/semver.ts`
   and `client/src/viewer/lib/semver.ts`: the header promises a shared case table that has no test.
5. The client lazy-chunk budget (about 8, never more than 10 —
   `docs/knowledgebase/client-routing-and-layout.md`) is prose only; a 2026-11 session broke it
   unnoticed until the owner caught it.

Test policy (`CLAUDE.md`): only algorithm-doc rows, contract registry rows or scenario steps. Twins
are therefore pinned the way existing ones are: one algorithm doc per rule with its rows file in
`docs/algorithm-examples/<name>.json`, run by a table test on **each** side (as `cost-formula`,
`tool-call-outcome`, `work-time` already do).

## Functional Requirements

- **FR-1** Hook outcome classification (`REJECTION_MARKERS`) is run against the existing
  `tool-call-outcome` rows by a hook `node --test` table test (rows a twin cannot receive are marked
  `"only"`, as the algorithm README defines).
- **FR-2** File path normalisation and categorisation (`KNOWN_TOP_LEVEL_DIRS`, `normaliseFilePath`,
  `classifyFile`, `computeToolResultBytes`) get an algorithm doc and rows file, run by a server jest
  table test and a hook `node --test` table test — or, if an existing doc already covers the rule,
  its rows are extended and the hook test added.
- **FR-3** `countPatchLines` gets an algorithm doc whose rows replace
  `tests/fixtures/patch-line-counts.json`; server and hook table tests run them; the fixture is
  deleted and the hook comment points at the doc.
- **FR-4** The stale `builtin-tools.ts` twin comment is fixed: either it names the real current
  client counterpart and the pair is pinned by rows like FR-2, or, if there is no client copy any
  more, the twin claim is removed.
- **FR-5** SemVer helpers get an algorithm doc and rows file run by server jest and client vitest;
  the header comment points at the doc.
- **FR-6** A build-script test (`npm run test:scripts`) fails when the client build would produce
  more lazy chunks than the documented budget — read from the source (`lazy(` / dynamic `import(`
  sites) or the build manifest, whichever needs no full build; the budget is one named constant
  that the KB article refers to instead of a number.
- **FR-7** `docs/knowledgebase/twins-and-cross-cutting-rules.md` shows the new test for every row
  this task pins, and no row says **none** for items 1–4.

## Acceptance Criteria

- [ ] FR-1: changing a marker in the hook copy only turns the hook table test red.
- [ ] FR-2: changing `KNOWN_TOP_LEVEL_DIRS` on one side only turns that side's table test red.
- [ ] FR-3: `tests/fixtures/patch-line-counts.json` no longer exists; a changed line count in either
      copy turns its table test red.
- [ ] FR-4: no comment in the repo names `client/src/viewer/lib/tools/registry.ts`.
- [ ] FR-5: a SemVer behaviour change on one side turns that side's table test red.
- [ ] FR-6: adding an eleventh lazy route in a scratch change makes `npm run test:scripts` fail with
      a message naming the budget constant.
- [ ] FR-7: the registry has a test named in every row touched by this task.
- [ ] No test of a kind outside the CLAUDE.md test policy is added.

## Notes

- Evidence: twins registry rows (`docs/knowledgebase/twins-and-cross-cutting-rules.md`), trap
  inventory and session case studies from the 2026-11-03 KB evaluation (scratch reports, not in git).
- Behaviour must not change: where the copies already differ, the rows document the difference
  (`"only"` rows) and the owner decides in review whether to align them; installed hooks of older
  versions are not affected by tests.
- 2026-11-09 (task `2026-11-09-morning-check-followups`, hook 2.31.2): the hook's
  `classifyToolOutcome` (`hook/.claude/telemetry_tool/post-turn-analysis-worker.js`) now follows the
  server rule — the background-MCP rule (DD-4: no notification → `unresolved`, `completed` →
  `success`, any other status → `failure`), `denialKind` → `unresolved`, and the rejection marker
  only on `is_error` results. It should be pinned to `docs/algorithm-examples/tool-call-outcome.json`
  (rows TO-27…TO-31 included) as part of this task.
