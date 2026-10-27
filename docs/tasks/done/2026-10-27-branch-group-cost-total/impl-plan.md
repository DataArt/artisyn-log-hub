# Implementation Plan: Branch Group Cost Total Is Lower Than Its Sessions

## TL;DR

- Server-only bug fix in `getRepositorySessionBranches()`: `totalCost` becomes the sum of each
  root's **tree** cost (`loadTreeCostRows` + `readTreeCost`, already used by active-sessions and
  attribution-breakdown) instead of `SUM(session_costs.cost)` of the roots.
- One extra batched query (`loadTreeCostRows` over all roots of all branches), run in parallel
  with the existing `loadTreeMetricsByRoot`; no per-branch / per-session round trips.
- No DB/migration changes, no new deps, no response-shape change, no client change.
- The value of an existing field changes, so the API contract oracle row `F17-branches`
  (`server/test/contract/registry/f17-sessions.ts`) switches from `ownCostSql` to `treeCostSql`.
- Scenarios: `golden-load.spec.ts` drops its `test.fail`; `s-slife-09.spec.ts` gains branch-cost
  API + UI assertions.

## Reference

- Requirements: [requirements.md](requirements.md) (GH-41)

## Design Decisions

- The tree costs are folded **index-wise over `session_row_ids`** (the same pairing the lines
  fold uses, `repositories.controller.ts:1191-1202`), so duplicates are treated exactly as the old
  `SUM(sc.cost)` treated them and the contract oracle (which also sums per listed row) matches.
- `readTreeCost(row).total` is the per-root value (`null` = the row's `$???`); a `null` adds
  nothing, and the branch `totalCost` is `null` only when every root's total is `null` — the same
  semantics as SQL `SUM`.

## Files to create/modify

| Path | Purpose | Note |
|------|---------|------|
| `server/src/logs/repositories.controller.ts` | Branch route: tree-cost fold | Drop `SUM(sc.cost)` + `LEFT JOIN session_costs` (lines 1149-1153, 1158) and `total_cost` from `BranchRow` (1135); `loadTreeCostRows` in `Promise.all` with `loadTreeMetricsByRoot` (1185); fold in the `map` (1190-1212) |
| `server/test/contract/registry/f17-sessions.ts` | Contract oracle `F17-branches` (lines 251-289) | `${ownCostSql('ss')} AS root_cost` → `${treeCostSql('r.id')} AS tree_cost`; replace the "KNOWN DISCREPANCY" comment |
| `tests/scenarios/view/golden-load.spec.ts` | `GOLDEN-LOAD cost by branch includes sub-agents` (lines 395-406) | Remove `test.fail` and the "Code bug" comment |
| `tests/scenarios/sessions/s-slife-09.spec.ts` | Branch cost API + UI step | `BranchRow.totalCost`, step 2 assertion, new UI step, header comment (lines 18-19) |
| `docs/knowledgebase/api-reference.md` | `BranchSummary.totalCost` comment (line ~1403) | Tree-scoped, same value as the session list's `totalCost` |
| `docs/knowledgebase/server-endpoint-map.md` | `sessions/branches` row (line 274) | Add: `totalCost` is tree-scoped via `loadTreeCostRows` |

## Test coverage plan

- **API contract** — `server/test/contract/registry/f17-sessions.ts` row `F17-branches`: oracle
  switched to `treeCostSql('r.id')` (no new row; route unchanged, its value changes).
- **Scenario** — `tests/scenarios/view/golden-load.spec.ts`, `GOLDEN-LOAD cost by branch
  includes sub-agents` (`@mode-a`): `test.fail` removed, now must pass against `expected.json`
  `costByBranch`.
- **Scenario** — `tests/scenarios/sessions/s-slife-09.spec.ts` (`@S-SLIFE-09`, modes a/c): step 2
  asserts `main.totalCost ≈ R.costUsd + P.costUsd`; a new UI step asserts the `main` branch
  header cost equals the sum of its two `session-item-cost` rows.
- No algorithm doc touched → no algorithm tests. Iterate with
  `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-SLIFE-09|GOLDEN-LOAD cost by branch"`.
- Server rules: run `npm run perf` (from `server/`) — one extra batched query; must not degrade > 20 %.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Tree cost in branch route + tests/docs | 9 | — |

### Chunk 1 — Tree cost in branch route + tests/docs

- [x] `server/src/logs/repositories.controller.ts` `getRepositorySessionBranches()`: delete the `SUM(sc.cost)::text AS total_cost` select with its comment (lines 1149-1153), the `LEFT JOIN session_costs sc ...` (line 1158) and `total_cost` from `type BranchRow` (line 1135). Add `loadTreeCostRows` to the existing `./session-tree-cost.sql` import (near line 71).
- [x] Same method: replace the single `await loadTreeMetricsByRoot(...)` (line 1185) with `const [branchTreeMetrics, branchTreeCosts] = await Promise.all([loadTreeMetricsByRoot(this.db, branchRootIds), loadTreeCostRows(this.db, branchRootIds)]);` and extend the comment above it: the tree cost is loaded in the same batch.
- [x] Same method, inside `rootIds.forEach` (line 1194): `const t = readTreeCost(branchTreeCosts.get(Number(rawId))).total; if (t != null) totalCost = (totalCost ?? 0) + t;` with `let totalCost: number | null = null;` declared before the loop; return `totalCost` instead of `parseFloat(row.total_cost)` (line 1210). Comment: null only when every root is unpriced, as `SUM` was.
- [x] `server/test/contract/registry/f17-sessions.ts` row `F17-branches` (lines 251-289): `${ownCostSql('ss')} AS root_cost` → `${treeCostSql('r.id')} AS tree_cost`; `sum(b.root_cost) AS root_cost` → `sum(b.tree_cost) AS tree_cost`; field `totalCost: { col: 'tree_cost', as: 'numeric' }`. Keep the `ownCostSql` import (line 125 uses it).
- [x] Same row: replace the "KNOWN DISCREPANCY ... Reported with chunk 23." comment lines with "totalCost is the sum of the roots' tree costs (sub-agents included), as the session list shows them."; keep the latestEndTime sentence.
- [x] `tests/scenarios/view/golden-load.spec.ts` lines 395-400: delete the "Code bug ..." comment block and the `test.fail(...)` line of `GOLDEN-LOAD cost by branch includes sub-agents`.
- [x] `tests/scenarios/sessions/s-slife-09.spec.ts`: replace header bullet lines 18-19 with "the branch route's cost is the tree cost (R tree + P), the same as the session rows"; add `totalCost: number | null` to `interface BranchRow`; in step 2 add `expect(main.totalCost).toBeCloseTo(totalCost, 6);` and add "cost R tree + P" to its title.
- [x] `s-slife-09.spec.ts`, new step after step 5 (`5b. UI: «main» header cost = sum of its session rows`): `page.goto('/#/repos/${loaded.repoId}')`; `header = page.locator('button', { has: page.locator('span.font-mono', { hasText: /^main$/ }) })`; expect `toContainText(usd4(totalCost))` (`usd4` from `../helpers/session-view`); click; expect 2 `session-item-cost`; parse their `$x.xxxx`, sum `toBeCloseTo(totalCost, 3)`.
- [x] Docs: `docs/knowledgebase/api-reference.md` `BranchSummary.totalCost` comment (~line 1403) → "sum of the roots' tree costs (own + sub-agents + utility calls, loadTreeCostRows/readTreeCost), same per-session value as GET .../sessions; unpriced tree adds nothing; null when none priced". Append to `docs/knowledgebase/server-endpoint-map.md` line 274: "`totalCost` is TREE-scoped too (`loadTreeCostRows`, batched with the lines rollup)".
