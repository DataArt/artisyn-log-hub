# Implementation Plan: Fix Anthropic Pricing Fetch and Add Prompt-Length Tiered Pricing

## TL;DR

- **DB (migration `0074_pricing_tiers_session_costs.sql`):**
  - New nullable `jsonb` columns `model_pricing.tiers` and `model_pricing_meta.override_base_tiers`.
  - New 1:1 tables `session_call_tokens` (per-call token arrays) and `session_costs` (each session's stored cost and its breakdown).
  - A one-off SQL backfill fills `session_costs` for every existing `session_stats` row using today's formula.
- **New server module `server/src/logs/session-cost/`:**
  - `session-cost-writer.ts` exports `recomputeSessionCosts` and `drainStaleSessionCosts`.
  - `SessionCostRecomputeService` runs a background sweep of rows flagged `stale`, configured by the new env vars `SESSION_COST_RECOMPUTE_INTERVAL_MS` and `SESSION_COST_RECOMPUTE_INLINE`.
  - Pricing writes reach it through a new `server/src/model-pricing/session-cost-invalidation.ts` (`markModelSessionsStale`, `notifySessionCostsStale`), so `model-pricing/` never imports `logs/`.
- **Cost formula:** cost becomes per LLM call with prompt-length tiers (Design Decision 2). It is implemented in three twins that must agree: server `computeSessionCostBreakdown` in `cost.sql.ts`, client `computeCostBreakdown` in `format.ts`, and the hook's `computeLocalSessionCost`.
- **Server cost readers:**
  - Every session-cost reader switches from inline `sessionCostSql` to `session_costs`: sessions list, session stats, timeline, executive summary, attribution, cache-read-ratio, active sessions, turn-end advisor and the delete audit row.
  - The sessions-list fallback to raw-JSONB tokens is removed.
  - `sessionCostSql` stays only in the OTEL `utilityCostsCte`.
  - Soft-delete purge also clears `session_call_tokens` and `session_costs`.
- **API (additive, backward compatible):**
  - `GET /api/v1/model-pricing` gains an optional `tiers` field.
  - In the admin list, `effective.tiers` and `base.tiers` are added.
  - `PUT /api/v1/admin/model-pricing/price` and `/override` accept an optional `tiers`; omitting it keeps the current tiers. Invalid tiers return 400.
- **Fetch fix:** the parser accepts `$N USD per 1,000 searches`, and merges each `(for prompts up to/over N tokens)` row pair into one model with tiers.
- **Hook:** version bump to `2.25.0`. The hook prices per call when the server sends `tiers`; old hooks ignore the field.
- **Admin UI:** a new `PricingTiersEditor.tsx` in the price/override dialog, and a tier suffix in the model table.
- **Session-view cost tooltip:** gains a muted long-context tier note.
- **Client parser:** `log-parser.ts` now records per-call tokens (`TokenBreakdown.calls`), so the client prices tiered sessions per call.

## Reference

- Requirements: [requirements.md](D:/_work/Artisyn-LogHub/_repo/docs/tasks/todo/2026-10-26-pricing-fetch-tiered/requirements.md)
- Research archive: `research/findings-1.md` (audit only)

## Design Decisions

**DD1 — Tier shape and validation.**
- `PricingTier` is `{ aboveTokens: number; priceIn; priceOut; priceCacheR; priceCacheW5m; priceCacheW1h }`, with every rate in USD/MTok.
- `tiers` is `PricingTier[] | null`, sorted ascending by `aboveTokens`. An empty array is stored as `NULL`.
- One shared validator, `validatePricingTiers(tiers): string | null` in `model-pricing-rates.ts`, returns an error text or `null`. It is used by the admin service and the parser. It checks that:
  - there are at most `MAX_PRICING_TIERS = 10` tiers;
  - `aboveTokens` is an integer between 1 and `MAX_TIER_THRESHOLD = 100_000_000`, and strictly increasing;
  - all 5 rates are present and pass `isValidRate` (0 to `MAX_RATE`).
- A tier carries no web-search price; web search always uses the base rate.

**DD2 — Per-call formula, the contract shared by all three twins.**
For each call `c`:
1. `P = input + cacheRead + cacheWrite5m + cacheWrite1h`.
2. `r` = the rates of the last tier with `P > aboveTokens` (strictly greater), or the base rates if no tier matches.
3. With `F = FAST_MODE_MULTIPLIER − 1`:
   `cost_c = (in + inFast·F)/1e6·r.in + (out + outFast·F)/1e6·r.out + cr/1e6·r.cr + w5/1e6·r.w5 + w1/1e6·r.w1`.
4. Session cost = `Σ cost_c + webSearchRequests · base.priceWebSearch`.

When to use which path:
- **Per-call path:** only when per-call data exists **and** `tiers` is non-empty.
- **Aggregate path:** otherwise, the existing aggregate formula at base rates.
- Both paths give the same number for a model without tiers.

Breakdown terms (per call, at the chosen rates):
- `input` = `Σ in·r.in/1e6`
- `output` = `Σ out·r.out/1e6`
- `cacheRead`, `cacheWrite5m`, `cacheWrite1h`
- `webSearch`
- `fastSurcharge` = `Σ (inFast·F·r.in + outFast·F·r.out)/1e6`
- `tierDelta` = total − the same tokens priced at base rates. It is informational only: the seven terms above, at the chosen rates, already sum to the total, so no display ever adds `tierDelta` as a summand.

**DD3 — Per-call key.**
- One call is one deduplicated usage entry in `extractClaudeStats`'s `lastUsageByMessageId`, keyed by `message.id` with a fallback to `uuid`. The client and the hook use the same key.
- This deliberately replaces the requirement's "one entry per `requestId`" wording. It is the only key whose per-call sums equal the `session_stats` totals exactly.
- The array order is the Map's first-seen order.

**DD4 — `session_call_tokens.calls` shape.**
- A columnar object with the keys `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens`, `inputTokensFast` and `outputTokensFast`. Each value is a `number[]`.
- A missing key reads as all zeros.
- `replaceSessionCallTokens` throws when the array lengths differ.
- A session with zero calls stores the row with empty arrays.

**DD5 — `session_costs` shape.**

| Column | Content |
|---|---|
| `session_id` | PK, FK to `sessions.id`, `ON DELETE CASCADE` |
| `model_id` | `session_stats.model` with any `-YYYYMMDD` suffix stripped; nullable |
| `price_date` | `date`, not null |
| `pricing_effective_from`, `pricing_source` | The resolved `model_pricing` row's date and source (`varchar(16)`); NULL when unpriced |
| `cost` | `double precision`; NULL means unpriced |
| `cost_input`, `cost_output`, `cost_cache_read`, `cost_cache_write_5m`, `cost_cache_write_1h`, `cost_web_search`, `cost_fast_surcharge`, `cost_tier_delta` | `double precision`; all NULL when unpriced |
| `unavailable_reason` | `varchar(32)`: `'unknown-model'` or NULL |
| `stale` | `boolean not null default false` |
| `computed_at` | `timestamptz not null default now()` |

Indexes:
- a partial index `idx_session_costs_stale ON (session_id) WHERE stale`;
- `idx_session_costs_model_date ON (model_id, price_date)`.

**DD6 — Price date.**
- A session is priced at its **top ancestor's** price date: `sessionPriceDateSql` of the session reached by walking `parent_session_id` to the top, depth ≤ 50, the same join as `descendantSessionsCte`. A top-level session uses its own date.
- This matches today's readers, which price descendants at the root's date.
- It differs only for a sub-agent viewed on its own whose date falls on the other side of a price-version boundary. That case is accepted.

**DD7 — Recompute triggers.**
- **Ingest:** every `session_stats` upsert path (upload `logs.service.ts:422`, import merge `logs.service.ts:1029`, recompute-all `repositories.service.ts:1432`) calls `replaceSessionCallTokens` and then `recomputeSessionCosts(tx, [id])` synchronously in the same transaction.
- **Tree:** when a recompute creates a session's row or changes its `price_date`, all of that session's descendants are marked `stale`.
- **Pricing:**
  - `writeEffectivePrices` calls `markModelSessionsStale(tx, modelId, effectiveFrom)` for every model it actually wrote, inside the pricing transaction. That function is the single writer for fetch, OpenRouter import, set price, override and clear.
  - The predicate is `model_id = M AND price_date >= E`, and no `model_pricing` row of M has `effective_from` in `(E, price_date]`.
  - `setOverrideBase` alone marks nothing.

**DD8 — Sweeper.**
- `SessionCostRecomputeService` lives in `LogsModule`. It ticks every `SESSION_COST_RECOMPUTE_INTERVAL_MS` (default `10000`), and also on `notifySessionCostsStale()`, an in-process `EventEmitter` signal.
- `drainStaleSessionCosts(db)` loops over batches of `SESSION_COST_RECOMPUTE_BATCH = 500`. Each batch runs `SELECT session_id … WHERE stale ORDER BY session_id LIMIT 500 FOR UPDATE SKIP LOCKED` in its own transaction, recomputes the rows and writes `stale = false`. This makes it safe across a cluster.
- Module boundary: `model-pricing/` must not import from `logs/`. So `markModelSessionsStale` and the signal live in a new `server/src/model-pricing/session-cost-invalidation.ts`, which only does raw SQL on `session_costs` and has no `logs/` imports. That file exports:
  - `markModelSessionsStale(db, modelId, effectiveFrom)`;
  - `registerSessionCostDrainHandler(fn)`;
  - `notifySessionCostsStale(): Promise<void>`.
- `SessionCostRecomputeService` registers `() => drainStaleSessionCosts(db)` as the handler when the module initializes.
- After their transaction commits, the pricing writers (admin, fetch, import) call `await notifySessionCostsStale()`. That call:
  - awaits the handler when `SESSION_COST_RECOMPUTE_INLINE=true` (contract stand);
  - otherwise starts the handler without awaiting it;
  - does nothing when no handler is registered.

**DD9 — Backfill.**
- Migration 0074 inserts one `session_costs` row per `session_stats` row using an **inline frozen copy** of today's `sessionCostSql` arithmetic: base rates, aggregates, the top-ancestor price date, and the `pricingAsOfSql` lookup rule.
- This keeps the AC4c numbers identical. A migration is immutable history, so the copy is not a second live implementation.
- Tier delta is 0. There are no per-call rows (FR5b).

**DD10 — Reader rules.**
- Own cost is `sc.cost`, and `pricing_missing` is `sc.cost IS NULL`. A missing `session_costs` row counts as unpriced.
- The sub-agent rollup is `COALESCE(SUM(sc.cost), 0.0)`, keeping the existing `EXISTS(claude/claude-subagent log)` guard.
- The sessions list keeps its JSONB `model` column for display, but drops the JSONB token fallback for cost.
- `session_stats` rows created only by the OTEL writers (`upsertSessionTelemetryCost`, `upsertSessionClaudeVersionOtel`, `upsertSessionChangeSurfaceCounters`) get no `session_costs` row from ingest. These rows have a NULL `model`, so today's lookup already reports them as unpriced, and "a missing row counts as unpriced" keeps that result. The backfill still writes their rows.
- Soft-deleted sessions: `SessionsService.purgeSessionChildData` (`sessions.service.ts:179`) also deletes their `session_call_tokens` and `session_costs` rows.
- Accepted change: a pure Task-orchestrator root, whose `ss.model` falls back to the sidechain model, now gets a computed cost of `0 + sub-agents + utility` instead of NULL. The dev DB has 0 transcript sessions without `session_stats`, checked on 2026-10-26.

**DD11 — OTEL.**
- `utilityCostsCte` / `otelCostsCte` and `session_stats.telemetry_cost` are unchanged.
- Utility calls are not tiered.
- `sessionCostSql` survives only for `utilityCostsCte`; its doc comment says so.

**DD12 — API field rules.**
- **Public `GET /api/v1/model-pricing`:** emits `tiers` only when it is non-NULL, so old consumers see byte-identical entries for untiered models.
- **Admin list:** always emits `tiers` (array or `null`) in `effective` and `base`.
- **`PUT /price` and `/override`:**
  - an omitted `tiers` carries over the current effective row's tiers (the same rule as `charsPerToken`);
  - `null` or `[]` clears them;
  - invalid tiers give 400 `BadRequestException` with the `validatePricingTiers` text.

**DD13 — Parser rules.**
- `parseWebSearchPrice` uses the regex `/\$([\d,]*\.?\d+)(?:\s+USD)? per 1,000 searches/`.
- `toModelId` returns `{ id, bound: { kind: 'upTo' | 'over', tokens } | null }` from a trailing `(for prompts up to N tokens)` / `(for prompts over N tokens)`. This is case-insensitive, and commas in N are allowed.
- Merging rows:
  - a plain or `upTo N` row sets the base rates, and the first base row wins;
  - an `over N` row adds a tier `{ aboveTokens: N }`.
- The whole parse fails (returns `null`) when:
  - an `over` row has no base row;
  - an `over N` row follows an `upTo M` row with M ≠ N;
  - an `over` threshold is duplicated;
  - the tiers fail `validatePricingTiers`.
- `MIN_PARSED_MODELS` counts merged models.
- `carryForward` keeps the page's `tiers`; it does not carry them from the current row.

**DD14 — Client.**
- `TokenBreakdown` gains optional `calls?: CallTokens[]`, where `CallTokens` is `{ input, output, cacheRead, cacheWrite5m, cacheWrite1h, inputFast, outputFast }`.
- `log-parser.ts` pushes one entry per deduplicated assistant usage, and per sub-agent `toolUseResult.usage`, which is priced as one call. Merged breakdowns concatenate `calls`.
- `computeCost(breakdown, pricing)` keeps its signature and delegates to `computeCostBreakdown`, which follows the DD2 path rules.

**DD15 — Hook.**
- `deriveTokenTotals` adds `calls` (row-wise `{inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, inputTokensFast, outputTokensFast}`).
- `computeLocalSessionCost(tokens, rates)` uses the per-call path when `tokens.calls` and a non-empty `rates.tiers` are present, and the old aggregate path otherwise. This works against old servers.

**DD16 — Fetch under override (AC6).**
- The existing override branch already writes only the meta base, so once the store maps tiers it refreshes `override_base_tiers` and never touches the override row's tiers.
- `clearOverride` restores the base's tiers.

**DD17 — Verification outside automated tests.**
- AC6 and AC8 are manual checks on local prod: the fetch reaches the network, which is disabled in both stands.
- AC4c is a one-off SQL comparison on the dev DB after migrating (Chunk 1).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0074_pricing_tiers_session_costs.sql` | new migration | DDL + backfill, DD5/DD9 |
| `server/drizzle/migrations/meta/_journal.json` | register 0074 | idx 74, `when` 1790899200000 |
| `server/src/database/schema/index.ts` | `tiers`, `overrideBaseTiers`, `sessionCallTokens`, `sessionCosts` | template `sessionRequestIds` :387 |
| `server/src/model-pricing/model-pricing.types.ts` | `PricingTier`, `tiers` on `ModelPricingRates` | |
| `server/src/model-pricing/model-pricing.constants.ts` | `MAX_PRICING_TIERS`, `MAX_TIER_THRESHOLD` | |
| `server/src/model-pricing/model-pricing-rates.ts` | `validatePricingTiers`, `ratesEqual`/`pickRates` with tiers | |
| `server/src/model-pricing/anthropic-pricing-parser.ts` | web-search regex, tier rows | DD13 |
| `server/src/model-pricing/model-pricing-store.ts` | tiers in mappers/writes, stale marking | DD7 |
| `server/src/model-pricing/anthropic-pricing-fetch.service.ts` | `carryForward` tiers, post-commit notify | |
| `server/src/model-pricing/openrouter-import.service.ts` | `tiers: null`, post-commit notify | |
| `server/src/model-pricing/dto/model-price-input.dto.ts` | `PricingTierDto`, optional `tiers` | |
| `server/src/model-pricing/model-pricing-admin.service.ts` | tiers defaults/validation, post-commit notify | DD12 |
| `server/src/logs/model-pricing.controller.ts` | public `tiers` | DD12 |
| `server/src/logs/cost.sql.ts` | `computeSessionCostBreakdown`, per-call, `pricingColumnsSql` + tiers/effective_from/source | DD2 |
| `server/src/logs/claude-extractor.ts` | `callTokens` on `ClaudeStats` | DD3/DD4 |
| `server/src/logs/session-stats-writer.ts` | `replaceSessionCallTokens` | |
| `server/src/logs/session-cost/session-cost-writer.ts` | new: recompute/mark/drain/notify | DD6–DD8 |
| `server/src/logs/session-cost/session-cost-recompute.service.ts` | new: sweeper | DD8 |
| `server/src/logs/logs.module.ts` | register sweeper | |
| `server/src/logs/logs.service.ts`, `server/src/logs/repositories.service.ts` | call writer + recompute at 3 sites | DD7 |
| `server/src/logs/session-tree.sql.ts` | `topAncestorIdsSql` helper | DD6 |
| `server/src/model-pricing/session-cost-invalidation.ts` | new: `markModelSessionsStale`, drain-handler registry, `notifySessionCostsStale` | DD8; no `logs/` imports |
| `server/src/model-pricing/model-pricing-store.ts` (`loadModelStates` :63), `model-pricing-rates.ts` (`deriveModelState` :82) | admin list `tiers` | |
| `server/src/sessions/sessions.service.ts` (`purgeSessionChildData` :179) | purge new tables | DD10 |
| `server/.env.example` | document the two new env vars | not added to `release-template/` (other `*_INTERVAL_MS` vars aren't there) |
| `client/src/viewer/pages/admin/tabs/AdminModelPricingTab.tsx`, `client/src/viewer/hooks/useAdminModelPricing.ts` | size/type checks | |
| `.artisyn/marketplace/plugins/log-hub-hooks/` | dogfooded hook refresh | per `.claude/rules/hook.md` |
| `server/test/contract/registry/f23-export-import.ts` | `derived` tables on `F23-recompute` | |
| `docs/knowledgebase/session-metrics-scope.md` | cost readers note | |
| `server/src/logs/repositories.controller.ts` | sessions list, session stats, timeline readers | DD10 |
| `server/src/logs/reports/executive-summary.service.ts`, `attribution-breakdown.service.ts`, `cache-read-ratio.service.ts` | stored readers | |
| `server/src/logs/cache-ratio.sql.algo.spec.ts` | row builder fields | |
| `server/src/logs/analytics/active-sessions.service.ts`, `turn-end-cost-advisor/turn-end-cost-advisor.service.ts`, `server/src/sessions/sessions.service.ts` | stored readers | |
| `hook/.claude/telemetry_tool/post-turn-analysis-worker.js`, `version.json` | per-call hook cost | DD15 |
| `client/src/models/pricing.ts` | `PricingTier`, `tiers` fields | |
| `client/src/viewer/pages/repository/session-log/types.ts` | `CallTokens`, `TokenBreakdown.calls` | |
| `client/src/viewer/lib/format.ts` | `computeCostBreakdown` | DD2 |
| `client/src/viewer/pages/repository/session-log/log-parser.ts` | per-call entries | DD14 |
| `client/src/viewer/components/CostBreakdownTooltip.tsx` | tier row | Visual/UX |
| `client/src/viewer/pages/admin/tabs/model-pricing/PricingTiersEditor.tsx` | new tier editor | |
| `client/src/viewer/pages/admin/tabs/model-pricing/{ModelPriceDialog.tsx,priceForm.ts,modelPricingColumns.tsx}` | tiers in dialog/table | |
| `docs/knowledgebase/algorithms/cost-formula.md` | per-call rules + rows | |
| `docs/knowledgebase/algorithms/anthropic-pricing-parse.md` | new algorithm doc | |
| `server/src/model-pricing/anthropic-pricing-parser.algo.spec.ts` | new table test | |
| `server/src/logs/cost.sql.algo.spec.ts`, `client/src/viewer/lib/format.algo.test.ts`, `hook/.claude/telemetry_tool/__tests__/cost-formula.algo.test.js` | `calls` input support | |
| `server/test/contract/registry/f22-pricing-tool-versions.ts` (+ other families with `session_stats` writes), `server/test/contract/setup/global-setup.ts` | contract rows/env | |
| `tests/scenarios/helpers/prompt-session.ts`, `tests/scenarios/modes.ts`, `tests/scenarios/view/s-cost-01.spec.ts`, `tests/scenarios/auth/s-adm-01.spec.ts` | scenario steps | |
| KB: `llm-call-math.md`, `model-pricing-research.md`, `db-tables.md`, `api-reference.md`, `algorithms/README.md`, `algorithms/cache-ratio-and-causes.md`, `index.md`; scenario docs `docs/qaa-overview/scenarios/01-…`, `03-…` | docs | |

## API changes

| Endpoint | Method | Change |
|---|---|---|
| `/api/v1/model-pricing` | GET | Each entry gains an optional `tiers: PricingTier[]`, present only when the model has tiers (DD12). |
| `/api/v1/admin/model-pricing` | GET | `models[].effective.tiers` and `models[].base.tiers` are added: `PricingTier[] \| null`. |
| `/api/v1/admin/model-pricing/price` | PUT | The body gains an optional `tiers: PricingTier[] \| null`; omitted means carry the current tiers. Invalid tiers return 400. The response row includes `tiers`. |
| `/api/v1/admin/model-pricing/override` | PUT | Same as `/price`. The override row stores its own tiers. |
| `/api/v1/admin/model-pricing/override/clear` | POST | No body change. It restores the base's tiers. |

Sessions list, session stats, timeline and report responses keep their current shapes; only the source of the cost changes. `PricingTier` is defined in DD1 and mirrored in `client/src/models/pricing.ts`.

## Database changes

Migration `server/drizzle/migrations/0074_pricing_tiers_session_costs.sql`. It is hand-written and re-runnable with guarded statements, in the header style of `0071_otel_api_calls_request_ids.sql`. It runs in this order:

1. `ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS tiers jsonb` with `CHECK (tiers IS NULL OR jsonb_typeof(tiers) = 'array')`, named `model_pricing_tiers_array_chk`.
2. `ALTER TABLE model_pricing_meta ADD COLUMN IF NOT EXISTS override_base_tiers jsonb` with the same check, named `model_pricing_meta_override_base_tiers_array_chk`.
3. `CREATE TABLE IF NOT EXISTS session_call_tokens` with:
   - `session_id integer PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE`;
   - `calls jsonb NOT NULL CHECK (jsonb_typeof(calls) = 'object')`;
   - `updated_at timestamptz NOT NULL DEFAULT now()`.
4. `CREATE TABLE IF NOT EXISTS session_costs` with the columns of DD5, plus the two indexes.
5. Backfill per DD9:

   ```sql
   INSERT INTO session_costs (...)
   SELECT ...
     FROM session_stats
     -- top-ancestor recursive CTE
     -- price date
     -- LATERAL pricing lookup
   ON CONFLICT (session_id) DO NOTHING
   ```

Other notes:
- Lock profile: additive only. No `CONCURRENTLY`. The new tables start empty, so their indexes are built inside the migration.
- No data is deleted, and the existing pricing rows keep `tiers = NULL` (AC7).
- No tier backfill: the next successful fetch writes Haiku 5.5's tiers.
- After adding the file, add the journal entry (`idx` 74, `version` "7", `when` 1790899200000, `tag` `0074_pricing_tiers_session_costs`) and run `npm run migrations:lock` from `server/`.

Edge cases in production data (per the `migrations-data-integrity` skill):

| Case | Result |
|---|---|
| `session_stats.model` is NULL | `cost` and terms NULL, `unavailable_reason = 'unknown-model'`, `model_id` NULL |
| Session with no timed log | `price_date = CURRENT_DATE` (today's fallback) |
| A `parent_session_id` cycle, or a parent that is missing | Depth cap of 50 / the session itself is its top |
| A duplicate `sessions.session_id` reached as a parent | `DISTINCT ON (id) … ORDER BY depth DESC` picks one top |
| OTEL-only `session_stats` row | Zero tokens, so cost 0 when priced. Readers keep their `EXISTS` guard |

## Test coverage plan

All tests follow the CLAUDE.md test policy (three kinds only).

**Algorithm tests — `docs/knowledgebase/algorithms/cost-formula.md`.** Add rows CF-23 onwards to the existing examples block. They use the new optional `input.calls` (a row-wise list) and `pricing.tiers`; `expected.tierDelta` is optional. All rows use Haiku 5.5 base rates 0.10/0.50/0.01/0.125/0.20 and a tier above 100000 of 0.5/2.5/0.05/0.625/1.

| Row | Input | Expected cost |
|---|---|---|
| CF-23 | one call 60000 in + 50000 cache read | 0.0325, tierDelta 0.026 |
| CF-24 | one call 90000 in | 0.009 |
| CF-25 | one call exactly 100000 in | 0.01 |
| CF-26 | call 1: 60000 in + 50000 cache read; call 2: 90000 in | 0.0415 |
| CF-27 | same tokens as aggregates, no calls | 0.0065 (FR5b base path) |
| CF-28 | calls present, `tiers` null | equals the aggregate formula |
| CF-29 | fast call of 110000 in all fast + 1000 out all fast | 0.115 |
| CF-30 | CF-23 tokens + 2 web searches at base 0.01 | 0.0525 |
| CF-31 | second tier above 200000 with in 1.0; one call 250000 in | 0.25 |

These rows run in the existing server, client and hook loaders (AC3, AC4).

**Algorithm tests — new doc `docs/knowledgebase/algorithms/anthropic-pricing-parse.md`.** It comes with a new `server/src/model-pricing/anthropic-pricing-parser.algo.spec.ts`, and its inputs are markdown snippets. Rows:
- AP-01: current wording, web search 0.01.
- AP-02: old wording.
- AP-03: no web-search price, giving `null`.
- AP-04: a Haiku 5.5 pair, giving one model with a tier (AC2).
- AP-05: every other model has `tiers` null.
- AP-06: an `over` row without a base row, giving `null`.
- AP-07: mismatched thresholds, giving `null`.
- AP-08: fewer than 5 merged models, giving `null`.

The doc states the snippets are trimmed copies of the live page as of 2026-10-26 (AC1, AC2).

**Algorithm tests — `algorithms/cache-ratio-and-causes.md`.** Prose only: own cache costs come from the stored terms. The existing rows still pass with the renamed null fields.

**API contract — `server/test/contract/registry/f22-pricing-tool-versions.ts`.**
- Add `tiers` to `F22-public-pricing` and `F22-admin-list`.
- New rows:
  - `F22-set-price-tiers`: 200, with `tiers` stored.
  - `F22-set-price-tiers-nonincreasing`: 400.
  - `F22-set-price-tiers-bad-rate`: 400.
  - `F22-override-tiers`: 200, with the override row's tiers stored and the meta base untouched.
- `derived: ['session_costs']` on every pricing write row (AC5 API part).

**API contract — other families.** Every row whose `watch`/`derived` lists `session_stats` (upload, import, `F23-recompute`) adds `session_call_tokens` and `session_costs` to `derived`. F17/F20/F21 `totalCost` oracle comparisons stay. The world sessions have no per-call rows, so they cover AC4b/FR5b and the stored-reader switch (AC4c).

**Scenario — `tests/scenarios/view/s-cost-01.spec.ts` (modes A, C).** New steps:
- AC4a: a tiered model seeded as `anthropic` 30 days back; a 3-day-old session and a today session, each with a 110k and a 90k call. List, header, Info, Summary and per-turn all show 0.0415.
- AC4d: an admin override that moves the threshold to 120000 moves the today session to 0.0155, while the 3-day-old one stays 0.0415.

**Scenario — `tests/scenarios/auth/s-adm-01.spec.ts`.** New steps (AC5 UI): set a price with one tier through the dialog; the table shows the tier; an invalid tier shows the 400 error; an override with one tier on an `anthropic`-sourced model is stored on the override row.

**Not automated (DD17):** AC6 and AC8 (manual check on local prod), and the AC4c backfill-equality SQL check.

## Visual/UX notes

**Price/override dialog.**
- Below the base rate fields, a "Long-context tiers" section holds a compact table. Each row has: `Above (tokens)`, `Input`, `Output`, `Cache read`, `5m write`, `1h write` and a remove icon button.
- Below the table, an "Add tier" text button, disabled at 10 rows.
- Empty state: a muted line, "No tiers — base rates apply to every request."
- Validation errors show inline under the section, in the existing dialog error style. A server 400 message shows in the dialog's error area.
- Use existing form inputs and the existing spacing tokens (follow the `ui-components` skill).

**Model table.** The effective-price cell shows a small muted suffix `· >100k tier` (the first threshold, compact format) when tiers exist. Its tooltip lists all thresholds.

**Cost breakdown tooltip.** The term rows show the DD2 terms (priced at each call's chosen rates), so they sum to the total. When `tierDelta > 0`, add a muted note line under the total, "incl. long-context tier +$X". It is not a summand row.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema and migration | 5 | first; everything reads these tables |
| 2 | Tier validation and cost formula (server) | 5 | needs 1 (`PricingTier`, columns) |
| 3 | Per-call capture and session-cost module | 8 | needs 2 (formula) |
| 4 | Parser and pricing writes | 6 | needs 3 (invalidation module, drain handler) |
| 5 | Server cost readers I (repositories controller, analytics) | 5 | needs 3 (stored costs) |
| 6 | Server cost readers II (reports, delete audit, purge, docs) | 7 | needs 5; deliberately includes the `cache-ratio` algo-spec builder and doc prose, since the field rename breaks them |
| 7 | Pricing API surface | 6 | needs 4 |
| 8 | Client cost formula | 6 | needs 7 (public `tiers`) |
| 9 | Client admin tier editor | 5 | needs 7, 8 (types) |
| 10 | Hook per-call cost | 6 | needs 7 (public `tiers`) |
| 11 | Tests — algorithm docs | 7 | needs 2, 4, 8, 10 |
| 12 | Tests — API contract | 6 | needs 3–7 |
| 13 | Tests — scenarios | 8 | needs all |

### Chunk 1 — Schema and migration
- [ ] In `model-pricing.types.ts`, add `PricingTier` (DD1). In `server/src/database/schema/index.ts`, add a nullable `tiers` jsonb column (`.$type<PricingTier[]>()`) to `modelPricing` and `overrideBaseTiers` (`override_base_tiers`) to `modelPricingMeta`. Add a comment pointing to the SQL-only CHECK constraints.
- [ ] In `server/src/database/schema/index.ts`, add the tables `sessionCallTokens` and `sessionCosts`, with columns and indexes per DD4/DD5, using `sessionRequestIds` (:387) as the template.
- [ ] Create `server/drizzle/migrations/0074_pricing_tiers_session_costs.sql` with steps 1–4 of Database changes and a header comment naming the lock profile and the edge cases table.
- [ ] Append the backfill (step 5) to migration 0074: a top-ancestor recursive CTE, the price date per `sessionPriceDateSql`, a LATERAL lookup per `pricingAsOfSql`, and the per-term arithmetic of `sessionCostSql`, frozen inline (DD9).
- [ ] Register 0074 in `meta/_journal.json` (idx 74, when 1790899200000) and run `npm run migrations:lock` from `server/`. Then run `npm run migrate` and an AC4c check query on the dev DB: count the `session_costs.cost` values that differ by more than 1e-9 from the `sessionCostSql` cost; the expected count is 0.

### Chunk 2 — Tier validation and cost formula (server)
- [ ] Add `tiers: PricingTier[] | null` to `ModelPricingRates` in `model-pricing.types.ts`, and set `tiers: null` at every existing construction site the typecheck reports (parser, OpenRouter import, `withDefaults`, store mappers). In `model-pricing.constants.ts`, add `MAX_PRICING_TIERS = 10` and `MAX_TIER_THRESHOLD = 100_000_000`.
- [ ] In `model-pricing-rates.ts`, add `validatePricingTiers(tiers): string | null` per DD1, and `normalizeTiers` (sorts, maps `[]` to null, rounds rates with `round6`). Extend `ratesEqual` to compare tiers deeply and `pickRates` to carry `tiers`.
- [ ] In `server/src/logs/cost.sql.ts`, add `SessionCallTokens` (the columnar shape of DD4) and an optional `calls` on `SessionCostTokens`, plus an optional `tiers` on `SessionCostPricing`.
- [ ] In `cost.sql.ts`, add `computeSessionCostBreakdown(tokens, pricing)`, which returns `{ cost, terms, tierDelta } | null`. It follows DD2, with tier selection in `pickCallRates(promptTokens, pricing)`. Reimplement `computeSessionCost` as `computeSessionCostBreakdown(...)?.cost ?? null`, keeping both overloads.
- [ ] Extend `pricingColumnsSql()` in `cost.sql.ts` to select `tiers`, `effective_from` and `source`. Update the module doc comment with the per-call rule, and with `sessionCostSql` now serving only `utilityCostsCte` (DD11).

### Chunk 3 — Per-call capture and session-cost module
- [ ] In `claude-extractor.ts`, add `callTokens: SessionCallTokens` to `ClaudeStats`. Fill it inside the totals loop (:1093) from the same `lastUsageByMessageId` values, with the fast subsets per `usage.speed`, so the per-call sums equal the totals (DD3).
- [ ] In `session-stats-writer.ts`, add `replaceSessionCallTokens(db, sessionRowId, calls)`: an upsert on `session_call_tokens` that throws when the array lengths differ (DD4).
- [ ] In `server/src/logs/session-tree.sql.ts`, add `topAncestorIdsSql(idsArray)`: a recursive CTE returning `(id, top_id)` per DD6, with a depth cap of 50 and the deepest ancestor winning.
- [ ] Create `server/src/model-pricing/session-cost-invalidation.ts` per DD8: `markModelSessionsStale(db, modelId, effectiveFrom)` (the DD7 predicate, raw SQL), `registerSessionCostDrainHandler(fn)` and `notifySessionCostsStale()`, which reads `SESSION_COST_RECOMPUTE_INLINE` (inline only when the value is `true`). No imports from `logs/`.
- [ ] Create `server/src/logs/session-cost/session-cost-writer.ts` with `recomputeSessionCosts(db, ids)`. It bulk-loads `session_stats`, `session_call_tokens`, the top price dates and the pricing via `pricingAsOfSql`, computes with `computeSessionCostBreakdown` and upserts `session_costs` (`stale=false`). It marks descendants stale when the row is new or its `price_date` changed (DD7).
- [ ] In `session-cost-writer.ts`, add `drainStaleSessionCosts(db)`, which runs the DD8 batches with a `SESSION_COST_RECOMPUTE_BATCH = 500` constant.
- [ ] Create `session-cost/session-cost-recompute.service.ts`. On module init it registers the drain handler and a `SchedulerRegistry` interval of `SESSION_COST_RECOMPUTE_INTERVAL_MS` (constant `DEFAULT_SESSION_COST_RECOMPUTE_INTERVAL_MS = 10_000` when unset or invalid) calling the drain, with overlapping runs skipped. Register it in `logs.module.ts`, and document both env vars in `server/.env.example`.
- [ ] After every `upsertSessionStatsRow` + `replaceSessionRequestIds` pair, call `replaceSessionCallTokens(tx, id, stats.callTokens)` and then `recomputeSessionCosts(tx, [id])`. The call sites are `logs.service.ts:422`, `logs.service.ts:1029` and `repositories.service.ts:1432`.

### Chunk 4 — Parser and pricing writes
- [ ] In `anthropic-pricing-parser.ts`, change the `parseWebSearchPrice` regex per DD13 and update the module doc comment.
- [ ] In `anthropic-pricing-parser.ts`, make `toModelId` return `{ id, bound }` and replace the duplicate-skip loop (:46-74) with the DD13 merge and fail rules. Validate the tiers with `validatePricingTiers`, and set `tiers: null` on untiered models.
- [ ] In `model-pricing-store.ts`, map `tiers` in `selectNewestVersions` (:125) and `override_base_tiers` in `toMeta` (:156). Write `tiers` in the `writeEffectivePrices` insert values and in the `onConflictDoUpdate` set list. Write and clear `override_base_tiers` in `setOverrideBase` and `clearOverrideBase`.
- [ ] In `writeEffectivePrices`, call `markModelSessionsStale(tx, modelId, effectiveFrom)` from `session-cost-invalidation.ts` for every model it actually inserted or updated (DD7).
- [ ] In `anthropic-pricing-fetch.service.ts`, keep the page's `tiers` in `carryForward` (DD13, DD16), and `await notifySessionCostsStale()` after `persist` commits.
- [ ] In `openrouter-import.service.ts`, write `tiers: null` on every row and `await notifySessionCostsStale()` after the import transaction commits.

### Chunk 5 — Server cost readers I
- [ ] In the `repositories.controller.ts` sessions list (:627-750), keep `session_events_jsonb` only for `model`. Replace `main_cost`/`pricing_missing` with `LEFT JOIN session_costs sc` on the row id (DD10), and `subagent_costs` with `SUM(sc.cost)` over `descendant_sessions`, keeping the `EXISTS` guard.
- [ ] In the `repositories.controller.ts` session stats query (:1247-1257), replace the `sessionCostSql` + `pricingAsOfSql` lateral with the stored `session_costs.cost`, and set `pricing_missing = sc.cost IS NULL`.
- [ ] In the `repositories.controller.ts` timeline/branches query (:2713-2889), set `computed_cost` to `sc.cost` + the stored sub-agent sum, and `pricing_missing` from `sc.cost IS NULL`. Remove the `p` lateral and the `subagent_costs` pricing lateral; keep the `tk` token columns for the response.
- [ ] In `analytics/active-sessions.service.ts` (:143-159), replace the `sessionCostSql` + lateral with stored `session_costs.cost`, keeping the current NULL/0.0 guard semantics.
- [ ] In `turn-end-cost-advisor/turn-end-cost-advisor.service.ts` (:302-316), use stored `session_costs.cost` for each tree member. Leave the :452 rate lookup unchanged.

### Chunk 6 — Server cost readers II
- [ ] In `reports/executive-summary.service.ts` (:441-508), replace both the own-cost and sub-agent `sessionCostSql` sites with stored `session_costs.cost`. Unpriced sessions keep being counted through `sc.cost IS NULL`.
- [ ] In `reports/attribution-breakdown.service.ts` (:411-468), replace both `sessionCostSql` sites with stored `session_costs.cost`, keeping the unpriced handling.
- [ ] In `reports/cache-read-ratio.service.ts`, replace the row fields `priceCacheRead`, `priceCacheWrite5m` and `priceCacheWrite1h` with `cacheReadCost` (from `sc.cost_cache_read`) and `cacheWriteCost` (from `sc.cost_cache_write_5m + sc.cost_cache_write_1h`), each null when unpriced. Do the same in the descendant rollup and in the rollup at :320-345.
- [ ] Update the `cache-ratio.sql.algo.spec.ts` row builder (:58-60) to the new null fields, and the prose of `docs/knowledgebase/algorithms/cache-ratio-and-causes.md` to say that cache costs come from stored terms.
- [ ] In `sessions/sessions.service.ts` (:301-335), set the delete-audit `computedCost` from the session's `session_costs.cost`, read before the cascade delete. Remove the inline pricing lookup and the `computeSessionCost` call.
- [ ] In `sessions/sessions.service.ts` `purgeSessionChildData` (:179), also delete the `session_call_tokens` and `session_costs` rows of the purged ids (DD10).
- [ ] Update `docs/knowledgebase/llm-call-math.md` §2/§3 (stored cost, per-call tiers, readers list, `tiers` column) and `docs/knowledgebase/db-tables.md` (`model_pricing`, `model_pricing_meta`, and new `session_call_tokens`/`session_costs` entries). Update `session-metrics-scope.md` if it lists cost readers.

### Chunk 7 — Pricing API surface
- [ ] In `dto/model-price-input.dto.ts`, add a `PricingTierDto` class (an `@IsInt` `aboveTokens` from 1 to `MAX_TIER_THRESHOLD`, and five rates validated like `priceIn`). Add an optional `tiers?: PricingTierDto[] | null` with `@IsOptional @IsArray @ArrayMaxSize(MAX_PRICING_TIERS) @ValidateNested({ each: true }) @Type(() => PricingTierDto)`.
- [ ] In `model-pricing-admin.service.ts` `withDefaults`, resolve `tiers` per DD12 (omitted means carry `current.tiers`; null or `[]` clears). Normalize the tiers, then throw `BadRequestException(validatePricingTiers(...))` when they are invalid.
- [ ] In `model-pricing-admin.service.ts`, `await notifySessionCostsStale()` after the `setPrice`, `setOverride` and `clearOverride` transactions commit. `clearOverride` restores `state.base.tiers` through `writeEffectivePrice`.
- [ ] In `logs/model-pricing.controller.ts` (:56-111), select `tiers` and emit it on an entry only when it is non-null (DD12). Update the response type.
- [ ] Make the admin list (`loadModelStates` in `model-pricing-store.ts:63` → `deriveModelState` in `model-pricing-rates.ts:82` → `AdminModelPricingRow`) emit `tiers` in `effective` and `base`, null allowed.
- [ ] Update `docs/knowledgebase/api-reference.md` (the four routes per API changes) and `docs/knowledgebase/model-pricing-research.md` (the parser rules of DD13, the tier/override rules of DD12/DD16, removing "a tiered model takes its first tier" at :105-107).

### Chunk 8 — Client cost formula
- [ ] In `client/src/models/pricing.ts`, add `PricingTier`, optional `tiers?: PricingTier[]` on `ModelPricingEntry`, `tiers: PricingTier[] | null` on the admin rate types (:46-55), and optional `tiers?: PricingTier[] | null` on `ModelPriceInput` (:101-111).
- [ ] In `session-log/types.ts`, add the `CallTokens` type and an optional `calls?: CallTokens[]` on `TokenBreakdown` (DD14).
- [ ] In `client/src/viewer/lib/format.ts`, add `computeCostBreakdown(breakdown, pricing)`, which returns `{ total, terms, tierDelta }` per DD2, and make `computeCost` return its `total`. Update the doc comment to name the server and hook twins.
- [ ] In `log-parser.ts`, push one `CallTokens` per deduplicated assistant usage and per non-skipped sub-agent `toolUseResult.usage`, in the turn sums and the summary loop (:2340-2420). Concatenate `calls` in every merge: `sumTokenBreakdown`, the own-turn sum (:496-520), sub-agent/sidechain breakdowns, and `addBreakdown` in `charts/chart-data.ts:289`.
- [ ] In `components/CostBreakdownTooltip.tsx` (:91-108), render the term rows from `computeCostBreakdown` terms, and add the muted tier note when `tierDelta > 0` (Visual/UX notes, DD2).
- [ ] Check that the breakdowns read by `SubAgentDetail.tsx`, `WorkflowAgentsTable.tsx`, `AgentActivationItem.tsx` and `call-tree/cost-utils.ts` carry `calls`. Run `bun run typecheck` in `client/` and fix the errors without casts.

### Chunk 9 — Client admin tier editor
- [ ] In `model-pricing/priceForm.ts`, add tier rows to the form state (as strings), a `tiers → form` prefill from the effective or base rates, and a form → `PricingTier[] | null` conversion. Add local `MAX_PRICING_TIERS = 10` and `MAX_TIER_THRESHOLD = 100_000_000` next to its `MAX_RATE`, and port the DD1 validation.
- [ ] Create `model-pricing/PricingTiersEditor.tsx`: the controlled tier table, add/remove buttons, the empty state and inline errors per Visual/UX notes. Follow the `ui-components` skill.
- [ ] Integrate `PricingTiersEditor` into `ModelPriceDialog.tsx` for both the set-price and override modes. Always send `tiers` in the PUT body (null when empty), and show a server 400 message in the dialog error area.
- [ ] In `modelPricingColumns.tsx`, show the `· >Nk tier` suffix with a threshold tooltip when the effective tiers exist (Visual/UX notes).
- [ ] Keep `ModelPriceDialog.tsx` and `AdminModelPricingTab.tsx` under the component-size threshold (extract helpers if needed). Check that `useAdminModelPricing.ts` types compile with the new `tiers` fields.

### Chunk 10 — Hook per-call cost
- [ ] In `hook/.claude/telemetry_tool/post-turn-analysis-worker.js` `deriveTokenTotals` (:959), push one row-wise `calls` entry per counted usage (DD15), so the sums still equal the totals.
- [ ] Add a `pickCallRates(promptTokens, rates)` helper and extend `computeLocalSessionCost` (:1118) with the per-call path when `tokens.calls` and a non-empty `rates.tiers` are present (DD2/DD15). Keep the aggregate path otherwise.
- [ ] Update the `fetchModelPricing` JSDoc (:1096) to include the optional `tiers`.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.25.0`.
- [ ] Run `npm run build:hooks-installer` and refresh `.artisyn/marketplace/plugins/log-hub-hooks/` per `.claude/rules/hook.md`.
- [ ] Run the `update-install-instructions` skill to sync the install docs with the hook change.

### Chunk 11 — Tests: algorithm docs
- [ ] In `docs/knowledgebase/algorithms/cost-formula.md`, update the Purpose, Code (add `computeSessionCostBreakdown`, `computeCostBreakdown` and the hook path), Input/output (`input.calls`, `pricing.tiers`, optional `expected.tierDelta`), Rules (DD2) and Edge cases sections.
- [ ] In `cost-formula.md`, add example rows CF-23 to CF-31 with the inputs and expected values in the Test coverage plan table.
- [ ] In `server/src/logs/cost.sql.algo.spec.ts`, convert a row-wise `input.calls` into columnar `SessionCallTokens`, pass `tiers`, and assert `expected.tierDelta` through `computeSessionCostBreakdown` when present.
- [ ] In `client/src/viewer/lib/format.algo.test.ts`, map `input.calls` to `CallTokens[]` on the breakdown, pass `tiers`, and assert `tierDelta` through `computeCostBreakdown` when present.
- [ ] In `hook/.claude/telemetry_tool/__tests__/cost-formula.algo.test.js`, pass `input.calls` as `tokens.calls` and `pricing.tiers` into `computeLocalSessionCost`.
- [ ] Create `docs/knowledgebase/algorithms/anthropic-pricing-parse.md` (front matter `reviewed: no`, `reviewer: none`; sections per the algorithms README; rows AP-01 to AP-08 per the Test coverage plan) and `server/src/model-pricing/anthropic-pricing-parser.algo.spec.ts`, which loads it with `loadExamples('anthropic-pricing-parse')`.
- [ ] Add `anthropic-pricing-parse` to the table in `docs/knowledgebase/algorithms/README.md` and to `docs/knowledgebase/index.md`. Then run the fast set: the server, client and hook algorithm tests and `npm run test:scripts`.

### Chunk 12 — Tests: API contract
- [ ] In `f22-pricing-tool-versions.ts`, change `F22-public-pricing` to append `tiers` only when it is non-null, and `F22-admin-list` to add `'tiers', cp.tiers` to `effective` and `'tiers', m.override_base_tiers` to `base` (DD12).
- [ ] Add row `F22-set-price-tiers`: `PUT /price` on `@models.b` with one tier. Expect 200, an inserted `model_pricing` row with `tiers` stored, and `derived: ['session_costs']`.
- [ ] Add rows `F22-set-price-tiers-nonincreasing` (two tiers at 200000 then 100000) and `F22-set-price-tiers-bad-rate` (a tier `priceIn` of -1), both expecting 400 and no writes.
- [ ] Add row `F22-override-tiers`: `PUT /override` on the fetched world model with tiers. Expect the override row to carry the tiers and the meta base tiers to stay null. Add `derived: ['session_costs']` to the existing pricing write rows.
- [ ] Add `session_call_tokens` and `session_costs` to `derived` of `F23-recompute` (`f23-export-import.ts:253-270`). Add `session_costs` to the `watch` list and `delta.deleted` of the delete rows: `f06-admin-users.ts:20,35`, `f08-admin-repos-teams.ts:202,219` and `SESSION_TABLES` in `f18-session-delete-retention.ts:14,76`.
- [ ] In `server/test/contract/setup/global-setup.ts`, set `SESSION_COST_RECOMPUTE_INLINE=true` and `SESSION_COST_RECOMPUTE_INTERVAL_MS=3600000`, and call `recomputeSessionCosts` for every world session after the fixture loads. Then run `npm run test:contract`.

### Chunk 13 — Tests: scenarios
- [ ] In `tests/scenarios/helpers/prompt-session.ts`, add optional `model` and `usages` (a per-turn assistant `usage` object) to `PromptSession`, applied to each turn's main assistant line. The defaults stay unchanged. The AC4a/AC4d sessions set no `reads`.
- [ ] In `tests/scenarios/modes.ts`, set `SESSION_COST_RECOMPUTE_INTERVAL_MS: '50'` in the fast-tick env.
- [ ] In `s-cost-01.spec.ts`, add AC4a setup steps: `insertRow` a `model_pricing` row for `scn-tiered-<run>` (source `anthropic`, effective 30 days ago, the Test coverage plan's Haiku 5.5 rates and tier). Upload sessions dated 3 days ago and today, with turns of 60000 in + 50000 cache read, then 90000 in.
- [ ] In `s-cost-01.spec.ts`, add the AC4a assert step: 0.0415 in the list, header, Info and Summary, and per-turn values 0.0325 / 0.0090, for both sessions.
- [ ] In `s-cost-01.spec.ts`, add the AC4d steps: `PUT /override` for the same model with the same base and tier rates but `aboveTokens` 120000, `expect.poll` the today session's list cost to 0.0155 and check the UI header shows it, and check the 3-day-old session still shows 0.0415.
- [ ] In `s-adm-01.spec.ts`, add AC5 set-price steps: seed an unpriced `scn-tier-ui-<run>` in `model_pricing_meta`, set a price with one tier through the dialog, and assert the table's tier suffix and the admin GET `tiers`. Enter non-increasing thresholds and assert that the error shows and nothing is saved.
- [ ] In `s-adm-01.spec.ts`, add AC5 override steps: `insertRow` a `model_pricing` row with source `anthropic` for `scn-tier-ov-<run>`, set an override with one tier through the dialog, and assert the admin GET `effective.tiers` and a null `base.tiers`.
- [ ] Add the new steps to `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §S-COST-01 and `01-auth-access-admin.md` §S-ADM-01. Then run `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-COST-01|@S-ADM-01"`.
