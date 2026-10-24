## Step

Logs. Open `{{SESSION_URL}}&tab=logs` and wait for the prompt turns to load. Read the text of the first user message (the first prompt turn). Take a screenshot, filename `{{SHOT_LOGS}}`.

## Judge

- `prompt`: the first user message (Logs step) must contain the expected `prompt` text. Ignore differences in whitespace and line breaks, and a UI truncation ellipsis at the end.

## Fields

"prompt":    { "status": "pass", "observed": "<first user message text>", "note": "", "screenshot": "{{SHOT_REL}}/logs.png" }
