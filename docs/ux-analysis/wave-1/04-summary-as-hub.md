# 4. Summary as a hub

Wave 1 · Effort M · Impact high · Proposed by 4 of 5 agents

## Problem

Users open tabs blindly to see whether there is anything in them. Summary already links out ("View on
… tab →"), but only per block.

## Proposal

Below `SummaryExecutiveBand`, add one mini-card per tab (about 6–8, not all 14): one headline figure
and "Open →", which calls the existing `onSessionTabChange`.

Examples: Bash call count, top changed paths, OKF reads, MCP calls, startup context tokens, OTEL
hidden-call cost, advisor hits. Empty tabs show a dimmed card ("No OKF reads"), so the user sees at a
glance where to go.

Optionally a one-row "Explore" strip with task entries — *Debug a tool call*, *Why this cost*,
*Harness & context*, *Code changes* — each switching to the matching tab and lens
([03](03-use-case-lenses.md)).

## Constraints

- Use figures already loaded in `SessionDetailPane` (usage, code impact, change surface). Do not load
  lazy tab chunks (Charts, Change surface, Harness, Bash) just to render a card.
- Keep Summary readable: one number and one link per card.

## Compatibility and tests

- Client only.
- Tests: a step in an existing session scenario that opens a tab from a Summary card.
