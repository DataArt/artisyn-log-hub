# T-108: Brief overview

**What changes:** Two large text LLM prompts, which are currently hardcoded directly in the JS code
of the file `post-turn-analysis-worker.js` (in `hook/` — the source of truth), are moved into
separate markdown files next to this JS file:

- the **attribute extraction** prompt (function `buildAttributionPrompt()`) — used for
  AI classification of a session by the attributes defined by the team (JIRA ticket, ADLC stages,
  presence of fixes, etc.);
- the **analysis** prompt (function `buildAdvisorPrompt()`) — used by the turn-end cost advisor
  to analyze the causes of the session cost and give recommendations.

The functions `buildAdvisorPrompt()` and `buildAttributionPrompt()` will no longer assemble the
whole prompt text in code; instead they will load the fixed part from the `.md` file and substitute
the dynamic sections into it (usage summary, attribute list, changed files, sample of user
messages, etc.).

**Expected result:**
- Two new `.md` files in `hook/` next to `post-turn-analysis-worker.js`.
- The final text of the prompts sent to `claude -p` does not change — only the place where the
  static part of the text comes from changes.
- The changes are synced into `.artisyn/marketplace/plugins/log-hub-hooks/` via
  `npm run build:hooks-installer` and the process from `.claude/rules/hook.md`.

**Why:** the prompts will become easier to edit and review separately from the JS logic, without
having to dig into template strings inside the code.
