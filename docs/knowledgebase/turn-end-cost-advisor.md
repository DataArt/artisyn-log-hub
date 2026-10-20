---
type: "Architecture Guide"
title: "Turn-End Cost Advisor and Session Attributes"
description: "The post-turn analysis pipeline: one Stop hook and a detached worker that run the Turn-End Cost Advisor and AI Attribute Extraction, the combined config endpoint, the no-cost-gate advisor rule, how sessions not yet ingested are handled, the advisor prompt inputs, attribute extraction (watermark, failure cap), attributes as a chart dimension, and the user-visible naming."
tags:
  - hooks
  - server
  - analytics
  - llm
timestamp: "2026-10-14T00:00:00+04:00"
---

# Turn-End Cost Advisor and Session Attributes

Two LLM-backed features run after every turn of a monitored session:

- **Turn-End Cost Advisor** — a short cost/efficiency summary of the session (what drove the cost,
  what to change next time), shown on the session's Advisor tab.
- **Session Attributes** — values such as a ticket key, workflow stages or "has correction" that
  an LLM extracts from the session's prompts. Sessions can be filtered and grouped by them.

Both run hook-side through the user's own `claude -p`, never on the server.

## Architecture

| Piece | File |
|---|---|
| `Stop` trigger | `hook/.claude/telemetry_tool/post-turn-analysis-hook.js` |
| Detached worker | `hook/.claude/telemetry_tool/post-turn-analysis-worker.js` |
| LLM call helper | `hook/.claude/telemetry_tool/claude-invoke-async.js` (`callLlmAsync`) |
| Attribute failure-cap state | `hook/.claude/telemetry_tool/session-attribution-state.js` |
| Combined config | `GET /api/v2/post-turn-analysis/config` — `server/src/logs/post-turn-analysis/post-turn-analysis.controller.ts` |
| Advisor runs | `POST /api/v2/turn-end-cost-advisor` — `server/src/logs/turn-end-cost-advisor/turn-end-cost-advisor.service.ts` |
| Attribute runs | `POST /api/v2/session-attribution` — `server/src/logs/session-attribution/session-attribution.service.ts` |
| Attribute filter SQL | `server/src/logs/attribute-filter.sql.ts` |
| UI | `client/src/viewer/pages/repository/AdvisorTab.tsx`, `AnalysisSettings.tsx`, `SessionAttributionSettings.tsx` |

**Flow.**

1. On `Stop`, `post-turn-analysis-hook.js` reads the payload, resolves the repository URL and spawns
   `post-turn-analysis-worker.js` fully detached, then exits. The interactive turn never waits.
2. The worker makes one call to `GET /api/v2/post-turn-analysis/config`, which returns an `advisor`
   half and an `attribution` half. If one half fails to resolve on the server, it is answered as
   "feature off", and the other half is still returned.
3. The worker runs the advisor branch and the attribution branch concurrently
   (`Promise.allSettled`). Each branch decides on its own whether to run, makes its own `claude -p`
   call and posts its own result as soon as it settles.
4. Each branch logs to its own rotated file under `.artisyn/ai_work_dir/`: `analysis.log` (advisor)
   and `attribution.log` (attributes).

**Recursion guard.** Every `claude -p` the worker starts carries `ARTISYN_HOOK_SERVICE` in its
environment. A `Stop` hook that sees it exits at once, because that `Stop` ends a hook-service LLM
call, not a user turn — evaluating it would spawn two more sessions per evaluation.

**Configuration.**

- The advisor can be switched on at team scope or personal scope. Resolution is the user's personal
  `repo_config` row, then the team config, then the built-in default. The hook path
  (`GET /api/v2/post-turn-analysis/config`, `resolveEffectiveConfig(userId, repoUrl)` with no
  `teamId`) picks the team by the lowest team id among the user's teams (member or owner) linking
  the URL, and reads that team's single config from `team_repo_config`.
- Attributes are team-only. A repository that resolves to a team (same lowest-id rule) gets that
  team's attribute set, or the built-in set (`jira_ticket`, `adlc_stages`, `has_correction`) if the
  team has none.
- Hook-side keys (model, LLM timeout, prompt-size cap) are listed in
  [hook-installation.md](hook-installation.md) § "Post-Turn Analysis Settings". The defaults in
  `env-context.js` are `sonnet` for the advisor, `haiku` for attributes, a 600000 ms timeout and a
  60 KB prompt cap for both.

**Prompt cap.** Only the free-text sample of user prompts is shortened (middle-truncated) to fit the
cap. Aggregate numbers, attribute definitions and the changed-file list are always sent in full.

## Advisor gate

The advisor has **no cost gate**. While it is enabled, every turn of every session is analysed.
`minSessionCostUsd` is still returned in the gate response, but nothing gates on it, and
`thresholdMet` means only "enabled and the session is known to the server".

- The aggregate the server sends is **tree-wide** (sub-agent and workflow sessions included), but
  its tool and file usage cover only the descendants. The worker re-derives the current session's
  own tool and file usage from its live transcript and merges it in, so the figures cover the whole
  tree without double-counting and without waiting for ingest.
- A run row is written to `turn_end_advisor_runs` only for a real attempt: `submitted` or `failed`.
  Rapid consecutive turns may overlap; the Advisor tab shows the newest `submitted` row by
  `started_at`, counting only rows recorded by the session owner.
- The advisor's own LLM cost is stored on the run row and shown separately from the session's cost
  (the Executive Summary has its own "advisor spend" tile — see
  [executive-summary-report.md](executive-summary-report.md)).

The hook uploads the current session's transcripts before its backlog so the server usually knows
the turn that just ended — see [upload-queue.md](upload-queue.md) § "Upload priority".

## Sessions not yet ingested

A short or single-turn session may reach the worker before its upload has been ingested. Such a
turn is still analysed:

- For an unknown session (or one owned by another user) the server answers `aggregate: null`. The
  worker builds a placeholder aggregate and falls through to local derivation.
- When the server knows the session but has no `session_stats` row yet, the aggregate comes with
  `hasTelemetry: false`. The worker then derives turns, prompts, model, work time, tool usage and
  file usage from the local transcript (`deriveLocalAggregate`) and prices them locally, classifying
  files with the `fileCategories` the gate response carries.
- Only when there is no local transcript either is the turn skipped.
- The server accepts a run row for a session it has not ingested yet, so the result is not lost.
  `TurnEndAdvisorOrphanCleanupScheduler` deletes rows that are older than
  `TURN_END_ADVISOR_ORPHAN_RETENTION_MS` (default 24h) and still match no session.

## Advisor prompt inputs

`buildAdvisorPrompt()` asks for JSON `{ general, costFactors[], harnessAdvice[] }` and gives the
model:

- turns, prompts (whole tree), work time, session cost so far, model and context window;
- three timed context figures from `computeContextUsage()`: **initial** (the first assistant event
  with usage), **current** (the last assistant event, overridden by a later `compact_boundary`'s
  `preTokens`) and **peak** (the maximum over all assistant events and compact boundaries);
- tool usage, file usage by category, and the skills invoked;
- the (possibly truncated) list of user prompts.

The prompt tells the model not to claim *when* a figure was reached ("upfront", "early") unless that
point's number is given — only the initial, current and peak context lines carry timing.

## Attribute extraction

- **When it runs.** The config call reports a prompt watermark: the number of `prompt_start` events
  in the session's own local `artisyn` telemetry file (`computePromptWatermark`). The server
  stores the highest watermark seen (`GREATEST`, never regresses) and answers
  `evaluationRequired = enabled && promptWatermark > evaluatedWatermark`. So attributes are
  re-evaluated only when new prompts arrived since the last applied evaluation. For a session not
  yet ingested, `evaluationRequired` is simply `enabled`.
- **Submission.** The store is a conditional upsert: a run is `applied` only when its prompt
  watermark is higher than the stored evaluation's, otherwise `ignored_stale` (a late, older
  evaluation); an unsuccessful run is `failed`. Values land in `session_attribution` (see
  [db-tables.md](db-tables.md#session_attribution)).
- **Failure cap.** After 3 consecutive failures for a session, the hook stops retrying until a
  success or a change of the attribute definitions resets the count (`session-attribution-state.js`).
- **Filtering.** Session lists, charts and reports accept `attr=<key>:<op>:<value>` with a fixed
  operator set (`eq`, `is`, `any`, `gte`, `lte`, `isnull`, `unattributed`). One shared helper builds
  the predicate everywhere, so it matches the GIN index `idx_session_attribution_values_gin`.

## Attributes as a chart dimension

Session attributes are a **Group by** dimension, `groupBy=attr:<key>`, on the charts and reports
that support grouping. They are not a standalone view (the Attribution Breakdown and Attribution
Usage reports are the exception: they are about attributes). The key is validated against the
repository's resolved attribute definitions.

A `string[]` attribute fans out: a session with several values counts in full in every matching
bucket, so bucket totals can add up to more than the overall total. Reports show
`GroupByFanOutCaveat` when that can happen. See also
[session-metrics-scope.md](session-metrics-scope.md).

## Naming

The user-visible names are **Session Attributes** (the settings sub-tab and the feature) and **AI
Attribute Extraction** (the mechanism that fills them). Code identifiers, routes, config keys and DB
objects keep the older `attribution` names (`session-attribution`, `sessionAttribution*`,
`session_attribution`). Rename only user-facing text.
