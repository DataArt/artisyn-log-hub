---
reviewed: 2026-10-15
reviewer: ai
---

# Cost formula: what a session's tokens cost

## Purpose

Turns a session's token counts and one `model_pricing` row into US dollars. Every computed
session cost in the product (sessions list, session Info, Summary, Executive Summary, Analytics,
the delete-time audit row) comes from this one formula, so the same tokens must always cost the
same, and "we cannot price this model" must never look like "$0.00".

## Code

- Implementation: `server/src/logs/cost.sql.ts` (`computeSessionCost`; the SQL form
  `sessionCostSql` is the same expression and is covered end-to-end by the scenario and e2e
  suites, not by these rows). Which `model_pricing` row applies (the newest one in effect on
  the session's price date, model id without a `-YYYYMMDD` suffix) is decided before this
  formula by `pricingAsOfSql`; it is covered through the cost scenarios and golden sessions.
- Twins:
  - `client/src/viewer/lib/format.ts` (`computeCost`, own `FAST_MODE_MULTIPLIER`);
  - `hook/.claude/telemetry_tool/post-turn-analysis-worker.js` (`computeLocalSessionCost`).

  Both twins take plain numbers and always a pricing row, so they run every row except the ones
  marked `"only": "server"` (missing pricing, DB strings, `null` columns). The hook twin has no
  guard of its own: its caller returns `null` when `GET /api/v1/model-pricing` fails or does
  not list the model, and it relies on that response carrying all six rates. That caller also
  picks the rate row differently from the server: by the exact model id (no `-YYYYMMDD`
  stripping) and at today's rates, not at the session's price date.
- The SQL form `sessionCostSql` does not `COALESCE` the rates (the `model_pricing` rate columns
  are `NOT NULL`) and has no missing-pricing guard of its own; every SQL caller wraps it
  in `CASE WHEN p.model_id IS NOT NULL ...` (see Rules, last paragraph).
- Tests:
  - `server/src/logs/cost.sql.algo.spec.ts`;
  - `client/src/viewer/lib/format.algo.test.ts`;
  - `hook/.claude/telemetry_tool/__tests__/cost-formula.algo.test.js`.

## Input and output

Tokens (`session_stats` columns): `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWrite5mTokens`, `cacheWrite1hTokens`, `webSearchRequests`, `inputTokensFast`,
`outputTokensFast`. `inputTokensFast` and `outputTokensFast` are **subsets** of `inputTokens` and
`outputTokens` (the part billed in fast mode), not extra tokens.

Rates (`model_pricing` row): `priceIn`, `priceOut`, `priceCacheR`, `priceCacheW5m`,
`priceCacheW1h` in USD per million tokens, and `priceWebSearch` in USD **per request**.

Output: the cost in USD, or `null` when there is no pricing row.

## Rules

1. No pricing row (`null` or absent): the cost is `null`. Stop.
2. Every token count and rate that is `null` or absent counts as `0`. A string (what Postgres
   returns for `bigint`/`numeric`) is read with `parseFloat` (so `"12abc"` is 12); a result
   that is not a finite number (`"abc"`, `"Infinity"`) counts as `0`. The same holds for a number
   that is `NaN` or infinite; no row can carry one (JSON has no such numbers, and neither
   Postgres nor the callers produce them), so the rows test it through strings.
3. Fast mode is a surcharge on the total, with `FAST_MODE_MULTIPLIER = 2`, so `F = 2 - 1 = 1`:
   - `in  = inputTokens  + inputTokensFast  * F`
   - `out = outputTokens + outputTokensFast * F`
4. The cost is the sum of six terms:

   ```
   cost = in                 / 1e6 * priceIn
        + out                / 1e6 * priceOut
        + cacheReadTokens    / 1e6 * priceCacheR
        + cacheWrite5mTokens / 1e6 * priceCacheW5m
        + cacheWrite1hTokens / 1e6 * priceCacheW1h
        + webSearchRequests        * priceWebSearch
   ```

5. A pricing row whose rates are all `0` is a priced model: the cost is `0`, not `null`.

There is no separate `cacheWrite` term: `cacheWrite5mTokens + cacheWrite1hTokens` already is the
whole cache write, and cache reads, cache writes and web search carry no fast surcharge. The
result is not rounded; screens round it for display.

Rule 1 is about one session. Where SQL sums several sessions (analytics totals, the executive
summary), the caller adds an unpriced session as `0` so the priced ones still add up, and reports
the unpriced ones separately (`costUnavailableReason`).

## Edge cases

- No pricing row, `null` or omitted: CF-10, CF-16.
- Rates all zero (priced, free): CF-11.
- Numbers as strings from Postgres: CF-12.
- `null` token columns: CF-13; strings that are not numbers: CF-15, CF-19, CF-20; rates that
  are `null`, absent or not numbers: CF-21.
- No tokens at all: CF-17; a sub-cent cost is not rounded: CF-18, CF-22.
- All fast vs part fast: CF-06, CF-07, CF-08.
- 1h cache write priced at its own rate: CF-04, CF-05.
- Web search per request, not per million: CF-09.

## Examples

Every row uses the Opus 5 rates unless it says otherwise: `priceIn 5`, `priceOut 25`,
`priceCacheR 0.5`, `priceCacheW5m 6.25`, `priceCacheW1h 10`, `priceWebSearch 0.01`.

`input.tokens` lists only the non-zero counts; an omitted count is `0`. `input.pricing` is the
rate row, `null` for "no pricing row", or left out (CF-16) for an absent row. `expected.cost` is compared with a tolerance of
`1e-9`; a `null` expected cost must be exactly `null`. Rows marked `"only": "server"` use inputs
the twins never receive (no pricing row, strings, `null` columns).

```examples
[
  {
    "id": "CF-01",
    "input": {"tokens": {"inputTokens": 1000000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 5},
    "note": "Input term only: 1,000,000 / 1e6 * 5 = 5."
  },
  {
    "id": "CF-02",
    "input": {"tokens": {"outputTokens": 100000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 2.5},
    "note": "Output term only: 100,000 / 1e6 * 25 = 2.5. Swapping the input and output rates would give 0.5."
  },
  {
    "id": "CF-03",
    "input": {"tokens": {"cacheReadTokens": 2000000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 1},
    "note": "Cache read: 2,000,000 / 1e6 * 0.5 = 1."
  },
  {
    "id": "CF-04",
    "input": {"tokens": {"cacheWrite1hTokens": 1000000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 10},
    "note": "1h cache write at its own rate: 1,000,000 / 1e6 * 10 = 10. Pricing it at the 5m rate (the bug before the TTL split) gives 6.25. S-COST-02 checks this through SQL; the row holds the client and hook twins to it."
  },
  {
    "id": "CF-05",
    "input": {"tokens": {"cacheWrite5mTokens": 400000, "cacheWrite1hTokens": 600000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 8.5},
    "note": "0.4 * 6.25 + 0.6 * 10 = 2.5 + 6 = 8.5. Adding a flat 'whole cache write' term on top would double it."
  },
  {
    "id": "CF-06",
    "input": {"tokens": {"inputTokens": 1000000, "inputTokensFast": 1000000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 10},
    "note": "All input billed fast. in = 1,000,000 + 1,000,000 * (2 - 1) = 2,000,000; 2 * 5 = 10, exactly 2x the standard 5. Using F = M = 2 gives 15."
  },
  {
    "id": "CF-07",
    "input": {"tokens": {"inputTokens": 1000000, "inputTokensFast": 250000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 6.25},
    "note": "Fast is a subset: in = 1,000,000 + 250,000 = 1,250,000; 1.25 * 5 = 6.25 (750k standard at 5 = 3.75 plus 250k fast at 10 = 2.5). Treating fast as extra tokens at 2x gives 7.5."
  },
  {
    "id": "CF-08",
    "input": {"tokens": {"outputTokens": 200000, "outputTokensFast": 200000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 10},
    "note": "Output fast surcharge: out = 200,000 + 200,000 = 400,000; 0.4 * 25 = 10. Forgetting the output surcharge gives 5."
  },
  {
    "id": "CF-09",
    "input": {"tokens": {"webSearchRequests": 7}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 0.07},
    "note": "Per request: 7 * 0.01 = 0.07. Dividing by 1e6 as for tokens gives 0.00000007. Also in S-COST-02 via SQL; here for the twins."
  },
  {
    "id": "CF-10",
    "only": "server",
    "input": {"tokens": {"inputTokens": 5000000, "cacheWrite1hTokens": 1000000}, "pricing": null},
    "expected": {"cost": null},
    "note": "Rule 1: no pricing row, so null whatever the tokens. Returning 0 would show a fake $0.00. S-COST-03 checks the API; this row pins the TS function the audit row uses."
  },
  {
    "id": "CF-11",
    "input": {"tokens": {"inputTokens": 1000000, "webSearchRequests": 5}, "pricing": {"priceIn": 0, "priceOut": 0, "priceCacheR": 0, "priceCacheW5m": 0, "priceCacheW1h": 0, "priceWebSearch": 0}},
    "expected": {"cost": 0},
    "note": "Rule 5: a row exists, every term is 1 * 0 or 5 * 0, so 0, not null."
  },
  {
    "id": "CF-12",
    "only": "server",
    "input": {"tokens": {"inputTokens": "1000000", "outputTokens": "0", "cacheReadTokens": "0", "cacheWrite5mTokens": "0", "cacheWrite1hTokens": "1000000", "webSearchRequests": "3", "inputTokensFast": "0", "outputTokensFast": "0"}, "pricing": {"priceIn": "5.000000", "priceOut": "25.000000", "priceCacheR": "0.500000", "priceCacheW5m": "6.250000", "priceCacheW1h": "10.000000", "priceWebSearch": "0.010000"}},
    "expected": {"cost": 15.03},
    "note": "Rule 2, strings parsed: input 1 * 5 = 5, 1h write 1 * 10 = 10, web 3 * 0.01 = 0.03; total 15.03. String concatenation or NaN would break it."
  },
  {
    "id": "CF-13",
    "only": "server",
    "input": {"tokens":{"inputTokens":1000000,"outputTokens":null,"cacheWrite5mTokens":null,"cacheWrite1hTokens":null,"webSearchRequests":null,"inputTokensFast":null},"pricing":{"priceIn":5,"priceOut":25,"priceCacheR":0.5,"priceCacheW5m":6.25,"priceCacheW1h":10,"priceWebSearch":0.01}},
    "expected": {"cost":5},
    "note": "Rule 2: null and absent columns count as 0, so only the input term remains: 1 * 5 = 5. Kills a guard that sends null to parseFloat without the finite check (parseFloat(null) is NaN). Plain arithmetic would also turn null into 0, so this row does not need the null check itself."
  },
  {
    "id": "CF-14",
    "input": {"tokens": {"inputTokens": 2000000, "inputTokensFast": 500000, "outputTokens": 300000, "outputTokensFast": 100000, "cacheReadTokens": 10000000, "cacheWrite5mTokens": 1000000, "cacheWrite1hTokens": 500000, "webSearchRequests": 4}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 38.79},
    "note": "All six terms: in = 2.5M -> 12.5; out = 0.4M -> 10; read 10M * 0.5 = 5; 5m 1M * 6.25 = 6.25; 1h 0.5M * 10 = 5; web 4 * 0.01 = 0.04. Sum 12.5 + 10 + 5 + 6.25 + 5 + 0.04 = 38.79."
  },
  {
    "id": "CF-15",
    "only": "server",
    "input": {"tokens": {"inputTokens": "abc", "outputTokens": 1000000}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 25},
    "note": "Rule 2: 'abc' parses to NaN, which is not finite, so 0; only the output term remains: 1 * 25 = 25. Without the finite check the sum is NaN."
  },
  {
    "id": "CF-16",
    "only": "server",
    "input": {"tokens": {"inputTokens": 1000000}},
    "expected": {"cost": null},
    "note": "Rule 1: an absent pricing row (not even null) is no pricing row: null. A check for === null alone would crash on it."
  },
  {
    "id": "CF-17",
    "input": {"tokens": {}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 0},
    "note": "Every term is 0 * rate: 0. A priced session with no usage costs $0.00, it is not 'n/a'."
  },
  {
    "id": "CF-18",
    "input": {"tokens": {"inputTokens": 1}, "pricing": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01}},
    "expected": {"cost": 0.000005},
    "note": "1 / 1e6 * 5 = 0.000005: the formula does not round (rounding to cents would give 0)."
  },
  {
    "id": "CF-19",
    "only": "server",
    "input": {"tokens":{"inputTokens":"1000000abc"},"pricing":{"priceIn":5,"priceOut":25,"priceCacheR":0.5,"priceCacheW5m":6.25,"priceCacheW1h":10,"priceWebSearch":0.01}},
    "expected": {"cost":5},
    "note": "Rule 2: parseFloat reads the leading number of '1000000abc', 1,000,000: 1 * 5 = 5. Number() would give NaN, then 0."
  },
  {
    "id": "CF-20",
    "only": "server",
    "input": {"tokens":{"inputTokens":"Infinity","outputTokens":100000},"pricing":{"priceIn":5,"priceOut":25,"priceCacheR":0.5,"priceCacheW5m":6.25,"priceCacheW1h":10,"priceWebSearch":0.01}},
    "expected": {"cost":2.5},
    "note": "Rule 2: 'Infinity' parses to Infinity, which is not finite, so 0; only the output term: 0.1 * 25 = 2.5. A NaN-only check would give Infinity."
  },
  {
    "id": "CF-21",
    "only": "server",
    "input": {"tokens":{"inputTokens":1000000,"outputTokens":100000,"cacheReadTokens":1000000,"webSearchRequests":3},"pricing":{"priceIn":5,"priceOut":"n/a","priceCacheW5m":6.25,"priceCacheW1h":10,"priceWebSearch":null}},
    "expected": {"cost":5},
    "note": "Rule 2 for rates: priceOut 'n/a' is not a number (0), priceCacheR is absent (0), priceWebSearch is null (0). Only the input term: 1 * 5 = 5. Using the rates without the guard gives NaN."
  },
  {
    "id": "CF-22",
    "input": {"tokens":{"cacheReadTokens":1},"pricing":{"priceIn":5,"priceOut":25,"priceCacheR":0.5,"priceCacheW5m":6.25,"priceCacheW1h":10,"priceWebSearch":0.01}},
    "expected": {"cost":5e-7},
    "note": "1 / 1e6 * 0.5 = 0.0000005: seven decimal places, so even rounding to 6 places (0.000001) is wrong."
  }
]
```

## Mutations

- Fast factor `M` instead of `M - 1` (fast tokens billed as extra tokens at 2x) -> CF-06 (15),
  CF-07 (7.5).
- Output fast surcharge dropped -> CF-08 (5).
- 1h cache write priced at the 5m rate -> CF-04 (6.25).
- Web search divided by 1e6 -> CF-09.
- Missing pricing returns `0` instead of `null` -> CF-10.
- `priceIn`/`priceOut` swapped -> CF-01 (25), CF-02 (0.5).
- Cache read priced at `priceIn` -> CF-03 (10); 5m write priced at the 1h rate -> CF-05 (10).
- A row of all-zero rates treated as unpriced (`null`) -> CF-11.
- Any one of the six terms dropped -> CF-14 (e.g. without web search 38.75).
- String columns added without parsing (string concatenation) -> CF-12.
- Neither the `null` check nor the finite check (`parseFloat(null)` is `NaN`) -> CF-13; no finite
  check -> CF-15; `isNaN` instead of the finite check -> CF-20; `Number` instead of `parseFloat` ->
  CF-19; rates used without the guard -> CF-21.
- Missing pricing tested with `=== null` only -> CF-16.
- Rounding the result (to cents or to 4 places) -> CF-18; to 6 places -> CF-22.
- "No usage" reported as `null` -> CF-17.
- The guards themselves do not exist in the twins; they are tested on the server only.

## Where the result is visible

- Repository -> Sessions list: the cost column (`computedCost`, and `totalCost` when no OTEL
  cost wins, see [otel-cost-selection.md](otel-cost-selection.md)).
- Session -> Info and Summary: cost tiles; Analytics and Executive Summary: cost totals.
- API: `computedCost` and `costBreakdown.mainCost` on `GET /api/v1/repositories/:id/sessions`.
