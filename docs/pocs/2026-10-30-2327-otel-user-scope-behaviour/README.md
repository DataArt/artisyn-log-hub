# PoC: Claude Code OTEL behaviour for a shared user-scope receiver

Task: [2026-10-30-otel-shared-receiver](../../tasks/todo/2026-10-30-otel-shared-receiver/requirements.md)
(FR-F1 items 1, 2, 5 and the Open Questions on FR-A13, `otelHeadersHelper`, pending TTL and the
FR-D11 note format).

## Questions

1. Do OTLP records arrive before the `SessionStart` hook runs (size of the pending-buffer problem)?
2. Does `OTEL_RESOURCE_ATTRIBUTES` from the project's `.claude/settings.local.json` reach log,
   metric and span records?
3. Does Claude Code accept an unknown top-level key (e.g. `_artisynOtel`) in a settings file, so the
   installer can leave a "what changed / how it was" note there?
4. Is exporting to a port where nothing listens silent for the user (no error, no slowdown)?
5. With `otelHeadersHelper`, does Claude Code send the helper's headers to the endpoint it exports
   to (so a proxying receiver can pass them upstream without storing or running the helper)?
6. Do records arrive after the last `Stop` hook?

7. With an OS-level `managed-settings.json` (FR-F1 item 3), which non-managed OTEL keys still
   apply?
8. What does `claude doctor` print for telemetry keys that are only in project scope (FR-F1 item 4)?

## How to run

From this folder (spends a few cents of real `claude -p` credits on haiku):

```
node run.mjs --work-dir <empty folder outside the repo>
node run.mjs --only baseline --work-dir <another empty folder>
```

`run.mjs` starts a mock OTLP/HTTP collector on a random loopback port, then runs one
`claude -p` session per experiment in its own sample project under `--work-dir`. The OTEL keys
and hooks come from a flag settings file (`--settings`, an honoured scope for telemetry keys) with
`--setting-sources project,local` so the developer's own user settings and plugins stay out.
`hook.mjs` reports `SessionStart` / `UserPromptSubmit` / `Stop` / `SessionEnd` with timestamps to
the same mock. `headers-helper.cmd` is the `otelHeadersHelper` (Windows). Summaries go to stdout and
`results/` (ignored).

Experiments: `baseline` (unknown `_artisynOtel` key in flag and local settings,
`OTEL_RESOURCE_ATTRIBUTES` in local settings), `invalid` (control: a known key with a wrong type),
`deadport`, `helper`, `managed`.

`managed` needs an elevated (Administrator) shell:

```
node run.mjs --only managed --work-dir <empty folder outside the repo>
```

It writes the OS managed file (`%ProgramFiles%\ClaudeCode\managed-settings.json` on Windows;
`--managed-path` overrides it). It refuses to run when that file already exists. It runs four
variants, each with the full OTEL env in the flag (non-managed) scope pointing at a "user" mock
collector. After each variant it deletes only the file it wrote. A folder it created is left in
place and printed.

| Variant | What the managed file sets |
|---|---|
| `managed-endpoint` | the full env, pointing at a second mock |
| `managed-logs-endpoint-only` | only `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` |
| `managed-disabled` | `CLAUDE_CODE_ENABLE_TELEMETRY=0` |
| `managed-exporters-none` | all three exporters set to `none` |

Item 8 is checked by hand: run `claude doctor` in a project whose OTEL keys are only in
`.claude/settings.local.json`.

## Result

Claude Code 2.1.314, Windows, 2026-10-30.

1. **No records before `SessionStart`.** In every session the hook ran first; the first OTLP
   request came ~420–470 ms after it (`otlpBeforeSessionStart: 0`). The pending buffer only has to
   bridge the register round trip, not minutes.
2. **Yes, on all three signals.** `artisyn.repo=poc-local` from `.claude/settings.local.json`
   was on the resource of every log, metric and span request (`artisynAttrBySignal` all `true`).
   FR-A13 routing fallback works.
3. **Unknown top-level keys are accepted silently** in flag and project-local settings (session
   ran, hooks fired, no stderr). Control: a known key with a wrong type makes Claude Code **skip
   the whole file** ("These settings files did not load, so nothing in them is in effect,
   including hooks and permission rules"). So the note key is safe, but anything the installer
   writes into `~/.claude/settings.json` must be schema-valid, or all the user's settings vanish.
   The user-scope file itself was not tested (it would mean editing the real one); it goes through
   the same settings loader.
4. **Silent.** Endpoint on a closed port: exit 0, normal answer, no stderr, same duration
   (6.1 s vs 6.2 s baseline).
5. **Yes.** With `otelHeadersHelper` the helper's header (`x-poc-auth: from-helper`) arrived on
   every OTLP request to the mock. A proxying receiver can forward the incoming headers as-is;
   neither the helper nor static header values need to be stored or run by Log Hub.
6. **Yes.** One logs, one metrics and one traces request arrived after the last `Stop` (shutdown
   flush). Status taken at `Stop` undercounts; the `SessionEnd` / correction rule is needed.
7. **A managed endpoint wins per key, not per file.** Claude Code 2.1.314, Windows, 2026-10-31,
   managed file at `C:\Program Files\ClaudeCode\managed-settings.json`. Requests per signal:

   | Variant | Non-managed endpoint (logs / metrics / traces) | Managed endpoint (logs / metrics / traces) |
   |---|---|---|
   | `managed-endpoint` | 0 / 0 / 0 | 3 / 3 / 1 |
   | `managed-logs-endpoint-only` | 0 / 3 / 1 | 3 / 0 / 0 |
   | `managed-disabled` | 0 / 0 / 0 | — |
   | `managed-exporters-none` | 0 / 0 / 0 | — |

   - A managed per-signal endpoint takes only that signal. The other signals still go to the
     non-managed endpoint, so a partly managed setup gives the receiver a `partial` state.
   - `CLAUDE_CODE_ENABLE_TELEMETRY=0`, or every exporter set to `none`, in managed settings stops
     all export.
   - Every session ran normally: exit 0, hooks fired, no settings error.
   - A generic managed `OTEL_EXPORTER_OTLP_ENDPOINT` and a single-signal `none` were not tested.
8. **`claude doctor` names the ignored keys exactly.** For a project with the OTEL env only in
   `.claude/settings.local.json` it prints:

   > Claude Code ignores these telemetry variables in .claude\settings.local.json:
   > CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_LOGS_EXPORTER, OTEL_METRICS_EXPORTER,
   > OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
   > OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, OTEL_LOG_TOOL_DETAILS. A project's settings files can
   > only turn telemetry off […] set them in your shell, your user settings
   > (~/.claude/settings.json), or managed settings instead.

   - `OTEL_RESOURCE_ATTRIBUTES` from the same file is not in the list, which confirms item 2.
   - `doctor` also prints `Managed settings (remote): …` (server-managed settings) and
     `Organization policy: …`. That makes it the check to name in the troubleshooting docs for
     `project-only` and `managed-*`.
   - `/status` was not captured; `doctor` covers what the docs need.
