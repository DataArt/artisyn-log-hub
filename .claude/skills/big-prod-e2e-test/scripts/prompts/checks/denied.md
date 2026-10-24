## Step

Denied call. Open `{{SESSION_URL}}&tab=logs` and wait for the prompt turns to load. Find the `denied.tool` tool call whose input names `denied.target`.
- Read its status badge (`data-testid="tool-status-badge"`): its text, and the `title` attribute of the `⊘ rejected` label inside it (also shown as a tooltip on hover).
- Expand the call and read its result text.
- Take a screenshot, filename `{{SHOT_DENIED}}`, showing the call with its badge.

## Judge

- `denied`: passes iff that call is shown, its `tool-status-badge` shows `⊘ rejected`, and either its result text contains "requested permissions" or the `title` of the `⊘ rejected` label is non-empty. A call shown as `✗ error` instead fails.

## Fields

"denied":    { "status": "pass", "observed": "<badge text; badge title; denial text>", "note": "", "screenshot": "{{SHOT_REL}}/denied.png" }
