---
reviewed: no
reviewer: none
---

# Session cost: the shown total, the unpriced models, and when to warn

## Purpose

A session can have two costs: the calculated cost (tokens times Log Hub's `model_pricing`, see
[cost-formula.md](cost-formula.md), for the root session, its sub-agents and its utility calls)
and the OTEL cost the Claude Code exporter reported. **The shown cost is always the calculated
one, complete or not at all.** Nothing is substituted: the OTEL cost never stands in for it
(Claude Code prices a model it does not know at another model's rates, e.g. `claude-haiku-5-5`
at Opus 5.5 rates, and reports that number with no marker), and no other model's price stands
in for an unknown one. OTEL stays a cross-check — with **two documented exceptions**: the cost of
a sub-agent recorded by Claude Code before `2.1.307`, whose transcript can miss API calls (rule 5),
and the **budget-only** tree cost, which takes the larger of the computed tree cost and the root's
OTEL total so a budget never under-counts spend (rule 6; no other surface uses it).

This rule computes the shown total from its parts, lists the model ids the "no price" hint
names, decides when the header shows the "sources disagree" warning icon, and decides when the
cost tooltip flags a mismatch between the calculated cost and telemetry.

## Code

- Implementation: `server/src/logs/otel-cost.sql.ts` — `resolveSessionTotalCost`,
  `unpricedModelList`, `otelComputedDiscrepancy` (`OTEL_DISCREPANCY_THRESHOLD = 0.33`),
  `costMismatch` (`COST_MISMATCH_TOLERANCE_USD = 0.5`, `COST_MISMATCH_TOLERANCE_RATIO = 0.01`),
  `selectSubagentCost` (rule 5, with `OTEL_SUBAGENT_COST_FIX_VERSION = '2.1.307'`,
  `ccVersionBeforeSql`, `subagentOtelCostSql`), `selectBudgetTreeCostMicros` (rule 6, budgets
  only; called by the budget spend read in `server/src/logs/budgets/`, no SQL twin).
  The parts come from SQL in `server/src/logs/session-tree-cost.sql.ts` (`treeCostCtes`,
  `readTreeCost`), which every cost surface uses.
- Twins: `selectSubagentCost` is the TypeScript twin of the rule-5 SQL in `treeCostCtes`
  (`tree_subagent_rows` / `tree_subagent_costs`) and in `selectSubagentStats`
  (`session-logs-delta.service.ts`, the per-sub-agent `otelCostUsd`); the rows pin the
  TypeScript, the SQL must match it. The client has no copy: it renders the server's
  `totalCost`, `costUnavailableReason`, `costBreakdown.unpricedModels`, `hasCostDiscrepancy`,
  `costBreakdown.mismatch`, `costBreakdown.subagentCostFromOtel` and `subagentStats[*].otelCostUsd`.
- Test: `server/src/logs/otel-cost.sql.algo.spec.ts`.

## Rules

Amounts are numbers of USD, never negative, or `null`. The callers turn database values into
numbers before the call.

The total takes the parts of one session tree: `mainCost` (the root's own stored cost, `null`
when the root is unpriced or has no stored cost), `subagentCost` (the sum of the sub-agents'
costs, each chosen by rule 5), `utilityCost` (the priced utility calls), and two flags:
`subagentPricingMissing` (some sub-agent is unpriced by rule 5) and `utilityPricingMissing`
(some utility call's model has no price).

1. **Shown cost** (`total`): `null` when `mainCost` is `null`, or either flag is true.
   Otherwise `mainCost + subagentCost + utilityCost`. A partial sum is never shown, and the OTEL
   total is not an input at all. **Exception:** `subagentCost` may contain OTEL-reported
   sub-agent costs of an old Claude Code (rule 5); the root's own cost and the utility calls
   never take OTEL.

The unpriced-model list takes several lists of model ids (the root's, the sub-agents', the
utility calls'), each possibly holding `null` or `""`:

2. **Unpriced models** (`models`): the distinct ids of all lists, without `null` and `""`,
   sorted by code unit (plain `Array.prototype.sort`). The server sends it as
   `costBreakdown.unpricedModels`, and `costUnavailableReason` is `'unknown-model'` exactly when
   the total is `null` because some model is unpriced.

The warning takes `otel` and `computed` (the shown total of rule 1):

3. **Discrepancy warning** (`discrepancy`): true only when both are present, `computed != 0`,
   and `|otel - computed| / computed >= 0.33`.

The mismatch flag takes `telemetry` (the OTEL total) and `calculated` (the shown total of rule
1), each USD or `null`:

4. **Mismatch** (`mismatch`): false if either is `null`. Otherwise with
   `delta = |calculated - telemetry|`, true only when `delta >= 0.5` **and**
   `delta >= |telemetry| * 0.01`.

The OTEL total arrives as `null`, never `0`: an OTEL total of exactly 0 is stored as `NULL` (an
upload with no billable call) and the query skips it. Rules 3 and 4 still accept 0 (the floor
rows CM-01/CM-02 use `telemetry: 0`).

The sub-agent selection takes one sub-agent's `transcriptCost` (its stored cost, `null` when
unpriced or none), `modelId` (its model, `null` when none) and `otelCostUsd`:

5. **Sub-agent cost** (`selectSubagentCost`, task `2026-11-03-otel-cost-attribution` FR-6).
   - `otelCostUsd` (SQL `subagentOtelCostSql`) is the sum of the root's `otel_calls.cost_usd_micros`
     whose `agent_id` equals the sub-agent's `sessions.session_id` without its `agent-` prefix —
     but only when the sub-agent's Claude Code version
     (`COALESCE(NULLIF(claude_version,''), claude_version_otel)`) parses as `major.minor.patch`
     and is strictly below `2.1.307` (`ccVersionBeforeSql`). Otherwise, an unknown version, or no
     matching call → `null`. A sub-agent of `2.1.307`+ therefore keeps the transcript cost.
   - `cost = otelCostUsd != null ? max(transcriptCost ?? 0, otelCostUsd) : transcriptCost`.
   - `pricingMissing = otelCostUsd == null && transcriptCost == null && modelId != null` — an
     OTEL cost prices an otherwise unpriced sub-agent.
   - `fromOtel = otelCostUsd != null && otelCostUsd > (transcriptCost ?? 0)`.
   - In SQL, `tree_subagent_costs` sums `cost` into `subagent_cost`, ORs `pricingMissing` into
     `subagent_pricing_missing` (and lists those models in `subagent_unpriced_models`) and ORs
     `fromOtel` into `subagent_cost_from_otel` → `costBreakdown.subagentCostFromOtel`.
     `selectSubagentStats` returns `otelCostUsd` per sub-agent only when `fromOtel` holds.
   - Rules 3 and 4 keep comparing the full totals; with a raised sub-agent cost the computed total
     is closer to OTEL, so fewer old sessions warn.

The budget tree cost takes one root tree's `hookUsd` (the shown total of rule 1, USD or `null`)
and `otelMicros` (the root's `otel_session_totals.cost_usd_micros`, integer micro-USD, or `null`
without a row):

6. **Budget tree cost — budget-only exception** (`selectBudgetTreeCostMicros`, task
   `2026-11-05-budgets-threshold-alerts` DD-5). Budgets alone count the **larger** of the two
   sources; every other surface keeps rule 1.
   - `hookMicros = Math.round(hookUsd * 1e6)` when `hookUsd != null`; `otelMicros` of `0` or
     `null` counts as missing.
   - Both present: `micros = max(hookMicros, otelMicros)`; `source = 'otel'` only when
     `otelMicros > hookMicros` (strict), else `'hook'`.
   - One side present: that side's micros and `source`.
   - Neither: `{micros: 0, source: 'none'}` — the tree counts as unpriced (`unpricedTrees`).
   - Comparison runs only in TypeScript: the SQL loads both values and calls this function.

## Edge cases

- All parts priced, with and without sub-agents and utility calls: CT-01, CT-02; a genuine `0`:
  CT-03.
- One unpriced part makes the whole total `null`, even when the priced parts are large: root
  CT-04, sub-agent CT-05, utility call CT-06; several at once: CT-07.
- Unpriced list: dedup across lists and sort UM-01, `null` and `""` dropped UM-02, nothing
  unpriced UM-03, code-unit order UM-04.
- Discrepancy exactly 33% (inclusive) vs 32%, on both sides of computed: OC-05, OC-06 (above),
  OC-07, OC-14 (below); a fraction under the limit: OC-16; far above: OC-08.
- One side or both missing: OC-09, OC-10, OC-11. Computed `0`: OC-12.
- Mismatch floor and ratio, inclusive and just below: CM-01..CM-05, CM-09, CM-10; direction:
  CM-06; missing side: CM-07, CM-08.
- Sub-agent (rule 5, `kind: "subagent"`): OTEL above the transcript → OTEL, `fromOtel` SA-01; OTEL
  below → transcript SA-02; no OTEL → transcript SA-03; unpriced transcript with OTEL → OTEL, not
  missing SA-04; unpriced without OTEL → missing SA-05; equal amounts → not `fromOtel` SA-06.
- Budget tree cost (rule 6, `kind: "budget-tree-cost"`): OTEL larger BT-01; hook larger BT-02;
  hook unpriced BT-03; OTEL 0 is missing BT-04, BT-05; neither BT-05, BT-06; equal → `hook` BT-07.

## Examples

Rows with `"kind": "total"` give the five parts and expect `total` (rule 1). Rows with
`"kind": "unpriced"` give `lists` and expect `models` (rule 2). Rows with
`"kind": "discrepancy"` give `otel` and `computed` and expect `discrepancy` (rule 3). Rows with
`"kind": "mismatch"` give `telemetry` and `calculated` and expect `mismatch` (rule 4). Rows with
`"kind": "subagent"` give `transcriptCost`, `modelId` and `otelCostUsd` and expect `cost`,
`pricingMissing` and `fromOtel` (rule 5). Rows with `"kind": "budget-tree-cost"` give `hookUsd`
and `otelMicros` and expect `micros` and `source` (rule 6). Amounts
are chosen so every boundary is exact in binary floating point (e.g. `33 / 100` is the same
double as `0.33`, and the sums of rule 1 are exact).

Rows (47): [`docs/algorithm-examples/otel-cost-selection.json`](../../algorithm-examples/otel-cost-selection.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Unpriced root treated as 0 (`(mainCost ?? 0) + …`) -> CT-04 (3.5).
- A pricing flag ignored -> CT-05 (2.5), CT-06 (0.19).
- OTEL used as a fallback when the computed total is null -> not expressible: the OTEL cost is
  no input of rule 1 (CT-04, CT-06 pin the null).
- `null` / `""` kept in the list -> UM-02; no dedup -> UM-01; locale sort -> UM-04.
- `>` instead of `>=` in rule 3 -> OC-05, OC-07.
- Signed delta instead of absolute in rule 3 -> OC-07.
- Missing `computed = 0` guard in rule 3 -> OC-12 (division by zero gives `Infinity`, true).
- `||` instead of `&&` in rule 4 -> CM-04, CM-05.
- `>` instead of `>=` in rule 4 -> CM-01, CM-03.
- Ratio constant lowered (e.g. `0.009`) -> CM-09; raised up to `0.05` -> CM-03.
- Rule 3 written as two ratio limits with a wrong lower one (`otel / computed <= 0.70 || >= 1.33`)
  -> OC-14.
- Rounding before comparing: rule 3 -> OC-16, rule 4 -> CM-10.
- Rule 5: `otel` instead of `max(transcript, otel)` -> SA-02; `pricingMissing` ignoring OTEL ->
  SA-04; `>=` instead of `>` in `fromOtel` -> SA-06; OTEL ignored -> SA-01.
- Rule 6: OTEL preferred whenever present -> BT-02; `>=` instead of `>` for `source` -> BT-07;
  OTEL `0` treated as present -> BT-05; OTEL ignored (rule 1 reused) -> BT-01, BT-03.
- Equivalent within the input domain: `|telemetry|` written without `abs` differs only for
  negative amounts, which never occur (see Rules).

## Where the result is visible

- Session header, Summary cost tile, Session Info: the cost (`totalCost`), `$???` with the "no
  price" hint naming `costBreakdown.unpricedModels` when it is `null` for an unpriced model, and
  the warning icon (`hasCostDiscrepancy`) whose hint names both numbers.
- Cost tooltip: the mismatch line (`costBreakdown.mismatch`), and the mismatch marker in the
  sessions list.
- Repository -> Sessions list cost column, the analytics timeline, the executive summary (an
  unpriced session is excluded from the sums and disclosed), the attribution breakdown (an
  unpriced session adds nothing), the turn-end advisor and the delete-time audit row — all
  through `readTreeCost`. Rule 5 raises these totals for old-CC sessions with OTEL data.
- Rule 5 per sub-agent: "from OTEL" next to the cost in `SubAgentDetail`, `WorkflowAgentsTable`
  and `AgentActivationItem`, and "Sub-agents (from OTEL)" in `CostBreakdownTooltip`.
- Rule 6 (budgets only): the Repository / Team **Spend** tab (budget bar, tiles, slices, costly
  sessions, the "N sessions unpriced · M OTEL-only" line), the budget threshold **notices** (bell,
  tray, banner, email), **Reports › Budget** and **Analytics › Budget burn**. A tree whose OTEL
  total exceeds the computed cost shows the computed cost everywhere else but counts the OTEL
  amount toward the budget.
