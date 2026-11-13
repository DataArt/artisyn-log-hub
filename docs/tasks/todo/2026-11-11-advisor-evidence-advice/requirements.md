# 2026-11-11: Evidence-Backed Turn-End Cost Advisor — Rock-Solid Advice Only

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook
**Owner:** denis.tsyplakov
**Created:** 2026-11-11
**Tracker:** GH-135 https://github.com/DataArt/artisyn-log-hub/issues/135

## Description

Raw idea: Turn-End Cost Advisor: evidence-backed, rock-solid advice only. The advisor (hook
`post-turn-analysis-worker.js`, `buildAdvisorPrompt`) gives generic, often wrong advice (trim
CLAUDE.md, /compact, batch calls, use cheaper model). PoC `docs/pocs/2026-11-11-2023-advisor-evidence/`
proved (blind judges, 10/10 sessions) that feeding computed evidence from the local transcripts
(incl. subagent transcripts: per-agent cost, per-prompt cost with context size, tiny one-command
agents, cache rebuilds, images in context, automatic turns, queued prompts) plus a strict bar gives
correct session-specific advice. User decision: no "run on Sonnet/cheaper model" advice at all; keep
only rock-solid advice such as "long chat — stop and start a new session at prompt N". Keep the JSON
shape `{general, costFactors, harnessAdvice}` so server/UI/old hooks stay compatible. Also fix
`buildPromptTurns` missing `queued_command` prompts. Related: `2026-11-02-session-antipatterns`
(server-side deterministic detector).

Today the prompt gets only counters (turns, tool-call counts, context sizes, the prompt list). It
has no cost per subagent or per prompt, while in large sessions agents are 50-90 % of the spend, so
the model falls back to stock tips. The PoC evidence block, priced at list prices, was exact or
conservative in every figure the judges re-derived from the raw transcripts.

## Functional Requirements

- **FR-1 Evidence block.** Before calling the LLM, the worker computes from the session's own
  transcript and every subagent / workflow-agent transcript next to it (`<session>/subagents/**/agent-*.jsonl`
  with its `.meta.json`):
  - cost split: this session vs agents; this session by token kind; context per call (first,
    median, peak, calls above 200k and their cost);
  - one line per agent (most expensive first, top 12 + a rest line): description, workflow agent or
    agent type, model, API calls, cost and its first-call startup write, context start -> peak, tool
    calls by tool, notes (still running, failed calls, images in context, cache rebuilds with cause),
    and the first 200 characters of its brief (workflow harness preamble stripped);
  - a group line for 3+ agents with at most 3 tool calls each: count, cost, startup-write share,
    examples;
  - cache rebuilds in this session with their cause (idle gap over the TTL, model switch, unknown);
  - images returned into this session's context and the estimated cost of carrying them;
  - the largest tool results kept in context, files read repeatedly, failed tool calls by tool;
  - a status line: figures are as of the latest turn; agents still running.
- **FR-2 Prompts with their cost.** The prompt list shows, per user prompt, its cost in this
  session, API calls and context at start -> end. Automatic turns (a background task finished,
  context compacted, a non-human queued command) are shown as unnumbered `(auto)` lines, so
  numbering matches the prompts the user typed. A prompt repeated verbatim 3+ times is folded into
  one line.
- **FR-3 Queued prompts.** A prompt typed while the model was busy (`attachment.type ==
  "queued_command"`, `origin.kind == "human"` or no origin) counts as a user prompt — in the advisor
  and in `buildPromptTurns()` used by AI Attribute Extraction.
- **FR-4 Rock-solid advice only.** The prompt allows advice of these kinds only, each with a number
  from the evidence and the named prompt / agent:
  - the context stayed large after the work changed topic — start a fresh session at prompt N
    (name it and the context carried across it);
  - a correction the user had to make recurs, or several agents redid the same artefact for the same
    reason — add this rule to the agent brief / skill / CLAUDE.md (name the rule);
  - many tiny agents each pay a full startup context to run one or two commands — run them as one
    scripted step or one agent per group.
  Model-switch advice ("run X on Sonnet/Haiku", "use a cheaper model") is never given. Any other
  advice is dropped. An empty `harnessAdvice` is the expected answer for cheap or efficient sessions.
- **FR-5 Banned generic advice.** The prompt lists and forbids: batching or parallelising calls,
  fewer calls, Grep instead of Bash, one shell, syntax checks, selector checks, reusing servers,
  checking a server is up, piping output through head/tail, one Write instead of Edits, skipping a
  skill, fewer screenshots, trimming CLAUDE.md / MCP / startup context (the System context tab owns
  that), generic /compact or new session, reading files partially, splitting an agent, anything
  about the advisor's own cost.
- **FR-6 Respect user decisions.** Nothing advises against what a prompt explicitly asked for (a
  second review pass, "stay in this session", a chosen model). A cause ("requirements changed") is
  claimed only when the prompts or agent briefs show it.
- **FR-7 Conservative savings.** A fresh-session saving counts only the cache-read part, scaled by
  the context no longer carried, minus a new session's startup write; it is rounded down.
- **FR-8 Real prices.** Costs use the same pricing the worker already uses for the local aggregate
  (`fetchModelPricing` / `pickCallRates`), not hard-coded list prices.
- **FR-9 No local paths.** Absolute paths in commands, file targets and error samples are reduced to
  their last two segments; the prompt tells the model to name files by name or repo-relative path.
- **FR-10 Compatibility.** The LLM answer keeps the shape `{ general, costFactors[], harnessAdvice[] }`
  and the POST body to `/api/v2/turn-end-cost-advisor` is unchanged, so the server, the Advisor tab
  and older hooks need no change. The prompt still fits `turnEndCostAdvisorMaxPromptSizeKb`; only the
  prompt list is truncated, never the evidence block.

## Non-Functional Requirements

- The evidence must not slow the turn: it is computed in the detached worker; reading subagent
  transcripts is bounded (only `agent-*.jsonl` under the session's own folder).
- Fail-open: an unreadable or missing subagent file or meta is skipped, never fails the run.

## Acceptance Criteria

- [ ] FR-1: for a session with subagents, the prompt sent to `claude -p` contains one line per agent
      with its cost, and the totals line equals session + agents.
- [ ] FR-2: task-notification and compaction turns appear as `(auto)` lines and do not consume a
      prompt number.
- [ ] FR-3: a `queued_command` human prompt appears in the advisor prompt list and in
      `buildPromptTurns()` output.
- [ ] FR-4/FR-5: on the 10 PoC sessions no advice item recommends a cheaper model or any banned
      item; the $0.12 and $1.97 sessions return an empty `harnessAdvice`.
- [ ] FR-6/FR-7: a blind re-check on the PoC sessions finds no advice against an explicit user
      decision and no saving above the judge's recomputed figure.
- [ ] FR-8: per-agent and per-prompt costs come from the worker's pricing lookup.
- [ ] FR-9: no absolute path reaches the prompt from commands, targets or error samples.
- [ ] FR-10: the server and client are unchanged; an Advisor tab renders the new result as before.

## Notes

<!-- Append timestamped notes here as work progresses -->

**2026-11-11:** Implemented inline in the session that ran the PoC (owner asked to "do the task and commit"): `hook/.claude/telemetry_tool/advisor-evidence.js`, new `buildAdvisorPrompt` and queued prompts in `buildPromptTurns` (`post-turn-analysis-worker.js`), hook 2.32.0. Algorithm doc `docs/knowledgebase/algorithms/advisor-evidence.md`, rows `docs/algorithm-examples/advisor-evidence.json` (18 rows, green). Check on the 10 PoC sessions with the real hook prompt: no model-switch advice; empty advice for 5 sessions. Evidence and judge reports: `docs/pocs/2026-11-11-2023-advisor-evidence/`.
