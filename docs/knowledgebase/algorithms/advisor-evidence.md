---
reviewed: no
reviewer: none
---

# Advisor evidence: per-call price, cache rebuilds, cost per prompt

## Purpose

The Turn-End Cost Advisor's LLM gives advice only from the figures it is shown. These rules turn
the session's transcripts into those figures: what each API call cost, which calls re-wrote the
cache and why, and what each user prompt cost. A wrong figure here becomes a wrong "start a fresh
session at prompt N" on the Advisor tab.

## Code

- Implementation: `hook/.claude/telemetry_tool/advisor-evidence.js` (`makePricer`,
  `collectCalls`, `cacheRebuilds`, `buildPromptCosts`; `buildAdvisorEvidence` assembles the text),
  and `buildPromptTurns` in `post-turn-analysis-worker.js` (queued prompts, rule 9).
- Twins: none. The per-call formula is the same as [cost-formula](cost-formula.md), applied per
  call with the server's rates through the hook's `pickCallRates`.
- Test: `hook/.claude/telemetry_tool/__tests__/advisor-evidence.algo.test.js` (`node --test`).

## Rules

Pricing (`makePricer`):

1. A call's rates are the server's `GET /api/v1/model-pricing` entry for its model, tier picked by
   `pickCallRates` on the call's prompt size (input + cache read + both cache writes). A model the
   server does not price falls back to list prices: opus/fable 5 / 25, sonnet 3 / 15, haiku 1 / 5,
   anything else 3 / 15 $/Mtok input / output; cache read 0.1x input, 5-minute write 1.25x,
   1-hour write 2x.
2. `usage.cache_creation` splits the cache write into 5-minute and 1-hour parts; without it (or
   with both parts 0) the whole `cache_creation_input_tokens` is a 5-minute write.
3. `usage.speed == "fast"` multiplies input and output tokens by `FAST_MODE_MULTIPLIER` (2).
4. Parts: `read = cacheRead * rCacheR`, `write = w5m * rW5m + w1h * rW1h`, `output = out * fast * rOut`,
   `input = in * fast * rIn`, all `/ 1e6`.

Calls (`collectCalls`):

5. One call per `message.id`; a later entry with the same id replaces the usage (the last streamed
   chunk carries the final output count). Context of a call = input + cache read + cache writes.

Cache rebuilds (`cacheRebuilds`):

6. Call `i > 1` is a rebuild when its cache write is at least `REBUILD_MIN_TOKENS` (20000) and at
   least half of call `i-1`'s context.
7. Cause, first match: the model differs from call `i-1` -> `model switched A -> B`; else the gap
   to call `i-1` exceeds the TTL (60 min when either call wrote a 1-hour cache, else 5 min) ->
   `<round(gap/60)> min since the previous call > cache TTL <ttl> min`; else
   `unknown (the cached prefix changed)`.
8. Extra cost = the call's write cost times `1 - 0.1 / (2 if it wrote a 1-hour cache else 1.25)`,
   i.e. the write minus reading the same tokens from the cache.

Prompts (`buildPromptCosts`, `buildPromptTurns`):

9. In entry order, each of these starts a new prompt; every later call belongs to it until the next:
   - a user entry whose string content starts with `<task-notification>` -> automatic,
     `(automatic turn: a background task finished)`;
   - a user entry with `isCompactSummary` -> automatic, `(context compacted: ...)`;
   - an `attachment` of type `queued_command`: origin `human` or none -> a user prompt
     `<text> (typed while the model was working)`; otherwise automatic, a background task text as
     above, any other as `(automatic turn: <origin kind>) <first 150 chars>`;
   - any other user entry `isQualifyingUserEvent` accepts, except a `<local-command…` output.
   `buildPromptTurns` (used by attribute extraction too) adds the human `queued_command` prompts
   and nothing else from this list.
10. A prompt's `calls`, `usd` (sum of call costs), `ctxStart` (first call's context) and `ctxEnd`
    (last call's) cover its calls only; calls before the first prompt belong to none.

## Edge cases

- No `cache_creation` split: AE-P03. Unknown model family: AE-P04. Fast mode: AE-P05.
- Server rates win over list prices: AE-P06; tier above `aboveTokens`: AE-P07.
- Growth that is not a rebuild (under half the previous context): AE-R04; below 20000: AE-R05.
- 1-hour TTL not exceeded -> unknown cause: AE-R02. Model switch checked first: AE-R03.
- Queued human prompt: AE-C02, AE-T01. Automatic turns keep user numbering: AE-C03, AE-C05.
- Local command output, meta entry, calls before any prompt: AE-C04.

## Examples

`input.kind` selects the function. `price`: `{model, usage, pricing?}` -> the four parts in $.
`rebuilds`: `calls[]` of `{t (seconds), model, input, read, write5m, write1h}` -> rebuilds
`{callNo, tokens, extraUsd, cause}`. `prompts`: `events[]` of `{user}`, `{meta}`,
`{queued, origin?}`, `{notification}`, `{compact}`, `{call: <context>}` (an opus call that only
reads its context from the cache) -> prompts, compared on the keys each expected row lists.
`turns`: the same events -> `buildPromptTurns` texts.
Rows (18): [`docs/algorithm-examples/advisor-evidence.json`](../../algorithm-examples/advisor-evidence.json) — test data for the table test.

## Mutations

- Whole cache write priced as 1-hour when no split is given -> AE-P03.
- List prices used although the server prices the model -> AE-P06.
- Tier ignored -> AE-P07.
- Rebuild when the write is merely over 20000 (half-context check dropped) -> AE-R04.
- Idle checked before the model switch -> AE-R03 (gap 30 s still shows the switch).
- Queued prompts ignored -> AE-C02, AE-T01; task notifications counted as user prompts -> AE-C03.

## Where the result is visible

The Advisor tab of a session (Turn-End Cost Advisor): the figures in "Summary", "Cost factors" and
"Harness advice" come from this evidence. Session Attributes: queued prompts now reach the
attribute extractor through `buildPromptTurns`.
