# 2026-10-27: Branch Group Cost Total Is Lower Than Its Sessions

**Status:** todo
**Priority:**
**Type:** bug
**Module(s):** server (`GET /api/v1/repositories/:repoId/sessions/branches`)
**Owner:** denis.tsyplakov
**Created:** 2026-10-27
**Tracker:** GH-41 https://github.com/DataArt/artisyn-log-hub/issues/41

## Description

Raw idea (verbatim): "issue with branch cost" + screenshot of the session list grouped by branch.

In the session list grouped by branch, the branch group header shows a total cost that is lower
than the sessions listed under it. Observed for branch `fix/2026-10-23-big-test-recent-features`
(7 sessions):

- Group header: `2026-10-25 01:14:23 · 334m 8s · $45.3943`
- One session inside the group alone costs **$66.0675** (2026-10-24 14:18:23,
  `/adlc-lh:implement-deep …`, has the `Workflow` badge) — more than the whole branch total.
- Sessions shown in the group: $4.3496, $66.0675, $1.8264, $0.2264, $4.1623, $10.0414, $4.9516 —
  their sum is **$91.6252**, about twice the header value.

Root cause: the branch summary route (`getRepositorySessionBranches()` in
`server/src/logs/repositories.controller.ts`) sums `session_costs.cost` of the root sessions only
(`SUM(sc.cost)`), while each session row shows the tree cost (root + sub-agents + utility calls,
`readTreeCost` / `treeCostCtes` in `server/src/logs/session-tree-cost.sql.ts`). Sub-agent-heavy
sessions (Workflow) are therefore undercounted in the header. The same route feeds the Branch
Cost chart (`BranchCostChart.tsx`), which is undercounted the same way.

## Functional Requirements

- `totalCost` of each row returned by `GET .../sessions/branches` is the sum of the tree costs
  (the same value as `totalCost` / `costBreakdown.calculatedCost` of `GET .../sessions`) of that
  branch's root sessions, in the same scope (repo, owner, date range, attribute filter).
- The tree costs are loaded in one batched query for all roots of all branches (like
  `loadTreeMetricsByRoot` for lines changed), never per branch or per session.
- No change to the response shape and no client change; the branch group header and the Branch
  Cost chart pick up the corrected value as is.

## Acceptance Criteria

- [ ] For `fix/2026-10-23-big-test-recent-features`, the header cost equals the sum of its 7
      session row costs (≈ $91.63 for the data in the screenshot), not $45.39.
- [ ] For any branch group with no client-side filter active (user filter, hide-hook, attribute
      chips), the header cost equals the sum of its session row costs (within display rounding).
- [ ] A branch containing a Workflow session counts that session's full row cost (including
      sub-agents and utility calls) in the header.
- [ ] Scenario `GOLDEN-LOAD cost by branch includes sub-agents` (`tests/scenarios/view/golden-load.spec.ts`)
      passes with its `test.fail` marker and the "code bug" comment removed.
- [ ] The new branch-cost step in `tests/scenarios/sessions/s-slife-09.spec.ts` (API + UI header =
      sum of rows, sub-agents included) passes.

## Common sense considerations

- Unpriced sessions keep today's `SUM` semantics: a root whose tree cost is null (row shows `$???`)
  contributes nothing; the branch `totalCost` is null only when every root's tree cost is null.
- The header duration (`totalWorkTimeMs`) is out of scope: it is wall-clock time, already correct
  for a tree (sub-agents run inside the root's span) and must not be rolled up.
- The header stays unfiltered by client-side filters, like `sessionCount`; with a user/attribute
  filter active the header may exceed the visible rows' sum — existing behaviour, not changed here.
- The outdated "branch cost is root-only" notes are removed from the SQL comment in
  `repositories.controller.ts` and from the header comment of `tests/scenarios/sessions/s-slife-09.spec.ts`.
- Tests: scenario only, no new test files (see Scenario coverage).

## Scenario coverage

The fix is covered by the scenario suite (kind 3 of the test policy), extending existing files:

- `tests/scenarios/view/golden-load.spec.ts` — `GOLDEN-LOAD cost by branch includes sub-agents`:
  drop `test.fail`; it asserts `totalCost` of every branch equals `expected.json` `costByBranch`
  (tree values).
- `tests/scenarios/sessions/s-slife-09.spec.ts` (root R with sub-agents A/B/D + plain P on `main`):
  add a step — `GET .../sessions/branches` row `main` has `totalCost` = R tree cost + P cost (the
  scenario's existing `totalCost`), and in the UI (session list grouped by branch) the `main`
  header cost equals the sum of its session row costs.

## Open Questions

_None._

## Steps to Reproduce

1. Open the session list grouped by branch for a repo that has branch
   `fix/2026-10-23-big-test-recent-features` (7 sessions, one of them a Workflow session).
2. Expand the branch group and compare the header cost with the session row costs.

**Expected:** header cost = sum of the session row costs (≈ $91.63).
**Actual:** header shows $45.3943, while one session alone is $66.0675.

## Notes

<!-- Append timestamped notes here as work progresses -->
- 2026-10-27 — implemented via adlc-lh:implement; checks green.
