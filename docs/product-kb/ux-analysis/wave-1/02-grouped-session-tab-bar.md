# 2. Grouped session tab bar with overflow

Wave 1 · Effort S–M · Impact high · Proposed by 4 of 5 agents

## Problem

The session pane shows 14 tabs in one flat row (`SessionTabBar.tsx`) with no grouping and no overflow
handling. Every new tab makes the row wider; cost-related content is spread over Charts, Statistics,
System context anatomy, OTEL and Info.

## Proposal

Keep every tab, but show them in labelled groups (names are a suggestion):

| Group | Tabs |
|---|---|
| Overview | Summary, Info, Statistics, Advisor |
| Transcript | Logs, Bash, Raw Logs |
| Cost & context | Charts, System context anatomy, Harness usage, OTEL |
| Effects | Change surface, Tools/MCP, OKF |

Rendering options (pick one in review):

- **A. One row with group headers / dividers**, overflow into a "More ▾" menu when the pane is narrow.
- **B. Two-level bar**: groups on top, sub-tabs below; remember the last sub-tab per group.

Group triggers show counts or health dots where data is already loaded (e.g. "Bash 34").

## Compatibility and tests

- `tab=` values and `tab-session-*` test ids stay the same; deep links keep working.
- A tab in the overflow menu must stay reachable from scenarios — open the menu in a scenario helper.
- Tests: extend existing session scenarios with a step that switches tabs via a group.
