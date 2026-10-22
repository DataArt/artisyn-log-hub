# Implementation Plan — 2026-10-22-local-dev-ports-config

## TL;DR

- Installer (`artisyn-hooks-installer/src/install.ts`): `serverUrl` (from `--server-url`) and
  `otelReceiverPort` move from the tracked `log-hub.json` to the gitignored `log-hub.local.json`;
  a legacy `otelReceiverPort` in `log-hub.json` is deleted on every install/upgrade. Patch bump
  `1.0.74 → 1.0.75`.
- `docker-dev/provision.mjs --static`: no longer needs a tracked `otelReceiverPort`; writes
  `serverUrl` + `otelReceiverPort` into the worktree's `log-hub.local.json` (fallback port `25317`).
  Takes effect after the sandbox image is rebuilt.
- No hook code change, no hook version bump, no config template change; no DB / API / dependency
  changes.
- This repo's tracked `.artisyn/config/log-hub.json` loses `otelReceiverPort` and gets
  `serverUrl: ""`; the values move to the local file.
- Tests: only existing steps of `tests/scenarios/installer/s-inst-01.spec.ts` change.

## Reference

Requirements: [requirements.md](requirements.md)

## Design Decisions

- The legacy `.env` migration (`convertLegacyEnvToConfigParts`, `install.ts:342`) keeps routing a
  legacy `SERVER_URL` into `log-hub.json` — requirements scope FR-2 to `--server-url` only, and the
  local value overrides it per key anyway.
- Backward compatibility (NFR) is already given: the frozen 2.6.1 hook
  (`tests/fixtures/legacy-hooks/2.6.1/env-context.js:245`) merges `log-hub.local.json` over
  `log-hub.json` per key exactly like the current one (`hook/.claude/telemetry_tool/env-context.js:259`),
  so no compat test change is needed.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `artisyn-hooks-installer/src/install.ts` | Config placement, port ownership, messages | `:729-751` overrides/merge; `:1542-1553` `readRecordedOtelPorts`; `:892`, `:911-917` messages; comments at `:731-735`, `:1499-1501`, `:1537-1538` |
| `artisyn-hooks-installer/package.json` | Patch bump | `1.0.74` → `1.0.75` (`.claude/rules/installer.md`) |
| `docker-dev/provision.mjs` | Static provisioning port + local file | `runStatic()` `:66-79`; header comment `:8-13` |
| `.artisyn/config/log-hub.json` | This repo's tracked config | drop `otelReceiverPort`, `serverUrl: ""` |
| `.artisyn/config/log-hub.local.json` | This repo's local config (gitignored, already exists) | add `serverUrl: "http://localhost:5003"`, `otelReceiverPort: 58603`, keep `apiKey` |
| `tests/scenarios/installer/s-inst-01.spec.ts` | Scenario steps 2, 4, 5, 6c, 8b, 9, 10 | read keys from local; upgrade cleanup |
| `docs/knowledgebase/hook-installation.md` | KB | `:41`, `:63`, `:222`, `:370` |
| `docs/knowledgebase/docker-dev-container.md` | KB | `:438`, `:455` (+ the `log-hub.local.json` keys list) |
| `docs/knowledgebase/otel-receiver.md` | KB | `:101` — where `otelReceiverPort` lives |
| `docs/knowledgebase/hook-system-overview.md` | KB | `:33` and any `log-hub.json` + `serverUrl`/`otelReceiverPort` mention |
| `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` | Scenario design doc | `:212`, `:446`, `:519` |
| `hook/INSTALL_HOOK.md` | Hook docs | `:26` `--server-url` row |
| `hook/README.md` | Hook docs | `:71` |
| `hook/HOW_HOOK_WORKS.md` | Hook docs | `:53` example, `:392` |
| `README.md` | Root docs | `:269` |

## Test coverage plan

Only kind 3 (Scenario) — extend existing steps of `tests/scenarios/installer/s-inst-01.spec.ts`
(`@S-INST-01`, mode A); no new files, no algorithm doc touched, no route changed.

- Step 4 (`:179-189`) — AC-1/AC-2: `log-hub.json` has `serverUrl: ""` and no `otelReceiverPort`;
  `log-hub.local.json` equals `{ apiKey, serverUrl: hub.url, otelReceiverPort: p }`, `p` in range
  and equal to `otel-port.json`.
- Step 5 (`:193-204`) — AC-1 upgrade: seed `otelReceiverPort: 12345` into `log-hub.json` before the
  reinstall; after it `log-hub.json` has no `otelReceiverPort`, local has `port`.
- Steps 6c (`:259`) and 8b (`:361`) — read `otelReceiverPort` from `log-hub.local.json`.
- Step 9 (`:270-275`) — `--server-url`-only: `log-hub.local.json` exists and equals
  `{ serverUrl: hub.url, otelReceiverPort: <otel-port.json port> }` (no `apiKey`).
- Step 2 (`:140-147`) — no flags: the hint text stays; no assertion on the local file needed.
- Step 10 title (`:281`) — "to the URL from log-hub.local.json".
- AC-3 (port recorded only in the local file) gets no dedicated step — the requirements' test list
  does not ask for one; steps 5/6b/6c exercise `readRecordedOtelPorts` with the port now in local.
- AC-4 (`git check-ignore`) is covered by the existing `.gitignore` assertion in step 4.
- `provision.mjs` (AC-5) has no scenario; verified manually by starting a sandbox after an image
  rebuild (see Chunk 2).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Installer + scenario | 6 | — |
| 2 | provision.mjs, repo config, docs | 5 | after chunk 1 (docs describe chunk 1) |

### Chunk 1 — Installer + scenario

- [x] `install.ts:729-737`: remove `serverUrl` and `otelReceiverPort` from `overridesBase`; add
  them to `overridesLocal` (`serverUrl` only when `overrides['SERVER_URL']` is set;
  `otelReceiverPort: Number(otelPort)` always). Move the `:731-734` comment to the local override.
- [x] `install.ts:741-751`: after `mergeConfig(...)` run `delete mergedBase['otelReceiverPort']`
  (FR-3); always write `log-hub.local.json` and call `ensureConfigIgnored(cwd, logHubLocalJsonPath)`
  (drop the `willWriteLocal` guard; in `:755` verify the local file unconditionally when migrating).
- [x] `install.ts:1542-1553` `readRecordedOtelPorts`: also add a usable `otelReceiverPort` from
  `.artisyn/config/log-hub.local.json`, keep reading the legacy `log-hub.json` one; update the
  comments at `:1499-1501` and `:1537-1538` to name `log-hub.local.json`.
- [x] `install.ts:892`: message → `Config written to .artisyn/config/log-hub.json and log-hub.local.json (serverUrl, apiKey, otelReceiverPort)`;
  `:911` and `:916`: `set serverUrl in .artisyn/config/log-hub.local.json`.
- [x] `artisyn-hooks-installer/package.json`: version `1.0.74` → `1.0.75`.
- [x] `tests/scenarios/installer/s-inst-01.spec.ts`: apply the step changes listed in "Test coverage
  plan" (steps 4, 5, 6c, 8b, 9, 10 title), then run
  `npm run test:scenarios -- --mode a --only scenarios --grep "@S-INST-01"`.

### Chunk 2 — provision.mjs, repo config, docs

- [x] `docker-dev/provision.mjs` `runStatic()` `:66-79`: port = `otel-port.json` `port` if a usable
  integer 1-65535, else tracked `log-hub.json` `otelReceiverPort` if usable, else `25317`; no throw.
  Then `writeJson(logHubLocalPath, { ...readJsonObject(logHubLocalPath), serverUrl: 'http://localhost:5173', otelReceiverPort: port })`; log it. Update header comment `:8-13`.
- [x] `.artisyn/config/log-hub.local.json`: add `"serverUrl": "http://localhost:5003"` and
  `"otelReceiverPort": 58603`, keep `apiKey` and every other key. Then `.artisyn/config/log-hub.json`:
  remove `otelReceiverPort`, set `serverUrl` to `""`.
- [x] Docs: update every place that says `serverUrl` / `otelReceiverPort` is in `log-hub.json` to
  say `log-hub.local.json` (written by the installer) — `docs/knowledgebase/hook-installation.md`,
  `docker-dev-container.md`, `otel-receiver.md`, `hook-system-overview.md`,
  `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md`, `hook/INSTALL_HOOK.md`,
  `hook/README.md`, `hook/HOW_HOOK_WORKS.md`, root `README.md` (line refs in the Files table).
- [x] Verify AC-7: `Grep` for `log-hub\.json` near `serverUrl|otelReceiverPort` across `docs/`,
  `hook/*.md`, `README.md`, `install.ts` messages — only legacy/back-compat mentions may remain.
- [x] Run `npm run build:hooks-installer`; manual AC-5 check: rebuild the sandbox image, start a
  sandbox (`scripts/claude-docker.ps1 <name>`) on this branch, confirm its `log-hub.local.json` has
  `serverUrl`, `otelReceiverPort`, `apiKey` and a session reaches the sandbox Log Hub.
  (2026-10-22: build done; AC-5 verified by running `provision.mjs --static` on a temp worktree —
  no tracked port → `25317`, legacy tracked port kept, `apiKey` kept, 9 OTEL env keys. The real
  image rebuild + sandbox session is still to be done by the developer.)
