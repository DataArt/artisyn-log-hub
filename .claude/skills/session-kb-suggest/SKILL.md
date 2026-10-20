---
name: session-kb-suggest
description: "Analyze a past Claude session to find codebase-exploration patterns and suggest a KB article that would shortcut similar future tasks"
argument-hint: <sessionId>
---

Analyze local Claude session `$ARGUMENTS` for repeating exploration patterns, then decide whether a new Knowledgebase article is warranted.

## Step 1 — Validate argument

If `$ARGUMENTS` is empty, run:

```
node .claude/skills/session-kb-suggest/analyze-session.js
```

This lists the 10 most recent sessions for this project. Show them to the user and ask which session to analyze. STOP — do not proceed until the user provides a session ID.

## Step 2 — Parse the session

Run via Bash:

```
node .claude/skills/session-kb-suggest/analyze-session.js $ARGUMENTS
```

If the script exits non-zero (file not found, parse error), report the error output and STOP.

The JSON output contains:
- `taskGoal` — first user message (what the user was trying to accomplish)
- `followUpMessages` — subsequent user messages (clarifications, redirections)
- `toolCallCounts` — how many times each tool was called
- `filesRead` — files opened, sorted by read frequency
- `grepSearches` — grep patterns and paths searched
- `globSearches` — glob patterns used
- `agentCalls` — Explore/general agent prompts from the main session
- `bashCommands` — shell commands run

## Step 3 — Read the existing KB index

Read `docs/knowledgebase/index.md`. Note which topics are already covered so you don't propose duplicates.

## Step 4 — Analyze for a repeatable pattern

Answer these questions mentally before deciding:

1. **Task goal** — What was the user trying to understand or find? One sentence.

2. **Navigation path** — What sequence of searches/reads did the session take? Describe it in 3–6 steps (e.g., "read index → grep for service name → open controller → discover the actual logic is in a helper").

3. **Non-obvious entry point?** — Did it take multiple hops to find the right starting file? Was the connection between files non-obvious from names alone?

4. **Coherent cluster?** — Do the touched files cluster around a single subsystem or concept? Or are they scattered across unrelated areas?

5. **Static shortcut possible?** — Would a one-page document that says "to understand X, start at file Y because Z" have reduced the search to ≤ 1 hop? Or did the session require inspecting live/dynamic state that no static doc could replace?

6. **Already covered?** — Is the pattern already documented in the KB index you read in step 3?

## Step 5 — Decide

### Case A — KB article is warranted

All of these must be true:
- Clear navigation cluster (files cluster around one subsystem/concept)
- Non-obvious entry point (took multiple hops)
- Shortcuttable by a static document
- Not already covered in the KB

Output:
1. One sentence describing the pattern found.
2. A draft KB article in the project's style:
   - YAML frontmatter: `type`, `title`, `description`, `tags` (array), `timestamp` (ISO 8601, use today's date)
   - Body: concise, factual — no narrative filler. Include: subsystem overview (2–3 sentences), a table of key files with their roles, and "Where to start" guidance (the entry point and why).
3. Suggested filename in `kebab-case.md`.
4. Ask the user: **"Should I create this KB article?"**

If the user says yes:
- Write `docs/knowledgebase/<filename>.md` with the draft content.
- Add one line to `docs/knowledgebase/index.md` under the most appropriate section:
  `* [Title](filename.md) - <one-line description>`

### Case B — Unavoidable search

If the exploration was task-specific, scattered across unrelated subsystems, required dynamic inspection, or the pattern is already covered — say:

> **No KB article warranted.** [1–2 sentences explaining why the search was unavoidable or already documented.]
