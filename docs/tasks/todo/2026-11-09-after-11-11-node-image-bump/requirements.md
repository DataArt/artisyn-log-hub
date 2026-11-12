# 2026-11-09: Node Image Bump After the 2026-11-11 Security Release

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** docker, docs
**Owner:** denis.tsyplakov
**Created:** 2026-11-09
**Tracker:** GH-115 https://github.com/DataArt/artisyn-log-hub/issues/115

## Description

**Do not start before 2026-11-11.** Node.js announced a security release for 2026-11-11. This task
moves the Log Hub Docker images to that release. Start only once a Node 26.x release with those
fixes is published with `-slim` and `-alpine3.24` (or newer Alpine) image tags.

Split out of `2026-11-09-morning-check-followups`. It was that task's impl-plan chunk 4 (DD-14),
gated on the release. The gate check on 2026-11-09 found the newest 26.x was v26.13.0
(2026-10-28), which has no fixes.

Raw idea: bump Node in Log Hub Docker images to the Node 26.x security release scheduled for
2026-11-11. Build stages `node:<NEW>-slim`, runtime `node:<NEW>-alpine3.24`; docker-dev
`NODE_VERSION` + `NODE_SHA256`; Node version lines in the docs; raise the "patched to at least"
floors; check the runtime image's musl/zlib/openssl versions; leave a note on GH-107.

## Functional Requirements

- **FR-1 (gate):** before any change, confirm the Node 26.x release with the 2026-11-11 fixes is
  published, call it `<NEW>`. It must have both `node:<NEW>-slim` and `node:<NEW>-alpine3.24`
  (or a newer Alpine minor) on Docker Hub. If either is missing, change nothing and record the
  check in Notes.
- **FR-2:** `Dockerfile` build stages (`:5`, `:18`, `:29`) use `node:<NEW>-slim`. The runtime
  stage (`:52`) uses `node:<NEW>-alpine3.24`, or the newest Alpine minor the release publishes.
- **FR-3:** in `docker-dev/Dockerfile` (`:48-49`), set `NODE_VERSION=<NEW>` and `NODE_SHA256`.
  Take the hash from the release's `SHASUMS256.txt` for the exact file that Dockerfile downloads.
- **FR-4:** update the Node version in `user-docs/component-reference.md` (`:48`),
  `user-docs/third-party-components.md` (`:16-17`, Alpine `3.24`),
  `docs/third-party-components.md` (`:35`) and `docs/knowledgebase/release-pipeline.md` (`:31-32`).
- **FR-5:** raise the "patched to at least …" floors in `user-docs/getting-started.md` (`:8`),
  `user-docs/connect-repository.md` (`:9`) and `hook/INSTALL_HOOK.md` (`:13-15`) to the new
  22.x/24.x/26.x patch releases of the same security release. Then run `npm run build:help`.
- **FR-6:** build the runtime image and run `docker run --rm <image> apk info -v`. Record in Notes
  the versions of musl, zlib and libssl3/libcrypto3.
- **FR-7:** add a dated line with the new image tag and its musl version to the Notes of
  `docs/tasks/todo/2026-11-06-alpine-musl-crypt-upgrade/requirements.md`. GH-107 stays open,
  because the musl `crypt()` fix is a separate matter.

## Non-Functional Requirements

- **Pins:** keep image tags and SHA-256 pins exact. Never use a floating `node:26` or `:alpine` tag.
- **Runtime check script:** `scripts/ci/node-runtime-check.js:50` already matches the
  `-alpine3.24` suffix, so no change is expected there. If the release ships a newer Alpine minor,
  check that the script still accepts it.

## Acceptance Criteria

- [x] Notes record the release version `<NEW>`, its date and that both image tags exist (FR-1).
- [x] All four `FROM` lines in `Dockerfile` name `<NEW>`, and `docker build` of the image succeeds
      (FR-2).
- [x] The `docker-dev/Dockerfile` hash matches `SHASUMS256.txt` for the downloaded file, and the
      dev image builds (FR-3). (Verified up to the `fetch-node` stage: `node.tar.xz: OK`.)
- [x] No doc listed in FR-4/FR-5 still names the old Node version or the old floors.
      `npm run build:help` has regenerated `client/public/help/*.md` (FR-4, FR-5).
- [x] `apk info -v` of the runtime image shows musl ≥ 1.2.6-r3, zlib ≥ 1.3.2-r1 and
      libssl3/libcrypto3 ≥ 3.5.9-r0, and the versions are in Notes (FR-6).
- [x] The GH-107 task has a dated note with the new tag and musl version (FR-7).
- [ ] The final health check (`adlc-lh:check-health`, `finalRun: true`) is green.

## Notes

<!-- Append timestamped notes here as work progresses -->
- **2026-11-09:** Created from chunk 4 of `2026-11-09-morning-check-followups`. The gate was not
  met: nodejs.org `dist/index.json` showed the newest 26.x as v26.13.0 (2026-10-28) and the last
  security release as v26.12.1 (2026-10-21).
- **2026-11-12:** Gate met (FR-1). `<NEW>` = **v26.13.1** (2026-11-10, `security: true` in
  `dist/index.json`; same release: v24.22.3 2026-11-10, v22.23.5 2026-11-11 — 7 High + 6 Medium
  CVEs in HTTP/2 / TLS / HTTPS, https://nodejs.org/en/blog/vulnerability/november-2026-security-releases).
  Docker Hub has `node:26.13.1-slim`, `node:26.13.1-alpine` and `node:26.13.1-alpine3.24`.
  `docker-dev` hash from `SHASUMS256.txt` for `node-v26.13.1-linux-x64.tar.xz`:
  `5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864`.
- **2026-11-12:** FR-6 — `apk info -v` of `node:26.13.1-alpine3.24` (Alpine 3.24.4): musl
  `1.2.6-r3`, zlib `1.3.2-r1`, libssl3 / libcrypto3 `3.5.9-r0`. FR-7 note added to the GH-107
  task. Floors in the user docs and `hook/INSTALL_HOOK.md` raised to 22.23.5 / 24.22.3 / 26.13.1.
  Side cleanup: deleted the gitignored local bundles `release/artisyn-log-hub-20261027-120735-*`
  (they shipped `postgres:18.2-alpine`).
- **2026-11-12:** Fast health-check set green (build, lints, typechecks, algorithm and script
  tests). Product image built from the working tree and deployed to the maintainer's local
  instance: container reports `node -v` = v26.13.1, the server started cleanly and hook uploads keep
  arriving after the redeploy. The `finalRun: true` set (contract, scenarios, e2e) has not run yet.
