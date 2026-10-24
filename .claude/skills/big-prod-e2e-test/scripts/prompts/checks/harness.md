## Step

Harness usage. Open `{{SESSION_URL}}&tab=harness-usage` and wait for the tab (`data-testid="harness-usage-tab"`) to load.
- In the session tree on the left (`data-testid="harness-tree-row"` rows), make sure the root row "Main session" is selected, and that every row is expanded (press any "Expand" button you see).
- Turn ON the "Include sub-sessions" switch (`data-testid="harness-include-children"`), so the element list covers the main session and all its sub-sessions.
- Read the element rows (`data-testid="harness-element-row"`): each row has a kind badge (`SKILL`, `RULE`, `WORKFLOW`, `MCP`, `TOOL`) and an element name. The kind chips (`data-testid="harness-kind-chip"`) show per-kind counts.
- Count the subagents: the number of tree rows below the root whose label starts with `Agent` (for example `Agent · general-purpose`). A `Workflow · <name>` row is a group, not a subagent, but the `Agent` rows under it are subagents.
- Take a screenshot, filename `{{SHOT_HARNESS}}`, showing the tree and the element list.

## Judge

- `skills`: the set of `SKILL` row names (Harness usage step) must equal the expected `skills` list. Expected `[]` means no `SKILL` row may be shown.
- `rules`: the set of `RULE` row names must equal the expected `rules` list. Expected `[]` means no `RULE` row may be shown.
- `workflows`: the set of `WORKFLOW` row names must equal the expected `workflows` list. Expected `[]` means no `WORKFLOW` row may be shown.
- `subagents`: the number of `Agent` tree rows below the root must equal the expected `subagents` number. Expected `0` means the tree shows only "Main session".
- `mcp`: `MCP` rows are named `<server>:<tool>` (for example `big-test-pg:query`). The set of server names (the part before the first `:`) must equal the expected `mcp` list. Expected `[]` means no `MCP` row may be shown.
- Never judge `TOOL` rows: they are allowed in any number and are never a mismatch. An `Agent` or `Task` TOOL row is a tool call, not a subagent; count subagents only from the tree.

## Fields

"skills":    { "status": "pass", "observed": "<SKILL rows, or none>", "note": "", "screenshot": "{{SHOT_REL}}/harness-usage.png" }
"rules":     { "status": "pass", "observed": "<RULE rows, or none>", "note": "", "screenshot": "{{SHOT_REL}}/harness-usage.png" }
"workflows": { "status": "pass", "observed": "<WORKFLOW rows, or none>", "note": "", "screenshot": "{{SHOT_REL}}/harness-usage.png" }
"subagents": { "status": "pass", "observed": "<Agent tree row count>", "note": "", "screenshot": "{{SHOT_REL}}/harness-usage.png" }
"mcp":       { "status": "pass", "observed": "<MCP rows, or none>", "note": "", "screenshot": "{{SHOT_REL}}/harness-usage.png" }
