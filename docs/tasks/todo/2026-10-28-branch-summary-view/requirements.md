# 2026-10-28: Branch Summary View

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-10-28
**Tracker:** GH-53 https://github.com/DataArt/artisyn-log-hub/issues/53

## Description

Raw idea (verbatim, user's words):

> чисто client фича - просмотр данных по ветке - кликнуть в списке сессий сгруппированных по веткам в
> ветку и уведет суммарную инфу по сессиям ветки
> summary, info, okf, в общем почти все кроме логов и чартов которые не получается аггрегировать -
> пройдись там глянь

In English: a client-only feature for viewing data per git branch. In the repository session list
grouped by branch, clicking a branch opens an aggregated view over all sessions of that branch —
Summary, Info, OKF and essentially every other session tab whose data can be aggregated. Logs and
Charts (and other per-transcript views that cannot be meaningfully aggregated) are excluded.

Context found while scratching (to be verified in review):

- The branch grouping lives in `client/src/viewer/pages/repository/session-list/BranchSection.tsx`
  (per-branch header already shows session count, latest end time, total work time, lines changed,
  total cost from `BranchSummary`; open/closed state via `useOpenBranches.ts`).
- Session detail tabs are listed in `SessionTabBar.tsx`: Summary, Info, Logs, Bash, Charts,
  Advisor, Statistics (`usage`), Change surface, Harness usage, OKF, Raw Logs.
- A branch-level PDF report already exists (`reports/BranchSummaryReport.tsx`) — a table across
  branches, not a per-branch drill-down.
- "Client-only" means the aggregation is built from data the client can already fetch (existing
  per-session / per-branch endpoints); no new server routes.

## Functional Requirements

- FR-1: Clicking a branch in the branch-grouped session list opens a branch view in the detail pane
  (instead of a single session), without breaking the existing expand/collapse of the branch's
  session list.
- FR-2: The branch view aggregates data over all sessions of that branch that are visible under the
  current list filters (user filter, hide-hook-sessions, attribute filter).
- FR-3: The branch view offers the aggregatable session tabs — at least Summary, Info and OKF;
  each other session tab (Statistics, Change surface, Harness usage, Bash, Advisor) is either
  aggregated or explicitly excluded, with the decision recorded in this document.
- FR-4: Logs, Charts and Raw Logs are not offered in the branch view, since they cannot be
  aggregated across sessions.
- FR-5: Additive metrics (cost, tokens, lines changed, files, tool calls) are summed over every
  session of the branch including sub-agent trees, following the root-vs-tree rule in
  `docs/knowledgebase/session-metrics-scope.md`, without double counting.
- FR-6: The feature is client-only: it uses existing server API endpoints and adds no new routes.

## Acceptance Criteria

- [ ] AC-1 (FR-1): Clicking a branch name in the grouped list shows a branch view identifying the
  branch and its session count; clicking a session afterwards returns to the normal session view.
- [ ] AC-2 (FR-2): With a user filter or attribute filter active, the branch view totals change to
  match only the sessions listed under that branch.
- [ ] AC-3 (FR-3): Summary, Info and OKF tabs are present in the branch view and show branch-wide
  values; the decision for every other session tab is documented here.
- [ ] AC-4 (FR-4): Logs, Charts and Raw Logs tabs are absent from the branch view.
- [ ] AC-5 (FR-5): The branch-view total cost equals the branch header's total cost (and the sum of
  its sessions' tree costs) for the same filter set.
- [ ] AC-6 (FR-6): No server code or route registry changes are made by this task.

## Open Questions

- How is "open branch view" distinguished from "expand/collapse branch" — a separate click target
  on the header, or the header click does both?
- Is the branch view addressable by URL (deep link / back button), like a selected session?
- Which existing endpoints can supply per-branch data without N per-session requests, and is the
  per-session fan-out acceptable for branches with many sessions?
- Exact per-tab aggregation semantics (e.g. Info: models used, time span, users; OKF: merged verdict
  or per-session list; Advisor: list of per-session advisor results or excluded).

## Notes

<!-- Append timestamped notes here as work progresses -->
