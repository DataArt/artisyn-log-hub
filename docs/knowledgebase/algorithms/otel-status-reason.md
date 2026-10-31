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
   `projectOnlyKeys`.

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
- Each warning class and its negative: SW-01 … SW-06.
- State: all / some / none, no enabled signal, a disabled signal ignored, a numeric string: ST-01 …
  ST-06.
- Reason order: receiver-down beats ok (RN-01) and is triggered by the detail alone (RN-02);
  managed-disabled vs managed-endpoint (RN-04, RN-05); managed signals that are not enabled do not
  count (RN-06, RN-12); project-only on both sides of the version cutoff and unknown (RN-07, RN-08,
  RN-09); not-configured and unknown (RN-10, RN-11).
- Write rule: first Stop without data (WR-01), with data (WR-02), first SessionEnd (WR-03),
  improvements (WR-04, WR-08), no change or worse (WR-05, WR-06, WR-07).

## Examples

```examples
[
  {"id": "SS-01", "input": {"kind": "effective", "claudeVersion": "2.1.281", "scopes": {"project": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"projectScopeHonored": true, "effective": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "project"}, "ignored": [], "projectOnlyKeys": []}, "note": "2.1.281 < 2.1.282 -> project honored; L only in project -> project wins"},
  {"id": "SS-02", "input": {"kind": "effective", "claudeVersion": "2.1.282", "scopes": {"project": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"projectScopeHonored": false, "effective": {}, "ignored": [{"key": "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "scope": "project", "why": "project-scope-ignored"}], "projectOnlyKeys": ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"]}, "note": "2.1.282 is not below the cutoff -> project ignored (rule 2), no winner -> project-only (rule 4)"},
  {"id": "SS-03", "input": {"kind": "effective", "claudeVersion": null, "scopes": {"local": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"projectScopeHonored": false, "effective": {}, "ignored": [{"key": "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "scope": "local", "why": "project-scope-ignored"}], "projectOnlyKeys": ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"]}, "note": "unknown version counts as >= cutoff; local is a project scope -> ignored, project-only"},
  {"id": "SS-04", "input": {"kind": "effective", "claudeVersion": "2.1.200", "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:31000/v1/logs"}, "local": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"projectScopeHonored": true, "effective": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "local"}, "ignored": [{"key": "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "scope": "user", "why": "shadowed"}], "projectOnlyKeys": []}, "note": "honored; local outranks user (Claude Code precedence) -> local wins, user shadowed (rule 3)"},
  {"id": "SS-09", "input": {"kind": "effective", "claudeVersion": "2.1.200", "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://foreign.example.com/v1/logs"}, "project": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}, "local": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30001/v1/logs"}}}, "expected": {"projectScopeHonored": true, "effective": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "local"}, "ignored": [{"key": "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "scope": "project", "why": "shadowed"}, {"key": "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "scope": "user", "why": "shadowed"}], "projectOnlyKeys": []}, "note": "honored; order managed > local > project > user -> local wins, project then user shadowed"},
  {"id": "SS-05", "input": {"kind": "effective", "claudeVersion": "2.1.300", "scopes": {"managed": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://corp.example.com/v1/logs"}, "user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:31000/v1/logs"}}}, "expected": {"projectScopeHonored": false, "effective": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "managed"}, "ignored": [{"key": "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "scope": "user", "why": "shadowed"}], "projectOnlyKeys": []}, "note": "managed first -> managed wins, user shadowed"},
  {"id": "SS-06", "input": {"kind": "effective", "claudeVersion": "2.1.300", "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:31000/v1/logs"}, "project": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"projectScopeHonored": false, "effective": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "user"}, "ignored": [{"key": "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "scope": "project", "why": "project-scope-ignored"}], "projectOnlyKeys": []}, "note": "user wins; project not honored -> project-scope-ignored; a winner exists -> not project-only"},
  {"id": "SS-07", "input": {"kind": "effective", "claudeVersion": "2.1.300", "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "   "}}}, "expected": {"projectScopeHonored": false, "effective": {}, "ignored": [], "projectOnlyKeys": []}, "note": "rule 1: a blank value does not count as having the key"},
  {"id": "SS-08", "input": {"kind": "effective", "claudeVersion": "v2", "scopes": {"project": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"projectScopeHonored": false, "effective": {}, "projectOnlyKeys": ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"]}, "note": "'v2' does not parse as x.y.z -> unknown -> not honored -> project-only"},
  {"id": "SW-01", "input": {"kind": "warnings", "claudeVersion": "2.1.300", "scopes": {"project": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"warnings": ["project-only"]}, "note": "warning 1: projectOnlyKeys = [L]; no user endpoint -> nothing else"},
  {"id": "SW-02", "input": {"kind": "warnings", "claudeVersion": "2.1.300", "forwardMode": "proxy", "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://collector.example.com/v1/logs"}}}, "expected": {"warnings": ["endpoint-drift"]}, "note": "warning 2: proxy and a non-loopback user endpoint"},
  {"id": "SW-03", "input": {"kind": "warnings", "claudeVersion": "2.1.300", "forwardMode": "keep", "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://collector.example.com/v1/logs"}}}, "expected": {"warnings": []}, "note": "warning 2 needs proxy or replace; keep -> no drift"},
  {"id": "SW-04", "input": {"kind": "warnings", "claudeVersion": "2.1.300", "sharedPort": 31000, "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"warnings": ["port-mismatch"]}, "note": "warning 3: loopback user endpoint on 30000, shared port 31000"},
  {"id": "SW-05", "input": {"kind": "warnings", "claudeVersion": "2.1.300", "sharedPort": 31000, "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://localhost:31000/v1/logs"}}}, "expected": {"warnings": []}, "note": "warning 3: same port (localhost counts as loopback) -> nothing"},
  {"id": "SW-06", "input": {"kind": "warnings", "claudeVersion": "2.1.300", "forwardMode": "replace", "sharedPort": 31000, "scopes": {"user": {"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:30000/v1/logs"}}}, "expected": {"warnings": ["port-mismatch"]}, "note": "replace, but the endpoint is loopback -> no drift; wrong port -> port-mismatch only"},
  {"id": "ST-01", "input": {"kind": "state", "received": {"logs": 3, "metrics": 1, "spans": 0}, "signals": {"logs": true, "metrics": true, "spans": false}}, "expected": {"state": "ok"}, "note": "enabled logs, metrics; both >= 1 -> ok (spans not enabled)"},
  {"id": "ST-02", "input": {"kind": "state", "received": {"logs": 3}, "signals": {"logs": true, "metrics": true, "spans": false}}, "expected": {"state": "partial"}, "note": "1 of 2 enabled signals present -> partial"},
  {"id": "ST-03", "input": {"kind": "state", "received": {}, "signals": {"logs": true, "metrics": true, "spans": true}}, "expected": {"state": "none"}, "note": "0 of 3 present -> none"},
  {"id": "ST-04", "input": {"kind": "state", "received": {"logs": 5}, "signals": {"logs": false, "metrics": false, "spans": false}}, "expected": {"state": "none"}, "note": "no enabled signal -> none"},
  {"id": "ST-05", "input": {"kind": "state", "received": {"logs": 2, "metrics": 2, "spans": 0}, "signals": {"logs": true, "metrics": true, "spans": true}}, "expected": {"state": "partial"}, "note": "spans enabled but 0 -> 2 of 3 -> partial"},
  {"id": "ST-06", "input": {"kind": "state", "received": {"logs": "2", "metrics": 1}, "signals": {"logs": true, "metrics": true}}, "expected": {"state": "ok"}, "note": "Number('2') = 2 >= 1 -> counts; 2 of 2 -> ok"},
  {"id": "RN-01", "input": {"kind": "reason", "state": "ok", "receiverDown": true, "signals": {"logs": true, "metrics": true}}, "expected": {"reason": "receiver-down"}, "note": "rule 1 comes before rule 2"},
  {"id": "RN-02", "input": {"kind": "reason", "state": "none", "detail": "port-conflict", "signals": {"logs": true, "metrics": true}, "effectiveHasArtisynEndpoint": true}, "expected": {"reason": "receiver-down"}, "note": "rule 1: the port-conflict detail alone"},
  {"id": "RN-03", "input": {"kind": "reason", "state": "ok", "signals": {"logs": true, "metrics": true}}, "expected": {"reason": null}, "note": "rule 2: ok -> no reason"},
  {"id": "RN-04", "input": {"kind": "reason", "state": "none", "signals": {"logs": true, "metrics": true}, "managed": {"pinnedSignals": [], "disabledSignals": ["logs", "metrics", "spans"]}}, "expected": {"reason": "managed-disabled"}, "note": "rule 3: enabled signals disabled, none pinned"},
  {"id": "RN-05", "input": {"kind": "reason", "state": "partial", "signals": {"logs": true, "metrics": true}, "managed": {"pinnedSignals": ["logs"], "disabledSignals": ["metrics"]}}, "expected": {"reason": "managed-endpoint"}, "note": "rule 3 fails (logs pinned); rule 4: logs pinned"},
  {"id": "RN-06", "input": {"kind": "reason", "state": "partial", "signals": {"logs": true, "metrics": true, "spans": false}, "managed": {"pinnedSignals": ["spans"], "disabledSignals": []}, "userHasArtisynEndpoint": true, "effectiveHasArtisynEndpoint": true}, "expected": {"reason": "unknown"}, "note": "spans pinned but not enabled -> rules 3-4 skip; user endpoint -> not project-only; effective -> unknown"},
  {"id": "RN-07", "input": {"kind": "reason", "state": "none", "signals": {"logs": true, "metrics": true}, "userHasArtisynEndpoint": false, "projectHasArtisynEndpoint": true, "effectiveHasArtisynEndpoint": false, "claudeVersion": "2.1.300"}, "expected": {"reason": "project-only"}, "note": "rule 5: only project endpoint on 2.1.300"},
  {"id": "RN-08", "input": {"kind": "reason", "state": "none", "signals": {"logs": true, "metrics": true}, "userHasArtisynEndpoint": false, "projectHasArtisynEndpoint": true, "effectiveHasArtisynEndpoint": true, "claudeVersion": "2.1.200"}, "expected": {"reason": "unknown"}, "note": "2.1.200 honors project -> rule 5 fails; effective endpoint -> rule 6 fails -> unknown"},
  {"id": "RN-09", "input": {"kind": "reason", "state": "none", "signals": {"logs": true}, "projectHasArtisynEndpoint": true, "claudeVersion": null}, "expected": {"reason": "project-only"}, "note": "unknown version -> not honored -> project-only"},
  {"id": "RN-10", "input": {"kind": "reason", "state": "none", "signals": {"logs": true, "metrics": true}}, "expected": {"reason": "not-configured"}, "note": "no managed, no endpoint anywhere -> rule 6"},
  {"id": "RN-11", "input": {"kind": "reason", "state": "none", "signals": {"logs": true, "metrics": true}, "userHasArtisynEndpoint": true, "effectiveHasArtisynEndpoint": true}, "expected": {"reason": "unknown"}, "note": "configured, nothing arrived, no known cause -> rule 7"},
  {"id": "RN-12", "input": {"kind": "reason", "state": "none", "signals": {"logs": true, "metrics": true, "spans": false}, "managed": {"pinnedSignals": [], "disabledSignals": ["spans"]}}, "expected": {"reason": "not-configured"}, "note": "only spans disabled and spans not enabled -> rule 3 skips; no endpoint -> not-configured"},
  {"id": "WR-01", "input": {"kind": "write", "phase": "stop", "prev": null, "next": {"state": "none", "received": {"logs": 0, "metrics": 0, "spans": 0}}}, "expected": {"write": false}, "note": "first Stop with total 0 -> not yet"},
  {"id": "WR-02", "input": {"kind": "write", "phase": "stop", "prev": null, "next": {"state": "partial", "received": {"logs": 1, "metrics": 0, "spans": 0}}}, "expected": {"write": true}, "note": "first Stop, total 1 >= 1 -> write"},
  {"id": "WR-03", "input": {"kind": "write", "phase": "session-end", "prev": null, "next": {"state": "none", "received": {"logs": 0, "metrics": 0, "spans": 0}}}, "expected": {"write": true}, "note": "SessionEnd, nothing written -> write even with none"},
  {"id": "WR-04", "input": {"kind": "write", "phase": "stop", "prev": {"state": "partial"}, "next": {"state": "ok", "received": {"logs": 4, "metrics": 2, "spans": 0}}}, "expected": {"write": true}, "note": "rank 2 > 1 -> late correction to ok"},
  {"id": "WR-05", "input": {"kind": "write", "phase": "stop", "prev": {"state": "ok"}, "next": {"state": "ok", "received": {"logs": 9, "metrics": 3, "spans": 0}}}, "expected": {"write": false}, "note": "same rank -> no second line"},
  {"id": "WR-06", "input": {"kind": "write", "phase": "session-end", "prev": {"state": "partial"}, "next": {"state": "partial", "received": {"logs": 4, "metrics": 0, "spans": 0}}}, "expected": {"write": false}, "note": "already written, not improved -> SessionEnd writes nothing"},
  {"id": "WR-07", "input": {"kind": "write", "phase": "session-end", "prev": {"state": "ok"}, "next": {"state": "partial", "received": {"logs": 4, "metrics": 0, "spans": 0}}}, "expected": {"write": false}, "note": "worse (1 < 2) -> never downgrade"},
  {"id": "WR-08", "input": {"kind": "write", "phase": "stop", "prev": {"state": "none"}, "next": {"state": "partial", "received": {"logs": 1, "metrics": 0, "spans": 0}}}, "expected": {"write": true}, "note": "a none written at SessionEnd of an earlier run, now partial: 1 > 0 -> write"}
]
```

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
