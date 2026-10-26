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

```examples
[
  {
    "id": "AP-01",
    "input": {"lines": [
      "## Model pricing",
      "",
      "The following table shows pricing for all Claude models:",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Opus 4.1 ([retired, except on Bedrock and Claude Models on Google Cloud (Google managed)](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "#### Web search tool",
      "",
      "Web search is available on the Claude API for **$10 USD per 1,000 searches**, plus standard token costs for search-generated content."
    ]},
    "expected": {"count": 5, "models": {
      "claude-opus-5": {"priceIn": 5, "priceOut": 25, "priceCacheR": 0.5, "priceCacheW5m": 6.25, "priceCacheW1h": 10, "priceWebSearch": 0.01, "charsPerToken": null, "contextLength": null, "tiers": null},
      "claude-opus-5-5": {"priceCacheR": 0.2},
      "claude-opus-4-1": {"priceIn": 15, "priceOut": 75},
      "claude-sonnet-5": {"priceIn": 2, "priceOut": 10}
    }},
    "note": "Rule 2: the current wording '$10 USD per 1,000 searches' matches, 10 / 1000 = 0.01. Rules 3-4: '<sup>2</sup>' after $0.20 is ignored (first $N), the Opus 4.1 link (with '(Google managed)' inside its text) is dropped and the empty '()' left behind is a plain parenthetical, so the id is claude-opus-4-1. Five models, all with tiers null (rule 7). The pre-fix regex without '(?:\\s+USD)?' finds no price and fails the page."
  },
  {
    "id": "AP-02",
    "input": {"lines": [
      "## Model pricing",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Opus 4.1 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "#### Web search tool",
      "",
      "Web search is available on the Claude API for **$25 per 1,000 searches**, plus standard token costs for search-generated content."
    ]},
    "expected": {"count": 5, "models": {"claude-opus-5": {"priceWebSearch": 0.025}, "claude-haiku-4-5": {"priceWebSearch": 0.025}}},
    "note": "Rule 2, the old wording without 'USD' (price edited to $25 so it cannot be a default): 25 / 1000 = 0.025 on every model. A regex that demands 'USD' fails the page."
  },
  {
    "id": "AP-03",
    "input": {"lines": [
      "## Model pricing",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Opus 4.1 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "#### Web search tool",
      "",
      "Web search is available on the Claude API, plus standard token costs for search-generated content."
    ]},
    "expected": {"result": null},
    "note": "Rule 2: the web-search sentence has no '$N ... per 1,000 searches', so the whole parse is null (the fetch writes nothing). Defaulting the price to 0 would store a free web search."
  },
  {
    "id": "AP-04",
    "input": {"lines": [
      "## Model pricing",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Opus 4.1 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |",
      "| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |",
      "| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "#### Web search tool",
      "",
      "Web search is available on the Claude API for **$10 USD per 1,000 searches**, plus standard token costs for search-generated content."
    ]},
    "expected": {"count": 6, "models": {
      "claude-haiku-5-5": {"priceIn": 0.1, "priceOut": 0.5, "priceCacheR": 0.01, "priceCacheW5m": 0.125, "priceCacheW1h": 0.2, "priceWebSearch": 0.01, "tiers": [{"aboveTokens": 100000, "priceIn": 0.5, "priceOut": 2.5, "priceCacheR": 0.05, "priceCacheW5m": 0.625, "priceCacheW1h": 1}]}
    }},
    "note": "Rules 3 and 5: both Haiku 5.5 rows map to claude-haiku-5-5. The 'up to 100,000' row gives the base rates 0.10 / 0.50 / 0.01 / 0.125 / 0.20, the 'over 100,000' row (comma stripped) the tier aboveTokens 100000 at 0.50 / 2.50 / 0.05 / 0.625 / 1. Seven table rows, six models. The pre-fix parser kept only the first row (no tier)."
  },
  {
    "id": "AP-05",
    "input": {"lines": [
      "## Model pricing",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Opus 4.1 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
      "| Claude Haiku 5.5 (For Prompts Over 100,000 Tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
      "| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "Web search is available on the Claude API for **$10 USD per 1,000 searches**."
    ]},
    "expected": {"count": 6, "tiered": ["claude-haiku-5-5"], "models": {
      "claude-haiku-5-5": {"priceIn": 0.1, "tiers": [{"aboveTokens": 100000, "priceIn": 0.5, "priceOut": 2.5, "priceCacheR": 0.05, "priceCacheW5m": 0.625, "priceCacheW1h": 1}]},
      "claude-opus-5": {"tiers": null},
      "claude-haiku-4-5": {"tiers": null}
    }},
    "note": "Rule 5: the pair in reverse order (the 'over' row first, in title case — the bound is case-insensitive) still merges to the same base 0.10 and tier above 100000. Rule 7: the five other models have tiers null, so only claude-haiku-5-5 is tiered. Taking the first row as the base would give priceIn 0.5."
  },
  {
    "id": "AP-06",
    "input": {"lines": [
      "## Model pricing",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Opus 4.1 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
      "| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "Web search is available on the Claude API for **$10 USD per 1,000 searches**."
    ]},
    "expected": {"result": null},
    "note": "Rule 6: the Haiku 5.5 'up to' row is removed from the copy, so its 'over' row has no base row and the whole parse is null. Skipping just that model, or using the tier rates as the base, would store wrong prices."
  },
  {
    "id": "AP-07",
    "input": {"lines": [
      "## Model pricing",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Opus 4.1 | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
      "| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |",
      "| Claude Haiku 5.5 (for prompts over 200,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "Web search is available on the Claude API for **$10 USD per 1,000 searches**."
    ]},
    "expected": {"result": null},
    "note": "Rule 6: the copy's 'over' threshold is edited to 200,000 while the base row says 'up to 100,000' (M = 100000 != N = 200000): prompts between the two would have no defined price, so the whole parse is null."
  },
  {
    "id": "AP-08",
    "input": {"lines": [
      "## Model pricing",
      "",
      "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
      "| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
      "| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |",
      "| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
      "",
      "Web search is available on the Claude API for **$10 USD per 1,000 searches**."
    ]},
    "expected": {"result": null},
    "note": "Rule 7: five table rows, but the Haiku 5.5 pair merges into one model, so 4 models < MIN_PARSED_MODELS = 5 and the parse is null. Counting table rows would accept the page."
  }
]
```

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
