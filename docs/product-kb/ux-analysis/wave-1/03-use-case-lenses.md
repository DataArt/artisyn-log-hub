# 3. Use-case lenses

Wave 1 · Effort M · Impact high · Proposed by all 5 agents

## Problem

Each kind of user needs 3–5 of the 14 session tabs, but everyone sees all of them in the same order.

## Personas (from the personas report)

- Developer reviewing own session — what did it do, what did it cost, why slow.
- Investigator of a failed tool / MCP call.
- Team lead — cost, adoption, productivity.
- Harness / plugin engineer — system context, harness, OKF, CLAUDE.md.

## Proposal

A small lens switcher above the session tab bar. A lens is only an **ordering + prominence list over
existing tab ids** and a default tab; the other tabs stay in "More ▾". Nothing is hidden for good.

| Lens | Promoted tabs | Default |
|---|---|---|
| What happened | Summary, Logs, Bash, Charts (Timeline), Change surface | Summary |
| Cost | Summary, Statistics, Charts (Context growth / Call tree), Advisor, OTEL | Statistics |
| Harness & context | System context anatomy, Harness usage, OKF, Info | System context anatomy |
| Failed tool call | Tools/MCP, Logs, Bash, OTEL | Tools/MCP |
| All | today's full bar | Summary |

- Stored in a new optional `lens=` URL param and remembered per viewer (localStorage, try/catch).
- An explicit `tab=` in a link always wins; a link without `lens=` opens with "All" — old links behave
  exactly as today.
- The active lens is always visible, so users don't think a tab disappeared.
- Fixed list of lenses, not user-defined (avoid config sprawl). Later: default lens by team role.
- The same idea can apply to the repository tab row (e.g. "Cost review" lands on Reports → Executive
  Summary).

## Compatibility and tests

- Client only; no API change. Optional param, unknown values fall back to "All".
- Document lenses in `user-docs/` (offline help).
- Tests: a step in an existing session scenario that switches lens and asserts the promoted tabs.
