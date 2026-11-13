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

- `run-hook.mjs` — runs the prompt the hook itself now builds (`advisor-evidence.js` +
  `buildAdvisorPrompt` in `post-turn-analysis-worker.js`), priced through a Log Hub server's
  `GET /api/v1/model-pricing`, and writes `out/hook/<id>.json`.

## How to run

From this folder (needs `claude` on PATH; spends a few cents per session):

```sh
node run.mjs <claude transcripts dir of the project> <session id prefix>... [--model sonnet] [--dry]
```

`--dry` only builds the evidence and the v2 prompt. `out/` is gitignored — it holds real prompts.

```sh
node run-hook.mjs <claude transcripts dir of the project> <Log Hub server url> <session id prefix>... [--dry]
```

## Result

**Yes.** Evidence plus a strict bar turns the advisor from a list of stock tips into a short,
correct, session-specific receipt. Checked on 10 real sessions of one developer ($0.12 – $221),
Sonnet as the evaluator, by blind A/B judge agents that re-derived every figure from the raw
transcripts:

| Round | Judges | Today's prompt (v1) | Evidence prompt |
|---|---|---|---|
| v1 vs v2 | 3 Opus agents, 3-4 sessions each | 0 / 10 | 10 / 10 |
| v1 vs v3 | 1 Fable agent, all 10 sessions | 0 / 10 | 10 / 10 |

- The evidence prompt's figures were exact or conservative in every case checked (~40 by the
  final judge). v1 carried 1-2 false causal claims per session ("the local server was unreachable",
  "put X in the first prompt" when it was there, "add a CRLF rule" already in CLAUDE.md) and
  "trim CLAUDE.md" in 7 of 10 sessions.
- On cheap sessions ($0.12, $1.97) the new prompt returns no advice — the judges rated that correct.
- The advice that judges called worth acting on came from data v1 never had: the cost of each
  subagent/workflow agent (in big sessions agents are 50-90 % of the spend), cost per user prompt
  with its context size (where a fresh session would have paid: ~$25 of a $148 day), groups of
  tiny one-command agents paying a full startup context each, cache rebuilds after an idle gap or
  a long command, screenshots piling up in an agent's context, a correction that should become a
  rule in an agent brief.
- Evaluator cost is unchanged (~$0.05-0.10 per run); the prompt grows from 2-30 KB to 5-19 KB.

v2 -> v3 changes, driven by the first judges: agent briefs and tool mix in the agent table,
images and cache rebuilds per agent, tiny-agent groups, automatic turns (background-task
notifications, compaction) separated from user prompts, prompts typed while the model was busy
(`queued_command` attachments — today's `buildPromptTurns` misses them), "respect what the user
asked for", conservative savings arithmetic, a longer banned-advice list.

Remaining weaknesses (final judge, ranked):
1. "Run agent X on Sonnet" is a reflex second item; it does not weigh whether the task needs
   judgement or whether the user picked the model explicitly.
2. Fresh-session savings count only cache reads, not the new session's cache write or lost context.
3. The single most expensive agent ($26-30, 400k context) often gets no advice.
4. Small arithmetic and attribution slips.
5. Subagents write a 5-minute cache while the main session writes a 1-hour one — the root of most
   rebuild losses — is not surfaced as such.

**Adopted** in task `docs/tasks/todo/2026-11-11-advisor-evidence-advice/` (hook 2.32.0), with the
owner's decision to drop weakness 1 entirely: model-switch advice is forbidden, and only three
kinds of advice remain (fresh session at a named topic change, a rule for a recurring correction,
tiny one-command agents as one scripted step). On the same 10 sessions the hook's prompt
(`run-hook.mjs`, Sonnet) gave no advice for 5 sessions and 1-2 such items for the other 5; none
suggested another model.
