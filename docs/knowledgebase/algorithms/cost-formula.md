---
reviewed: no
reviewer: none
---

# Cost formula: what a session's tokens cost

## Purpose

Turns a session's token counts and one `model_pricing` row into US dollars. Every computed
session cost in the product (sessions list, session Info, Summary, Executive Summary, Analytics,
the delete-time audit row) comes from this one formula, so the same tokens must always cost the
same, and "we cannot price this model" must never look like "$0.00".

Some models (Claude Haiku 5.5) charge more for a call whose prompt is long: their pricing row
carries prompt-length **tiers**. A tier applies to one LLM call at a time, so a session with
per-call token data is priced call by call; without per-call data, or for a model without
tiers, the formula runs once over the session's aggregates at the base rates.

## Code

- Implementation (one, shared by server and client): `packages/pricing/src/cost.ts` in the
  repo-local package `@loghub/pricing` (see [repo-local packages](../repo-local-packages.md)):
  - `computeCostBreakdown` — the total, its seven terms and `tierDelta`, on the per-call or the
    aggregate path, over plain numbers and `CallTokens[]` rows;
  - `pickCallRates` — the tier choice for one call; `promptTokens` — a call's prompt length;
  - `FAST_MODE_MULTIPLIER`.
- Server adapter: `server/src/logs/cost.sql.ts`:
  - `computeSessionCostBreakdown` — the missing-pricing guard, Postgres numerics (strings,
    `null`) to numbers, the columnar `SessionCallTokens` to `CallTokens[]`, then the package's
    `computeCostBreakdown`; its result is stored per session in `session_costs` by
    `server/src/logs/session-cost/session-cost-writer.ts`;
  - `computeSessionCost` — its scalar `cost`.
- Client adapter: `client/src/viewer/lib/format.ts` re-exports `computeCostBreakdown` and
  `FAST_MODE_MULTIPLIER`; `computeCost` is `computeCostBreakdown(...).total`. Per-call data is
  `TokenBreakdown.calls` (`CallTokens[]`).

  The SQL forms live in `server/src/logs/cost.sql.ts`: `sessionCostSql` is the aggregate
  formula at base rates; `callTierRatesSql` + `tieredCallCostSql` are the per-call rule
  (rule 7 for one call: prompt `P`, the last tier with `P > aboveTokens`, web search at
  base) that the OTEL utility-call rollup (`utilityCostsCte`) prices each `otel_api_calls` row
  with. They run only in Postgres, so they are covered by the scenario suite (S-COST-01), not by
  these rows. Which `model_pricing` row applies (the newest one in effect on
  the session's price date, model id without a `-YYYYMMDD` suffix) is decided before this
  formula by `pricingAsOfSql`; it is covered through the cost scenarios and golden sessions.
- Twin (the only one): `hook/.claude/telemetry_tool/post-turn-analysis-worker.js`
  (`computeLocalSessionCost`, with its own `pickCallRates`) — a plain-JS copy, because the hook
  is CommonJS installed into user repos and does not use `@loghub/pricing`. Per-call data is
  `tokens.calls` from `deriveTokenTotals`, tiers are `rates.tiers` from
  `GET /api/v1/model-pricing` (absent from a server too old to send them, which keeps the hook
  on the aggregate path).

  The client and the hook take plain numbers and always a pricing row, so their tests run every
  row except the ones marked `"only": "server"` (missing pricing, DB strings, `null` columns —
  handled by the server adapter, not the package). The hook twin has no
  guard of its own: its caller returns `null` when `GET /api/v1/model-pricing` fails or does
  not list the model, and it relies on that response carrying all six rates. That caller also
  picks the rate row differently from the server: by the exact model id (no `-YYYYMMDD`
  stripping) and at today's rates, not at the session's price date.
- The SQL form `sessionCostSql` does not `COALESCE` the rates (the `model_pricing` rate columns
  are `NOT NULL`) and has no missing-pricing guard of its own; every SQL caller wraps it
  in `CASE WHEN p.model_id IS NOT NULL ...` (see Rules, last paragraph).
- Tests (the server and client ones both run through the package):
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
`tiers` is a list of `{aboveTokens, priceIn, priceOut, priceCacheR, priceCacheW5m,
priceCacheW1h}`, ascending by `aboveTokens`, or `null`/absent/empty for an untiered model. A tier
has no web-search price.

Per-call tokens (`session_call_tokens.calls` on the server, `calls` in the package and the hook): one entry per
deduplicated LLM call with the same seven token counts as the aggregates (no web search). Their
sums equal the aggregates.

Output: the cost in USD, or `null` when there is no pricing row. The server and client also
return the seven terms (`input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`,
`webSearch`, `fastSurcharge`) and `tierDelta` = the cost minus the same tokens priced at the base
rates. The terms already sum to the cost; `tierDelta` is informational and never a summand.

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
6. **Which path.** The **per-call path** applies only when per-call tokens are present **and**
   `tiers` is non-empty. Otherwise (no per-call tokens, or `tiers` `null`/absent/empty) the
   **aggregate path** applies: rules 3-4 once over the aggregates at the base rates, and
   `tierDelta = 0`. For a model without tiers both paths give the same number, so the choice
   never changes an untiered cost.
7. **Per-call path.** For each call `c`:
   - `P = inputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens` (the prompt
     length: all input, including cache reads and writes; output does not count);
   - `r` = the rates of the **last** tier (in ascending order) with `P > aboveTokens` —
     **strictly** greater, so a prompt of exactly `aboveTokens` stays on the lower rates — or
     the base rates when no tier matches. The chosen rates apply to **all** of the call's
     tokens, output and cache included;
   - `cost_c` = rules 3-4 for the call's tokens at `r`, without the web-search term:

     ```
     cost_c = (in  + inFast  * F) / 1e6 * r.priceIn
            + (out + outFast * F) / 1e6 * r.priceOut
            + cr / 1e6 * r.priceCacheR + w5 / 1e6 * r.priceCacheW5m + w1 / 1e6 * r.priceCacheW1h
     ```

   Then `cost = Σ cost_c + webSearchRequests * priceWebSearch` — web search is never tiered and
   always uses the base row's per-request price.
8. `tierDelta = Σ cost_c − Σ (the same call priced at the base rates)`; the web-search term
   cancels out.

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
- Prompt over the tier threshold, cache reads counted in the prompt: CF-23; under it: CF-24;
  exactly at it (strictly greater, so base): CF-25.
- One session mixing a tiered and a base call (per call, not on the aggregates): CF-26.
- Tiers but no per-call tokens (aggregate path at base rates): CF-27; per-call tokens but no
  tiers (aggregate path): CF-28.
- Fast tokens on a tiered call (surcharge at the tier rate): CF-29.
- Web search on a tiered session stays at the base per-request price: CF-30.
- Two tiers, the last matching one wins: CF-31.

## Examples

Every row uses the Opus 5 rates unless it says otherwise: `priceIn 5`, `priceOut 25`,
`priceCacheR 0.5`, `priceCacheW5m 6.25`, `priceCacheW1h 10`, `priceWebSearch 0.01`.

`input.tokens` lists only the non-zero counts; an omitted count is `0`. `input.pricing` is the
rate row, `null` for "no pricing row", or left out (CF-16) for an absent row. `expected.cost` is compared with a tolerance of
`1e-9`; a `null` expected cost must be exactly `null`. Rows marked `"only": "server"` use inputs
the client and the hook never receive (no pricing row, strings, `null` columns).

Rows CF-23 onwards price prompt-length tiers. They use the Claude Haiku 5.5 base rates
`priceIn 0.10`, `priceOut 0.50`, `priceCacheR 0.01`, `priceCacheW5m 0.125`, `priceCacheW1h 0.20`,
`priceWebSearch 0.01` and, in `input.pricing.tiers`, a tier above `100000` of `0.5` / `2.5` /
`0.05` / `0.625` / `1` (CF-31 adds a second one). `input.calls` is the optional per-call list,
one object per call in the same column names as `input.tokens` (without `webSearchRequests`),
an omitted count again `0`; `input.tokens` holds the matching aggregates. The server test turns
the list into the columnar `session_call_tokens.calls` shape, the client into `CallTokens[]`,
the hook into `tokens.calls`. `expected.tierDelta`, when given, is compared (server and client)
with the same tolerance.

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
  },
  {
    "id": "CF-23",
    "input": {"tokens":{"inputTokens":60000,"cacheReadTokens":50000},"calls":[{"inputTokens":60000,"cacheReadTokens":50000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1}]}},
    "expected": {"cost":0.0325,"tierDelta":0.026},
    "note": "Rule 7: P = 60,000 + 50,000 = 110,000 > 100,000, so the tier rates apply to every token: 0.06 * 0.5 = 0.03 plus 0.05 * 0.05 = 0.0025; cost 0.0325. At base rates 0.06 * 0.1 + 0.05 * 0.01 = 0.0065, so tierDelta 0.0325 - 0.0065 = 0.026. Leaving cache reads out of P (60,000, base) gives 0.0065."
  },
  {
    "id": "CF-24",
    "input": {"tokens":{"inputTokens":90000},"calls":[{"inputTokens":90000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1}]}},
    "expected": {"cost":0.009,"tierDelta":0},
    "note": "Rule 7: P = 90,000 is not > 100,000, so base rates: 0.09 * 0.1 = 0.009, tierDelta 0. Applying the tier to every call of a tiered model gives 0.045."
  },
  {
    "id": "CF-25",
    "input": {"tokens":{"inputTokens":100000},"calls":[{"inputTokens":100000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1}]}},
    "expected": {"cost":0.01,"tierDelta":0},
    "note": "Rule 7, boundary: P = 100,000 exactly is not strictly greater than 100,000, so base rates: 0.1 * 0.1 = 0.01. A >= comparison gives 0.05."
  },
  {
    "id": "CF-26",
    "input": {"tokens":{"inputTokens":150000,"cacheReadTokens":50000},"calls":[{"inputTokens":60000,"cacheReadTokens":50000},{"inputTokens":90000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1}]}},
    "expected": {"cost":0.0415,"tierDelta":0.026},
    "note": "Rule 7, per call: call 1 is CF-23 (0.0325, tier), call 2 is CF-24 (0.009, base); 0.0325 + 0.009 = 0.0415. Only call 1 differs from base, tierDelta 0.026. Testing P on the aggregates (200,000 > 100,000) prices everything at the tier: 0.075 + 0.0025 = 0.0775."
  },
  {
    "id": "CF-27",
    "input": {"tokens":{"inputTokens":60000,"cacheReadTokens":50000},"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1}]}},
    "expected": {"cost":0.0065,"tierDelta":0},
    "note": "Rule 6: CF-23's tokens but no per-call list (a session ingested before per-call capture), so the aggregate path at base rates: 0.06 * 0.1 + 0.05 * 0.01 = 0.0065, tierDelta 0. Guessing a tier from the aggregates gives 0.0325."
  },
  {
    "id": "CF-28",
    "input": {"tokens":{"inputTokens":150000,"cacheReadTokens":50000},"calls":[{"inputTokens":60000,"cacheReadTokens":50000},{"inputTokens":90000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":null}},
    "expected": {"cost":0.0155,"tierDelta":0},
    "note": "Rule 6: per-call tokens but tiers null, so the aggregate path: 0.15 * 0.1 + 0.05 * 0.01 = 0.015 + 0.0005 = 0.0155, the same as rules 3-4 on the aggregates. Reading tiers without the null guard crashes."
  },
  {
    "id": "CF-29",
    "input": {"tokens":{"inputTokens":110000,"inputTokensFast":110000,"outputTokens":1000,"outputTokensFast":1000},"calls":[{"inputTokens":110000,"inputTokensFast":110000,"outputTokens":1000,"outputTokensFast":1000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1}]}},
    "expected": {"cost":0.115,"tierDelta":0.092},
    "note": "Rules 3 and 7: P = 110,000 (output is not prompt) > 100,000, tier. in = 110,000 + 110,000 * 1 = 220,000 -> 0.22 * 0.5 = 0.11; out = 1,000 + 1,000 = 2,000 -> 0.002 * 2.5 = 0.005; cost 0.115. Base: 0.22 * 0.1 + 0.002 * 0.5 = 0.023, tierDelta 0.092. A fast surcharge at the base rate gives 0.055 + 0.011 + 0.0025 + 0.0005 = 0.069."
  },
  {
    "id": "CF-30",
    "input": {"tokens":{"inputTokens":60000,"cacheReadTokens":50000,"webSearchRequests":2},"calls":[{"inputTokens":60000,"cacheReadTokens":50000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1}]}},
    "expected": {"cost":0.0525,"tierDelta":0.026},
    "note": "Rule 7: CF-23's call (0.0325) plus web search at the base per-request price, 2 * 0.01 = 0.02; cost 0.0525. tierDelta stays 0.026 (web search is the same on both sides). Dropping web search on the per-call path gives 0.0325."
  },
  {
    "id": "CF-31",
    "input": {"tokens":{"inputTokens":250000},"calls":[{"inputTokens":250000}],"pricing":{"priceIn":0.1,"priceOut":0.5,"priceCacheR":0.01,"priceCacheW5m":0.125,"priceCacheW1h":0.2,"priceWebSearch":0.01,"tiers":[{"aboveTokens":100000,"priceIn":0.5,"priceOut":2.5,"priceCacheR":0.05,"priceCacheW5m":0.625,"priceCacheW1h":1},{"aboveTokens":200000,"priceIn":1,"priceOut":5,"priceCacheR":0.1,"priceCacheW5m":1.25,"priceCacheW1h":2}]}},
    "expected": {"cost":0.25,"tierDelta":0.225},
    "note": "Rule 7: P = 250,000 is above both 100,000 and 200,000; the last matching tier wins: 0.25 * 1 = 0.25. Base 0.25 * 0.1 = 0.025, tierDelta 0.225. Taking the first matching tier gives 0.125."
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
- The guards live only in the server adapter (`cost.sql.ts`), not in the package or the hook;
  they are tested on the server only.
- Cache tokens left out of the prompt length -> CF-23 (0.0065).
- `>=` instead of `>` at the threshold -> CF-25 (0.05).
- Tier chosen from the aggregates instead of per call -> CF-26 (0.0775); tier guessed without
  per-call data -> CF-27 (0.0325).
- `tiers: null` not guarded -> CF-28.
- Fast surcharge priced at the base rate on a tiered call -> CF-29 (0.069).
- Web search dropped on the per-call path -> CF-30 (0.0325).
- First matching tier instead of the last -> CF-31 (0.125).

## Where the result is visible

- Repository -> Sessions list: the cost column (`totalCost` = `computedCost`, the root plus
  sub-agents plus utility calls, or null when any part is unpriced; see
  [otel-cost-selection.md](otel-cost-selection.md)).
- Session -> Info and Summary: cost tiles; Analytics and Executive Summary: cost totals.
- API: `computedCost` and `costBreakdown.mainCost` on `GET /api/v1/repositories/:id/sessions`.
- Stored per session in `session_costs` (`cost`, the seven `cost_*` terms, `cost_tier_delta`).
