# PoC: evidence-backed Turn-End Cost Advisor

Task: none yet — an exploration of the session Advisor tab
(see [turn-end-cost-advisor.md](../../knowledgebase/turn-end-cost-advisor.md)).

## Question

The advisor's advice is generic ("batch tool calls", "shorten CLAUDE.md", "use /compact", "use one
shell"). Does giving the model computed, number-backed evidence from the transcripts plus a strict
"no generic advice" bar produce advice that is specific and worth acting on?

## What it does

- `evidence.mjs` — computes, from the main transcript and every subagent/workflow transcript next
  to it: cost split (session vs agents, by token kind), context per call, cost per user prompt with
  context at its start and end, a per-agent table (description, type, model, calls, cost, context),
  cache rebuilds with their cause, the tool results that cost most to carry in context, files read
  repeatedly, failed tool calls. Prices are list prices (estimate).
- `prompt-v2.mjs` — the proposed prompt: same JSON shape as today
  (`{ general, costFactors[], harnessAdvice[] }`, so the server and UI need no change), evidence
  first, a bar every advice item must clear, a list of banned generic advice, empty arrays allowed.
- `run.mjs` — builds today's prompt (the hook's own `buildAdvisorPrompt` over a locally derived
  aggregate) and the v2 prompt for the same session, runs both through the hook's `callLlmAsync`
  (`claude -p`, isolated, Sonnet) and writes `out/<id>.json`.

## How to run

From this folder (needs `claude` on PATH; spends a few cents per session):

```sh
node run.mjs <claude transcripts dir of the project> <session id prefix>... [--model sonnet] [--dry]
```

`--dry` only builds the evidence and the v2 prompt. `out/` is gitignored — it holds real prompts.

## Result

(filled in below)
