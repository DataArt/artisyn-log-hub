---
name: use-playwright
description: "Playwright MCP usage conventions. ALWAYS invoke this skill before using any mcp__playwright__ tool, taking screenshots, checking the UI, or verifying browser state."
---

App runs at `http://localhost:5173`. Test login credentials are in `CLAUDE.local.md`.

## Screenshots
- Save all screenshots to `.playwright-work-folder/`
- Use descriptive filenames that indicate the step or feature being verified

## Console errors
- After every screenshot, check the browser console with `mcp__playwright__browser_console_messages`
- Any console errors must be treated as failures and fixed before moving on
