---
type: "Task"
title: "Mount the Export/Import Staging Dir in the Release Compose"
description: "Release compose mounts the repo export/import staging dir under LOG_HUB_DATA_DIR; the export/import cleanup scheduler stops logging the same error every 5 minutes"
---

# 2026-11-19: Mount the Export/Import Staging Dir in the Release Compose

**Status:** todo
**Priority:** low
**Type:** bug
**Module(s):** release-template, server
**Owner:** denis.tsyplakov
**Created:** 2026-11-19
**Tracker:** GH-158 https://github.com/DataArt/artisyn-log-hub/issues/158

## Description

Raw idea: Release compose should mount the repo export/import staging dir, and the export/import
cleanup scheduler should not log the same error every 5 minutes. Found on the Pi install (read-only
root fs override): ExportImportJobCleanupScheduler logs "ENOENT mkdir '/app/dist/export-import'"
every 5 min per worker and export/import fails. Stock installs work but keep staging zips inside the
container layer (lost on recreate).

Details:

- The staging dir for repository export zips and uploaded import zips is
  `resolveExportImportStagingDir()` (`server/src/logs/export-import-zip.ts:30`):
  `EXPORT_IMPORT_DIR` or `export-import` relative to the CWD, created lazily with `mkdirSync`. In
  the image the CWD is `/app/dist`, so the dir is `/app/dist/export-import`.
- `release-template/docker-compose.yml` mounts only `${LOG_HUB_DATA_DIR}/upload-queue` and
  `${LOG_HUB_DATA_DIR}/logs` into `app`; `export-import` is not mounted.
- **Stock install** (`install.sh`, container runs as root, writable root fs): works, no errors.
  The zips live in the container's writable layer, so an upgrade or any recreate of `app` loses an
  export that was ready but not yet downloaded, or an import zip uploaded but not yet confirmed.
  The user just repeats the operation. Space is not leaked: the TTL sweep
  (`EXPORT_IMPORT_JOB_TTL_MS`, default 30 min) deletes the files.
- **Hardened installs** (an operator override with `read_only: true` and/or a non-root `user:`):
  `mkdirSync` fails (EROFS on a read-only root fs, EACCES for a non-root user, ENOENT seen on the
  Pi), so repo export/import does not work at all, and `ExportImportJobCleanupScheduler`
  (`server/src/logs/export-import-job-cleanup.scheduler.ts:95`) logs the same ERROR every 5 minutes
  in every cluster worker (~300 entries/day per worker). The flood hides real errors in Admin →
  Error logs. Observed on a Raspberry Pi install on 1.3.0 and 1.5.0; worked around there with a
  local volume in the override.
- `turn-end-advisor-orphan-cleanup.scheduler.ts:86` uses the same "log every failed sweep" pattern.

Who is affected by the change:

- New installs and upgrades through `install.sh` get the new compose: zips move to
  `loghub-db/export-import/` on the host and survive upgrades. Docker creates the dir on first
  start (owned by root, fine for the stock root container).
- Hardened installs with only `read_only: true` start working without an override. With a non-root
  `user:` the operator still has to `chown` the new dir, because Docker creates bind-mount sources
  as root — document it.
- Installs that already mount their own volume on `/app/dist/export-import` in an override (the Pi
  workaround) keep working unchanged: Compose merges service volumes by container path and the
  override wins. The override can be removed after the upgrade.
- Installs that do not upgrade keep the old compose and the current behaviour.
- `loghub-db/` backups start including in-flight staging zips (small, short-lived) — document it.
- Dev server, sandboxes, scenario stand and contract suite are unaffected (they use
  `EXPORT_IMPORT_DIR` or the CWD fallback).

## Functional Requirements

- FR1: `release-template/docker-compose.yml` mounts
  `${LOG_HUB_DATA_DIR:?…}/export-import:/app/dist/export-import` into `app`, next to the
  `upload-queue` mount.
- FR2: Every other compose copy that mirrors the release template gets the same mount and creates
  the same subdirectory — at least `.claude/skills/big-prod-e2e-test/scripts/lib/stand.mjs`
  (template and its `pgdata` / `upload-queue` / `logs` subdir list). `scripts/local-loghub.js`
  picks it up from the template.
- FR3: Docs:
  - `release-template/INSTALL.md` and `release-template/LOCAL-BUNDLE.md` list `export-import/`
    among the data subdirectories and say it holds short-lived export/import staging zips.
  - Both get one non-root note covering all three dirs: "If you run the app container as a
    non-root user (`user:` in an override), create `upload-queue/`, `logs/` and `export-import/`
    under `LOG_HUB_DATA_DIR` before the first start and `chown` them to that UID — Docker creates
    missing bind-mount sources as root."
  - The backup section of `INSTALL.md` says `loghub-db/` backups include short-lived staging zips,
    and the upgrade section says an override volume on `/app/dist/export-import` can be removed.
  - `user-docs/component-reference.md` §3.3 gets a row `/app/dist/export-import` |
    `$LOG_HUB_DATA_DIR/export-import` | short-lived repository export/import staging zips (deleted
    after `EXPORT_IMPORT_JOB_TTL_MS`); help regenerated with `npm run build:help`.
  - `docs/knowledgebase/system-info-and-cluster.md` lists `export-import` / `EXPORT_IMPORT_DIR`
    with the other CWD-relative dirs.
- FR4: A failing sweep in `ExportImportJobCleanupScheduler` is logged once per distinct failure:
  - Key: `err.message`, compared with the previous failure only (A, B, A logs three ERRORs).
  - The first ERROR line ends with "(repeats suppressed until the sweep recovers)"; repeats go to
    DEBUG.
  - State is in memory per worker; a worker restart logs the first failure again.
  - The first successful sweep after failures logs one INFO
    "Export/import job cleanup sweep recovered after N failed sweeps" and resets the state.
- FR5: The same de-duplication applies to `TurnEndAdvisorOrphanCleanupScheduler`, through one
  small shared helper used by both schedulers.

## Non-Functional Requirements

- Backward compatibility: a new image with an old compose (no mount) behaves exactly as today; an
  old image with the new compose works (the mount is simply unused). No server env var or default
  changes.
- Offline first: all wording lands in the shipped `INSTALL.md` / `LOCAL-BUNDLE.md` and in-app help.

## Acceptance Criteria

- [ ] AC1 (FR1): on a stand built from the release template, `docker inspect artisyn-log-hub`
  shows a bind mount `$LOG_HUB_DATA_DIR/export-import → /app/dist/export-import`; a repo export
  creates its zip under `$LOG_HUB_DATA_DIR/export-import/` on the host, and the zip survives
  `docker compose up -d --force-recreate app` until its TTL.
- [ ] AC2 (FR1): with the override from Steps to Reproduce (`read_only: true` + `tmpfs: [/tmp]`),
  repo export and import work and Admin → Error logs shows no `Export/import job cleanup sweep
  failed` entry (any errno) after 10 minutes.
- [ ] AC3 (FR2): the `big-prod-e2e-test` stand creates `export-import/` and mounts it like the
  release template.
- [ ] AC4 (FR3): every doc listed in FR3 carries its wording; the generated
  `client/public/help/component-reference.md` has the new row.
- [ ] AC5 (FR4): with the staging dir broken, after 3 sweeps the process has written exactly one
  `Export/import job cleanup sweep failed` ERROR; after the dir is restored the next sweep writes
  one `recovered` INFO (server log) and no ERROR.
- [ ] AC6 (FR5): the turn-end advisor orphan cleanup uses the same helper and behaves as AC5
  (checked by code review; no separate test).
- [ ] AC7: tests per the repo test policy — FR4 is a new step in
  `tests/scenarios/repos/s-repo-11.spec.ts` (export/import scenario): the stand env in
  `tests/scenarios/modes.ts` sets a short `EXPORT_IMPORT_CLEANUP_INTERVAL_MS` (e.g. 2000); the step
  replaces the stand's `export-import` dir with a regular file (fails on every OS), waits ≥ 3
  sweeps, asserts exactly one matching ERROR in Admin → Error logs (the stand is one process), then
  deletes the file and asserts no new ERROR and a working export. FR1–FR3 are checked by the
  `big-prod-e2e-test` stand; no new test kinds.

## Steps to Reproduce

1. Install Log Hub with `install.sh`, then add a `docker-compose.override.yml` that sets
   `read_only: true` (and `tmpfs: [/tmp]`) on `app`; `docker compose up -d`.
2. Wait 10 minutes and open Admin → Error logs; try a repository export.

**Expected:** no errors; the export zip is written and can be downloaded.
**Actual:** `Export/import job cleanup sweep failed: <EROFS|EACCES|ENOENT> … mkdir
'/app/dist/export-import'` every 5 minutes per worker, and the export fails.

## Common sense considerations

- FR5 in scope via a shared helper: same bug pattern, a few lines, priority stays low.
- FR4 test lives in `s-repo-11` (the export/import scenario); the stand is single-process
  (`CLUSTER_MODE` never set), so one ERROR is expected.
- The staging dir is broken by replacing it with a file — portable to Windows hosts, unlike chmod.
- The `recovered` INFO is checked in the server log, since Admin → Error logs shows only ERRORs.
- AC2 matches the sweep error by text, not by errno, and uses the same override as the repro.
- No AC for the Pi-style override: Compose override precedence is standard behaviour; documented only.

## Notes

<!-- Append timestamped notes here as work progresses -->
