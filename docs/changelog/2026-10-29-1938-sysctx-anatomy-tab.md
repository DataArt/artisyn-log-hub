# System context anatomy tab

- New session tab "System context anatomy": a bar and table showing what the startup context is made of (system prompt, memory, MCP servers, skills, instruction files, reminders, first prompt, harness internals) with drill-downs for skills, files and MCP servers.
- The System Context panel in Logs is replaced by a one-line "Startup context" summary that links to the new tab.
- Hook 2.28.0 records each file's git status (tracked / untracked / ignored / outside repo) and org-synced skill names in the environment snapshot.
