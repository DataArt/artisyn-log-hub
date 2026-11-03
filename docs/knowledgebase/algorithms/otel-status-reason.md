---
reviewed: no
reviewer: none
---

# OTEL status: effective config, state, reason and write rule

## Purpose

A session's OTEL tab can be empty for reasons the user cannot see: Claude Code `2.1.282`+ ignores
telemetry keys in the project settings, an admin pins or disables OTEL through managed settings,
the receiver is down. Since hook `2.30.0` the hook tells the user why: at `SessionStart` it warns
about ignored or drifted keys, and at `Stop` / `SessionEnd` it reports one per-session
`otel-status` (state + reason) that the session and repository OTEL tabs turn into the reason panel,
the partial banner and the coverage chips. The same rules must give the same answer every time, or
the UI would blame the wrong cause.

## Code

- Implementation: `hook/.claude/telemetry_tool/otel-status.js` — `resolveEffectiveOtel`,
  `deriveConfigWarnings`, `deriveState`, `deriveReason`, `shouldWriteStatus` (constants
  `CLAUDE_CODE_PROJECT_OTEL_CUTOFF` = `'2.1.282'`, `ARTISYN_OTEL_KEYS`, `STATE_RANK`). Callers:
  `otel-endpoint-check.js` (SessionStart warnings), `send-logs-hook.js` (`maybeWriteOtelStatus`,
  via `buildOtelStatusEvent`).
- Twins: none. The server only stores and normalises the event (`extractOtelStatus`); the managed
  inputs come from `managed-settings.js` (`pinnedSignals` / `disabledSignals`).
- Test: `hook/.claude/telemetry_tool/__tests__/otel-status-reason.algo.test.js`.
- Design: [../otel-tabs.md](../otel-tabs.md) § "OTEL coverage and status",
  [../hook-installation.md](../hook-installation.md) § "OTEL Settings".

## Input and output

Every row has `input.kind`:

| `kind` | Call | Compared |
|---|---|---|
| `effective` | `resolveEffectiveOtel(scopes, claudeVersion)`; `scopes` = `{managed?, user?, local?, project?}`, each that scope's `env` object | `{projectScopeHonored, effective, ignored, projectOnlyKeys}`, where `effective` maps each key to its winning **scope** name (values dropped) and `ignored` / `projectOnlyKeys` are compared in full |
| `warnings` | `deriveConfigWarnings({effective: resolveEffectiveOtel(scopes, claudeVersion), userEnv: scopes.user, forwardMode, sharedPort})` | `{warnings}` (ordered list) |
| `state` | `deriveState(received, signals)` | `{state}` |
| `reason` | `deriveReason(input)` — the row's `input` minus `kind` is passed as is | `{reason}` |
| `write` | `shouldWriteStatus(phase, prev, next)` | `{write}` |

`L` in the notes is `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`.

## Rules

**Version** (`projectScopeHonored`): Claude Code reads telemetry keys from the project scopes
(`local` = `.claude/settings.local.json`, `project` = `.claude/settings.json`) only when its version
parses as `x.y.z` (prefix match) and is **below** `2.1.282`. An unknown or unparseable version counts
as "at or past the cutoff".

**Effective scope** (`resolveEffectiveOtel`), for each key of `ARTISYN_OTEL_KEYS` in order:

1. Walk the scopes `managed → local → project → user` (Claude Code's settings precedence: user is
   the lowest file scope); a scope "has" the key when its value is a string that is not blank after
   trimming. From 2.1.282 on the project scopes drop out (rule 2), leaving `managed → user`.
2. A project scope (`local`, `project`) that is not honored → add `{key, scope,
   why:'project-scope-ignored'}` to `ignored` and continue.
3. The first remaining scope wins (`effective[key]` = that scope); every later scope that has the
   key → `{key, scope, why:'shadowed'}` in `ignored`.
4. No winner, project scopes not honored, and a project scope has the key → the key goes to
   `projectOnlyKeys` — except `OTEL_RESOURCE_ATTRIBUTES`: the installer writes it only to
   `.claude/settings.local.json` by design (its `artisyn.repo` value differs per repository, the
   user scope is shared) and the receiver routes by the session register, so it is never
   `project-only`.

**Warnings** (`deriveConfigWarnings`), in this order, at most one each:

1. `project-only` — `projectOnlyKeys` is not empty.
2. `endpoint-drift` — `forwardMode` is `proxy` or `replace` and some user-scope endpoint key (logs,
   metrics, traces) is not a loopback URL (`http(s)://127.0.0.1|localhost|[::1]:<port>…`).
3. `port-mismatch` — `sharedPort` is set and some user-scope endpoint is a loopback URL on another
   port.

**State** (`deriveState`): the enabled signals are those with `signals[s] === true` (logs, metrics,
spans). No enabled signal → `none`. Count the enabled signals with `Number(received[s]) >= 1`: all →
`ok`, some → `partial`, none → `none`. `received` counts only routed records (pending ones are not
in it).

**Reason** (`deriveReason`), first match wins:

1. `receiverDown === true` or `detail === 'port-conflict'` → `receiver-down` (even with state `ok`).
2. `state === 'ok'` → `null`.
3. Among the enabled signals: some is in `managed.disabledSignals` and none is in
   `managed.pinnedSignals` → `managed-disabled`.
4. Some enabled signal is in `managed.pinnedSignals` → `managed-endpoint`.
5. `!userHasArtisynEndpoint && projectHasArtisynEndpoint` and the project scope is not honored for
   `claudeVersion` → `project-only`.
6. `!effectiveHasArtisynEndpoint` → `not-configured`.
7. Otherwise → `unknown`.

**Write rule** (`shouldWriteStatus(phase, prev, next)`), with `STATE_RANK` none 0 < partial 1 < ok 2:

1. `prev` set (already written for this session) → write only when `rank(next.state) >
   rank(prev.state)`.
2. Nothing written yet: `session-end` → write; `stop` → write when
   `received.logs + received.metrics + received.spans ≥ 1`.

## Edge cases

- Version boundary on both sides and unknown: SS-01, SS-02, SS-03, SS-08.
- Shadowing within honored and not-honored scopes: SS-04, SS-05, SS-06, SS-09; blank value: SS-07.
- Each warning class and its negative: SW-01 … SW-06; the per-repo resource attributes are not
  project-only: SS-10, SW-07.
- State: all / some / none, no enabled signal, a disabled signal ignored, a numeric string: ST-01 …
  ST-06.
- Reason order: receiver-down beats ok (RN-01) and is triggered by the detail alone (RN-02);
  managed-disabled vs managed-endpoint (RN-04, RN-05); managed signals that are not enabled do not
  count (RN-06, RN-12); project-only on both sides of the version cutoff and unknown (RN-07, RN-08,
  RN-09); not-configured and unknown (RN-10, RN-11).
- Write rule: first Stop without data (WR-01), with data (WR-02), first SessionEnd (WR-03),
  improvements (WR-04, WR-08), no change or worse (WR-05, WR-06, WR-07).

## Examples

Rows (43): [`docs/algorithm-examples/otel-status-reason.json`](../../algorithm-examples/otel-status-reason.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Unknown version treated as before the cutoff" -> SS-03, RN-09.
- "Cutoff compared with `<=`" (2.1.282 still honored) -> SS-02.
- "Project scope wins over user when honored" -> SS-04.
- "A blank value counts" -> SS-07.
- "endpoint-drift also in keep mode" -> SW-03.
- "`partial` when no signal is enabled" / "disabled signals counted" -> ST-04, ST-01.
- "ok is checked before receiver-down" -> RN-01.
- "managed signals counted even when not enabled" -> RN-06, RN-12.
- "managed-disabled wins over a pinned signal" -> RN-05.
- "Stop writes the first status even without records" -> WR-01; "a status is re-written on every
  Stop" -> WR-05; "SessionEnd always writes" -> WR-06; "a worse state overwrites" -> WR-07.

## Where the result is visible

`hook.log` (`otel project-only …`, `otel endpoint-drift …`, `otel port-mismatch …`,
`otel-status state=… reason=…`); the session's `otel-status` line → `session_stats.otel_state` /
`otel_reason` → the session OTEL tab's reason panel and partial banner, the repository / team
coverage chips and the sessions `otelReason=` filter.
