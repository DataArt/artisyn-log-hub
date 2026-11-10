# 2026-11-09: Session Waiting-Time Breakdown by Cause

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server, client
**Owner:** denis.tsyplakov
**Created:** 2026-11-09
**Tracker:** GH-116 https://github.com/DataArt/artisyn-log-hub/issues/116

## Description

Session waiting-time breakdown by cause: split session wall-clock time into agent working vs
waiting for the user, and split waiting by cause — permission prompt (PermissionRequest →
tool_result), plan approval (ExitPlanMode), question to user (AskUserQuestion), waiting for the next
prompt (idle between turns), plus rate-limit/API-error blocked time where detectable. Today work
time (algorithms/work-time.md) runs from prompt to the last answer, so in-turn waits for permission
/ AskUserQuestion / plan approval are counted as autonomous work. Show per session (Info tab /
timeline) and aggregated in Analytics per user/repo/team (where people wait most, which tools cause
the most permission waits). Inspired by Beezi (docs/product-kb/competitive-research/beezi.md)
session timeline. Display-only, uses data already uploaded, older hooks must keep working.

Context:

- Beezi's session timeline splits time into working / planning / waiting for you / idle / break, and
  splits "waiting for you" into plan approval, question, tool approval and next instruction; it also
  shows "blocked time due to rate limits" (`docs/product-kb/competitive-research/beezi.md`, row A10).
- Work time today: `docs/knowledgebase/algorithms/work-time.md` (server `computeWorkTime` in
  `claude-extractor.ts`, hook twin `deriveWorkTimeMs`); the client's per-turn sum is a separate
  algorithm (`docs/knowledgebase/session-log-view.md` § "Work time"). A turn spans prompt → last
  answer, so a permission dialog that sits for 20 minutes inside a turn is "work".
- Permission events: `PermissionRequest` / `PermissionDenied` artisyn lines, attributed to calls in
  `docs/knowledgebase/algorithms/tool-call-sections.md` (`PermissionRequest` has no `tool_use_id`;
  `PermissionDenied` has one from hook 2.24.0). A call has `startedAt` (tool_use) and `endedAt`
  (tool_result).
- Metric scope rules (root vs sub-agent tree): `docs/knowledgebase/session-metrics-scope.md`.
- Competitors (`docs/product-kb/competitive-research/budgets-forecasts-waiting.md`): only Beezi splits
  waiting by cause, method undocumented. Claude Code's own OTel gives cross-checks: span
  `claude_code.tool.blocked_on_user` vs `tool.execution` (permission wait), `active_time.total` with
  `type=user|cli`, `api_request.duration_ms` / `tool_result.duration_ms` (API vs tool time), `api_error`
  with `attempt` / `status_code` (rate-limit retries).
- Related: `2026-11-02-session-antipatterns` ("cache expired after idle" uses idle gaps).

## Functional Requirements

- FR-1 For each session, compute: total wall-clock span, agent working time, and waiting time; the
  parts add up to the span (no double counting with parallel sub-agents).
- FR-2 Waiting time is split by cause:
  - permission prompt (a tool call that got a `PermissionRequest`: from the request to the
    tool_result / denial);
  - plan approval (`ExitPlanMode` call: tool_use → tool_result);
  - question to the user (`AskUserQuestion` call: tool_use → tool_result);
  - next prompt (last answer of a turn → next prompt), with long gaps separated as "away/break"
    above a threshold;
  - blocked by rate limit / API error, where the transcript shows it (API error / retry lines).
- FR-3 Session view shows the breakdown (Info tab section and a timeline strip of the states over
  the session).
- FR-4 Analytics shows the breakdown aggregated per user, repository and team for a period, plus
  the top tools by permission-wait time.
- FR-5 Decide and document whether "Autonomous work time" (and every per-hour figure built on it)
  excludes in-turn waits; if it changes, the server, hook twin and client stay consistent.
- FR-6 Works on sessions already in the DB and from older hooks; causes the old data cannot show
  (e.g. no permission events) fall back to "unknown wait", never to an error.

## Non-Functional Requirements

- Backward compatibility: no hook change required; older hooks' sessions still get a breakdown
  (with fewer causes).
- Analytics must not read transcripts per request (`docs/knowledgebase/server-conventions.md`):
  per-session figures are computed at ingest/stats time and stored.

## Acceptance Criteria

- [ ] FR-1 For a session, working + all waiting causes = wall-clock span, pinned by algorithm rows.
- [ ] FR-2 A turn with a 10-minute permission prompt reports ~10 min "permission" wait; the same for
  `ExitPlanMode` and `AskUserQuestion`; an idle gap between turns is "next prompt"/"away" (algorithm
  rows).
- [ ] FR-3 The session Info tab shows the breakdown, and the timeline strip shows the states in order.
- [ ] FR-4 Analytics shows totals per user/repo/team and a top-tools-by-permission-wait list; numbers
  match the sum of the sessions' figures.
- [ ] FR-5 The decision on work time is written in `algorithms/work-time.md`, and all places that show
  work time agree.
- [ ] FR-6 A session uploaded by a hook without permission events shows a breakdown with "unknown
  wait" and no error.

## Open Questions

- Does work time change to exclude in-turn waits, or stay as is with waits shown alongside? Per-hour
  figures (Productivity, Executive Summary) shift if it changes.
- Threshold for "away/break" vs "waiting for next prompt" (fixed, e.g. 15 min, or configurable)?
- How are waits inside background sub-agents counted when the main thread keeps working?
- Which transcript lines reliably mark rate-limit / API-error blocked time?

## Notes

<!-- Append timestamped notes here as work progresses -->
