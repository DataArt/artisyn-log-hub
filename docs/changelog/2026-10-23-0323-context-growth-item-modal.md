# Tool call details: Context Growth step modal, readable Bash view, Bash tab

- Context Growth step rows show the step's own token delta and open a modal with every tool call of that step.
- Bash commands are shown formatted and syntax-highlighted, with the working directory and the files they change, read and run, all paths repo-relative; the same view is used in the Logs tab and the Context Growth step modal.
- New session **Bash** tab lists every Bash command of the session and its sub-agents.
- Tool calls show precise statuses (error, rejected, interrupted, output not captured), Files/Skills/Agents rows open the call details, and permission badges land on the call that actually asked.
- Logs Tools rows lead with the call's own description; the hook (2.24.0) records `tool_use_id` on failed and denied tool calls.
