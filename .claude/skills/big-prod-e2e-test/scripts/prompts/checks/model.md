## Step

Summary. Open `{{SESSION_URL}}&tab=summary` and wait for the session to load. Read the model shown in the session header. Take a screenshot with `browser_take_screenshot`, filename `{{SHOT_SUMMARY}}`.

## Judge

- `model`: the model in the session header (Summary step) must equal the expected `model` exactly (for example `claude-sonnet-4-5`; the UI already strips date suffixes).

## Fields

"model":     { "status": "pass", "observed": "<what the UI showed>", "note": "<short reason>", "screenshot": "{{SHOT_REL}}/summary.png" }
