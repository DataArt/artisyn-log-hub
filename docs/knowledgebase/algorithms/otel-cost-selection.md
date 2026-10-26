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
in for an unknown one. OTEL stays a cross-check.

This rule computes the shown total from its parts, lists the model ids the "no price" hint
names, decides when the header shows the "sources disagree" warning icon, and decides when the
cost tooltip flags a mismatch between the calculated cost and telemetry.

## Code

- Implementation: `server/src/logs/otel-cost.sql.ts` — `resolveSessionTotalCost`,
  `unpricedModelList`, `otelComputedDiscrepancy` (`OTEL_DISCREPANCY_THRESHOLD = 0.33`),
  `costMismatch` (`COST_MISMATCH_TOLERANCE_USD = 0.05`, `COST_MISMATCH_TOLERANCE_RATIO = 0.01`).
  The parts come from SQL in `server/src/logs/session-tree-cost.sql.ts` (`treeCostCtes`,
  `readTreeCost`), which every cost surface uses.
- Twins: none (the client only renders the server's `totalCost`, `costUnavailableReason`,
  `costBreakdown.unpricedModels`, `hasCostDiscrepancy` and `costBreakdown.mismatch`).
- Test: `server/src/logs/otel-cost.sql.algo.spec.ts`.

## Rules

Amounts are numbers of USD, never negative, or `null`. The callers turn database values into
numbers before the call.

The total takes the parts of one session tree: `mainCost` (the root's own stored cost, `null`
when the root is unpriced or has no stored cost), `subagentCost` (the sum of the priced
sub-agents' stored costs), `utilityCost` (the priced utility calls), and two flags:
`subagentPricingMissing` (some sub-agent with a transcript names a model with no price) and
`utilityPricingMissing` (some utility call's model has no price).

1. **Shown cost** (`total`): `null` when `mainCost` is `null`, or either flag is true.
   Otherwise `mainCost + subagentCost + utilityCost`. A partial sum is never shown, and the OTEL
   cost is not an input at all.

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
   `delta = |calculated - telemetry|`, true only when `delta >= 0.05` **and**
   `delta >= |telemetry| * 0.01`.

The OTEL total arrives as `null`, never `0`: an OTEL total of exactly 0 is stored as `NULL` (an
upload with no billable call) and the query skips it. Rules 3 and 4 still accept 0 (the floor
rows CM-01/CM-02 use `telemetry: 0`).

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

## Examples

Rows with `"kind": "total"` give the five parts and expect `total` (rule 1). Rows with
`"kind": "unpriced"` give `lists` and expect `models` (rule 2). Rows with
`"kind": "discrepancy"` give `otel` and `computed` and expect `discrepancy` (rule 3). Rows with
`"kind": "mismatch"` give `telemetry` and `calculated` and expect `mismatch` (rule 4). Amounts
are chosen so every boundary is exact in binary floating point (e.g. `33 / 100` is the same
double as `0.33`, and the sums of rule 1 are exact).

```examples
[
  {
    "id": "CT-01",
    "input": {"kind": "total", "mainCost": 2, "subagentCost": 0.5, "subagentPricingMissing": false, "utilityCost": 0.25, "utilityPricingMissing": false},
    "expected": {"total": 2.75},
    "note": "Everything priced: 2 + 0.5 + 0.25 = 2.75."
  },
  {
    "id": "CT-02",
    "input": {"kind": "total", "mainCost": 1.5, "subagentCost": 0, "subagentPricingMissing": false, "utilityCost": 0, "utilityPricingMissing": false},
    "expected": {"total": 1.5},
    "note": "No sub-agents, no telemetry (utility 0): the root's own cost."
  },
  {
    "id": "CT-03",
    "input": {"kind": "total", "mainCost": 0, "subagentCost": 0, "subagentPricingMissing": false, "utilityCost": 0, "utilityPricingMissing": false},
    "expected": {"total": 0},
    "note": "A priced model with all-zero rates: a genuine 0, not null."
  },
  {
    "id": "CT-04",
    "input": {"kind": "total", "mainCost": null, "subagentCost": 3, "subagentPricingMissing": false, "utilityCost": 0.5, "utilityPricingMissing": false},
    "expected": {"total": null},
    "note": "Unpriced root: null, never the priced parts 3.5 (and never the OTEL cost)."
  },
  {
    "id": "CT-05",
    "input": {"kind": "total", "mainCost": 2, "subagentCost": 0.5, "subagentPricingMissing": true, "utilityCost": 0, "utilityPricingMissing": false},
    "expected": {"total": null},
    "note": "A sub-agent with an unpriced model: its share is missing from 0.5, so the total is null, not 2.5."
  },
  {
    "id": "CT-06",
    "input": {"kind": "total", "mainCost": 0.19, "subagentCost": 0, "subagentPricingMissing": false, "utilityCost": 0, "utilityPricingMissing": true},
    "expected": {"total": null},
    "note": "A utility call on a model with no price: null, not 0.19. The Haiku 5.5 case: OTEL said 2.85 (Opus rates), and that number is never shown either."
  },
  {
    "id": "CT-07",
    "input": {"kind": "total", "mainCost": null, "subagentCost": 0, "subagentPricingMissing": true, "utilityCost": 0, "utilityPricingMissing": true},
    "expected": {"total": null},
    "note": "Every part unpriced: null."
  },
  {
    "id": "UM-01",
    "input": {"kind": "unpriced", "lists": [["claude-zeta-1"], ["claude-alpha-2", "claude-zeta-1"], ["claude-alpha-2"]]},
    "expected": {"models": ["claude-alpha-2", "claude-zeta-1"]},
    "note": "Root, sub-agent and utility lists merge into distinct ids, sorted."
  },
  {
    "id": "UM-02",
    "input": {"kind": "unpriced", "lists": [[null], ["", "claude-haiku-5-5"]]},
    "expected": {"models": ["claude-haiku-5-5"]},
    "note": "null and empty ids are not model names and are dropped."
  },
  {
    "id": "UM-03",
    "input": {"kind": "unpriced", "lists": [[], [], []]},
    "expected": {"models": []},
    "note": "Nothing unpriced: an empty list."
  },
  {
    "id": "UM-04",
    "input": {"kind": "unpriced", "lists": [["claude-a"], ["Claude-b"]]},
    "expected": {"models": ["Claude-b", "claude-a"]},
    "note": "Code-unit order: 'C' (67) sorts before 'c' (99). A locale-aware sort (localeCompare) would give claude-a first."
  },
  {
    "id": "OC-01",
    "input": {"kind": "discrepancy", "otel": 110, "computed": 100},
    "expected": {"discrepancy": false},
    "note": "|110 - 100| / 100 = 0.10 < 0.33."
  },
  {
    "id": "OC-02",
    "input": {"kind": "discrepancy", "otel": 50, "computed": 100},
    "expected": {"discrepancy": true},
    "note": "50 / 100 = 0.5 >= 0.33."
  },
  {
    "id": "OC-04",
    "input": {"kind": "discrepancy", "otel": 84, "computed": 100},
    "expected": {"discrepancy": false},
    "note": "16 / 100 = 0.16 < 0.33."
  },
  {
    "id": "OC-05",
    "input": {"kind": "discrepancy", "otel": 133, "computed": 100},
    "expected": {"discrepancy": true},
    "note": "Rule 3 is inclusive: 33 / 100 = 0.33 >= 0.33."
  },
  {
    "id": "OC-06",
    "input": {"kind": "discrepancy", "otel": 132, "computed": 100},
    "expected": {"discrepancy": false},
    "note": "32 / 100 = 0.32 < 0.33."
  },
  {
    "id": "OC-07",
    "input": {"kind": "discrepancy", "otel": 67, "computed": 100},
    "expected": {"discrepancy": true},
    "note": "The warning uses the absolute delta: |67 - 100| / 100 = 0.33 >= 0.33."
  },
  {
    "id": "OC-08",
    "input": {"kind": "discrepancy", "otel": 1500, "computed": 100},
    "expected": {"discrepancy": true},
    "note": "The Haiku 5.5 shape: Claude Code priced an unknown model at Opus rates, 15x the Log Hub cost. The warning fires; the shown cost stays 100."
  },
  {
    "id": "OC-09",
    "input": {"kind": "discrepancy", "otel": null, "computed": 100},
    "expected": {"discrepancy": false},
    "note": "No OTEL: nothing to compare."
  },
  {
    "id": "OC-10",
    "input": {"kind": "discrepancy", "otel": 70, "computed": null},
    "expected": {"discrepancy": false},
    "note": "No computed total (some model unpriced): nothing to compare; the session shows $??? instead."
  },
  {
    "id": "OC-11",
    "input": {"kind": "discrepancy", "otel": null, "computed": null},
    "expected": {"discrepancy": false},
    "note": "Neither side."
  },
  {
    "id": "OC-12",
    "input": {"kind": "discrepancy", "otel": 30, "computed": 0},
    "expected": {"discrepancy": false},
    "note": "computed = 0 is no baseline: rule 3 needs computed != 0."
  },
  {
    "id": "OC-14",
    "input": {"kind": "discrepancy", "otel": 68, "computed": 100},
    "expected": {"discrepancy": false},
    "note": "Below computed, inside the band: |68 - 100| / 100 = 0.32 < 0.33. A ratio rule with a looser lower limit on this side (otel / computed <= 0.70) would warn."
  },
  {
    "id": "OC-16",
    "input": {"kind": "discrepancy", "otel": 132.9, "computed": 100},
    "expected": {"discrepancy": false},
    "note": "Rule 3 is not rounded: |132.9 - 100| / 100 = 0.329 < 0.33. Rounding the ratio to two places (0.33) would warn."
  },
  {
    "id": "CM-01",
    "input": {"kind": "mismatch", "telemetry": 0, "calculated": 0.05},
    "expected": {"mismatch": true},
    "note": "delta = 0.05 >= 0.05 (inclusive floor) and >= 0 * 0.01 = 0."
  },
  {
    "id": "CM-02",
    "input": {"kind": "mismatch", "telemetry": 0, "calculated": 0.04},
    "expected": {"mismatch": false},
    "note": "delta = 0.04 < 0.05 floor."
  },
  {
    "id": "CM-03",
    "input": {"kind": "mismatch", "telemetry": 100, "calculated": 101},
    "expected": {"mismatch": true},
    "note": "delta = 1 >= 0.05 and 1 >= 100 * 0.01 = 1 (inclusive ratio)."
  },
  {
    "id": "CM-04",
    "input": {"kind": "mismatch", "telemetry": 100, "calculated": 100.5},
    "expected": {"mismatch": false},
    "note": "delta = 0.5 is above the 0.05 floor but below 1% of 100 = 1: both bounds are required."
  },
  {
    "id": "CM-05",
    "input": {"kind": "mismatch", "telemetry": 0.1, "calculated": 0.14},
    "expected": {"mismatch": false},
    "note": "delta = 0.04 is 40% of telemetry but below the 0.05 floor: both bounds are required."
  },
  {
    "id": "CM-06",
    "input": {"kind": "mismatch", "telemetry": 100, "calculated": 99},
    "expected": {"mismatch": true},
    "note": "Calculated below telemetry counts too: |99 - 100| = 1 >= 0.05 and >= 1."
  },
  {
    "id": "CM-07",
    "input": {"kind": "mismatch", "telemetry": null, "calculated": 5},
    "expected": {"mismatch": false},
    "note": "No telemetry: false."
  },
  {
    "id": "CM-08",
    "input": {"kind": "mismatch", "telemetry": 5, "calculated": null},
    "expected": {"mismatch": false},
    "note": "No calculated cost (some model unpriced): false."
  },
  {
    "id": "CM-09",
    "input": {"kind": "mismatch", "telemetry": 100, "calculated": 100.99},
    "expected": {"mismatch": false},
    "note": "Just under the 1% bound: delta = 0.99 < 100 * 0.01 = 1 (but above the floor). A ratio of 0.009 would flag it."
  },
  {
    "id": "CM-10",
    "input": {"kind": "mismatch", "telemetry": 1, "calculated": 1.049},
    "expected": {"mismatch": false},
    "note": "Rule 4 is not rounded: delta = 0.049 < 0.05. Rounding the delta to cents (0.05) would flag it."
  }
]
```

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
  through `readTreeCost`.
