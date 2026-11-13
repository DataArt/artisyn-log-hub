# 2026-11-13: Session Cost Diagnosis Report ("Why Was This Session Expensive")

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | client
**Owner:** denis.tsyplakov
**Created:** 2026-11-13
**Tracker:** GH-144 https://github.com/DataArt/artisyn-log-hub/issues/144

## Description

Expensive-session diagnosis report ("why was this session expensive"): a one-click per-session
report, inspired by AgentsView v0.47.0 `session diagnose <id>`
(https://github.com/kenn-io/agentsview/releases/tag/v0.47.0, seen in morning check 2026-11-13).
For a selected session, explain where the cost came from: context growth over turns, compactions,
large tool results (which tool, how many tokens), retries / repeated failing tool calls, child
sessions / subagents and their share of cost, cache rebuilds. Today the cost advisor only covers
cache rebuilds and cost per prompt. Reuse existing data (session_stats, cache ratio stats,
context-growth tab, OTEL api calls, subagent stats) rather than new hook data where possible; keep
backward compatibility with old hooks. Output: ranked list of cost drivers with links to the exact
turns/messages.

## Functional Requirements

- FR-1: A session page offers a one-click "Why was this session expensive?" report for the selected
  session.
- FR-2: The report shows a ranked list of cost drivers, each with its share of the session cost
  (USD and %) and a short explanation.
- FR-3: Covered driver kinds: context growth over turns, compactions, large tool results (tool name
  and tokens), retries / repeated failing tool calls, child sessions / subagents (their share of
  cost), cache rebuilds.
- FR-4: Each driver links to the exact turns / messages it comes from.
- FR-5: The report is computed from data Log Hub already stores (session_stats, cache ratio stats,
  context-growth data, OTEL api calls, subagent stats); no new hook data is required for the
  first version.
- FR-6: Sessions uploaded by old hook versions still get a report; driver kinds whose data is
  missing are shown as "not available for this session" instead of failing.

## Acceptance Criteria

- [ ] FR-1: On a session page, one click opens the report for that session.
- [ ] FR-2: Drivers are sorted by cost share, descending; each shows USD, % of session cost and an
      explanation.
- [ ] FR-3: A session with a compaction, a large tool result, a failing-then-retried tool call, a
      subagent and a cache rebuild shows each of these as a separate driver.
- [ ] FR-4: Clicking a driver navigates to the referenced turn / message in the session view.
- [ ] FR-5: No hook change and no hook version bump is needed for the feature.
- [ ] FR-6: A session uploaded by an older hook (missing some data) renders the report with the
      unavailable driver kinds marked, and no error.

## Open Questions

- Where does the report live: a new session tab, a modal, or an extension of the cost advisor?
- How to attribute cost between overlapping drivers (e.g. context growth vs. cache rebuild on the
  same turn) so shares do not double-count?

## Notes

<!-- Append timestamped notes here as work progresses -->
- **2026-11-13:** Related existing ideas: `docs/product-kb/ideas/code-to-session-lookup.md` (the
  AgentsView `why file:line` part — out of scope here). The AgentsView "Friction Log" (daily
  corrections / tool errors) is a separate, larger idea, not part of this task.
