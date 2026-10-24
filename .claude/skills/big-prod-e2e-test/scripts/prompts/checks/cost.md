## Step

Cost. Open `{{SESSION_URL}}&tab=info` and wait for the Info tab to load.
- Find the cost reconciliation table (`data-testid="cost-reconciliation"`) and its row labelled "Telemetry total". Read that row's full text verbatim (label and amount, for example `Telemetry total $0.0123`).
- If the table is not shown, or it has no "Telemetry total" row, record the text `none`.
- Take a screenshot, filename `{{SHOT_COST}}`, showing the table (or the place where it should be).

## Judge

- `cost`: do not compare amounts yourself; the test harness compares the telemetry total with the session's own cost after you finish. Report the "Telemetry total" row text verbatim in `observed` (or `none`). Use `"pass"` when the row is shown, and `"skipped"` when it is not (`observed` = `none`).

## Fields

"cost":      { "status": "pass", "observed": "<Telemetry total row text, or none>", "note": "", "screenshot": "{{SHOT_REL}}/cost.png" }
