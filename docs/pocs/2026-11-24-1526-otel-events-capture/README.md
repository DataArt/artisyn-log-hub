# PoC: which Claude Code OTEL events and attributes actually arrive

Task: [2026-11-24-otel-events-triage](../../tasks/todo/2026-11-24-otel-events-triage/requirements.md) (FR-1 inventory).

## Question

Which of the events / attributes listed in the task arrive on a real session with the Log Hub
installer's OTEL env (logs + metrics + traces), on the stable Claude Code (2.1.325) and on the
latest (2.1.331)? What are their attribute keys? Does `gen_ai.usage.input_tokens` include cache
tokens, and does `gen_ai.response.model` differ from the native `model` attribute?

## Method

- `receiver.js` — a minimal OTLP/HTTP-JSON receiver that appends every request body to
  `raw.ndjson`. It stands in for the hook's receiver, which forwards the lines unchanged; Log Hub
  itself is not involved.
- `capture.js` — runs `claude -p` sessions (model haiku, `--setting-sources project`, so the user
  scope's OTEL endpoints and plugins do not interfere) with exactly the installer's env
  (`artisyn-hooks-installer/src/otel-env.ts` `OTEL_ENV_KEYS` + `OTEL_TRACE_ENV_KEYS`), in a copy of
  `sample-project/` (its `claude-config/` becomes `.claude/` there: three command hooks and the
  `poc-hello` skill). Sessions and their triggers:

  | session | trigger |
  |---|---|
  | `skill-subagent-mention` | skill call, `@src/app.js` mention, hooks |
  | `denied-tool` | Write without permission in `-p` → reject |
  | `compact` | `/compact` on the first session (`--resume`) |
  | `api-failure` | `ANTHROPIC_BASE_URL` on a dead local port, `CLAUDE_CODE_MAX_RETRIES=2` |
  | `mid-turn` | stream-json input: a second user message while the turn runs + `set_permission_mode` control request |
  | `subagent` | general-purpose sub-agent |
  | `auto-mode` | `--permission-mode auto`, Write + Read |
  | `auto-bash` | `--permission-mode auto`, a Bash command the classifier has to decide |

- `analyze.js` — turns `raw.ndjson` into a sanitised inventory (ids, emails, paths and free text
  redacted): `results/inventory-<version>.md`.
- `check-genai.js` — for every `llm_request` span compares `gen_ai.usage.input_tokens` with
  `input_tokens + cache_read_tokens + cache_creation_tokens`, and `gen_ai.response.model` with `model`.

Deviation from the `nodejs-script` conventions: `receiver.js` is an HTTP server, so it is
callback-based; everything else is synchronous.

## How to run

From this folder (costs a few cents of haiku per version):

```powershell
npm install --ignore-scripts          # pins Claude Code 2.1.331 locally; nothing global changes
node receiver.js --port 25391 --out <raw-dir>                     # leave running
node capture.js --claude claude --port 25391 --work <new-empty-dir>
#   or --claude node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe for 2.1.331
#   --only <session,...> runs a subset
# stop the receiver, then:
node analyze.js --raw <raw-dir>/raw.ndjson --label <version> --out results/inventory-<version>.md
node check-genai.js --raw <raw-dir>/raw.ndjson
```

Keep `<raw-dir>` and the work dir outside the repo: the raw capture holds account ids and prompts.

## Result

Captured 2026-11-24 on Claude Code 2.1.325 and 2.1.331 (same sessions on both). Full per-key
inventories: [results/inventory-2.1.325.md](results/inventory-2.1.325.md),
[results/inventory-2.1.331.md](results/inventory-2.1.331.md).

**Arrived on both versions, with the installer's env (no extra flag needed):** `compaction`,
`api_error`, `api_retries_exhausted`, `skill_activated`, `subagent_completed`, `hook_registered`,
`hook_execution_start`, `hook_execution_complete`, `permission_mode_changed`, `at_mention`,
`managed_settings_resolved`, `tool_decision` (with `permission_mode`, and `classifier_verdict` in
auto mode), `user_prompt` (with `delivery.mode = "mid_turn"`), `tool_result`.

**Not documented in the task list but emitted:** log events `assistant_response`,
`mcp_server_connection`, `plugin_loaded`; spans `claude_code.tool.blocked_on_user`,
`claude_code.tool.execution`.

**Not triggered** (no cheap local trigger, or the trigger did not fire): `api_refusal`,
`hook_plugin_metrics`, `plugin_installed` (would need a plugin install outside the project),
`internal_error`, `feedback_survey`, `retention_sweep`, and the `classifier_category` attribute
(the one classifier decision in the capture was `allow`, with no category).

**`gen_ai.*` span attributes:** only on 2.1.331 (2.1.325 has `gen_ai.operation.name` on
`interaction` / `tool` spans only). On 2.1.331 `llm_request` spans carry
`gen_ai.response.model`, `gen_ai.request.model`, `gen_ai.operation.name = "chat"`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, plus
`gen_ai.system`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.response.id`,
`gen_ai.response.finish_reasons`.

`check-genai.js` on 2.1.331: 11 of 11 `llm_request` spans have
`gen_ai.usage.input_tokens == input_tokens + cache_read_tokens + cache_creation_tokens`
(e.g. 25916 = 2 + 17912 + 8002) — the semconv value **includes** cache tokens. In 11 of 11,
`gen_ai.response.model` equals the native `model` attribute, which every `llm_request` span
already carries.

**Hook identity:** `hook_execution_complete` carries `hook_event`, `hook_name` (e.g.
`PreToolUse:Skill`), `hook_source` (`merged`), `num_hooks`, `num_success`, `total_duration_ms`,
`stdout_chars`, but no hook command or plugin name; `hook_registered` has `hook_source`
(`projectSettings`) and `hook_matcher`, also without a command. Telling Log Hub's own hook apart
from other hooks was not verified (the capture had only the sample's project hooks).

**Caveats:** one machine, one account, haiku only, `-p` (non-interactive)
sessions; mid-turn delivery and the mode change came through stream-json, not the interactive UI.
