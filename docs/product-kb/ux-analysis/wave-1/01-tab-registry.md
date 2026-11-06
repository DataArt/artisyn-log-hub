# 1. Tab registry with metadata

Wave 1 · Effort S–M · Impact high (enabler for 2, 3, 5 and the ⓘ help hints)

## Problem

Tab labels, order and visibility are hand-written separately in every tab bar (session, repository,
settings, admin, team). Labels drift from ids (the `usage` tab is labelled "Statistics"), and each new
tab means editing several components.

## Proposal

Extend `client/src/viewer/tab-ids.ts` into one metadata table. Per tab:

- `id` (unchanged — it is the URL value and the base of `data-testid`)
- `label`
- `scope` — session / repository / settings / admin / team
- `group` — the group it belongs to (see [02](02-grouped-session-tab-bar.md))
- `description` — one line: what question this tab answers
- `synonyms` — words the command palette matches ("cost", "cache", "prompt")
- visibility predicate (e.g. Advisor only with results, Raw logs behind a setting)

All tab bars, tooltips, lenses and the command palette read from it. A new tab = one row.

## Compatibility and tests

- Ids and URL params do not change; old links keep working.
- Refactor of tab bars covered by scenarios — check the scenarios that click `tab-session-*`.
- Tests: none of its own (no algorithm doc); behaviour is covered by the existing scenario steps.
