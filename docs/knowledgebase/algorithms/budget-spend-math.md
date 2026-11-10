---
reviewed: no
reviewer: none
---

# Budget spend math: forecast, anomaly days, costly sessions, threshold notices

## Purpose

A budget caps what a repository, a team repository or a team spends per day, week or month
(task `2026-11-05-budgets-threshold-alerts`). This math turns a period's spend into what the user
reads: how fast money burns, where the period will end, when the budget runs out, which days and
sessions stand out, and which crossed threshold earns a notice.

## Code

- Implementation: `server/src/logs/budgets/budget-math.ts` — `computeBudgetForecast`,
  `markAnomalyDays`, `markCostlySessions`, `selectThresholdNotices`; constants
  `BUDGET_ANOMALY_DAY_FACTOR = 2`, `BUDGET_COSTLY_MIN_TREES = 5` in
  `server/src/logs/budgets/budget.constants.ts`.
- Inputs come from the budget spend read (`SpendService`): spend per root tree is
  `selectBudgetTreeCostMicros` ([otel-cost-selection.md](otel-cost-selection.md), rule 6), the
  period bounds (elapsed / total units) from `loadPeriodBounds`.
- Twins: none. The client renders the server's `forecast`, `anomalyDays` and `costlySessions`.
- Test: `server/src/logs/budgets/budget-math.algo.spec.ts`.

## Rules

Money is integer micro-USD (`micros`). A **unit** is a day for week and month budgets and an hour
for a day budget. `elapsedUnits` counts the current unit (at least 1 in a current period);
`totalUnits` is the period length (28–31 days, 7 days, 23–25 hours).

**Forecast** (`computeBudgetForecast`, input `spendMicros`, `amountMicros` or `null`,
`elapsedUnits`, `totalUnits`, `isCurrent`):

1. `burnRateMicrosPerUnit = spend / elapsedUnits` (0 when `elapsedUnits ≤ 0`), not rounded.
2. `forecastMicros = Math.round(spend + burnRate × (totalUnits − elapsedUnits))` in a current
   period; `= spend` in a past one.
3. `percentUsed = spend × 100 / amount`, `null` without an amount.
4. `status`: `exceeded` when an amount exists and `spend ≥ amount`; else `no-rate` when
   `burnRate = 0`; else `ok`.
5. `unitsLeft = (amount − spend) / burnRate` only when `status = ok`, the period is current and an
   amount exists; otherwise `null`.
6. `overspendRisk = isCurrent && amount != null && forecast > amount` (strict).

**Anomaly days** (`markAnomalyDays`, input `dailyMicros` per bucket, `elapsedUnits`,
`spendMicros`):

7. None when `elapsedUnits ≤ 1` or `spend ≤ 0`.
8. Otherwise the indices `i < elapsedUnits` with `daily[i] × elapsedUnits ≥
   BUDGET_ANOMALY_DAY_FACTOR × spend` — i.e. at least twice the average, compared without a
   division so integer micros stay exact. Buckets past the elapsed ones are ignored.

**Costly sessions** (`markCostlySessions`, input trees `{id, micros, source}`):

9. Only trees with `source ≠ 'none'` count (`n` of them).
10. `n < BUDGET_COSTLY_MIN_TREES` → `{mean: 0, sigma: 0, marks: []}`.
11. Population statistics: `mean = Σ micros / n`, `sigma = sqrt(Σ (micros − mean)² / n)`.
    `sigma = 0` → no marks (mean and sigma still returned).
12. Each tree in input order: `level 3` when `micros ≥ mean + 3σ`, else `level 2` when
    `micros ≥ mean + 2σ`, else no mark.

**Threshold notices** (`selectThresholdNotices`, input `thresholds` in percent, `spendMicros`,
`amountMicros`, `existing` = thresholds already recorded for this budget period):

13. `crossed = {t : spend × 100 ≥ t × amount}`, compared in `BigInt` after rounding the micros.
14. `fresh = crossed \ existing`. Empty → `{notify: null, superseded: []}`.
15. `top = max(fresh)`, `maxExisting = max(existing, 0)`.
    - `top > maxExisting`: `notify = top`; every other fresh threshold is superseded by `top`.
    - Otherwise `notify = null`; every fresh threshold is superseded by `maxExisting`.
16. `superseded` is `{threshold, supersededBy}[]`, ascending by threshold. A jump over several
    thresholds in one check therefore sends one notice, and the skipped ones are recorded as
    superseded (no late notice for a lower threshold).

## Edge cases

- Monthly / weekly / hourly forecasts: BF-01, BF-02, BF-03.
- Exceeded, and exactly at the amount (inclusive): BF-04, BF-05.
- Zero spend → `no-rate`, no division by zero: BF-06.
- Past period → forecast = spend, no units left, no risk: BF-07.
- No amount → `percentUsed` and `unitsLeft` null, no risk: BF-08.
- Anomaly: one spike AD-01; one elapsed day AD-02; zero spend AD-03; exactly twice the average
  (inclusive) AD-04; buckets past `elapsedUnits` ignored AD-05.
- Costly: level 2 CS-01; level 3 CS-02; fewer than 5 trees CS-03; σ = 0 CS-04; unpriced trees not
  counted CS-05.
- Threshold: exactly at a threshold (inclusive) TN-01, just below TN-02; jump over two TN-03;
  next threshold after one recorded TN-04; nothing fresh TN-05; a lower threshold added later
  TN-06; above 100 % TN-07; largest amount, one micro short TN-08.

## Examples

Every row has `input.kind`. `"forecast"` rows give the five forecast inputs and expect the whole
forecast object (rules 1–6). `"anomaly-days"` rows give `dailyMicros`, `elapsedUnits` and
`spendMicros` and expect `days` (rules 7–8). `"costly-sessions"` rows give `trees` and expect
`mean`, `sigma` and `marks` (rules 9–12). `"threshold-notices"` rows give `thresholds`,
`spendMicros`, `amountMicros` and `existing` and expect `notify` and `superseded` (rules 13–16).

Rows (26): [`docs/algorithm-examples/budget-spend-math.json`](../../algorithm-examples/budget-spend-math.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `spend / amount × 100` instead of `spend × 100 / amount` -> BF-01 (82.39999999999999).
- `>` instead of `>=` for `exceeded` -> BF-05; past period projected like a current one -> BF-07.
- `unitsLeft` computed without an amount, or 0 instead of `null` when exceeded -> BF-08, BF-05.
- `overspendRisk` ignoring `isCurrent` -> BF-07.
- Anomaly: no zero-spend guard -> AD-03; `>` instead of `>=` -> AD-04; all buckets scanned ->
  AD-05.
- Costly: sample σ (`n − 1`) -> CS-01; unpriced trees counted -> CS-05; no σ = 0 guard -> CS-04;
  `>` instead of `>=` -> not killed by a row (σ is irrational for the rows), accepted.
- Threshold: notifying every fresh threshold, or the lowest one -> TN-03; ignoring `existing` ->
  TN-05; notifying a fresh threshold below an existing one -> TN-06; `>` instead of `>=` ->
  TN-01.

## Where the result is visible

- Repository / Team **Spend** tab: budget card ("$41.20 of $50.00 · 82 %"), the "⚠ Overspend
  risk" pill, the Burn rate / Forecast / Runs out in tiles, the amber-outlined anomaly bar in the
  daily chart and the `2σ` / `3σ` pills in the costly-sessions list ("mean $X · σ $Y").
- Budget threshold **notices**: the bell count, the tray, the banner and the email — one per
  `notify`; superseded thresholds appear only in the budget event log ("Threshold superseded").
- **Reports › Budget** (spend, %, forecast) and **Analytics › Budget burn** (forecast line).
