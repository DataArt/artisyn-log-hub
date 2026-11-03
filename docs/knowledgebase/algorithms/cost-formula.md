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

Rows (31): [`docs/algorithm-examples/cost-formula.json`](../../algorithm-examples/cost-formula.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
