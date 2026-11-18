# PoC: what Log Hub sees of a Claude Code "Code Mode" session

Task: none yet — ad-hoc research (2026-11-15). If Code Mode support becomes a task, link it here.

## Background

Claude Code 2.1.323 added **Code Mode** (experimental, off by default,
`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`): instead of one tool call per step, Claude writes JavaScript
that makes several tool calls in one step; only what the code returns goes back to the model.
Official page: `https://code.claude.com/docs/en/code-mode`. What it states (read 2026-11-15):

- The tool that runs the code is `REPL`; the code is in `tool_input.code`.
- Every tool call the code makes goes through `deny` / `ask` rules and `PreToolUse` hooks.
- **Code Mode does not start when OpenTelemetry export is on** (reason `OpenTelemetry is on`; fix:
  unset `CLAUDE_CODE_ENABLE_TELEMETRY` and `ENABLE_BETA_TRACING_DETAILED`). The Log Hub installer
  writes `CLAUDE_CODE_ENABLE_TELEMETRY=1` into the user settings, so a user with Log Hub OTEL on
  cannot use Code Mode.
- Interactive terminal sessions only: not `claude -p`, not the Agent SDK, VS Code panel, Desktop app
  or cloud sessions; native build; Anthropic API only (no gateway / Bedrock / Vertex / Foundry);
  models Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2; not together with agent teams.
- A Code Mode session can be resumed only with Code Mode on.

The page does **not** say whether `PostToolUse` fires for the calls made from the code, which
`tool_name` / `tool_use_id` those calls carry in hook payloads, or how they are stored in the
transcript JSONL. The token-saving numbers in news posts (150k → 2k) are not on the page.

## Question

With OTEL off and Code Mode on, what does a monitoring tool get?

1. Hooks: which events fire for the `REPL` call and for each call made from the code
   (`PreToolUse`, `PostToolUse`), and with which fields?
2. Transcript: are the inner calls written as `tool_use` / `tool_result` blocks, or is there only
   the `REPL` call with its code and return value?
3. Does the Log Hub hook still upload the session, and how do the Logs, Map, Tools/MCP, Change
   Surface and OKF views show it (unknown tool `REPL`, file edits and reads made from the code)?

## How to run

Needs an interactive terminal, so it cannot be run by an agent or in CI.

1. Update Claude Code to 2.1.323 or newer (`claude update`), native build.
2. Turn OTEL off for the test: remove `CLAUDE_CODE_ENABLE_TELEMETRY` (and the `OTEL_*` keys next to
   it) from the `env` block of your user `settings.json`; keep a copy to put them back afterwards.
3. From this folder, in PowerShell:

   ```powershell
   .\run.ps1
   ```

   It starts `claude` with Code Mode on and hooks that append every hook payload to
   `capture/hooks.jsonl`. Confirm the Code Mode question. If the session says
   `Code Mode (experimental) isn't available`, note the reason (also in `/status`) — that line is a
   result too.
4. Give it this prompt, wait for the answer, then exit:

   ```
   In the folder sample/ find every broken relative link in the Markdown files (a link whose
   target file does not exist). Fix the one that is a typo of an existing file name, and list the
   rest. Do it with as few steps as you can.
   ```

5. Analyse:

   ```powershell
   node analyze.cjs
   ```

6. Open the same session in Log Hub (the repository's own hook also saw it) and look at the Logs,
   Map, Tools/MCP and Change Surface views.
7. Put the OTEL keys back and restart Claude Code. To run it again, first restore the link the
   session fixed in `sample/reference/glossary.md` (`../instal.md`).

For a baseline, repeat steps 3–5 with `$env:CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '0'` (move
`capture/` away first) and compare the token usage and the number of steps.

## Files

| File | Purpose |
|---|---|
| `run.ps1` | starts the session; writes `capture/settings.json` from `claude-config/settings.json` with this folder's path filled in |
| `claude-config/settings.json` | hook wiring template (not a live `.claude/` folder) |
| `dump-hook.cjs` | the hook: appends each payload to `capture/hooks.jsonl`, never blocks |
| `analyze.cjs` | the report: hook events per tool, Pre without Post, transcript tool blocks, calls missing from the transcript, token usage |
| `sample/` | four Markdown files with three broken links (one is a typo of an existing file) |

## Result

Not run yet (2026-11-15): the capture kit is ready and its scripts were smoke-tested with fake
payloads; the session itself needs Claude Code ≥ 2.1.323 and an interactive terminal.

Already known from the documentation, without a run:

- Log Hub OTEL and Code Mode exclude each other today (see Background).
- The automated checks cannot cover Code Mode: the scenario fixtures and `big-prod-e2e-test` use
  `claude -p`, where Code Mode is unavailable.
