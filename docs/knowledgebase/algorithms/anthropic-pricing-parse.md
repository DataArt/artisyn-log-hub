---
reviewed: no
reviewer: none
---

# Anthropic pricing page parse

## Purpose

Turns the markdown rendering of Anthropic's official pricing page into one rate row per Claude
model, so the hourly fetch can keep `model_pricing` current. A page whose layout no longer matches
must fail the whole fetch (write nothing) rather than store wrong or partial prices, and a model
listed with prompt-length rows (Claude Haiku 5.5: "up to" / "over 100,000 tokens") must become
one model with a tier, not two rows of which the second is silently dropped.

## Code

- Implementation: `server/src/model-pricing/anthropic-pricing-parser.ts`
  (`parseAnthropicPricing`; helpers `toModelId`, `parsePrice`, `parseWebSearchPrice`). Tier
  validation is the shared `validatePricingTiers` from `@loghub/pricing`
  (`packages/pricing/src/tiers.ts`, re-exported by `model-pricing-rates.ts`); the minimum model
  count is `MIN_PARSED_MODELS = 5` in `model-pricing.constants.ts`.
- Caller: `server/src/model-pricing/anthropic-pricing-fetch.service.ts` (network fetch, carry
  forward of `charsPerToken` / `contextLength`, the write). Not covered here.
- Twins: none.
- Test: `server/src/model-pricing/anthropic-pricing-parser.algo.spec.ts`.

## Input and output

Input: the page's markdown. Output: a map from model id to `{priceIn, priceOut, priceCacheR,
priceCacheW5m, priceCacheW1h, priceWebSearch, charsPerToken, contextLength, tiers}`, or `null`
when the page cannot be parsed. Token rates are USD per million tokens, `priceWebSearch` USD per
request, `charsPerToken` and `contextLength` always `null` (they are not on the page).

## Rules

1. Find the `## Model pricing` heading and the first pipe table after it (before the next
   heading). Columns are located by header text, case-insensitive: `model`, `base input`,
   `5m cache write`, `1h cache write`, `cache hits`, `output`. A missing heading, table or column:
   `null`.
2. Web search: the first `$N per 1,000 searches` or `$N USD per 1,000 searches` anywhere on the
   page (regex `/\$([\d,]*\.?\d+)(?:\s+USD)? per 1,000 searches/`); `priceWebSearch = N / 1000`,
   rounded to 6 decimals. None found: `null`.
3. Model cell -> id: drop markdown links and `<sup>` notes; read a trailing
   `(for prompts up to N tokens)` / `(for prompts over N tokens)` (case-insensitive, commas in
   `N` allowed) as the row's bound; drop any other trailing parenthetical. The rest must be
   `Claude <Opus|Sonnet|Haiku|Fable|Mythos> <major>[.<minor>]`; other rows are skipped. Major >= 4
   gives `claude-<family>-<major>[-<minor>]`, older ones `claude-<major>[-<minor>]-<family>`.
4. Rate cell: its first `$N` amount, rounded to 6 decimals. A missing, negative or out-of-range
   rate on a model row: `null`.
5. Merge rows per model id, in first-seen order:
   - a plain or `up to N` row sets the base rates; the first base row wins;
   - an `over N` row adds a tier `{aboveTokens: N, priceIn, priceOut, priceCacheR, priceCacheW5m,
     priceCacheW1h}` (no web-search price), whichever order the rows come in.
6. The whole parse is `null` when an `over` row has no base row, an `over N` row is paired with
   an `up to M` row where `M != N`, an `over` threshold repeats, or the tiers (sorted ascending)
   fail `validatePricingTiers`.
7. A model without tiers gets `tiers: null`. Fewer than `MIN_PARSED_MODELS` **merged** models
   (not table rows): `null`.

## Edge cases

- Current wording `$10 USD per 1,000 searches`: AP-01; old wording `$10 per 1,000 searches`:
  AP-02; no web-search price: AP-03.
- `<sup>` notes after a price and a link with nested parentheses in the model cell: AP-01.
- An `up to` / `over` pair merged into one model with a tier: AP-04; the same pair in reverse
  order, and every other model untiered: AP-05.
- An `over` row without a base row: AP-06; `up to 100,000` with `over 200,000`: AP-07.
- Five table rows but four merged models: AP-08.

## Examples

`input.lines` is the page markdown, one string per line (the test joins them with `\n`). The
snippets are trimmed copies of the live page
(`https://platform.claude.com/docs/en/about-claude/pricing.md`) as of 2026-10-26: the `## Model
pricing` table with a subset of its rows and the web-search sentence from the `#### Web search
tool` section; AP-02, AP-03 and AP-06 to AP-08 edit that copy as their note says.

`expected.result` is `null` when the parse must fail. Otherwise `expected.count` is the number of
models, `expected.models` maps a model id to the fields it must have (a subset match; `tiers` is
compared whole), and `expected.tiered`, when given, lists exactly the model ids whose `tiers` is
not `null`.

Rows (8): [`docs/algorithm-examples/anthropic-pricing-parse.json`](../../algorithm-examples/anthropic-pricing-parse.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Web-search regex without the optional ` USD` -> AP-01 (the 2026-10-22 outage).
- Web-search regex that requires ` USD` -> AP-02.
- A missing web-search price defaulted to `0` -> AP-03.
- The bound parenthetical stripped like any other (both rows map to one id, the second dropped as
  a duplicate) -> AP-04 (no tier).
- The first row of a pair taken as the base whatever its bound -> AP-05 (`priceIn 0.5`).
- An `over` row without a base row skipped instead of failing -> AP-06.
- `up to M` / `over N` thresholds not compared -> AP-07.
- `MIN_PARSED_MODELS` counted over table rows -> AP-08.

## Where the result is visible

- Admin -> Model pricing: the rates and the tier column of models whose source is `anthropic`,
  after the hourly fetch or "Fetch now".
- Server log: `Anthropic pricing fetch failed: unexpected pricing page layout ...` when the parse
  is `null`; nothing is written then.
