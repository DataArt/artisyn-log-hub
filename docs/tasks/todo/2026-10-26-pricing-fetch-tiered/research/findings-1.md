## Findings for the plan: pricing fetch fix and prompt-length tiered pricing

### Requirements summary
The work has two parts.

1. **Fix the Anthropic fetch.** `parseWebSearchPrice` has to accept `$N USD per 1,000 searches` as well as the old `$N per 1,000 searches`. If no web-search price is found, the whole fetch still fails.
2. **Model prompt-length tiers.**
   - Add a nullable `jsonb` `tiers` column to `model_pricing`, holding `[{aboveTokens, priceIn, priceOut, priceCacheR, priceCacheW5m, priceCacheW1h}]` sorted by threshold. Add a matching `override_base_tiers` column to `model_pricing_meta`.
   - The parser merges each `(for prompts up to N tokens)` / `(for prompts over N tokens)` row pair into one model with one tier.
   - Cost is priced **per LLM call**. Prompt length = input + cache read + 5m write + 1h write. The highest tier whose `aboveTokens` the call strictly exceeds prices every token of that call. Web search and the fast surcharge keep today's rules.
   - The server, client and hook implementations must all agree.
   - The server stores per-call token arrays in a new 1:1 table keyed by `sessions.id` (one columnar `jsonb`). Sessions ingested before the change are costed at base rates from their aggregates.
   - The server stores each session's computed cost plus its breakdown (cost per term, the part added by tiers, which pricing row was used, unpriced reason). Every server cost reader switches to that stored value. A one-off backfill fills it using today's formula.
   - The stored cost is recomputed when tokens change and, in background batches, when a pricing write changes which row applies.
   - The admin set-price and override screens show and edit tiers. An override keeps its own tiers, and the fetch refreshes only the override base.
   - The change stays backward compatible: `GET /api/v1/model-pricing` gains an optional `tiers` field that old hooks ignore.

**Exact AC values** (Haiku 5.5 base: in 0.10, 5m 0.125, 1h 0.20, read 0.01, out 0.50; above-100k tier: 0.5 / 0.625 / 1 / 0.05 / 2.5):

| Case | Cost |
|---|---|
| AC1: web search = 10 / 1000 | **0.01** per request |
| AC3: 60,000 input + 50,000 cache read = 110,000 (&gt; 100,000), tier rates | 0.03 + 0.0025 = **0.0325** |
| Same call at base rates (the wrong answer) | 0.006 + 0.0005 = **0.0065** |
| 90,000 input at base | **0.009** |
| Exactly 100,000 input at base (not strictly above) | **0.01** (it would be 0.05 at tier rates) |
| AC4a example: the 110k call + the 90k call, per call | **0.0415** |
| Same two calls costed from aggregates at base (FR5b path) | **0.0155** |

### Wireframes
None referenced.

### Knowledgebase
- `docs/knowledgebase/algorithms/cost-formula.md`
  - The CF-xx `examples` block drives three table tests: `server/src/logs/cost.sql.algo.spec.ts`, `client/src/viewer/lib/format.algo.test.ts` and `hook/.claude/telemetry_tool/__tests__/cost-formula.algo.test.js`.
  - Rows marked `"only": "server"` are skipped by the twins. Tolerance is 1e-9.
  - Required sections: Purpose, Code, Input/output, Rules, Edge cases, Examples, Mutations, Where visible.
  - The current input shape is `{tokens, pricing}`. Per-call rows need a new input shape (e.g. `calls: [...]` plus `pricing.tiers`), and all three test loaders must change with it.
- `docs/knowledgebase/algorithms/README.md`
  - Format for a new doc: front matter `reviewed: no` / `reviewer: none`, one ```` ```examples ```` JSON block, test placed next to the code.
  - Add the new `anthropic-pricing-parse` doc to the table there. `scripts/__tests__/algo-docs.test.js` loads every doc.
- `docs/knowledgebase/model-pricing-research.md` § Live price sync
  - Covers the parser rules (first-row-wins duplicate, fail-closed, `MIN_PARSED_MODELS = 5`, `MAX_RATE`), the today-row rule in `writeEffectivePrices`, the override/meta-base rules, the OpenRouter import and the admin action matrix.
  - The parser and apply-rules text needs updating.
  - Lines 105-107 currently document "a tiered model takes its first tier".
- `docs/knowledgebase/llm-call-math.md`
  - §2: the single-implementation rule ("a twelfth hand-written cost expression is review-blocking"), the list of `sessionCostSql` call sites, price date (`sessionPriceDateSql` / `pricingAsOfSql`), `costBreakdown`, and utility calls.
  - §3: the `model_pricing` column table and the "all rates only in the DB" rule.
  - §1: `sumCtxTokens` (input + cache_read + cache_creation) — the same "prompt length" definition FR4 needs.
- `docs/knowledgebase/db-schema-code.md`
  - Migrations are hand-written SQL (never `drizzle-kit generate`).
  - Register each one in `meta/_journal.json`, then run `npm run migrations:lock`.
  - No `CONCURRENTLY`. CHECK constraints live only in SQL, noted by a comment in the schema.
- `docs/knowledgebase/db-tables.md`: the `model_pricing`, `model_pricing_meta`, `session_stats` and `session_request_ids` sections need updating, and the new tables need entries.
- `docs/knowledgebase/session-metrics-scope.md`: the tree-rollup rule (root plus every descendant, the `descendantSessionsCte` helpers). The stored cost per session must still be rolled up at read time.
- `docs/knowledgebase/api-reference.md`: entries for `GET /api/v1/model-pricing` and the admin pricing routes.
- `.claude/skills/migrations-data-integrity/SKILL.md`: committed migrations are immutable, and the plan must include an analysis of edge cases in production data.
- `.claude/rules/hook.md`: bump `hook/.claude/telemetry_tool/version.json`, run `npm run build:hooks-installer`, refresh `.artisyn/marketplace/plugins/log-hub-hooks/`, then run the `update-install-instructions` skill.

### Existing patterns
**Parser and fetch**
- `server/src/model-pricing/anthropic-pricing-parser.ts`
  - :161-166 `parseWebSearchPrice` — the bug is the regex `/\$([\d,]*\.?\d+) per 1,000 searches/`.
  - :48 `if (!modelId || result.has(modelId)) continue;` drops the second tier row silently.
  - :125-141 `toModelId` strips the trailing parenthetical (:130). This is where `up to` / `over N tokens` must be captured.
  - :144-158 `PRICE_RE`, `parsePrice` and `isValidRate` are reusable for tier rates.
- `server/src/model-pricing/model-pricing.types.ts:21-30` `ModelPricingRates`: add `tiers`. It is also mirrored in `client/src/models/pricing.ts:46-55`, along with `ModelPricingEntry` :12-24 and `ModelPriceInput` :101-111.
- `server/src/model-pricing/model-pricing-rates.ts`
  - :94-108 `ratesEqual` must also compare tiers (requirement: a tier change writes a new version).
  - :129-140 `pickRates` must carry tiers.
  - :152 `deriveModelState`.
- `server/src/model-pricing/model-pricing-store.ts`
  - :125-154 `selectNewestVersions` (row → `PriceVersion` mapping).
  - :156-179 `toMeta` (meta base → `ModelPricingRates`).
  - :241-305 `writeEffectivePrices`: the insert values and the `onConflictDoUpdate` set list both need `tiers`.
  - :311-357 `setOverrideBase` / `clearOverrideBase`: add `override_base_tiers`.
- `server/src/model-pricing/anthropic-pricing-fetch.service.ts`
  - :98-140 `persist`: the override branch writes only the meta base.
  - :169-178 `carryForward`: tiers come from the page, not carried forward.
  - Hooking a recompute trigger after commit fits here.
- `server/src/model-pricing/openrouter-import.service.ts`: writes `NULL` tiers.

**Admin edits**
- `server/src/model-pricing/model-pricing-admin.service.ts`
  - :275-292 `setPrice`, :301-324 `setOverride`, :332-344 `clearOverride`.
  - :367-390 `withDefaults`: tier defaults and validation go here, and a `BadRequestException` produces the 400.
- `server/src/model-pricing/dto/model-price-input.dto.ts`: the class-validator DTO. Add an optional nested `tiers` (`@ValidateNested`, `@Type`) plus the strictly-increasing check.

**Cost formula and readers**
- `server/src/logs/cost.sql.ts`
  - :99-107 `pricingColumnsSql` (add `tiers`), :146-152 `pricingAsOfSql`, :200-209 `sessionCostSql`.
  - :265-293 `computeSessionCost`, the TypeScript twin. The per-call tier picker belongs next to it, and the requirement says the recompute uses it.
- `server/src/logs/model-pricing.controller.ts:56-111`: the public `GET /api/v1/model-pricing`. Add optional `tiers` to the select and response.
- Server cost readers to switch to the stored cost:
  - `logs/repositories.controller.ts`: sessions list :645-750, which falls back to raw-JSONB `session_events` when there is no `session_stats` row; session stats :1247; timeline/branches :2701-2888.
  - `logs/reports/executive-summary.service.ts` :441 and :494.
  - `logs/reports/attribution-breakdown.service.ts` :411 and :455.
  - `logs/reports/cache-read-ratio.service.ts` :590-700. It prices only the cache terms, so it should read the per-term breakdown.
  - `logs/analytics/active-sessions.service.ts:143`.
  - `logs/turn-end-cost-advisor/turn-end-cost-advisor.service.ts:302`.
  - `sessions/sessions.service.ts:301-335` (delete-time audit row).
  - `logs/otel-cost.sql.ts:225` (utility calls per OTEL call; see gaps).

**Ingest**
- `server/src/logs/claude-extractor.ts`
  - :849-898 `lastUsageByMessageId`: usage is deduplicated per `message.id` (falling back to uuid), not per `requestId`.
  - :1092-1112 the totals loop. This is where per-call arrays come from, so their sum equals the `session_stats` totals.
  - :274 / :855-866 `requestIds`.
- `server/src/logs/session-stats-writer.ts`
  - :28-106 `upsertSessionStatsRow`.
  - :124-147 `replaceSessionRequestIds`: the delete-then-insert, rewrite-on-every-upsert pattern the per-call table should copy.
  - Three call sites: `logs.service.ts:422-423` (upload), `logs.service.ts:1029-1030` (import merge), `repositories.service.ts:1432-1433` (recompute-all, in a transaction).

**Schema and migrations**
- `server/src/database/schema/index.ts`
  - :387-402 `sessionRequestIds`: a 1:1 or child table with an FK cascade on `sessions.id`; use it as the template.
  - :513-565 `modelPricing`, :571-610 `modelPricingMeta`, :648+ `sessionStats`.
- `server/drizzle/migrations/0071_otel_api_calls_request_ids.sql`: header-comment style (additive-only, lock profile, guarded re-runnable statements, robust backfill). Use it as the template for the new migration and backfill.
- Next migration: `0074_*`. Journal `idx` 74, `when` = 1790812800000 + 86400000 = **1790899200000**. Then run `npm run migrations:lock`.
- `0066_model_pricing_source.sql` is the precedent for pricing schema changes.

**Client**
- `client/src/viewer/lib/format.ts:57-73` `computeCost`. Callers that price aggregated breakdowns:
  - `session-log/log-parser.ts:1537`, :1567, and the per-turn sum :2350-2420. The last one also folds sub-agent `toolUseResult.usage` aggregates.
  - `PromptTurnTokenMetrics.tsx:114`, `session-info-derive.ts:392-401`, `CostBreakdownTooltip.tsx:91-108`, `call-tree/cost-utils.ts:42`, `charts/chart-data.ts:149`, `AgentActivationItem.tsx:151`.
  - `useModelPricing` in `client/src/viewer/hooks/useModelPricing.ts`.
- Admin UI:
  - `client/src/viewer/pages/admin/tabs/AdminModelPricingTab.tsx` (227 lines).
  - `model-pricing/ModelPriceDialog.tsx` (198), `priceForm.ts` (125), `modelPricingColumns.tsx` (170).
  - Data hook: `client/src/viewer/hooks/useAdminModelPricing.ts`.
  - The `ui-components` skill and the client component-size post-impl check apply.

**Hook**
- `hook/.claude/telemetry_tool/post-turn-analysis-worker.js`
  - :959-1035 `deriveTokenTotals`, which deduplicates per `message.id` like the server. It needs a per-call list.
  - :1096-1107 `fetchModelPricing`.
  - :1118-1131 `computeLocalSessionCost`, exported :1823.
  - :1144-1176 `priceLocalAggregate`.
- Keep the old signature working (tiers absent means base rates), so a new hook still works against an old server.

**Tests**
- Algorithm tests:
  - Extend `cost-formula.md` with tier rows for AC3 and AC4.
  - Add a new `docs/knowledgebase/algorithms/anthropic-pricing-parse.md` with `server/src/model-pricing/anthropic-pricing-parser.algo.spec.ts`, using inline markdown snippets as inputs for AC1 and AC2.
  - There is no page fixture in the repo today, and the fetch is disabled in both stands (`tests/scenarios/modes.ts:35`, `server/test/contract/setup/global-setup.ts:66`).
- Contract registry `server/test/contract/registry/f22-pricing-tool-versions.ts`:
  - :18-22 `RATES_JSON`: both `F22-public-pricing` (map JSON compare) and `F22-admin-list` (`strict: true`, effective/base JSON) must gain `tiers`.
  - The `F22-set-price` / `F22-override` / `F22-override-clear` writes have `watch: ['model_pricing','model_pricing_meta']`. Any write to the stored-cost table must be listed in `derived`.
  - Add tier rows and invalid-tier 400 rows.
- Other contract files:
  - `f23-export-import.ts:253-270` `F23-recompute` `derived: [...]`: add the per-call and stored-cost tables.
  - The world fixture is `server/test/contract/fixtures/world-v1.sql.ts`. It inserts `session_stats` (:1188-1234) and `model_pricing` (:1733) with raw SQL **after** migrations.
  - Oracle cost SQL is in `registry/oracle-sql.ts:11-35` (`ownCostSql` / `treeCostSql`). F17, F20 and F21 compare `totalCost` against it.
- Scenarios:
  - `tests/scenarios/view/s-cost-01.spec.ts` (one cost everywhere) and `s-cost-02.spec.ts` (formula, golden GS-04) suit AC4a and AC4b.
  - `s-cost-03.spec.ts` covers the unpriced/public-prices case.
  - `auth/s-adm-01.spec.ts` only walks the Model Pricing tab. No scenario edits prices through the UI.
  - Golden data lives in `tests/golden/` (`check-arithmetic.mjs`, `repo-gold.expected.json`). The scenario doc is `docs/qaa-overview/scenarios/03-session-view-reports-golden.md`.
  - No Haiku 5.5 price exists in any migration or fixture, so a scenario has to seed one through the admin API or SQL.

### Open gaps
1. **Per-call key.** FR5a says "one entry per distinct transcript `requestId`", but the server extractor, client parser and hook all deduplicate usage by `message.id`. The plan has to pick one key and keep the per-call arrays summing exactly to the `session_stats` totals.
2. **Where the stored cost lives.** It needs a new table or columns (cost per term, tier delta, the `model` / `effective_from` / `source` used, `costUnavailableReason`). There is no existing pattern for a stored computed cost, and the requirements give no shape.
3. **Background recompute.** There is no existing job or queue to reuse for "after the pricing write commits, in batches". The closest are the `UploadQueueSchedulerService` and `ModelPricingScheduler` patterns. Async writes to the stored-cost table would race with the contract `write` snapshots on the F22 admin rows. The plan must choose: synchronous in tests, `derived`, or something else.
4. **Price-date drift.** The stored cost depends on `sessionPriceDateSql` (`MIN(logs.start_time)`). An earlier chunk arriving late, or `tests/scenarios/helpers/time-shift.ts` `shiftSessionTree`, changes the price date with no token change. The recompute triggers must cover this.
5. **Fixtures bypass ingest and the migration backfill.** The contract world-v1 inserts `session_stats` after migrations, so it gets no stored cost unless the fixture inserts it or readers fall back. The same applies to `F23-recompute`.
6. **Rollups and sub-agents.** Readers roll up root + descendants (`descendantSessionsCte`) and price sub-agents at the **root's** date. The stored per-session cost must be computed at the root's date for descendants.
7. **Sessions list without a `session_stats` row.** The list falls back to the raw-JSONB `session_events` aggregate (`repositories.controller.ts:676-697`). A stored value has no equivalent for that case yet.
8. **Utility (OTEL) calls are not in scope.** `otel_api_calls` are already per call, but FR4/FR5 do not say whether tiers apply to them in `utilityCostsCte`. It stays SQL with `sessionCostSql`, which the requirement says should become formula-only.
9. **Client per-call data.**
   - Per-turn `tokenBreakdown` sums several calls, and the session summary folds sub-agent `toolUseResult.usage` aggregates (`log-parser.ts:2380-2402`), which have no per-call split.
   - `CostBreakdownTooltip` and `session-info-derive` derive term rows from aggregates.
   - The client needs a per-call list per turn and a way to show the tier delta. There is no existing structure for it.
10. **Tier validation.** No validator exists for nested `jsonb` arrays in the DTOs. The shape check and the strictly-increasing thresholds rule have to be written from scratch, and shared by the admin DTO, the fetch and the meta base.
11. **Parser fixture.** There is no stored copy of the pricing page. AC1 and AC2 rows must embed markdown snippets, and the doc must state where the current-page snippet came from.
12. **Scenario for AC5 (admin edits tiers).** No scenario edits prices in the UI. The plan must name one to extend (`s-adm-01` or `s-cost-0x`), and a Haiku 5.5 price must be seeded.
13. **Hook packaging.** The hook change needs a version bump, an installer rebuild, the dogfooded-install refresh and `INSTALL_HOOK.md` sync. Old hooks must keep pricing at base rates when `tiers` is present but ignored.
