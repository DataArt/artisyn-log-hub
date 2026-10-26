# 2026-10-26: Fix Anthropic Pricing Fetch and Add Prompt-Length Tiered Pricing

**Status:** todo
**Priority:**
**Type:** bug
**Module(s):** server, client, hook
**Owner:** denis.tsyplakov
**Created:** 2026-10-26
**Tracker:** GH-35 https://github.com/DataArt/artisyn-log-hub/issues/35

## Description

Raw idea (from the local prod log review, 2026-10-26):

> Fix the Anthropic pricing fetch, and correct the cost calculation for models whose price changes
> with the prompt length — store it as an extra field in the pricing table: the price above some
> context-length threshold. Keep reading prices from Anthropic (the official pricing page), not from
> OpenRouter / LiteLLM.

**1. The fetch is broken.** Local prod logs
`Anthropic pricing fetch failed: unexpected pricing page layout at https://platform.claude.com/docs/en/about-claude/pricing.md (model table or web-search price not found)`
on every run since at least 2026-10-22 (the oldest log file), with no successful run in between. The
page's model table still parses. The failure is in `parseWebSearchPrice`
(`server/src/model-pricing/anthropic-pricing-parser.ts`): the page now says
`**$10 USD per 1,000 searches**`, and the regex expects `$10 per 1,000 searches`.

**2. Tiered pricing is not modelled.** The page now lists **Claude Haiku 5.5** twice:
`(for prompts up to 100,000 tokens)` at $0.10 / $0.125 / $0.20 / $0.01 / $0.50 per MTok, and
`(for prompts over 100,000 tokens)` at $0.50 / $0.625 / $1 / $0.05 / $2.50. `toModelId` strips the
parenthetical, so both rows map to `claude-haiku-5-5`, and the second row is silently skipped as a
duplicate. Requests over the threshold are costed about 5x too low.

The page's own rule ("Long context pricing" section): a request's prompt length counts **all of its
input tokens, including cache reads and cache writes**. Each request is priced on its own. A request
over the threshold pays the higher prices for **all** its tokens (input, cache, output), even when
part of its prompt is a cache hit.

Relevant docs: `docs/knowledgebase/llm-call-math.md`, `docs/knowledgebase/algorithms/cost-formula.md`,
`docs/knowledgebase/model-pricing-research.md`, and the model-pricing KB article on sources,
overrides and `model_pricing_meta`.

## Functional Requirements

- FR1. The web-search price is parsed from the current page wording (`$N USD per 1,000 searches`)
  and from the old one (`$N per 1,000 searches`). A missing or unparseable web-search price still
  fails the whole fetch, as today.
- FR2. The pricing table (`model_pricing`) gets one nullable `jsonb` column with the model's
  prompt-length tiers. It stays one row per model price; there is no separate tier table and no
  extra rows per tier. The column holds an array of tiers sorted by threshold, for example
  `[{ "aboveTokens": 100000, "priceIn": 0.5, "priceOut": 2.5, "priceCacheR": 0.05, "priceCacheW5m": 0.625, "priceCacheW1h": 1 }]`.
  Each tier carries the full rate set that applies when the prompt is above `aboveTokens`. Models
  without tiered pricing keep it `NULL`. The shape is validated on write (admin edit, fetch): the
  thresholds are positive and strictly increasing, and every rate is valid under the same limits as
  the base rates.
- FR3. The Anthropic parser reads `(for prompts up to N tokens)` / `(for prompts over N tokens)`
  row pairs into one model with base rates (up to N) and above-threshold rates (over N, threshold N).
  It no longer drops the second row silently.
- FR4. Cost calculation picks the rate set per LLM call. It takes the highest tier whose
  `aboveTokens` the call's prompt length (input + cache-read + cache-write tokens) exceeds, and
  prices every token of that call at that tier's rates. If no tier matches, the base rates apply.
  Web search and the fast-mode surcharge keep their current rules.
- FR5. Every cost implementation listed in `algorithms/cost-formula.md` (server, client, hook)
  applies FR4 identically, so the server and the client land on the same cost for the same session.
- FR5a. The server stores the token counts of every LLM call of a session at ingest, as **one row
  per session**: a 1:1 table keyed by `sessions.id` with one `jsonb` column in columnar form — an
  object whose keys are the `session_stats` token kinds and whose values are arrays where index
  `i` is call `i`, e.g. `{"inputTokens":[…],"outputTokens":[…],"cacheReadTokens":[…],"cacheWrite5mTokens":[…],"cacheWrite1hTokens":[…],"inputTokensFast":[…],"outputTokensFast":[…]}`.
  A new token kind is a new key; a key missing from an older row reads as all zeros, so no
  migration is needed for it. All arrays of a row have the same length (validated on write). A
  call's prompt length is input + cache read + 5m + 1h write at its index. Web search is not tiered
  and stays only in `session_stats`. The arrays hold raw counts, never a split by threshold, so a
  later change of thresholds or tiers can reprice without re-ingest.
- FR5b. A session without stored per-call data (ingested before this change) is costed from its
  `session_stats` aggregates at base rates, as today.
- FR5c. The server stores each session's computed cost together with its breakdown: the cost per
  term (input, output, cache read, 5m/1h cache write, web search, fast surcharge), the part added
  by tiers, which pricing row was used (model, `effective_from`, source), and the unpriced reason
  when there is none. Every server reader of a session's computed cost — sessions list, session
  Info/Summary, analytics, executive summary, team reports, the delete-time audit row — reads this
  stored value instead of computing it in its query.
- FR5d. The stored cost is recomputed when the session's tokens change (new chunk, re-upload) and
  when a pricing write changes which pricing row or tiers apply to it (fetch, OpenRouter import,
  admin set price, override set/clear). The recompute covers only the sessions of the changed
  model whose pricing lookup resolves to the changed row; because price versions are dated, a new
  version does not touch sessions dated before it.
- FR6. The admin model-pricing view/edit (set price and override) shows and accepts the tiers
  (threshold and above-threshold rates).
- FR7. Tiers follow the existing override rules: an admin override carries its own tiers (e.g. a
  negotiated discount), and the fetch never overwrites them. Under an active override the fetch
  refreshes only the hidden override base, tiers included.
- FR8. Backward compatibility: existing pricing rows and stored data remain valid. A model with no
  tiers is costed exactly as today.

## Acceptance Criteria

- [ ] AC1 (FR1). The parser on a fixture copy of the current page returns a price table with web
  search = $0.01 per request. The old wording still parses too. Without any web-search price the
  parser returns `null`.
- [ ] AC2 (FR2, FR3). On the same fixture, `claude-haiku-5-5` is one row with base input
  $0.10/MTok. Its tiers column holds one tier: `aboveTokens` 100,000, input $0.50/MTok, output
  $2.50/MTok, cache read $0.05, 5m write $0.625, 1h write $1. Every other model has tiers `NULL`.
- [ ] AC3 (FR4). For a Haiku 5.5 call with 60,000 input + 50,000 cache-read tokens (110,000 total),
  all its tokens are costed at the above-threshold rates. A 90,000-token call and a call of exactly
  100,000 tokens are costed at base rates. These are rows in `algorithms/cost-formula.md`.
- [ ] AC4 (FR5). The same rows pass in the server, client and hook algorithm tests.
- [ ] AC4a (FR5, FR5a). A Haiku 5.5 session with one call over 100,000 tokens and one under shows
  the same cost in the sessions list, session Info, Summary and the client per-turn view; after an
  admin changes the threshold, all of them show the new cost without re-uploading the session.
- [ ] AC4b (FR5b). A session ingested before the change keeps its current cost.
- [ ] AC4c (FR5c). After the backfill every existing session has a stored cost equal to the cost the
  current queries return for it; the sessions list, analytics, executive summary and team reports
  show the same numbers as before the change.
- [ ] AC4d (FR5d). An admin override on a model updates the stored cost of that model's sessions
  dated on or after the override, and leaves older sessions and other models' sessions untouched.
- [ ] AC5 (FR6). An admin sees and can edit the tiers for a model, both via set price and override.
  Invalid tiers (non-increasing thresholds, an invalid rate) are rejected with 400.
- [ ] AC6 (FR7). With an active override on `claude-haiku-5-5`, a fetch leaves the override's tiers
  unchanged and updates the override base tiers.
- [ ] AC7 (FR8). The migration applies on a DB with existing pricing rows. Costs for non-tiered
  models are unchanged.
- [ ] AC8. After deploy, the scheduled fetch succeeds and the log shows no
  `unexpected pricing page layout` error (manual check on local prod).

## Steps to Reproduce

1. Run the server (or local prod) and wait for the hourly `AnthropicPricingFetch`.
2. Look at the app log.

**Expected:** Prices are fetched and written.
**Actual:** `Anthropic pricing fetch failed: unexpected pricing page layout ... (model table or web-search price not found)`, nothing written.

## Common sense considerations

- Parser checks (AC1, AC2) are rows of a new algorithm doc `docs/knowledgebase/algorithms/anthropic-pricing-parse.md` with its own `*.algo.spec.ts` table test; inputs are page markdown snippets.
- `model_pricing_meta` gets a matching nullable `override_base_tiers` `jsonb` column for FR7.
- The "rates unchanged" check in `writeEffectivePrices` compares tiers too, so a tier change writes a new price version.
- The OpenRouter import does not read tiers; its rows carry `NULL`.
- `GET /api/v1/model-pricing` gains an optional `tiers` field; old hooks ignore it and keep pricing at base rates.
- Changed admin routes get updated rows in `server/test/contract/registry/f22-pricing-tool-versions.ts`.
- AC5 is a scenario step; no existing scenario edits prices through the admin UI, so the plan names the scenario it extends.
- The migration follows the `migrations-data-integrity` skill; no backfill — the next successful fetch writes Haiku 5.5's tiers.
- The per-call arrays are rewritten whole with every `session_stats` upsert (like `session_request_ids`), one entry per distinct transcript `requestId`, so a re-uploaded chunk does not double-count; the row is cascade-deleted with the session.
- The per-call arrays live in their own table, not in `session_stats`, so the session list and report queries never read them; only the cost recompute does.
- The recompute reads the per-call `jsonb` in TypeScript (`computeSessionCost`); no SQL does arithmetic over it.
- Each sub-agent / workflow session gets its own arrays, as it has its own `session_stats` row.
- All calls of a session are priced at the session's model (`session_stats.model`), as today; per-call model is out of scope.
- Arrays are stored for every model, not only tiered ones, so a model that gains tiers later is priced correctly for sessions ingested from now on.
- No backfill of per-call rows for existing sessions; re-uploading a session creates them.
- Existing sessions get their stored cost by a one-off backfill with today's formula, so their numbers do not change.
- The stored cost is per session; aggregates (analytics, executive summary, team reports) sum it and keep reporting unpriced sessions separately (`costUnavailableReason`).
- Pricing-triggered recomputes run in the background in batches after the pricing write commits; readers see the previous stored value until then.
- `sessionCostSql` stays only as the formula behind the recompute and the backfill; no report query calls it any more.
- Telemetry cost (`session_stats.telemetry_cost`) and the OTEL cost selection are unchanged.

## Open Questions

None.

## Notes

<!-- Append timestamped notes here as work progresses -->
- 2026-10-26: Decided to keep the official Anthropic page as the source. There is no official JSON:
  the Models API carries no prices. OpenRouter is already wired in as a secondary import. Other
  findings from the same log review (EPIPE in the cluster primary when a worker dies at startup,
  DB-not-ready startup crash, SMTP warm-up) are out of scope here.
