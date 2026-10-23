# Workflow runs: rejected launches show as failed, scriptPath runs get a name

- A `Workflow` call that Claude Code rejected before launch (an `is_error` tool result, no task
  notification) is shown as **failed** with its error as the summary, instead of **running** forever.
- A workflow launched by `scriptPath` (no `name` input) is named from the launch result's
  `workflowName` (or the script file name) instead of an empty pill.
