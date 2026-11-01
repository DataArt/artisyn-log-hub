# Research findings 1 — 2026-10-30 (plan-deep)

## Requirements summary
Claude Code ≥ 2.1.282 ignores OTEL exporter keys in project `.claude/settings*.json`, so the per-project receiver (random port per repo, endpoint in `settings.local.json`) gets nothing. Replace with **one receiver per OS user**: per-user port in `~/.artisyn/otel/port.json`; endpoint keys in `~/.claude/settings.json` (+ mirror in `settings.local.json` for < 2.1.282); "first spawner's code wins" dumb receiver; each repo's hook sends authenticated `/artisyn/register` with sessionId, gitRoot, otelDir, signals, uploader path, realtime target, hookVersion, contract; answer `{receiverVersion, contract, capabilities[]}`; persisted session registry (24 h TTL) routes records to each repo's `otelDir`; pending spool for unregistered sessions (5 min / 5,000 records), `OTEL_RESOURCE_ATTRIBUTES` repo tag fallback; per-repo uploader sweep with chunk lines carrying `receiverVersion` and hookVersion from registration; new `/artisyn/session-status`; new `otel-status` artisyn event (state ok/partial/none, reason) stored server-side and surfaced on OTEL tabs (reason message, "OTEL for N of M" coverage, cost marker); managed settings detected, never overridden; installer asks proxy/keep/replace (default keep) when a foreign collector exists — proxy forwards raw OTLP/HTTP-JSON upstream, backup, `_artisynOtel` note, user-level SessionStart hook; user + troubleshooting + admin docs (offline). Old hooks keep their per-project ports.

## Wireframes
`wireframes/`:
- `session-otel-tab-no-data.svg` — status line `OTEL status: none · reason managed-endpoint · hook 2.29.0 · Claude Code 2.1.314 · forward off`; reason title + body; "Still works ✓ / Not available ✗" boxes (all reasons); help button; counts line "Received by the receiver at Stop: logs 0 · metrics 0 · spans 0 · first record —"; cost marker "excl. utility calls (no OTEL) ⓘ" in meta strip and Summary Cost tile; `partial` → slim amber banner above the normal chart; no `otel_status` → generic text, no status line.
- `repo-otel-tab-coverage.svg` — banner "OTEL for 30 of 42 sessions — totals and averages below cover these 30 sessions only…", reason chips with counts (`project-only · 7`, `not-configured · 3`, `no status (older hook) · 2`), "Why no OTEL?"; new KPI tile "Sessions with OTEL 30 / 42, 71 % coverage · 3 users" (30/42 = 71.43 % → 71 %); "0 of M" variant replaces chart/tiles with the dominant reason + "Show 1 month" + help; banner hidden when all sessions have OTEL; chips filter the Sessions list; team tab gets the same banner across team repos.
- `otel-reason-messages.svg` — full title/body/help-link table for `managed-endpoint`, `managed-disabled`, `project-only`, `not-configured`, `receiver-down`, `unknown`, "(no otel_status)"; chip colours red=managed, amber=user can fix, grey=unknown/not reported; reuse `OtelEmptyState`/`OtelHelpLink`.

## Knowledgebase
- `docs/knowledgebase/otel-receiver.md` — main article to rewrite: "One receiver per project — always" section and "Rejected alternatives" (shared receiver rejected) get replaced. Keep: spawn+register handshake (argv **and** `ARTISYN_OTEL_*` env twins), neutral cwd `os.tmpdir()`, 409 guard, origin/Content-Type defences, `SESSION_ID_RE`, `.tmp`+rename chunk write, `dir-gone` check, realtime sender, `--otel-sweep`. Stale-receiver restart section conflicts with FR-A3 → scope to legacy ports only.
- `docs/knowledgebase/hook-installation.md` §"OTEL Settings" (L343–503) — port allocation (range 25000–65535 = 40,536 slots, prime step 7919), `settings.local.json` env block, ownership rules (`isArtisynOwnedOtelValue`), per-key merge (`mergeOtelEnv`) rules 1–4, migration, `.bak`, gitignore. Same ownership rules required for user file (FR-B1).
- `docs/knowledgebase/hook-api-versioning.md` §"Hook ↔ OTEL receiver" (L193–228) — register contract additive only, unknown fields ignored; making a request field required is "breaking" → acceptable only because old hooks never touch the shared port (FR-A11); must be documented there. Section already stale ("warn only, no re-spawn" while code restarts). §"`POST /api/v2/otel-realtime`" (L613).
- `docs/knowledgebase/otel-tabs.md` (sibling task, uncommitted) — migration `0078` tables; `otel_session_state` exists only for sessions with OTEL data; statuses `hasOtel`/`slowReason`; empty states A/B/C; repo/session/team facts routes; compatibility matrix (DD-27) needs new rows; tests list names existing algo docs, contract file, scenarios.
- `docs/knowledgebase/hook-system-overview.md` — hook file table, events.
- `docs/knowledgebase/data-retention.md` — OTEL chunk prune, OTEL-only roots retention.
- `docs/knowledgebase/llm-call-math.md` — utility calls, two cost sources (cost marker).
- `docs/knowledgebase/db-tables.md`, `db-schema-code.md` — hand-written SQL migrations, never `drizzle-kit generate`; load `migrations-data-integrity` skill.
- `docs/knowledgebase/user-docs-and-site.md` — `user-docs/` + `nav.json`, relative-link rules; `user-docs/otel-tab.md` has sections Repository / Session / Team / Hidden calls / The realtime channel / Enable OTEL and traces / Upgrade the hook / Imported sessions.
- `docs/knowledgebase/algorithms/README.md` — doc format (Purpose, Code, Input and output, Rules, Edge cases, Examples block, Mutations, Where visible), table tests via `scripts/algo-docs/load-examples.cjs`. Existing OTEL docs: `otel-realtime-backoff.md` (hook), `otel-facts.md`, `otel-cost-selection.md`, `otel-trace-assembly.md`, `otel-delta-merge.md`; also `ndjson-tolerance.md`, `session-time-span.md` (`NON_ACTIVITY_LINE_TYPES`), `user-docs-links.md`.
- `docs/knowledgebase/claude-version-check.md` — server extracts Claude Code version (transcript `version` / OTEL `service.version`).
- `.claude/rules/hook.md` — bump `hook/.claude/telemetry_tool/version.json`, `npm run build:hooks-installer`, copy changed scripts to `.artisyn/marketplace/plugins/log-hub-hooks/scripts/` + bump its `plugin.json`, run `update-install-instructions` skill (INSTALL_HOOK.md), `npm run lint`.

## Existing patterns
**Hook (`hook/.claude/telemetry_tool/`)**
- `otel-receiver.js` (1938 lines): `parseArgs`/`ARGV_FLAGS`/`ENV_FALLBACKS` (:161–255) launch-args pattern; `parseOwner` (:206); `main()` (:1824) refuses ownerless; `EADDRINUSE` → exit 0 (:1880); `handleRegister` (:1668), `handleShutdown` (:1714) owner/409/400 checks; `resolveSessionId` (:338); `walkLogs`/`walkMetrics`/`walkSpans` (:367–511); `withHookVersion` (:527); `writeGroups` (:557) with `dir-gone` check — per-repo routing goes here; `getReceiverVersion` (:614); `armIdleTimer` (:741), `DEFAULT_IDLE_TIMEOUT_MS = 600000` (:80) = **10 min**; `spawnOtelSweep` (:796) spawns `send-logs-hook.js` next to itself; `readRealtimeTarget(gitRoot)` (:969) reads repo config; realtime queues per receiver (`RT_BUFFER_MAX_LINES` 2000) → per repo; `receiverLog` (:681) 1 MiB truncate; `module.exports` (:1904).
- `otel-register.js`: `buildRegistrationPayload` (:102); `handleRegisterResponse` (:188) 409 warn + stale-version restart (must not apply to shared port); `fireRegister` (:252) 2 s timeout; `buildReceiverLaunch` (:333) argv+env twins; `announceOtelSession` (:381); `maybeReArmOtelSession` (:439) throttled via `claimThrottleSlot` (`throttle-state.js`).
- `otel-restart.js`: `stopReceiverAndWait`, `findPidOnPort` (netstat/lsof); TS twin `artisyn-hooks-installer/src/otel-restart.ts`.
- `otel-endpoint-check.js`: `settingsSources` (:82) local→project→user (`claudeConfigDir`, honours `CLAUDE_CONFIG_DIR`); `resolveEndpoint` (:111); `findOtelEndpointProblems` (:141) with `opts.homeDir` test hook; one `warn` + `systemMessage`.
- `env-context.js`: `resolveOtelPort` (:459) endpoint → `otelReceiverPort` → `OTEL_FALLBACK_PORT` 25317; `resolveOtelDir` (:414); `resolveOtelNumber` (:508); config defaults table (:33–142) incl. `otelReceiverIdleTimeoutMs: 600000`.
- `lifecycle-hook.js`: SessionStart awaits `announceOtelSession` then `checkOtelEndpoints` (~:225–240).
- `send-logs-hook.js`: Stop/SessionEnd `main()` (:709), Stop re-arm (:764), `runSessionEndFlush` (:850); `hook-status` event build (:1727) — pattern for `otel-status`; `--otel-sweep` parse (:583), `runOtelSweep` (:663).
- `telemetry-hook.js` :189 UserPromptSubmit re-arm.
- `spawn-hidden.js` `spawnDetachedHidden(script, argv, {env, cwd, onSpawned, onError})`.
- `hook-log.js` `hookLog(file, sessionId, level, msg, cwd)`, `getHookVersion`.
- `claude-config-dir.js` user-level dir resolution (`os.homedir()` per call).
- `__tests__/otel-realtime.algo.test.js` — only OTEL hook table test (template).

**Installer (`artisyn-hooks-installer/src/`)**
- `otel-env.ts`: `OTEL_ENV_KEYS(port)` (9 keys), `OTEL_TRACE_ENV_KEYS(port)` (3), `OTEL_ENDPOINT_KEYS`; imported at runtime by `docker-dev/provision.mjs:97-101` (writes `settings.local.json`) — erasable TS only; sandbox provisioning needs user-scope update.
- `install.ts`: `applyHooksUpdate` (:656) → `readRecordedOtelPorts`, `resolveInstallOtelPort` (:1572), **`stopExistingReceiverIfRunning` (:709)** (conflicts FR-A3), `mergeSettings`, `verifyInstalledReceiver` (:1762) (spawns `--owner` receiver; needs shared-mode path); `allocateOtelPort` (:1548) bind probe + HTTP round-trip; `otelPortFilePath`/read/write/`removeStoredOtelPort` (:1418–1600) per-project `otel-port.json`; `isArtisynOwnedOtelValue` (:1647); `mergeOtelEnv` (:2087); `stripOwnedOtelEnvKeys` (:2217); `removeOtelEnvKeys` (:2244); `readSettingsForMutation` (:2031) aborts on invalid JSON + `.bak`, project-only; `getUserSettingsPath`/`getUserSettingsLabel` (:1951) user-scope aware; `settingsHasInstallerHooks`/`removeInstallerHookEntries` (:1867–1930); `ensureConfigIgnored(..., {secret})` (:1308) chmod 0600 POSIX only; `prompt()` (:1146); `resolveOtelTracesAnswer` (:1166) flag → stored → TTY → default; `atomicWrite` (:1217); `runUninstall` (:1095).
- `index.ts`: manual argv parsing; `--otel-traces=` (:76) pattern; upgrade/uninstall reject install-only flags.

**Server**
- `server/src/logs/artisyn-extractor.ts:87` `NON_ACTIVITY_LINE_TYPES`; `extractHookStatus` (:292).
- `server/src/logs/logs.service.ts:597-620` Step 5c hook-status UPDATE only when event present.
- `server/src/database/schema/index.ts`: `session_stats` (:979), nullable `telemetryCost` (:1056), `claudeVersion`/`claudeVersionOtel` (:1082); `otel_session_state` (:619) only with OTEL data. Last migration `server/drizzle/migrations/0078_otel_tabs_traces.sql` (sibling, uncommitted) → next 0079.
- `server/src/logs/otel/otel-facts.types.ts`: `OtelRepoKpis` (:138), `OtelSessionStatus` (:285), `OtelSlowReason` (:50); mirrored in `client/src/models/repositories.ts`, `teams.ts`.
- `server/src/logs/otel-cost.sql.ts:175-186`; `repositories.controller.ts:692` session `costBreakdown`.
- `server/test/contract/registry/f25-otel.ts`, `f17-sessions.ts`.

**Client**
- `client/src/viewer/pages/repository/otel/`: `OtelEmptyState.tsx` (A/B/C), `OtelHelpLink.tsx`, `OtelSlowUpdatesBanner.tsx`, `OtelKpiTiles.tsx`/`OtelKpiTile.tsx`, `otel.constants.ts:39` `OTEL_HELP_ANCHORS`, `RepoOtelTab.tsx:206`.
- `client/src/viewer/pages/repository/session-log/otel/SessionOtelTab.tsx`; `client/src/viewer/pages/teams/otel/TeamOtelTab.tsx`.
- Cost marker: `SessionDetailHeader.tsx:136,274`, `client/src/viewer/lib/cost-hints.ts:42`, `session-log/summary/SummaryExecutiveBand.tsx`.

**Scenarios**
- `tests/scenarios/hook/s-hook-07.spec.ts` receiver register/409/400/shutdown/idle/traces/realtime.
- `tests/scenarios/hook/s-compat-01.spec.ts` frozen 1.6.2 / 2.6.1 / 2.28.0 hooks (`tests/fixtures/legacy-hooks/`).
- `tests/scenarios/hook/s-hook-01.spec.ts` Stop upload order, hook-status, new hook vs old hub.
- `tests/scenarios/installer/s-inst-01.spec.ts`, `s-inst-02.spec.ts`, `s-inst-04.spec.ts`.
- `tests/scenarios/view/s-otel-01.spec.ts`, `s-cost-01.spec.ts`; `tests/scenarios/sessions/s-slife-08.spec.ts`.
- Tours: `tests/scenarios/tours/screen-registry.ts`, tour-03/04/05/06.
- Helpers `tests/scenarios/helpers/hook-process.ts`: `makeFakeHome`/`fakeHomeEnv` (:164–188), `spawnReceiver`/`startReceiver` (:609–656) only `--owner`, `freeLoopbackPort`, `startFakeLogHub` (:479), `rawRequest` (:699); `helpers/installer.ts`; `helpers/otel.ts`.

**PoC**: `docs/pocs/2026-10-30-2327-otel-user-scope-behaviour/README.md` — no records before SessionStart (first ≈420–470 ms after); project `OTEL_RESOURCE_ATTRIBUTES` reaches all three signals; unknown top-level key accepted, wrong-typed known key disables whole file; dead port silent; `otelHeadersHelper` headers on every request; records after last Stop.

## Open gaps
1. Idle timeout: requirements "60 minutes … as today" vs code `600000` ms (10 min) in `otel-receiver.js:80`, `env-context.js:99`, `hook-installation.md`; 60 min = `3600000` ms.
2. Sibling task `2026-10-30-otel-tabs-traces` (GH-66) uncommitted on this branch (83 files): hook 2.29.0, traces, realtime, migration 0078, `f25-otel.ts`, OTEL tabs, `OtelEmptyState`. This task builds on it; version bump target undecided.
3. No Claude Code version detection in the hook (FR-E1, FR-C3, FR-B4); candidates: transcript `version` lines, `claude --version` (slow).
4. No managed-settings reader anywhere; per-OS paths/precedence from scratch; FR-F1 items 3–4 open PoC items.
5. Register auth (FR-A14): no token/HMAC pattern; no Windows user-only file permission pattern.
6. No user-level state dir (`~/.artisyn/...`): registry persistence format, locking, per-user repo registry (FR-B3), `~/.artisyn/otel/bin/` copy/versioning all new.
7. No user-level hook writer (FR-D7); FR-D11 schema-type validation new.
8. No forwarding/upstream client/foreign-collector detection (FR-D); no header masking; `isArtisynOwnedOtelValue` only loopback 25000–65535.
9. Server storage for `otel-status` undecided (nullable `session_stats` columns vs `otel_session_state`); migration 0079; coverage aggregates new SQL; contract rows in `f25-otel.ts`, `f17-sessions.ts`.
10. Algorithm docs needed: effective-OTEL-config/reason resolution, routing/pending decision, `otel-status` state + write rule.
11. Backward compat: FR-A0 rewrites `otelReceiverPort` → an old hook copy in another repo may read the shared port; shared receiver must answer legacy `--owner`-style register/shutdown safely without being shut down.
12. Side issue: `ownerRepo=` in `receiver.log` alternates remote URL/local path (`buildOwnerPayload` `repo: remote || gitRoot` vs `verifyInstalledReceiver` `path.basename(cwd)`).
