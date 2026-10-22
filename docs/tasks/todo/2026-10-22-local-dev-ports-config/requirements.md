# 2026-10-22: Per-Developer Log Hub Settings in log-hub.local.json

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** artisyn-hooks-installer | docker-dev | docs
**Owner:** denis.tsyplakov
**Created:** 2026-10-22

## Description

Raw idea (verbatim): "надо настройки из log-hub.json перенести в локальные — у каждого разработчика
порты будут свои" (move the settings from log-hub.json into the local file — every developer will
have their own ports).

Move per-developer settings (`serverUrl`, `otelReceiverPort`) out of the tracked
`.artisyn/config/log-hub.json` into the gitignored `.artisyn/config/log-hub.local.json`, because
every developer has their own ports. Installer (`artisyn-hooks-installer/src/install.ts`) must write
`otelReceiverPort` and `--server-url` into `log-hub.local.json` instead of `log-hub.json`;
`docker-dev/provision.mjs` must write `serverUrl` and `otelReceiverPort` into `log-hub.local.json`
instead of reading them from the tracked file; this repo's own config migrated; KB/docs updated.

### Current state (from code and KB)

- The hook already supports this: `loadConfig` in `hook/.claude/telemetry_tool/env-context.js`
  shallow-merges `log-hub.local.json` over `log-hub.json` per top-level key, and `resolveOtelPort`
  reads the merged `config.otelReceiverPort` (after the `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` port from
  `.claude/settings.local.json`). No hook change should be needed.
- The installer (`install.ts`, step 1 of the install path) puts `otelReceiverPort` (always, from
  `otel-port.json`) and `serverUrl` (from `--server-url`) into `overridesBase`, i.e. into the
  tracked `log-hub.json`. Every (re)install therefore re-dirties the tracked file with this
  checkout's port.
- `readRecordedOtelPorts` (`install.ts`) reads `otelReceiverPort` only from `log-hub.json` to judge
  which OTEL endpoints are Artisyn-owned.
- `docker-dev/provision.mjs --static` reads `otelReceiverPort` from the tracked `log-hub.json` and
  throws without it; the sandbox's `serverUrl` (`http://localhost:5173`, resolving to the sandbox
  client inside the container) also comes from the tracked file
  (`docs/knowledgebase/docker-dev-container.md`, "Hook in the sandbox and provisioning").
- This repo's tracked `log-hub.json` currently holds `serverUrl` and `otelReceiverPort`; a local
  edit of `serverUrl` is what prompted this task.

## Functional Requirements

- FR-1: The installer writes `otelReceiverPort` into `log-hub.local.json`, never into
  `log-hub.json`.
- FR-2: The installer writes `--server-url` into `log-hub.local.json` and never changes `serverUrl`
  in `log-hub.json` (the template's empty `serverUrl` and a teammate's existing value stay as is).
- FR-3: On install/upgrade, an `otelReceiverPort` already present in the tracked `log-hub.json` is
  removed from it (the port from `otel-port.json` goes to local), so an upgrade cleans up an
  existing project.
- FR-4: `readRecordedOtelPorts` also recognises `otelReceiverPort` from `log-hub.local.json` (and
  keeps reading the legacy `log-hub.json` value, so a pre-upgrade port is still recognised as ours).
- FR-5: `log-hub.local.json` is now written on every install (it always gets `otelReceiverPort`)
  and is confirmed git-ignored every time, with the existing tracked-file hard abort.
- FR-6: `docker-dev/provision.mjs --static` no longer requires `otelReceiverPort` in the tracked
  `log-hub.json`. The sandbox port is: the existing `otel-port.json` port, else the legacy tracked
  `otelReceiverPort`, else the fixed in-container port `25317` (the hook's `OTEL_FALLBACK_PORT`).
  It writes `serverUrl: "http://localhost:5173"` and that `otelReceiverPort` into the worktree's
  `log-hub.local.json`, keeping every other key (e.g. `apiKey`).
- FR-7: This repo's `.artisyn/config/log-hub.json` has no `otelReceiverPort` and `serverUrl` is the
  template's `""`; the developer's values live in `log-hub.local.json`.
- FR-8: Installer messages point at `log-hub.local.json` for `serverUrl`: the "set serverUrl in
  .artisyn/config/log-hub.json" hints and the "Config written to …" line.
- FR-9: KB and docs describe the new placement: `docs/knowledgebase/hook-installation.md`,
  `docs/knowledgebase/docker-dev-container.md`, `docs/knowledgebase/otel-receiver.md`,
  `docs/knowledgebase/hook-system-overview.md`,
  `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md`, `hook/INSTALL_HOOK.md`,
  `hook/README.md`, `hook/HOW_HOOK_WORKS.md`, root `README.md`.

## Non-Functional Requirements

- Backward compatibility: old hooks (already installed, not upgraded) must keep working with a
  config written by the new installer. They already merge `log-hub.local.json` over `log-hub.json`
  per key — verify the oldest supported hook (e.g. `tests/fixtures/legacy-hooks/2.6.1`) does too.
- A teammate who still has `serverUrl` in the tracked `log-hub.json` keeps working (local overrides
  per key; base stays a valid fallback).

## Acceptance Criteria

- [ ] AC-1 (FR-1, FR-3): After a fresh install and after an upgrade of a project whose `log-hub.json`
  had `otelReceiverPort`, `log-hub.json` has no `otelReceiverPort` and `log-hub.local.json` holds the
  port from `otel-port.json`.
- [ ] AC-2 (FR-2): `install --server-url <url>` leaves `log-hub.json`'s `serverUrl` unchanged
  (`""` on a fresh install) and puts the URL without trailing slashes into `log-hub.local.json`.
- [ ] AC-3 (FR-4): A reinstall replaces an OTEL endpoint whose port is recorded only in
  `log-hub.local.json` (outside the allocation range) as Artisyn-owned.
- [ ] AC-4 (FR-5): After install, `git check-ignore .artisyn/config/log-hub.local.json` succeeds.
- [ ] AC-5 (FR-6): A sandbox started from a worktree whose tracked `log-hub.json` has no
  `otelReceiverPort` provisions successfully; its `log-hub.local.json` has `serverUrl`
  `http://localhost:5173`, `otelReceiverPort` and `apiKey`, and its sessions reach the sandbox
  Log Hub.
- [ ] AC-6 (FR-7): `git diff` of this repo shows `otelReceiverPort` removed and `serverUrl` set to
  `""` in `log-hub.json`; the hook in this repo still uploads to the developer's server and binds
  the same OTEL port.
- [ ] AC-7 (FR-8, FR-9): No doc or installer message tells the user to put `serverUrl` or
  `otelReceiverPort` into `log-hub.json`.
- [ ] Tests (scenario): extend the existing steps of `tests/scenarios/installer/s-inst-01.spec.ts`
  — the config-placement step checks AC-1/AC-2 (keys in `log-hub.local.json`, not in
  `log-hub.json`), the port-reuse steps read the port from `log-hub.local.json`, the
  `--server-url`-only step expects `log-hub.local.json` to exist with `serverUrl` +
  `otelReceiverPort` and no `apiKey`, and the upgrade case seeds a legacy `otelReceiverPort` in
  `log-hub.json` and expects it moved (AC-1). No new test files.

## Decisions

- **2026-10-22 — `--server-url` goes to the local file for every installer user (FR-2).** The
  hooks are committed to the repo, but the final activation is always per developer: each one has
  their own API key, so each one runs the install command themselves. That command is where the
  per-developer settings (`apiKey`, `serverUrl`, `otelReceiverPort`) get written — into
  `log-hub.local.json`. A shared tracked `serverUrl` default is therefore not needed.

## Common sense considerations

- The sandbox uses a fixed in-container OTEL port, not the installer's allocation: each container
  has its own loopback.
- `provision.mjs` keeps reading a legacy tracked `otelReceiverPort`, so the current image still
  provisions worktrees of branches made before this change.
- The config template (`config-template/log-hub.json`, with `serverUrl: ""`) is unchanged — no hook
  change and no hook version bump.
- A non-empty `serverUrl` already in a tracked `log-hub.json` is never removed by the installer; the
  local value overrides it per key.
- Every `artisyn-hooks-installer/` change bumps its patch version (`.claude/rules/installer.md`).
- This repo's own `log-hub.local.json` gets the current `serverUrl`/`otelReceiverPort` values before
  they are removed from the tracked file, so the dogfooded hook keeps working.

## Open Questions

None.

## Notes

<!-- Append timestamped notes here as work progresses -->
2026-10-22 — implemented via adlc-lh:implement; checks green.
