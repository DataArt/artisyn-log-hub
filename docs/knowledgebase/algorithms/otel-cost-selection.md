---
reviewed: 2026-10-15
reviewer: ai
---

# OTEL cost selection: which session cost is shown, and when to warn

## Purpose

A session can have two costs: the OTEL cost the Claude Code exporter reported (real billing) and
the calculated cost (tokens times `model_pricing`, see [cost-formula.md](cost-formula.md), for
the root session, its sub-agents and its utility calls). This
rule picks the one the user sees as the session cost, decides when the header shows the
"sources disagree" warning icon, and decides when the cost tooltip flags a mismatch between the
utility-inclusive calculated cost and telemetry.

## Code

- Implementation: `server/src/logs/otel-cost.sql.ts` — `resolveSessionTotalCost`,
  `isOtelCostIncomplete` (`OTEL_INCOMPLETE_RATIO = 0.5`), `otelComputedDiscrepancy`
  (`OTEL_DISCREPANCY_THRESHOLD = 0.33`), `costMismatch` (`COST_MISMATCH_TOLERANCE_USD = 0.05`,
  `COST_MISMATCH_TOLERANCE_RATIO = 0.01`).
- Twins: none (the client only renders the server's `totalCost`, `hasCostDiscrepancy` and
  `costBreakdown.mismatch`).
- Test: `server/src/logs/otel-cost.sql.algo.spec.ts`.

## Rules

Inputs are numbers of USD, never negative, or `null`. The functions accept 0 on either side
(the floor rows CM-01/CM-02 use `telemetry: 0` to hit the 5-cent floor exactly), though the
product never passes an OTEL total of 0 (see below). The callers turn database values into
numbers before the call (`repositories.controller.ts`), and the OTEL total arrives as `null`,
never `0`: an OTEL total of exactly 0 is stored as `NULL` (an upload with no billable call) and
the query skips it, so "OTEL present" always means a positive amount. In the session header
`computed` is the calculated cost including sub-agents and utility calls. Other surfaces pass
their own figure as `computed`: the executive summary its own cost plus the sub-agent rollup
(never `null`), the attribution breakdown own plus sub-agent cost, the delete-time audit row the
root's own cost. So the same session can trip rule 1 on one surface and not on another.

Selection and the warning take `otel` and `computed`.

1. **Incomplete OTEL.** `incomplete` is true only when both are present, `computed > 0`, and
   `otel < computed * 0.5` (strictly below half). In every other case it is false.
2. **Shown cost** (`total`):
   - if `otel` is present and not `incomplete`: `otel`;
   - otherwise `computed` if present, else `otel`, else `null`.

   The rule is asymmetric: an OTEL cost above the computed one is normal and always kept.
3. **Discrepancy warning** (`discrepancy`): true only when both are present, `computed != 0`, and
   `|otel - computed| / computed >= 0.33`. It does not depend on which cost won in rule 2.

The mismatch flag takes `telemetry` (the OTEL total) and `calculated` (main + sub-agents +
utility calls), each USD or `null`:

4. **Mismatch** (`mismatch`): false if either is `null`. Otherwise with
   `delta = |calculated - telemetry|`, true only when `delta >= 0.05` **and**
   `delta >= |telemetry| * 0.01`.

## Edge cases

- Exactly half (not incomplete) vs just below: OC-02, OC-03, OC-17; a tiny positive computed
  cost: OC-15.
- Discrepancy exactly 33% (inclusive) vs 32%, on both sides of computed: OC-05, OC-06 (above),
  OC-07, OC-14 (below); a fraction under the limit: OC-16.
- OTEL far above computed is kept: OC-08.
- One side or both missing: OC-09, OC-10, OC-11.
- Computed `0`: OC-12 (OTEL kept, no warning), OC-13 (genuine `0`, not `null`).
- Mismatch floor and ratio, inclusive and just below: CM-01..CM-05, CM-09, CM-10; direction: CM-06; missing side:
  CM-07, CM-08.

## Examples

Rows with `"kind": "select"` give `otel` and `computed` and expect all three outputs of rules 1-3
(`total`, `incomplete`, `discrepancy`). Rows with `"kind": "mismatch"` give `telemetry` and
`calculated` and expect `mismatch`. Amounts are chosen so every boundary is exact in binary
floating point (e.g. `33 / 100` is the same double as `0.33`).

```examples
[
  {
    "id": "OC-01",
    "input": {"kind": "select", "otel": 110, "computed": 100},
    "expected": {"total": 110, "incomplete": false, "discrepancy": false},
    "note": "110 >= 50, OTEL wins; |110 - 100| / 100 = 0.10 < 0.33."
  },
  {
    "id": "OC-02",
    "input": {"kind": "select", "otel": 50, "computed": 100},
    "expected": {"total": 50, "incomplete": false, "discrepancy": true},
    "note": "Rule 1 is strict: 50 < 100 * 0.5 = 50 is false, so OTEL wins at exactly half. Discrepancy 50 / 100 = 0.5 >= 0.33."
  },
  {
    "id": "OC-03",
    "input": {"kind": "select", "otel": 49, "computed": 100},
    "expected": {"total": 100, "incomplete": true, "discrepancy": true},
    "note": "49 < 50, incomplete, computed wins. The warning stays on: 51 / 100 = 0.51 >= 0.33."
  },
  {
    "id": "OC-04",
    "input": {"kind": "select", "otel": 84, "computed": 100},
    "expected": {"total": 84, "incomplete": false, "discrepancy": false},
    "note": "84 >= 50, OTEL wins; 16 / 100 = 0.16 < 0.33 (the healthy out-of-process sub-agent case)."
  },
  {
    "id": "OC-05",
    "input": {"kind": "select", "otel": 133, "computed": 100},
    "expected": {"total": 133, "incomplete": false, "discrepancy": true},
    "note": "Rule 3 is inclusive: 33 / 100 = 0.33 >= 0.33. OTEL wins."
  },
  {
    "id": "OC-06",
    "input": {"kind": "select", "otel": 132, "computed": 100},
    "expected": {"total": 132, "incomplete": false, "discrepancy": false},
    "note": "32 / 100 = 0.32 < 0.33."
  },
  {
    "id": "OC-07",
    "input": {"kind": "select", "otel": 67, "computed": 100},
    "expected": {"total": 67, "incomplete": false, "discrepancy": true},
    "note": "The warning uses the absolute delta: |67 - 100| / 100 = 0.33 >= 0.33. 67 >= 50, OTEL wins."
  },
  {
    "id": "OC-08",
    "input": {"kind": "select", "otel": 200, "computed": 100},
    "expected": {"total": 200, "incomplete": false, "discrepancy": true},
    "note": "Asymmetry: OTEL above computed is never incomplete, so 200 is shown; the warning still fires (100 / 100 = 1)."
  },
  {
    "id": "OC-09",
    "input": {"kind": "select", "otel": null, "computed": 100},
    "expected": {"total": 100, "incomplete": false, "discrepancy": false},
    "note": "No OTEL: computed is shown; rules 1 and 3 need both sides."
  },
  {
    "id": "OC-10",
    "input": {"kind": "select", "otel": 70, "computed": null},
    "expected": {"total": 70, "incomplete": false, "discrepancy": false},
    "note": "No computed (unpriced model): OTEL is shown; nothing to compare."
  },
  {
    "id": "OC-11",
    "input": {"kind": "select", "otel": null, "computed": null},
    "expected": {"total": null, "incomplete": false, "discrepancy": false},
    "note": "Neither source: null, never 0."
  },
  {
    "id": "OC-12",
    "input": {"kind": "select", "otel": 30, "computed": 0},
    "expected": {"total": 30, "incomplete": false, "discrepancy": false},
    "note": "computed = 0 is no baseline: rule 1 needs computed > 0, rule 3 needs computed != 0. OTEL is shown."
  },
  {
    "id": "OC-13",
    "input": {"kind": "select", "otel": null, "computed": 0},
    "expected": {"total": 0, "incomplete": false, "discrepancy": false},
    "note": "Rule 2 fallback: computed is present (0), so 0 is shown, not null."
  },
  {
    "id": "OC-14",
    "input": {"kind": "select", "otel": 68, "computed": 100},
    "expected": {"total": 68, "incomplete": false, "discrepancy": false},
    "note": "Below computed, inside the band: |68 - 100| / 100 = 0.32 < 0.33. A ratio rule with a looser lower limit on this side (otel / computed <= 0.70) would warn."
  },
  {
    "id": "OC-15",
    "input": {"kind": "select", "otel": 0.004, "computed": 0.01},
    "expected": {"total": 0.01, "incomplete": true, "discrepancy": true},
    "note": "A small but positive baseline still counts: 0.004 < 0.01 * 0.5 = 0.005, incomplete, computed wins; |0.004 - 0.01| / 0.01 = 0.6 >= 0.33. A guard like computed < 1 would skip both."
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
    "note": "No calculated cost (unpriced main model): false."
  },
  {
    "id": "CM-09",
    "input": {"kind": "mismatch", "telemetry": 100, "calculated": 100.99},
    "expected": {"mismatch": false},
    "note": "Just under the 1% bound: delta = 0.99 < 100 * 0.01 = 1 (but above the floor). A ratio of 0.009 would flag it."
  },
  {
    "id": "OC-16",
    "input": {"kind":"select","otel":132.9,"computed":100},
    "expected": {"total":132.9,"incomplete":false,"discrepancy":false},
    "note": "Rule 3 is not rounded: |132.9 - 100| / 100 = 0.329 < 0.33. Rounding the ratio to two places (0.33) would warn."
  },
  {
    "id": "OC-17",
    "input": {"kind":"select","otel":49.9,"computed":100},
    "expected": {"total":100,"incomplete":true,"discrepancy":true},
    "note": "Rule 1 is not rounded: 49.9 < 50, incomplete, computed wins; |49.9 - 100| / 100 = 0.501 >= 0.33. Rounding otel / computed to 0.50 first would keep 49.9."
  },
  {
    "id": "CM-10",
    "input": {"kind":"mismatch","telemetry":1,"calculated":1.049},
    "expected": {"mismatch":false},
    "note": "Rule 4 is not rounded: delta = 0.049 < 0.05. Rounding the delta to cents (0.05) would flag it."
  }
]
```

## Mutations

- `<=` instead of `<` in rule 1 -> OC-02 (total becomes 100).
- Incomplete check made symmetric (`|otel - computed|`) -> OC-08 (total becomes 100).
- Fallback order `otel ?? computed` after an incomplete verdict -> OC-03 (total 49).
- `>` instead of `>=` in rule 3 -> OC-05, OC-07.
- Signed delta instead of absolute in rule 3 -> OC-07.
- Missing `computed = 0` guard in rule 3 -> OC-12 (division by zero gives `Infinity`, true).
- `||` instead of `&&` in rule 4 -> CM-04, CM-05.
- `>` instead of `>=` in rule 4 -> CM-01, CM-03.
- Ratio constant lowered (e.g. `0.009`) -> CM-09; raised up to `0.05` -> CM-03.
- Rule 3 written as two ratio limits with a wrong lower one (`otel / computed <= 0.70 || >= 1.33`)
  -> OC-14.
- A larger "no baseline" guard (`computed < 1`) -> OC-15.
- Rounding before comparing: rule 1 -> OC-17, rule 3 -> OC-16, rule 4 -> CM-10.
- Equivalent: the final `?? otel` of rule 2 (when OTEL is incomplete, `computed` is present by
  definition, so the fallback to `otel` is never taken).
- Equivalent within the input domain: `|telemetry|` written without `abs`, and `computed <= 0`
  written `computed === 0`, differ only for negative amounts, which never occur (see Rules).

## Where the result is visible

- Session header: the cost (`totalCost`) and the warning icon (`hasCostDiscrepancy`).
- Cost tooltip: the mismatch line (`costBreakdown.mismatch`), and the mismatch marker in the
  sessions list.
- Repository -> Sessions list cost column and the analytics totals (all use `totalCost`). Some
  reports (executive summary, attribution breakdown) add a `null` cost as 0 in their sums.
