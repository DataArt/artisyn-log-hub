---
name: update-install-instructions
description: "Once code in folder `hook/` is updated"
---

Read all hook implementation files and rewrites INSTALL_HOOK.md so that installation steps, configuration options, and
output format stay in sync with the code.

## Step 1 — read the implementation

Read all files under `.claude/telemetry_tool/`:

- `telemetry-hook.js`
- `env-context.js`
- `git-context.js`
- `write-telemetry.js`

Also read `.claude/settings.json` to see the current hook wiring.

## Step 2 — derive ground truth from the code

For each area below, check whether `INSTALL_HOOK.md` is still accurate. Use only what you find in the code — do not
invent or assume.

**Hook wiring (`settings.json` snippets)**

- Which Claude Code hook events are used (`UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionStart`, …)? The hook is monitoring/logging only — there is no `PreToolUse` guardrail wiring.
- Are the `command` strings and `statusMessage` values correct?

**File list**

- Which `.js` files must be copied into `.claude/telemetry_tool/`?

**Configuration (`.env` variables)**

- What variables does `env-context.js` (or any other file) read from the `.env`?
- What are the defaults? What values are accepted?
- Any variables that were removed or renamed?

**Recorded events**

- What `event` values are written to telemetry (search for `event:` assignments in the source)?
- What fields does each event carry?

**Output format**

- What is the file-naming scheme (`<session_id>.jsonl`, etc.)?
- Is the example JSON still representative?

## Step 3 — update `INSTALL_HOOK.md`

Edit only the sections that are out of date. Keep sections that are already correct unchanged.
Preserve the existing document structure (headings, order, style).

After editing, verify the file reads correctly end-to-end and that every code block matches the implementation.
