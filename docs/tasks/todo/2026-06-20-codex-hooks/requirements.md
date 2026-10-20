# T-32: Codex Hook Parity

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook, installer, docs
**Owner:** denis.tsyplakov
**Created:** 2026-06-20

## Description

Add Codex equivalents for the existing Claude Code telemetry hooks so Codex sessions can be logged, uploaded, and
guarded
by the same Artisyn infrastructure.

The current project has Claude hook wiring in `.claude/settings.json` and hook scripts in `.claude/telemetry_tool/`.
There is no project `.codex/` folder yet. Codex supports project hooks through `.codex/hooks.json` or inline
`.codex/config.toml` hook tables when the project is trusted. Prefer `.codex/hooks.json` for parity with the current
Claude `settings.json` structure.

## Current Claude Hook Inventory

### `UserPromptSubmit`

- Wired in `.claude/settings.json` to run `.claude/telemetry_tool/telemetry-hook.js`.
- Reads hook JSON from stdin.
- On `hook_event_name === "UserPromptSubmit"`, appends a `prompt_start` event to
  `<git root>/.ai_work_dir/telemetry/<session_id>.jsonl`.
- Captures:
    - `session_id`
    - prompt text
    - ISO timestamp
    - `CTX_*` values from `.claude/telemetry_tool/.env` and `.env.local`
    - git remote/root, branch, and user
- Non-blocking: exits `0` on errors after writing to `hook.log`.

### `PreToolUse`

- Wired in `.claude/settings.json` for `Read`, `Write`, `Edit`, `Glob`, and `Bash`.
- Runs `.claude/telemetry_tool/guardrail-hook.js`.
- Static checks for file tools:
    - resolves Windows, Git Bash, and WSL path variants
    - blocks access to `GUARDRAIL_PROHIBITED_FILES`
    - blocks paths outside the git root unless `GUARDRAIL_BLOCK_OUTSIDE_PROJECT=false`
    - writes `guardrail_block` telemetry for blocked access
- Optional Bash checks:
    - controlled by `GUARDRAIL_LLM_ENABLED=true`
    - asks `claude --print --no-session-persistence` to identify referenced files and evaluate policy
    - can block prohibited-file, outside-project, and network access
    - fail-open on LLM errors, timeouts, and invalid JSON
- Claude-specific block output currently uses `hookSpecificOutput.permissionDecision = "deny"`.

### `Stop`

- Wired in `.claude/settings.json` to run `.claude/telemetry_tool/send-logs-hook.js`.
- Uploads JSONL logs to the Artisyn server when both `SERVER_URL` and `API_KEY` are configured.
- Upload sources:
    - project telemetry files from `.ai_work_dir/telemetry`
    - Claude session files from `~/.claude/projects/<project-slug>/*.jsonl`
    - Claude subagent files from `~/.claude/projects/<project-slug>/<session>/subagents/*.jsonl`
- Prepends context records to Artisyn uploads:
    - `system-context` from `CLAUDE.md`, `CLAUDE.local.md`, and `.claude/rules/*.md`
    - `skill-definitions` from `.claude/skills` and user plugin skills
    - `agent-definitions` from `.claude/agents`
    - `mcp-config` from project/user Claude MCP config
- Uses `.claude-logs.sent` manifest to skip unchanged non-current-session files.
- Non-blocking: upload failures are logged but never fail the Codex/Claude session.

## Codex Hook Mapping

Codex hook events map closely to the Claude hooks:

| Existing Claude behavior         | Codex event         | Proposed Codex script                            |/t
|----------------------------------|---------------------|--------------------------------------------------|
| Prompt-start telemetry           | `UserPromptSubmit`  | `.codex/telemetry_tool/codex-telemetry-hook.js`  |
| File and command guardrails      | `PreToolUse`        | `.codex/telemetry_tool/codex-guardrail-hook.js`  |
| Upload logs at turn/session stop | `Stop`              | `.codex/telemetry_tool/codex-send-logs-hook.js`  |
| Optional approval policy checks  | `PermissionRequest` | `.codex/telemetry_tool/codex-permission-hook.js` |
| Post-command observability       | `PostToolUse`       | `.codex/telemetry_tool/codex-post-tool-hook.js`  |

Codex matchers are regex strings. Use `Read|Write|Edit|apply_patch|Bash|mcp__.*` where appropriate, and verify the exact
tool names emitted by the active Codex version before finalizing.

## Proposed Scope

### Project config

- Add `.codex/hooks.json` with command hooks for:
    - `UserPromptSubmit`
    - `PreToolUse`
    - `Stop`
- Use `commandWindows` for native Windows commands where quoting differs.
- Resolve scripts from the git root instead of relying on Codex's startup directory.
- Keep hooks short-timeout and fail-open unless the hook is intentionally blocking a policy violation.
- Document that users must trust project hooks via Codex `/hooks` before non-managed hooks run.

Example shape:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/.codex/telemetry_tool/codex-telemetry-hook.js\"",
            "commandWindows": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.codex/telemetry_tool/codex-telemetry-hook.js')\"",
            "statusMessage": "Recording Codex prompt"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read|Write|Edit|apply_patch|Bash|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/.codex/telemetry_tool/codex-guardrail-hook.js\"",
            "commandWindows": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.codex/telemetry_tool/codex-guardrail-hook.js')\"",
            "statusMessage": "Checking Codex tool call"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/.codex/telemetry_tool/codex-send-logs-hook.js\"",
            "commandWindows": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.codex/telemetry_tool/codex-send-logs-hook.js')\"",
            "statusMessage": "Uploading Codex logs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Shared hook support

- Extract shared code from `.claude/telemetry_tool/` into a provider-neutral package or duplicate minimally into
  `.codex/telemetry_tool/` for the first iteration.
- Reuse these helpers unchanged where possible:
    - `env-context.js`
    - `git-context.js`
    - `hook-log.js`
    - `write-telemetry.js`
- Add a provider field to Artisyn telemetry events:
    - `provider: "codex"`
    - keep existing Claude events either unchanged or explicitly set `provider: "claude"` in a later migration.

### Prompt telemetry

- Implement `codex-telemetry-hook.js` with the same behavior as `telemetry-hook.js`.
- Normalize Codex stdin shape into the existing event schema.
- Store prompt text if Codex exposes it on the `UserPromptSubmit` event. If prompt text is not included, record the
  event without prompt body and rely on native Codex transcript upload.
- Write to `.ai_work_dir/telemetry/<session_id>.jsonl`.

### Guardrails

- Implement `codex-guardrail-hook.js` using the current static project-boundary checks first.
- Verify the Codex blocking contract before porting Claude's `hookSpecificOutput.permissionDecision = "deny"` response.
- Prefer Codex's built-in permission profiles for broad filesystem/network restrictions and use the guardrail hook for
  project-specific checks that need telemetry or custom explanations.
- Add optional Codex LLM evaluation using `codex exec` only if it can be called without recursively firing hooks or
  creating noisy sessions. Otherwise keep LLM guardrails Claude-only for now.
- Consider adding a separate `PermissionRequest` hook for approval-time decisions that do not belong in `PreToolUse`.

### Upload

- Implement `codex-send-logs-hook.js`.
- Upload Artisyn files exactly as the Claude hook does.
- Discover Codex native session logs separately from Claude's `~/.claude/projects` path. Candidate discovery steps:
    - inspect `CODEX_HOME` or default `~/.codex`
    - find current-session transcript/log paths from hook stdin, Codex config, or Codex JSONL output
    - document the final path rules once verified
- Preserve the existing manifest behavior so unchanged files are skipped.
- Add Codex context records:
    - `AGENTS.md` files discovered from repo root to cwd
    - `.codex/rules` if present
    - `.codex/skills` if present
    - enabled Codex plugins and plugin skills when discoverable
    - MCP config from Codex config layers when discoverable

### Installer

- Extend the hook installer to support a `--provider codex|claude|both` option.
- For Codex install:
    - create `.codex/telemetry_tool/`
    - copy Codex hook scripts and shared helpers
    - create `.codex/hooks.json` or patch an existing one without removing unrelated user hooks
    - create `.codex/telemetry_tool/.env` and `.env.local`
    - print a post-install note instructing the user to review/trust hooks with Codex `/hooks`
- For uninstall:
    - remove only installer-owned Codex hook entries
    - remove `.codex/telemetry_tool/` only after confirmation
    - leave unrelated `.codex/config.toml`, `.codex/hooks.json`, rules, and skills untouched

## Acceptance Criteria

- [ ] A new `.codex/hooks.json` can be installed without requiring an existing `.codex/` directory.
- [ ] `UserPromptSubmit` writes a Codex `prompt_start` telemetry line with `provider: "codex"`.
- [ ] `PreToolUse` blocks prohibited files and outside-project file access for Codex file-edit/read tools.
- [ ] Guardrail failures write `guardrail_block` telemetry with `provider: "codex"`.
- [ ] `Stop` uploads Artisyn telemetry files for Codex sessions using the existing `SERVER_URL` and `API_KEY`.
- [ ] Upload manifest behavior matches the Claude hook behavior.
- [ ] Codex context upload includes `AGENTS.md` content when present.
- [ ] Installer supports Codex install and uninstall without damaging unrelated user Codex config.
- [ ] Hook scripts fail open on malformed stdin, missing env vars, network errors, and unsupported Codex event shapes.
- [ ] Documentation explains Codex hook trust review through `/hooks`.
- [ ] Manual validation covers Windows PowerShell and Git Bash/WSL-style paths.

## Edge Cases

- Project is not trusted by Codex: project hooks are ignored until trust is granted.
- Hook definitions changed after install: Codex requires the user to re-review the hook hash.
- No `SERVER_URL` or `API_KEY`: upload hook exits silently.
- No Codex native transcript path can be found: upload only Artisyn telemetry and log a warning.
- Codex event names or tool names differ from Claude names: normalize known aliases and log unknown shapes.
- Multiple hook sources exist: Codex runs all matching hooks, so the installer must not assume its hook is the only one.
- Multiple matching command hooks for the same event can run concurrently, so shared files must be append-safe.

## Open Questions

- What exact stdin schema does the active Codex build send for `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
  `PostToolUse`, and `Stop`?
- What exact stdout/exit-code contract should a Codex `PreToolUse` hook use to deny a tool call?
- Where should Codex native transcripts be collected from for local CLI and IDE sessions?
- Should Codex hooks live beside Claude hooks in a provider-neutral `hook/` source tree, or should `.codex/` be a
  separate install artifact?
- Should this be shipped as project-local hooks only, or as a Codex plugin that bundles hooks for easier reuse?

## References

- `.claude/settings.json`
- `.claude/telemetry_tool/telemetry-hook.js`
- `.claude/telemetry_tool/guardrail-hook.js`
- `.claude/telemetry_tool/send-logs-hook.js`
- Codex manual sections: Hooks, Advanced Configuration, Build plugins

## Notes

<!-- Append timestamped notes here as work progresses -->
