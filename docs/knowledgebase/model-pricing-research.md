---
type: "Reference"
title: "Researching Model Pricing & Context Length"
description: "Where to look up current Claude model pricing and context-window values before writing a model_pricing migration, the live price sync, the Opus 4.6+ 1M-context boundary, and a caveat on trusting unverified research."
tags:
  - pricing
  - database
timestamp: "2026-10-14T00:00:00+04:00"
---

# Researching Model Pricing & Context Length

The `model_pricing` table (see [Database Structure](db-tables.md)) stores per-model `price_in`,
`price_out`, `price_cache_r`, `price_cache_w_5m`, `price_cache_w_1h`, `price_web_search`,
`chars_per_token`, and `context_length` values. Rates are kept current at runtime by a **daily
fetch of Anthropic's pricing page** and an **admin-triggered OpenRouter import** (see
[Live price sync](#live-price-sync) below). Migrations still seed rows and carry the researched
columns the pricing page does not publish (`chars_per_token`, `context_length`).
(`price_cache_w`, the old flat cache-write rate, is still a column but is deprecated and has no
readers. The runtime writers set it equal to the 5m rate; do not research a value for it.)
When adding a new model row or a new researched column (such as `chars_per_token`,
`context_length` and the three columns above), use the sources below instead of relying on
memorized/trained knowledge, which is frequently stale or wrong for recently-released models.

The three cache-write/web-search columns each need their own lookup, and all three must be filled explicitly — their
`DEFAULT 0` would otherwise price 1h cache writes and web searches at zero:

- `price_cache_w_5m` — the 5-minute-TTL cache-write rate, `1.25 × price_in` for every Claude model
  observed so far.
- `price_cache_w_1h` — the 1-hour-TTL rate, `2 × price_in` (i.e. `1.6 ×` the 5m rate). Listed on the
  pricing page as a separate "1h cache write" line; do not assume it equals the 5m rate.
- `price_web_search` — USD **per web-search request**, not per million tokens ($0.01 for first-party
  Claude models — the page quotes it as $10 per 1,000 searches). Third-party rows offer no server
  tools and take `0.000000`. Priced from `session_stats.web_search_requests`;
  `web_fetch_requests` is not billed.

`price_cache_r` is **not** safely derivable either. It was `0.1 × price_in` on every model until
Anthropic started publishing per-model exceptions: as of 2026-09-23 the multiplier is `0.025×` on
Claude Fable 5.1 / Mythos 5.1 ($0.25) and `0.05×` on Claude Opus 5.5 ($0.20), while everything else
stays at `0.1×`. Always read the cache-hit column off the pricing page per model instead of
multiplying `price_in` (see `0064_model_pricing_2026_09_refresh.sql`).

Fast-mode pricing has **no column**: it is `FAST_MODE_MULTIPLIER = 2 ×` the standard rate, derived in
`server/src/logs/cost.sql.ts` and `client/src/viewer/lib/format.ts`. Do not add a `price_in_fast`.

## Live price sync

All code is in `server/src/model-pricing/` (migration `0066_model_pricing_source.sql`). Table
details are in [db-tables.md](db-tables.md) under `model_pricing`, `model_pricing_meta` and
`model_pricing_fetch_state`. Cost readers (`pricingColumnsSql()` and the hand-written lookups) are
unchanged: they still read only the effective `model_pricing` row.

### Storage model: `source` and `model_pricing_meta`

- `model_pricing` stays the single store of **effective** prices, one row per price version. Its
  `source` column records each version's origin: `anthropic`, `openrouter`, `manual` or `override`.
  A model's current source is the `source` of its effective row (the newest one with
  `effective_from <= CURRENT_DATE`).
- `model_pricing_meta` holds per-model facts that are not a price version:
  - `first_seen_at`: when ingest auto-registered the model as unpriced
  - `override_base_*` and `override_base_source`: the fetched/imported price hidden under an
    active override
- The resolved state comes from the pure `deriveModelState()` in `model-pricing-rates.ts`:
  - **No effective row:** `unpriced`. The model has a meta row only, so its cost stays null (never
    $0) and `GET /api/v1/model-pricing` omits it with no code change.
  - **Effective row with `source = 'override'`:** override active. The resolved source and the
    `base` rates come from `meta.override_base_*`. If those are missing, they fall back to the
    newest non-override row, or `manual` when there is none.
  - **Anything else:** the row's own source, with no base.
- The resolved source the API and UI expose is therefore always `anthropic` / `openrouter` /
  `manual` / `unpriced`. An override shows as its base source plus an `OVR` chip.
- **Unknown models are registered at ingest.** `registerUnpricedModels()`
  (`unpriced-model-registry.ts`) runs from `upsertSessionStatsRow` and `ingestOtelChunk`. It
  inserts a meta row for every normalised id with no effective price, using `ON CONFLICT DO NOTHING`.

### The today-row rule

`writeEffectivePrice` / `writeEffectivePrices` (`model-pricing-store.ts`) are the only runtime price
writers:
- They compare the new `(rates, source)` with the current effective row. The comparison covers the
  six rates plus `chars_per_token` and `context_length`, rounded to 6 decimals. If they are equal,
  nothing is written.
- Otherwise they upsert a row with `effective_from = CURRENT_DATE`
  (`ON CONFLICT (model_id, effective_from) DO UPDATE`). A second change on the same day overwrites
  today's row.
- Rows dated before today are **never** modified, so historical session costs do not move.
- `price_cache_w` (deprecated) is written equal to the 5m rate.
- Every price-writing transaction (fetch, import, set price, override, clear) starts with
  `pg_advisory_xact_lock(MODEL_PRICING_LOCK_KEY)`.

### Daily Anthropic fetch

`AnthropicPricingFetchService.runFetch()`, driven by `ModelPricingScheduler`:
- **Source:** `ANTHROPIC_PRICING_URL = https://platform.claude.com/docs/en/about-claude/pricing.md`,
  the **markdown** rendering of the official page (~50 KB, versus ~1.1 MB for the redirecting HTML).
  No HTML parser is needed.
- **Parser** (`anthropic-pricing-parser.ts`, pure):
  - It reads the first markdown table after `## Model pricing` and locates columns by header text:
    `Model`, `Base input`, `5m cache write`, `1h cache write`, `Cache hits`, `Output`.
  - Model cell: links, `<sup>` and any trailing parenthetical are stripped, then the cell must
    match `^Claude (Opus|Sonnet|Haiku|Fable|Mythos) N[.M]$`.
  - Id mapping: major ≥ 4 gives `claude-<family>-<major>[-<minor>]` (`Claude Opus 4.1` →
    `claude-opus-4-1`). Major < 4 gives `claude-<major>[-<minor>]-<family>` (`Claude Haiku 3.5` →
    `claude-3-5-haiku`).
  - Non-matching rows are skipped. For a duplicate id the first row wins, so a tiered model takes
    its first tier.
  - Price cells take the first `$N` amount. The web-search rate is the page's first "$N per 1,000
    searches" divided by 1000.
- **Fail-closed:** the parser returns `null` and nothing is written when any of these holds:
  - the heading, the table or any required column is missing
  - fewer than `MIN_PARSED_MODELS = 5` models parse
  - the web-search price is missing
  - any rate is not finite, is negative, or exceeds `MAX_RATE`
- **Apply rules,** per parsed model:
  - **Override active:** only the override base in `model_pricing_meta` is updated. The override
    row stays.
  - **Otherwise** (unpriced, `manual`, `openrouter`, `anthropic`): an `anthropic` row is written per
    the today-row rule. A **manual price on a Claude model is therefore replaced** as soon as
    Anthropic publishes that model.
  - `chars_per_token` / `context_length` are not on the page. They are carried forward from the
    current row, or from the override base.
  - Models missing from the page are untouched.
- **Schedule and claim:** see [system-info-and-cluster.md](system-info-and-cluster.md). It runs
  once at bootstrap and then every `MODEL_PRICING_FETCH_INTERVAL_MS` (default 1 h). A DB claim on
  `model_pricing_fetch_state['anthropic']` lets one worker fetch per 24 h, with a 1 h retry gap
  after a failure. `MODEL_PRICING_FETCH_ENABLED=false` turns it off.

### OpenRouter import (admin button)

`OpenRouterImportService.runImport()` runs synchronously on `POST /api/v1/admin/model-pricing/import-openrouter`:
- **Request:** `GET https://openrouter.ai/api/v1/models` (no auth, 20 s timeout).
- **Conversion:** the per-token USD strings are multiplied by 1e6 and rounded to 6 decimals. The one
  cache-write value fills both 5m and 1h. A missing cache-read, cache-write or web-search value
  becomes `0`, and `web_search` is stored per request as-is.
- **Skipped:**
  - `anthropic/*` ids are counted as `skippedAnthropic`.
  - Ids containing `:`, entries with a missing or invalid prompt/completion price, out-of-range
    rates and duplicate stripped ids are counted as `skippedOther`.
- **Matching:** an entry matches known ids (`model_pricing` ∪ `model_pricing_meta`) equal to either
  the full id (`deepseek/deepseek-v4-pro`, the form the seeded rows use) or the id after the first
  `/`. Per match:
  - A resolved-`anthropic` or `claude-*` model is **never touched** (`skippedOther`).
  - An overridden model gets only its base updated (`skippedOverride`).
  - Anything else gets an `openrouter` row: `updated` when it wrote, else `unchanged`.
  - An entry with no match is added under the stripped id (`added`).
- **Write path:** one locked transaction with batched multi-row upserts (`IMPORT_BATCH_SIZE = 500`).
  A fetch or parse failure writes no price, records `failed` in `model_pricing_fetch_state['openrouter']`
  and returns 502.

### Admin actions

`ModelPricingAdminService` backs the Admin → Model Pricing tab. Endpoints are listed in
[api-reference.md](api-reference.md). Allowed actions per resolved state (any other combination
returns 409):

| Resolved source | Override active | Allowed |
|---|---|---|
| `anthropic` / `openrouter` | no | `PUT /override` |
| `anthropic` / `openrouter` | yes | `PUT /override`, `POST /override/clear` |
| `manual` / `unpriced` | no | `PUT /price` (writes `source = 'manual'`) |

- Blank cache-write inputs default to `1.25×` / `2×` the input rate. Blank cache-read and web-search
  inputs default to 0.
- `PUT /override` returns 409 when the model has a future-dated row, which would silently end the
  override on its date.
- Clearing an override writes the base back as a today row with its base source.

### Rule for new pricing migrations

**A migration that inserts or updates `model_pricing` rows must set `source` explicitly**:
`'anthropic'` for first-party Claude rows, `'openrouter'` for provider-prefixed third-party rows,
and `'manual'` otherwise. A row left on the column default reads as `manual`. The next fetch
replaces a `manual` Claude row, but until then the admin tab shows the wrong source, and a
`manual` third-party row is replaced only by an explicit OpenRouter import. Keep following the
dateless-id and explicit-rate rules below as well.

## Authoritative sources

- **Models overview** — per-model context window, max output tokens, and API/Bedrock/Google Cloud
  model IDs: <https://platform.claude.com/docs/en/docs/about-claude/models/overview>
  (redirects from `docs.anthropic.com/en/docs/about-claude/models/overview`)
- **Pricing** — per-model `price_in`/`price_out`/cache rates, batch pricing, and which model
  generation gets the long-context window at standard pricing:
  <https://platform.claude.com/docs/en/docs/about-claude/pricing>
  (redirects from `docs.anthropic.com/en/docs/about-claude/pricing`)
- **Models API** — for a live, programmatic per-model lookup instead of scraping docs pages, the
  Models API returns `max_input_tokens`, `max_tokens`, and a `capabilities` object for every
  available model. See the "Models overview" page's tip callout for the endpoint reference.

Use `WebFetch` on the two doc URLs above (they 301-redirect once — reissue the fetch against the
redirect target) rather than `WebSearch` summaries alone; third-party pricing/context blog posts
that show up in search results are frequently stale, wrong, or written by content-farm sites
extrapolating from partial data.

## Known model-generation boundary (context window)

As of 2026-08-08: **Claude Opus 4.6 and all later models** (Opus 4.6/4.7/4.8/5, Sonnet 4.6/5,
Fable 5, Mythos 5) ship the full **1,000,000-token** context window at standard pricing (no beta
header needed — this was a beta/opt-in header in earlier generations but is now GA). Models before
Opus 4.6 (Opus 4.5/4.1/4.0, Sonnet 4.5, Haiku 4.5, Haiku 3.5, Claude 3.5 Haiku) stay at the
**200,000-token** standard window. Re-verify this boundary against the sources above before
reusing it — Anthropic ships new model generations frequently and the boundary shifts.

## Caveat: don't trust a research subagent's unverified claim

A past implementation pass asked a research subagent to look this up and it reported a
suspected prompt-injection/fabrication signal in its own tool output, so that pass defaulted
every current-generation model to the conservative 200K value rather than trust the unverified 1M
claim — which turned out to be wrong (the 1M number was real; see `0048_model_pricing_context_length_fix.sql`
in `server/drizzle/migrations/`, which corrected `0047`'s incorrect default). Lesson: when a
research pass on this topic produces a suspicious/unverifiable result, fetch the primary docs
directly (`WebFetch` on the URLs above) to confirm one way or the other, rather than defaulting to
the "safe-sounding" value — being cautious does not mean being correct, and an unverified guess is
still a guess even when it's the lower number.

## Where the backfill lives

Seeded and researched values (`chars_per_token`, `context_length`, historical/back-dated rates) are
hard-coded into dated migrations (`server/drizzle/migrations/NNNN_*.sql`). The daily fetch picks up
a **current** Anthropic rate change by itself, as a today row. It cannot back-date a change, and it
does not fill `chars_per_token` / `context_length`. For those, or for a correction to past
dates, add a new corrective migration, with an explicit `source`. Do not edit an already-applied migration file in place
(see `0040`→`0042`→`0043` and `0047`→`0048` for the established correction pattern in this repo).

The latest refresh is `0064_model_pricing_2026_09_refresh.sql` (2026-09-23): it added Opus 5.5,
Fable 5.1 and Mythos 5.1, gave Sonnet 5 a `2026-09-01` row at $2/$10 (the scheduled increase to
$3/$15 was cancelled, so the docs' "standard" rate is now the launch rate), and added the missing
dateless rows `claude-sonnet-4-5`, `claude-sonnet-4`, `claude-opus-4` and `claude-3-5-haiku`.

**Store the dateless (alias) id.** Every cost lookup — server SQL (`REGEXP_REPLACE(model, '-[0-9]{8}$', '')`)
and both client parsers (`.replace(/-\d{8}$/, '')`) — strips a `-YYYYMMDD` suffix before matching,
so a dated-only row is unreachable while the alias row serves both spellings. That is exactly how
`claude-opus-4-20250514` and `claude-3-5-haiku-20241022` sat in the table for months while sessions
on those models still resolved to `unknown-model`.
