## Step

Context growth. Open `{{SESSION_URL}}&tab=charts`, wait for the Charts tab to load, and press its "Context Growth" sub-tab (`context-growth`).
- Find the first step row (`data-testid="growth-step-row"`) that shows tool calls, and click it.
- In the step details modal (`data-testid="step-details-modal"`) count the call blocks (`data-testid="step-call-block"`).
- Take a screenshot, filename `{{SHOT_CONTEXT_GROWTH}}`, with the modal open. Then close the modal.

## Judge

- `contextGrowth`: passes iff the Context Growth sub-tab shows at least one `growth-step-row` with tool calls, and its `step-details-modal` lists at least one `step-call-block`.

## Fields

"contextGrowth": { "status": "pass", "observed": "<step row opened, number of call blocks>", "note": "", "screenshot": "{{SHOT_REL}}/context-growth.png" }
