---
type: "Research"
title: "5. Command palette (Ctrl/Cmd+K)"
description: "Wave 2 idea 5: a Ctrl/Cmd+K command palette to jump to repos, sessions and tabs."
tags: [ux-research, product]
generated: { by: "human:denistsyplakov", at: "2026-11-06T15:26:59+04:00" }
---

# 5. Command palette (Ctrl/Cmd+K)

Wave 2 · Effort S–M · Impact high · Proposed by 4 of 5 agents · Depends on [01](../wave-1/01-tab-registry.md)

## Problem

Reaching a repo, then a session, then the right tab takes 3–4 clicks plus knowing that the tab exists
and where it lives. There is no search or keyboard navigation anywhere in the app.

## Proposal

One overlay opened by Ctrl/Cmd+K (and a visible search button in the top nav, so it is discoverable).
It searches over:

- repos and teams (data the left nav already loads);
- every session / repository / settings / admin tab from the tab registry, with synonyms
  ("cost" → Statistics, Charts, Call tree, OTEL);
- Analytics views and Reports;
- help articles from `user-docs/nav.json`;
- recently visited repos and sessions.

Choosing an entry navigates with the existing route helpers. Later: a "Search content…" entry for
global full-text search (deferred, see README).

## Compatibility and tests

- Client only, no backend.
- Check the shortcut does not clash with keyboard navigation inside the Bash list.
- Tests: a step in an existing scenario that opens the palette and jumps to a tab.
