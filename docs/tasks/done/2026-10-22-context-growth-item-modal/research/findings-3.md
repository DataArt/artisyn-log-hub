# Research 3 — hook payloads: is `tool_use_id` available on permission events? (2026-10-22)

PoC: an isolated folder in the session scratchpad (`hook-poc/`, its own `git init` and
`.claude/settings.json`, so the repo's hooks were not loaded). A `dump-hook.mjs` recorded raw hook stdin for
PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest and PermissionDenied. It was driven by
`claude -p` runs on **Claude Code 2.1.280**, and each payload was joined to the session transcript.

## Payloads

| Event | Fires in `-p` | `tool_use_id` | Extra keys |
|---|---|---|---|
| PreToolUse | always | yes, matches the transcript | — |
| PostToolUse | yes | yes | `tool_response`, `duration_ms` |
| PostToolUseFailure | yes (non-zero exit) | **yes** | `error`, `is_interrupt`, `duration_ms` |
| PermissionRequest | yes, when a prompt would show | **no**, and no other join key | `permission_suggestions` |
| PermissionDenied | **only for auto-mode classifier denials** | **yes** | `reason` |

- Common keys on every event: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`, and `tool_name` / `tool_input`.
- Every `tool_use_id` in a hook payload matched a transcript `tool_use.id`, and every `tool_input` deep-equalled the transcript `input`.
- The Claude Code binary agrees with the observed behaviour: it builds the PermissionDenied payload with `tool_use_id` and `reason`, and the PermissionRequest payload without the id even though it holds the id internally.

## Permission behaviour

- **A call that needs approval in `-p` with no host to approve it:** PreToolUse (with id) fires, then PermissionRequest (without id). The call is denied immediately and no PermissionDenied fires. The transcript gets an `is_error` `tool_result`, and the user line carries a top-level `toolDenialKind: "user-rejected"`, or `"permission-rule"` with `--permission-prompts none`.
- **A deny rule or `--permission-mode dontAsk`:** only PreToolUse fires. The transcript gets `toolDenialKind: "permission-rule"`.
- **An auto-mode classifier denial:** PermissionDenied fires (with id and reason). The transcript gets `toolDenialKind: "automode-blocked"`.
- **Two calls in one turn, one of them needing approval:** name + input picked the right call.

## `toolDenialKind` in the maintainer's real transcripts

A top-level key on the `user` line that carries the `tool_result`, next to `toolUseResult`:
- `permission-rule` 96;
- `user-rejected` 17;
- `interrupted` 1;
- `automode-blocked` 1.

Example text that the rejection markers miss: "Claude requested permissions to write to …".

## Consequences for the plan

- The hook records `tool_use_id` on PostToolUseFailure and PermissionDenied, and `reason` on PermissionDenied. The change is additive: the values are null on older Claude Code (DD-25).
- PermissionRequest stays matched by name + input. Caching ids from a PreToolUse hook was rejected because it would spawn a process on every tool call.
- Denials that fire no permission event are read from `toolDenialKind` in the transcript (DD-2, DD-3), on both client and server.
