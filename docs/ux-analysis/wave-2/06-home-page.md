# 6. Home page instead of the placeholder

Wave 2 · Effort M · Impact high · Proposed by all 5 agents · Builds on [03](../wave-1/03-use-case-lenses.md)

## Problem

Every user starts on `/main`, which only says "Select an item from the left panel". Users keep
returning to the same few sessions with no shortcut.

## Proposal

Replace `MainPage` with an overview that deep-links into existing views:

- **Recent** — recently visited repos and sessions with their tab (per viewer, localStorage).
- **Pinned** — pinned repos, sessions and analytics views (per user, existing user settings, so they
  follow the user across devices).
- **Needs attention** — hooks with problems (data already in the left nav), sessions with advisor
  results, OTEL coverage gaps.
- **Question cards** — "Why was this session expensive?", "Which tools fail most?", "Is my hook
  healthy?", "What context does Claude load at startup?", "Is my CLAUDE.md being used?" — each opens
  the right view with filters preset and the matching lens.
- **This week** — cost per repo / team (from `session_stats`, not request-time transcript scans).
- **Get started** for new users.

## Constraints

- Respect private-repo and team visibility rules.
- Question cards need a sensible default repo when the user has several.
- Aggregates across repos may need one new endpoint → contract registry row; keep it cheap.

## Compatibility and tests

- Pinning adds one user-settings key; old clients ignore it.
- Tests: a step in an existing scenario that opens a question card; a contract row if a new route is
  added.
