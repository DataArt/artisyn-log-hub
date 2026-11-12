## Step

Denied call. Open `{{SESSION_URL}}&tab=logs` and wait for the prompt turns to load. The `denied.tool` call is already listed in its turn's Files section ("Code" group) as a file row (`data-testid="file-row"`) whose text contains `denied.target` (it shows as `⊘ <target>` with a `⚠ requested` badge).
- Read that row's text and badge, then click the row. A modal (`[role="dialog"]`) opens with the tool call view (`data-testid="tool-call-view"`).
- Inside the modal read the status badge (`[role="dialog"] [data-testid="tool-call-view"] [data-testid="tool-status-badge"]`): its text, and the `title` attribute of the `⊘ rejected` span inside it (expected `rejected by the user`). Also read the call's result text inside the modal.
- Take a screenshot, filename `{{SHOT_DENIED}}`, showing the open modal with its badge.

## Judge

- `denied`: passes iff the `file-row` for `denied.target` is shown, the modal it opens shows a `tool-status-badge` containing `⊘ rejected`, and either the result text in the modal contains "requested permissions" or the `title` of the `⊘ rejected` span is non-empty. Evidence from the file row alone (without the opened modal) fails — report what the row showed in `observed`. A badge showing `✗ error` instead of `⊘ rejected` fails.

## Fields

"denied":    { "status": "pass", "observed": "<row badge; modal badge text; title; result text>", "note": "", "screenshot": "{{SHOT_REL}}/denied.png" }
