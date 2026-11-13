# 2026-11-06: Upgrade Alpine Base Images Once musl crypt() Fix Ships

**Status:** todo — deferred, CHECK LATER (blocked on an upstream musl fix)
**Priority:** low
**Type:** feature
**Module(s):** docker / release
**Owner:** denis.tsyplakov
**Created:** 2026-11-06
**Tracker:** GH-107 https://github.com/DataArt/artisyn-log-hub/issues/107

## Description

Upgrade Alpine base images (node:26.13.0-alpine in Dockerfile runtime stage, postgres:18.6-alpine in
release-template/docker-compose.yml) once musl ships a fix for crypt() returning "*" on
257–1024-byte passwords (root cause of OpenSSH "sshole" CVE-2026-123158). Status: deferred — check
later. Our images have no sshd so currently not exploitable; this is defense-in-depth. As of
2026-11-06 no musl fix found (latest musl 1.2.6, 2026-03-20); OpenSSH fixed it on its side in 10.6p2.

Background: musl's `crypt()` cannot hash a password longer than 256 bytes and returns `"*"`, which is
also the shadow-file marker of a password-less account, so a naive `strcmp(crypt(pw, hash), hash)`
accepts any long password for such accounts. Any program in the image that verifies passwords
against `/etc/shadow` without PAM inherits the bug; no Log Hub image runs one today (no sshd, no
`login`/`su` exposed).

## Functional Requirements

- FR-1: Periodically check whether musl (musl.libc.org releases / security advisories, openwall musl
  list) and Alpine's `musl` package have shipped a fix for the long-password `crypt()` behaviour.
- FR-2: Once fixed, bump `node:<ver>-alpine` in the runtime stage of `Dockerfile` to a tag whose
  Alpine release contains the fixed `musl`.
- FR-3: Once fixed, bump `postgres:<ver>-alpine` in `release-template/docker-compose.yml` the same
  way (same Postgres major — an existing cluster cannot change major or libc).
- FR-4: If musl never fixes it upstream (treats it as a caller bug), close the task with that
  finding recorded in Notes.

## Acceptance Criteria

- [ ] FR-1: each check is recorded as a dated line in Notes (result: fixed / not yet).
- [ ] FR-2: `docker run --rm <image> apk info -v musl` shows the fixed musl version for the
      production image.
- [ ] FR-3: the same command on the bumped postgres image shows the fixed musl version; the release
      compose still starts against an existing data volume.
- [ ] FR-2/FR-3: the Snyk Container scan (`container` job, see `docs/knowledgebase/ci-security-scans.md`)
      is green on the PR.
- [ ] FR-4: when closed without a bump, Notes state why.

## Notes

<!-- Append timestamped notes here as work progresses -->
- **2026-11-06:** Created deferred. No musl fix published yet; OpenSSH 10.6p2 (2026-11-05) fixed
  sshd on its side. Repo has no `openssh`/`sshd` in any Dockerfile/compose/script — not exploitable
  in our images today.
- **2026-11-12:** The runtime image moved to `node:26.13.1-alpine3.24` (Alpine 3.24.4) in task
  `2026-11-09-after-11-11-node-image-bump`; it ships musl `1.2.6-r3`. This task stays open — the
  musl `crypt()` fix is a separate matter.
- **2026-11-13:** `release-template/docker-compose.yml` moved to `postgres:18.7-alpine` (Alpine
  3.24.4, Postgres 18.7 bug-fix release) after the morning check — a minor-version bump, not the
  musl fix. Task stays open.
