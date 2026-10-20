---
type: "Reference"
title: "LLM Call Math"
description: "Token counting and cost formulas: TokenBreakdown fields, computeCost, vision tokens, pricing rates, cache cost rules, and display helpers."
tags:
  - tokens
  - cost
timestamp: "2026-07-20T16:37:18+04:00"
---

# LLM Call Math

Reference for all token counting, cost calculation, and related formulas used across the
codebase. Read this before adding any new pricing, token-display, or cost-aggregation logic.

For the bytes→tokens heuristic specifically, see [`token-byte-ratio.md`](token-byte-ratio.md).

---

## 1. Token Breakdown

Every assistant turn reports four token counters from the Claude API, plus the TTL split of the
cache-write counter and the three billing inputs:

| Field | Meaning |
|---|---|
| `input` | Prompt tokens billed at input rate — the **grand total**, fast tokens included |
| `output` | Completion tokens billed at output rate — the **grand total**, fast tokens included |
| `cacheRead` | Tokens served from prompt cache (billed at cache-read rate) |
| `cacheWrite` | Tokens written into the prompt cache — the total of the two TTL buckets below |
| `cacheWrite5m` | The part of `cacheWrite` written with the **5-minute** TTL (billed at 1.25× base) |
| `cacheWrite1h` | The part of `cacheWrite` written with the **1-hour** TTL (billed at 2× base) |
| `webSearchRequests` | `usage.server_tool_use.web_search_requests` — billed **per request**, not per token |
| `inputFast` | **Subset of** `input` billed in fast mode (`usage.speed === 'fast'`) |
| `outputFast` | **Subset of** `output` billed in fast mode |

**Client type:** `TokenBreakdown` in `client/src/viewer/pages/repository/session-log/types.ts`  
**Raw API type:** `TokenUsage` (snake_case field names) — same file, used as the on-wire format;
carries `cache_creation`, `server_tool_use` and `speed`.
**Server twin:** `session_stats`'s `input_tokens` / `output_tokens` / `cache_read_tokens` /
`cache_write_5m_tokens` / `cache_write_1h_tokens` / `web_search_requests` / `input_tokens_fast` /
`output_tokens_fast`, extracted by `extractClaudeStats()` in `claude-extractor.ts`.

All three billing-input fields are **required** `number`s on `TokenBreakdown`, for the same reason the TTL
pair is: an optional field is a field some construction site will forget, and a forgotten field
reads as a genuine zero. Every fold site in `log-parser.ts` — the main-session assistant events, the
sub-agent `toolUseResult.usage` fold and the workflow `session_stats` fold — must populate them.

### Fast mode is a subset, so cost is a surcharge

`inputFast` / `outputFast` are **not** additional tokens: `input` and `output` keep their existing
"everything" semantics, so `fast + standard = input` by construction and nothing that already reads
`input` shifts. Consequently fast mode is priced as a *surcharge on the grand total*:

```
(total − fast)·r + fast·M·r  ≡  (total + fast·(M − 1))·r
```

which at `M = FAST_MODE_MULTIPLIER = 2` is `(total + fast)·r`. Writing it as
`total·r + fast·M·r` would double-bill every fast token. Only input and output are speed-split —
there is no fast-mode cache or web-search rate. `usage.speed` absent or `'standard'` → 0.

### Cache-write TTL split (one rule, both sides)

`cacheWrite5m` / `cacheWrite1h` are **required** `number`s, not optional, so the invariant

```
cacheWrite5m + cacheWrite1h === cacheWrite
```

is structurally guaranteed at every construction site rather than merely asserted in a test.

The bucketing rule is the same client-side and server-side:

- when `usage.cache_creation` is present, take `ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens` from it;
- when `usage.cache_creation` is **absent** (older transcripts), all
  `cache_creation_input_tokens` go to the **5m** bucket.

The same fallback applies to the sub-agent `toolUseResult.usage` fold and the workflow
`session_stats` fold, so the invariant holds at turn, session and aggregate level.

| Side | Where |
|---|---|
| Client | `splitCacheWrite()` in `log-parser.ts`; `TokenUsage.cache_creation` in `types.ts` |
| Server | `splitCacheCreationTokens()` in `claude-extractor.ts`; persisted to `session_stats.cache_write_5m_tokens` / `cache_write_1h_tokens` |

Pricing **is** split by TTL: `model_pricing.price_cache_w_5m` (1.25× base) and
`price_cache_w_1h` (2× base) are priced against the two token buckets separately. The deprecated
flat `price_cache_w` has no readers left. See `db-tables.md` § `model_pricing`.

The **context token count** for a turn is the sum of the input-side fields:

```ts
// log-parser.ts
function sumCtxTokens(usage: TokenUsage | undefined): number | null {
  if (!usage) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}
```

Context tokens do **not** include `output_tokens` — the model hasn't generated those yet when
the input is counted.

**Context window size displayed in UI:** the per-turn "tokens left" figure is the session model's
`model_pricing.context_length` (served as `contextLength` by `GET /api/v1/model-pricing`) minus the
turn's context tokens. A model with no `context_length` falls back to `DEFAULT_MAX_CONTEXT_TOKENS = 200_000`
(`client/src/viewer/pages/repository/session-log/PromptTurnTokenMetrics.tsx`).

---

## 2. Cost Calculation

### The canonical formula (one contract, every surface)

Every cost site — SQL or TypeScript, server or client, turn-level or session-level — computes
exactly this. Do not write a variant; call one of the two implementations below.

```
F = FAST_MODE_MULTIPLIER − 1                       // 1 today

cost = (input  + inputFast  × F) / 1e6 × priceIn
     + (output + outputFast × F) / 1e6 × priceOut
     +  cacheRead               / 1e6 × priceCacheR
     +  cacheWrite5m            / 1e6 × priceCacheW5m
     +  cacheWrite1h            / 1e6 × priceCacheW1h
     +  webSearchRequests             × priceWebSearch      // per REQUEST, not per 1e6
```

Two invariants make the shape non-obvious, and both are load-bearing:

- `cacheWrite5m + cacheWrite1h = cacheWrite`, so the formula must **never** also carry a
  `cacheWrite × priceCacheW` term — that would bill every cache write twice. The deprecated flat
  `price_cache_w` column has no readers left.
- `inputFast` / `outputFast` are subsets, hence the surcharge form (§ 1).

Worked checks: 1 000 000 Opus-5 **1h** cache-write tokens → `1e6/1e6 × 10.00 = $10.00`, not the
`$6.25` a flat cache-write rate would produce. An all-fast Opus-5 turn of N input tokens →
`(N+N)/1e6 × 5 = N/1e6 × 10`, i.e. the $10/$50 fast rate.

**Unpriced models yield `null`, never `0`.** Both implementations return `null` when no
`model_pricing` row matches, and every caller keeps its own guard around the expression (a scalar
`SELECT` wants `NULL`; a rollup `SUM` wants `0.0` for the unpriced member so its priced siblings
still add up). A fake `$0.00` is indistinguishable from a genuinely free session — which is exactly
why `costUnavailableReason: 'unknown-model'` exists on the API rows (§ `api-reference.md`) and why
`NoPricingBadge` replaces the figure in the UI. Derive that flag from the same `model_id IS NULL`
predicate that produced the cost, so the two can never contradict each other.

### Server-side — `server/src/logs/cost.sql.ts` (the single implementation)

This arithmetic lives in one module because hand-copied expressions drift: when it was copied into **eleven** expressions across six files,
a flat cache-write rate survived the TTL token split, since fixing one copy left the others
contradicting it on screen. All eleven now call this module.

| Export | Use |
|---|---|
| `sessionCostSql({ stats, pricing })` | The cost expression as a Drizzle `SQL` fragment, built from two aliases. Returns a bare arithmetic expression — no `CASE`, no outer `COALESCE`, no alias — so it drops into a `SELECT`, a `SUM(...)` or a `GROUP BY` unchanged. Every token column is `COALESCE(…, 0)`-guarded, because a `LEFT JOIN`ed row or an empty CTE yields `NULL` and one `NULL` term nulls the whole sum |
| `pricingColumnsSql()` | The `DISTINCT ON (model_id)` select list for a `model_pricing` lookup — all six rates `::float`-cast, plus `model_id` for the `p.model_id IS NULL` → `pricing_missing` guard. The caller supplies only the `WHERE` / `ORDER BY` |
| `computeSessionCost(tokens, pricing)` | The TypeScript twin, for the sites that roll up in TS rather than SQL. Accepts both raw shapes Postgres produces (`bigint`/`numeric` as strings, `::float` as numbers); `pricing == null` → `null` |
| `FAST_MODE_MULTIPLIER` | `2`. Written in the general `M`-form everywhere, so a future change is one edit here plus one in the client twin |

The `stats` alias must expose `session_stats`' column names (`input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_5m_tokens`, `cache_write_1h_tokens`, `web_search_requests`,
`input_tokens_fast`, `output_tokens_fast`), so the raw-JSONB CTEs in `repositories.controller.ts`
alias their aggregates to exactly those names.

Typical call shape:

```ts
sql`CASE WHEN p.model_id IS NOT NULL
      THEN ${sessionCostSql({ stats: sql`ss`, pricing: sql`p` })}
      ELSE NULL END AS computed_cost`
```

Sites currently routed through it: `repositories.controller.ts` (sessions list, sub-agent rollup,
branches, two timeline expressions), `reports/executive-summary.service.ts` (×2),
`reports/cache-read-ratio.service.ts` (one SQL, one TS rollup), `analytics/active-sessions.service.ts`,
`sessions/sessions.service.ts` (the delete-time audit row). **Adding a twelfth hand-written cost
expression is a review-blocking defect.**

### Two cost sources: computed vs. telemetry

Every session has up to two independent cost figures:

- **Computed cost** — the formula above, over `session_stats`' token columns.
- **Telemetry cost** — `session_stats.telemetry_cost`, micro-USD, denormalized at OTEL
  ingest time from `SUM(logs_otel.cost_usd_micros)` (in the same transaction as the chunk write,
  under a `SELECT ... FOR UPDATE` lock so concurrent chunk uploads can't lose an update — see
  `db-tables.md`'s `logs_otel` section). `NULL` means no telemetry signal: no `claude-otel` chunk
  was ever ingested for the session, or the recomputed sum was exactly 0 (indistinguishable from
  "hasn't seen a billable record yet"). Readers test `IS NOT NULL`, never `<> 0`. Recorded only on
  the **root** session and already covers its whole in-process descendant tree — never add a
  separately-computed sub-agent rollup on top of it for that root.

`otel-cost.sql.ts#otelCostsCte()` is the one CTE that reads `telemetry_cost` (joined on root
session ids only); every one of its callers gets the telemetry side for free: the sessions list,
the session-detail stats route, the executive summary and `active-sessions.service.ts`. No reader anywhere parses `logs.body` or `logs_otel` for
cost — the `otel-summary` JSONB body written to `logs.body` at ingest is write-only redundant
storage, kept only for the OTEL UI-invisibility guarantee (see `db-tables.md`'s `logs` section).

`resolveSessionTotalCost(otelCost, computedCost)` (`otel-cost.sql.ts`) is the **only** place that
picks between the two: it prefers the telemetry cost unless `isOtelCostIncomplete()` judges it too
far below the computed cost to be trustworthy (a truncated exporter stream or out-of-process
sub-agents), in which case the computed cost wins; `otelComputedDiscrepancy()` independently drives
the session-header disagreement warning regardless of which side `resolveSessionTotalCost()` picked.
Both guards read telemetry cost from a plain column (`session_stats.telemetry_cost`), not by parsing JSONB.

### Utility calls (calls no transcript records)

The OTEL exporter meters **every** API call the Claude Code process makes, including side calls
that never appear in any transcript: title generation, summarisation, prompt suggestions, haiku
classifier calls and so on. These are **utility calls**. Before they were priced, the calculated
cost was structurally below the telemetry total for every session with telemetry.

**Storage.** At OTEL ingest `summarizeOtelChunk()` (`otel-chunk.ts`) emits one `OtelApiCall` per
`claude_code.api_request` record, upserted into `otel_api_calls` on `(session_id, call_key)` in
the same transaction as the `logs_otel` row (so re-ingesting a chunk never duplicates calls).
`call_key` is the call's `request_id`, or `<chunkKey>:<1-based line index>` when the record has
none. Columns are named after `session_stats` (`cache_creation_tokens` → `cache_write_5m_tokens`,
because telemetry has no TTL split; `speed='fast'` copies the totals into `input_tokens_fast` /
`output_tokens_fast`), so `sessionCostSql` prices a call row unchanged. The transcript side is
`session_request_ids`: the distinct `requestId` of every `assistant` line, rewritten
(delete-then-insert) by `replaceSessionRequestIds()` in `session-stats-writer.ts` next to each
`upsertSessionStatsRow` call. Both tables are in `db-tables.md`.

**Classification — `request_id` first.** `utilityCostsCte(rootIdsArray)` in `otel-cost.sql.ts`
marks a call row of root R as utility when its `request_id` is NULL or is not in
`session_request_ids` for **any** session of R's `descendant_sessions` tree (depth 0 included).
`query_source` alone cannot decide it: `sdk` is the main thread under `claude -p` but a utility
haiku call in interactive sessions. Only when the whole tree has no `session_request_ids` rows (old
transcripts without `requestId`) does the CTE fall back to `query_source`: a call is utility
unless its source is in `TRANSCRIPT_QUERY_SOURCES` (`repl_main_thread`, `sdk`) or starts with
`TRANSCRIPT_QUERY_SOURCE_PREFIX` (`agent:`). Those values are always bound as SQL parameters.

**Pricing.** Each utility call is priced with `sessionCostSql` at the call's own model, as of the
**root's** price date (below). An unpriced model contributes 0 and sets `utility_pricing_missing`
rather than nulling the session. The CTE yields one row per root that has calls; roots without
telemetry have no row and callers `COALESCE` the utility cost to 0. It needs a
`descendant_sessions` CTE over the same roots earlier in the `WITH`.

### `costBreakdown` vs the unchanged `totalCost`

The sessions list (`GET /repositories/:repoId/sessions`, including `?branch=`) sends a
non-optional `costBreakdown` per session (`CostBreakdown` in `otel-cost.sql.ts`, mirrored in
`client/src/models/repositories.ts`):

| Field | Meaning |
|---|---|
| `mainCost` | Root session's own computed cost; `null` when the main model is unpriced |
| `subagentCost` | Computed rollup of the descendant tree (0 without sub-agents) |
| `utilityCost` | `utilityCostsCte` total (0 without telemetry) |
| `calculatedCost` | `mainCost + subagentCost + utilityCost`, summed in TS; `null` when `mainCost` is |
| `telemetryCost` | The root's `session_stats.telemetry_cost` in USD; `null` without telemetry |
| `mismatch` | `costMismatch(telemetryCost, calculatedCost)` |
| `utilityPricingMissing` | At least one utility call's model has no price |

`computedCost` is now this utility-inclusive `calculatedCost`, and both
`resolveSessionTotalCost()` and `otelComputedDiscrepancy()` receive it, so the 50% incompleteness
guard and the 33% header flag compare like with like. **`totalCost` keeps its meaning**
(telemetry preferred, computed as fallback): about thirty client analytics/report consumers and
the server reports read it, and changing it would make them disagree. Only the surfaces that
explain cost (Summary tile, list cell and its popover, Info tab) render `costBreakdown`, through
the client `CostReconciliation` component. Per-turn and Call Tree costs stay client-calculated.

**Mismatch tolerance.** `costMismatch()` is `true` only when both sides are non-null and
`|calculated − telemetry|` reaches **both** `COST_MISMATCH_TOLERANCE_USD` (`0.05`) and
`COST_MISMATCH_TOLERANCE_RATIO` (`0.01`) × telemetry. The 1% part absorbs the known utility-call
residual: OTEL reports only a total `cache_creation_tokens`, so utility calls are priced at the
5m write rate even when part of the write was 1h (cents per session). It is independent of the
relative `OTEL_DISCREPANCY_THRESHOLD` flag and is exposed only as `costBreakdown.mismatch`.

The branches route's per-branch `total_cost` deliberately does **not** add utility calls — it is
an aggregate report surface like the other `totalCost` readers; it only moved to the session
price date.

### Price date — `sessionPriceDateSql` / `pricingAsOfSql`

A session is priced at the rates in force **when it ran**, not today's, so a newer
`model_pricing` row never changes a historical cost. Two helpers in `cost.sql.ts`:

- `sessionPriceDateSql(sessionRowIdExpr)` — the UTC date of the session's earliest
  `logs.start_time`, falling back to `CURRENT_DATE` when it has no timed log yet.
- `pricingAsOfSql(modelExpr, dateExpr)` — the body of a `LEFT JOIN LATERAL`: `pricingColumnsSql()`
  over `model_pricing` with `effective_from <= dateExpr`, matched on the model id with the
  `-[0-9]{8}$` suffix stripped. The caller supplies the parentheses, alias and `ON true`.

Sub-agents and utility calls use the **root's** date. Every session-cost site uses them: the
sessions list, sub-agent rollup, branches and timeline expressions in `repositories.controller.ts`,
`sessions.service.ts`, `active-sessions.service.ts`, `attribution-breakdown.service.ts`,
`cache-read-ratio.service.ts`, `executive-summary.service.ts` and
`turn-end-cost-advisor.service.ts`. `model-pricing-store.ts` and `unpriced-model-registry.ts`
keep `CURRENT_DATE` on purpose: they ask whether a model is priced **now**.

The client matches it: `GET /api/v1/model-pricing?asOf=YYYY-MM-DD` filters
`effective_from <= asOf`, and `RepositoryView.tsx` passes the first 10 characters of the selected
session's ISO-UTC `startTime` (the same UTC date `sessionPriceDateSql` computes). With no
`startTime`, `asOf` is omitted, which means today on both sides.

### Client-side (`computeCost`)

`client/src/viewer/lib/format.ts` — the client twin of `computeSessionCost`, prices individual turns
from the transcript instead of sessions from `session_stats`, and exports its own
`FAST_MODE_MULTIPLIER`. Same formula, same rates, same result for the same tokens; any change to one
must be mirrored in the other.

```ts
export function computeCost(breakdown: TokenBreakdown, pricing: ModelPricingEntry): number;
```

Token rates are in **USD per million tokens**; `priceWebSearch` is USD **per request**.
`ModelPricingEntry` fields:

| Field | Meaning |
|---|---|
| `priceIn` | Input tokens (fast input bills at `FAST_MODE_MULTIPLIER ×` this) |
| `priceOut` | Output tokens (likewise) |
| `priceCacheR` | Cache-read tokens |
| `priceCacheW5m` | 5-minute-TTL cache-write tokens |
| `priceCacheW1h` | 1-hour-TTL cache-write tokens |
| `priceWebSearch` | Per web-search **request** |

`ModelPricingMap = Record<string, ModelPricingEntry>` — keyed by model ID string.  
Types live in `client/src/models/pricing.ts`. There is no second client-side pricing module and no
hardcoded rate on the client: the web-search rate, like every other rate, comes from
`model_pricing.price_web_search`.

### Call-tree variant

`client/src/viewer/pages/repository/session-log/call-tree/cost-utils.ts` has two helpers:

- `computeLeafCost(tokens, pricingType, model, pricing)` — cost for a single token counter. The
  `pricingType` union is `'input' | 'output' | 'cache-write-5m' | 'cache-write-1h' | 'cache-read'`
  (there is no single `'cache-write'` member).
- `computeActualCost(breakdown, model, pricing)` — same formula but accepts a full breakdown
  object; returns `null` when model/pricing is unavailable.

---

## 3. Pricing Rates

**All rates live only in the `model_pricing` database table.** There are no hardcoded rates
in server or client source code. Do not add them; add a migration instead, or let the runtime
writers below set them. This is why the $0.01 web-search price is a **column** (`price_web_search`)
and not a TS constant: an unpriced model must yield no web-search cost through exactly the same path
as its token cost.

The one number that is *not* a rate and therefore lives in source is `FAST_MODE_MULTIPLIER` — a
dimensionless multiple of a stored rate, not a price. See "Fast rates are derived" below.

### DB table

`server/src/database/schema/index.ts` — `model_pricing`:

| Column | Type | Meaning |
|---|---|---|
| `model_id` | `varchar` PK part 1 | Claude model ID string |
| `price_in` | `numeric(10,6)` | USD per million input tokens |
| `price_out` | `numeric(10,6)` | USD per million output tokens |
| `price_cache_r` | `numeric(10,6)` | USD per million cache-read tokens |
| `price_cache_w` | `numeric(10,6)` | **Deprecated, no readers left.** The old flat cache-write rate; kept, not dropped |
| `price_cache_w_5m` | `numeric(10,6)` | USD per million **5-minute**-TTL cache-write tokens (1.25× `price_in`) |
| `price_cache_w_1h` | `numeric(10,6)` | USD per million **1-hour**-TTL cache-write tokens (2× `price_in` = 1.6× the 5m rate) |
| `price_web_search` | `numeric(10,6)` | USD **per web-search request** — not per million anything. `0.01` for first-party Claude rows, `0` for third-party rows, which offer no server tools |
| `currency` | `varchar(3)` | Always `'USD'` |
| `effective_from` | `date` PK part 2 | Session cost uses `effective_from <= <session price date> ORDER BY effective_from DESC` (`pricingAsOfSql`, § 2) to get the rate in force when the session ran; "is it priced now" checks use `CURRENT_DATE`. Selecting by `model_id` alone can pick a future-dated row and overcharge |
| `source` | `varchar(16)` | Origin of the price version (migration `0066`): `anthropic` / `openrouter` / `manual` / `override`. **Cost math never reads it.** It exists for the admin tab and the runtime writers |

**Where rates come from.** Rows are seeded by migrations. Since migration `0066` they are also
written at runtime by `server/src/model-pricing/`:
- the **daily Anthropic fetch** of the official pricing page (`source = 'anthropic'`)
- the admin **OpenRouter import**, which covers non-Anthropic models only (`'openrouter'`)
- admin **set price** on an unpriced/manual model (`'manual'`)
- admin **override** of a fetched price (`'override'`)

Runtime writers only ever upsert a row dated **today**, so rows already in force for past days, and
therefore historical session costs, never change. A model seen in telemetry without a price gets a
`model_pricing_meta` row but **no** `model_pricing` row, so its cost stays null (`unknown-model`),
never $0. See [model-pricing-research.md](model-pricing-research.md) § Live price sync.

Join on the **normalised** model id — `REGEXP_REPLACE(model, '-[0-9]{8}$', '')` — so a dated id like
`claude-opus-5-20260714` resolves to its undated pricing row. `pricingColumnsSql()` (§ 2) emits the
correct `DISTINCT ON` shape; use it rather than hand-writing the lookup.

**Fast rates are derived, not stored.** There is deliberately no `price_in_fast` / `price_out_fast`
column: fast mode bills at `FAST_MODE_MULTIPLIER = 2` × the standard rate, and two stored rates could
drift apart while a multiplier cannot. It is exported from `server/src/logs/cost.sql.ts` and
`client/src/viewer/lib/format.ts`, and both call sites write the general `M`-form.

### Seeding / updating rates

Add a migration in `server/drizzle/migrations/` that inserts or updates rows in
`model_pricing`. See `server.md` for the migration naming convention. (For a current price change
on an Anthropic model, the daily fetch normally lands it by itself, and an admin can set or
override a price from the Model Pricing tab.)

- **Set `source` explicitly** (`'anthropic'` for Claude rows, `'openrouter'` for provider-prefixed
  third-party rows, `'manual'` otherwise). The column default `'manual'` would mislabel a fetched
  model in the admin tab.

- Inserts must use `ON CONFLICT (model_id, effective_from)` — the PK was widened in `0034` and
  `ON CONFLICT (model_id)` no longer matches a constraint.
- **Populate `price_cache_w_5m`, `price_cache_w_1h` and `price_web_search` explicitly on every new
  row.** Their `DEFAULT 0` exists only so `0051` could add the columns without a table rewrite; a new
  Claude row left on the defaults silently prices 1h cache writes and web searches at zero, which
  reads as a real cost rather than as missing data.

### Client access

`GET /api/v1/model-pricing` (`server/src/logs/model-pricing.controller.ts`) returns the
latest effective rate for every model as a `ModelPricingMap`. An optional `asOf=YYYY-MM-DD`
(anything else → 400) returns the rates in force on that date instead; without it the behaviour
is today's, so the hook is unaffected. The client fetches it via `useModelPricing(asOf?)`
(`client/src/viewer/hooks/useModelPricing.ts`, query key `['model-pricing', asOf ?? null]`), with
`asOf` set to the selected session's UTC start date (§ 2 "Price date"). Its response
carries `priceCacheW5m` / `priceCacheW1h` / `priceWebSearch`; the flat `priceCacheW` is not
returned and there is no compatibility shim, since the endpoint is internal and client and server ship together.

---

## 4. Vision / Image Token Estimation

`client/src/viewer/pages/repository/session-log/log-parser.ts`

```ts
function estimateImageInputTokens(width: number, height: number): number {
  // Scale down to fit within Claude's max image dimension (1568 px per side)
  let w = width, h = height;
  const maxEdge = Math.max(w, h);
  if (maxEdge > 1568) {
    const scale = 1568 / maxEdge;
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }
  // Claude's published vision formula
  return Math.round((w * h) / 750 + 1024);
}
```

- **Max dimension:** 1568 × 1568 (images larger on any side are scaled down proportionally).
- **Formula:** `(w × h) / 750 + 1024` — the `+1024` is a fixed base cost.
- PNG dimensions are extracted from the base64 header via `parsePngDimensions` in the same
  file. Non-PNG images fall back to `bytes`-based estimation using `BYTES_PER_TOKEN`.

---

## 5. Byte-Based Token Estimates

Used only when the API does not report actual token counts (file reads, skills, rules, etc.).  
See [`token-byte-ratio.md`](token-byte-ratio.md) for the value, rationale, and full usage list.

```ts
estTokens = Math.round(bytes / BYTES_PER_TOKEN);
```

**Never apply this to API-reported usage fields** (`input_tokens`, `output_tokens`, etc.) — those
are exact and should be used directly.

### Fixed overhead estimates

| Context element | Estimate | Source |
|---|---|---|
| Each deferred MCP tool definition | 150 tokens | `context-data.ts` |
| Conversation history (prior turns) | Derived from prior `output_tokens` | `context-data.ts` |

---

## 6. Sub-agent Token Aggregation

`extractSubagentStats(logs)` in `log-parser.ts` sums `TokenBreakdown` fields across all
`type=assistant` entries in a sub-agent log array, and also extracts the model ID (stripping
the `YYYYMMDD` date suffix). Called once per sub-agent node.

`PromptTurnItem`'s displayed per-turn "+$subagent" addend is **not** a single call to
`extractSubagentStats` per activation — it sums the full descendant subtree. Since Claude Code
agents can spawn further agents (3+ levels of nesting) and typically run in the background
(their completion can arrive after the parent's own transcript has already stopped recording),
the descendant set for each turn-level `agentActivation` is found via
`collectDescendantAgentIdsFromParentMap` — a walk over the DB-authoritative
`sessions.parent_session_id` chain (exposed per sub-agent by the `/logs` endpoint), not transcript
content. Two additional transcript-based sources (`collectDescendantAgentIds`, and the
agent_progress-derived `SubAgentNode` subtree) are unioned in as defensive fallbacks, but manual
verification against real data showed they rarely find anything beyond depth 1 on their own.
`extractSubagentStats` is then called once per id in the union (each priced independently at its
own model's rate) and summed. Summing only the directly activated agent's own tokens would ignore
every nested child it spawned, and the per-turn costs would then add up to less than the session
total.

The opposite error is guarded too. The per-turn "main" `tokenBreakdown`'s `session_stats` fallback
fold in `log-parser.ts` (used when a sub-agent completion has null inline `usage`) is gated on
membership in a `Set` built from `workflows[].agentSessionIds`, so only confirmed workflow-spawned
agents can fall back to `session_stats` in "main". Any other agent with null usage is counted exactly
once, via `subagentCost`. Without that gate a directly activated, non-workflow agent would be folded
into "main" *and* priced again via the `subagentCost` union above, counting it twice in the displayed
`main + subagents = total` line.

---

## 7. Display Helpers

| Function | Location | Output example |
|---|---|---|
| `formatTokens(n)` | `client/src/viewer/lib/format.ts` | `1.5K`, `2.3M` |
| `formatCompact(n)` | `log-parser.ts` (exported) | `1.5K`, `2.3M` (same logic) |
| `formatCost(v)` | `client/src/viewer/lib/format.ts` | `$0.0042` |
| `formatCostShare(share)` | `call-tree/cost-utils.ts` | `3.7%`, `<0.1%` |
| `formatCacheReadRatio(r)` | `client/src/viewer/lib/format.ts` | `93.0%`, `n/a` when `r` is `null` |

`formatTokens` and `formatCompact` are functionally identical. `formatTokens` is used in
general metric displays; `formatCompact` is used inside the session-log subsystem where
`log-parser.ts` is already imported.

---

## 8. Cache Read Ratio

"Of all the cache traffic this scope produced, how much was a cheap **read** rather than an
expensive **write**?"

```
cacheReadRatio = cacheRead / (cacheRead + cacheWrite)
```

The denominator is cache read **+ cache write** — *not* `input + cacheRead`. The pre-existing
`cacheHitRate` in `session-info-derive.ts` is that other metric; it is unrelated, it still exists,
and it is now labelled **"Cached input share"** in the UI to keep the two apart.

### The two non-negotiable rules

1. **Zero denominator is `null`, never `0`.** A scope that produced no cache traffic at all has
   no ratio; it renders as `n/a` and is excluded from every average. Folding it in as `0 %` drags
   every aggregate down. Under ratio-of-sums such a session contributes `0` to both sums, so it is
   inherently excluded — it is still *counted*, and surfaced as the report KPI row
   "Sessions with undefined ratio (excluded)".
2. **Aggregates are ratio-of-sums**, never a mean of per-session ratios:
   `SUM(read) / (SUM(read) + SUM(write))` over the scope. One tiny session at 0.20 plus one large
   session at 0.95 must come out near 0.95, not at their unweighted mean of ≈0.575.

### One definition per side

| Side | Location | Exports |
|---|---|---|
| Client | `client/src/viewer/lib/format.ts` | `cacheReadRatio(cacheRead, cacheWrite): number \| null`, `formatCacheReadRatio(r): string` |
| Server | `server/src/logs/cache-ratio.sql.ts` | `cacheReadRatioSql(readExpr, writeExpr): SQL` (→ `CASE WHEN read + write > 0 THEN read::float / (read + write)::float ELSE NULL END`), plus the identical TS `cacheReadRatio()` for aggregates computed in TS |

`cacheReadRatioSql` embeds each expression twice, so both must be side-effect-free (plain columns
or `SUM(...)`/`COALESCE(...)` over them — never a volatile function).

Do not re-derive the formula anywhere else; both twins carry a "keep in sync" note pointing at
each other.

### Where each value comes from

| Level | Source | Notes |
|---|---|---|
| Per turn | `PromptTurn.ownTokenBreakdown` (client) | **Main-session assistant events only** — no sub-agent `toolUseResult.usage` fold and no workflow `session_stats` fold, so the chip measures the turn's own cache behaviour. `turn.tokenBreakdown` still carries both folds and is unchanged. See `session-log-view.md`. |
| Per session | `parsedLogs.summary.tokenBreakdown` (client) | Computed client-side, not in SQL — the Session Info row must match what the parsed log shows. |
| Aggregates | SQL / TS ratio-of-sums | Analytics computes it client-side over the timeline rows; the report computes it server-side in `reports/cache-read-ratio.service.ts`. |

### The root / descendant scope pair

Every **aggregate** is reported twice, side by side — never as a single blended number:

- **root only** — the root session's own `session_stats` tokens;
- **root + descendants** — the root plus *every recursive descendant* sub-agent, resolved via
  `descendantSessionsCte` (`server/src/logs/session-tree.sql.ts`) with `depth > 0`.

A single-level `parent_session_id` match is wrong here: agents spawn agents 3+ levels deep (see
§6 and `db-tables.md` § `sessions`). Per-turn values have no pair.

The one deliberate asymmetry is the report's **cause decomposition**, which is root-only — see
`db-tables.md` § `session_cause_stats`.

### Cause decomposition (why was cache creation high?)

A turn whose own cache-creation tokens reach the repo's `highCacheCreationThreshold` is attributed
to one cause; everything else lands in `unattributed`:

| Cause | Rule |
|---|---|
| `compaction` | A `system` event with `subtype === 'compact_boundary'` sits at, or immediately before, the turn's boundary |
| `fileReread` | The turn reads a path already read earlier in the same session (session-level `seenPaths` set) |
| `unattributed` | Everything else — sub-threshold turns, and cache-creation tokens on assistant events belonging to no turn |

A turn matching both rules is attributed to **compaction**. The walk itself
(`server/src/logs/turn-walk.ts`'s `walkTurns`) is threshold-free; `classifyTurnCauses(turns,
threshold)` applies the threshold, so the same walk output can be re-classified per config scope
without re-parsing the log.

**Bucketing invariant:** `compaction + fileReread + unattributed === session_stats.cache_write_tokens`
for the same session.

The threshold itself is `RepoConfigJson.highCacheCreationThreshold`, resolved
user-scoped row → team-scoped row → `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD` (25 000, calibrated
against real logs — see the constant's own comment in `cache-ratio.sql.ts`).
