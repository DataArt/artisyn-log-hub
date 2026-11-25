---
type: "Note"
title: "Session Tags from OTEL Resource Attributes — notes"
description: "Decision history moved out of requirements.md"
---

# Notes

## 2026-11-25 — decision history moved from requirements.md

- **2026-11-24:** Scope narrowed by the user: only OTEL tags now, but the tag model is universal.
- **2026-11-25:** User decision: the old config-based tags — the hook config `context` array
  (`log-hub.json`, legacy `CTX_*`) — are not used; remove them and rely on OTEL tags as the standard
  (FR-9, compat NFRs, AC-10..11). Session Attributes (LLM-extracted) stay untouched.
- **2026-11-25:** Refined by the user: context already has a display — keep it and take the values
  from tags (OTEL is the standard now), and bring the feature itself up to date (untouched for
  months). Hence: rework, not removal; existing pairs migrate to `session_tags` with
  `source = config`; the `.../contexts` routes stay as compat readers; gaps listed under Current
  state are in scope.
- **2026-11-25:** `2026-06-16-prompt-classifier-session-tags` closed by the user: it was partly
  implemented as Session Attributes, which remain.
