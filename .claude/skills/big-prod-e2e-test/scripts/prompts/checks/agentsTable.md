## Step

Workflow agents. Open `{{SESSION_URL}}&tab=logs` and wait for the prompt turns to load. Scroll to the workflow block and its agents table.
- Read every agent row (`data-testid="workflow-agent-row"`): its number, its Duration and its Tokens.
- Take a screenshot, filename `{{SHOT_AGENTS_TABLE}}`, showing the table.
- Click agent row `1` to open the agent modal. Open its logs tab (`data-testid="workflow-agent-logs"`) and note whether it shows content, then its raw logs tab (`data-testid="workflow-agent-raw-logs"`) and note whether it shows content.
- Take a screenshot, filename `{{SHOT_AGENT_MODAL}}`, with the modal open. Then close the modal.

## Judge

- `agentsTable`: passes iff the table shows exactly `agents.count` `workflow-agent-row` rows, numbered `1` to `agents.count`, each with a non-empty Duration and a non-empty Tokens value, and the modal of row 1 shows non-empty content on both the `workflow-agent-logs` and the `workflow-agent-raw-logs` tabs.

## Fields

"agentsTable": { "status": "pass", "observed": "<rows with number, duration, tokens; modal tabs non-empty?>", "note": "", "screenshot": "{{SHOT_REL}}/agents-table.png" }
