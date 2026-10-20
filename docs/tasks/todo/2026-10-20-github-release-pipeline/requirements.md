# 2026-10-20: GitHub Release Pipeline (release branch, Actions, GHCR)

**Status:** todo
**Priority:** high
**Type:** feature
**Module(s):** ci | release | server | client
**Owner:** denis.tsyplakov
**Created:** 2026-10-20

## Description

Set up the release pipeline on GitHub once the repository `DataArt/artisyn-log-hub` is public
(planned for 2026-10-21). Start this task only after the repository is public.

Why it waits for the public switch:
- the organisation is on the GitHub Free plan, so branch protection and rulesets are not available
  for a private repository (the API answers "Upgrade to GitHub Pro or make this repository public
  to enable this feature");
- the organisation's 2,000 included Actions minutes are already used up by another repository;
  for a public repository the standard hosted runners (including native arm64
  `ubuntu-24.04-arm`), Actions storage and public GHCR packages are free.

Organisation settings (checked by the owner): all actions and reusable workflows are allowed;
repository-level self-hosted runners are allowed (not to be used here, see FR-9).

How a release is built today: `node scripts/release.js` with `RELEASE_STAMP` (UTC
`YYYYMMDD-HHMMSS`) and `RELEASE_ARCHS` (`amd64,arm64`). For each architecture it runs
`docker buildx build --platform linux/<arch> --output type=docker,dest=<tar>` and packs a zip
with the image tar, `release-template/docker-compose.yml`, a generated `.env` with random
secrets, `.env.example` and `INSTALL.md`. The zips are also served from the app itself (Admin →
System → Release Downloads, signed download links).

### Owner decisions (2026-10-20)

- **Versioning:** semver tags `vMAJOR.MINOR.PATCH`, assigned automatically — no manual tagging
  in the normal flow.
- **What is released:** the Docker image (GHCR) and, separately, `INSTALL.md` with instructions
  plus a light automatic install. No zips with image tars.
- **Checks before the build:** only what runs in about 20 s; no e2e, no scenarios, cold lint left
  out (exact command set in FR-5). The typechecks matter most: neither build typechecks (see
  `CLAUDE.md`).
- **In-app release downloads are removed** together with everything that exists only for them.

## Functional Requirements

### Branch and trigger

- **FR-1 (release branch):** a `release` branch exists; a push to it is what cuts a release.
- **FR-2 (branch protection):** after the repository is public, `release` and `main` are
  protected: no force-push, no deletion, changes only through a pull request with the FR-5 check
  required, push restricted to maintainers.
- **FR-3 (workflow trigger):** the release workflow in `.github/workflows/` runs on `push` to
  `release` and on `workflow_dispatch`. No workflow of this repository runs on
  `pull_request_target`; the FR-5 check may run on `pull_request` (hosted runners only).

### Version

- **FR-4 (automatic semver):** every release run computes the next version from the latest
  `v*` tag (none → `v0.1.0`): PATCH +1 by default; MINOR or MAJOR when the `workflow_dispatch`
  input `bump` says so, or when a commit since the last tag carries `[minor]` / `[major]` in its
  message. When these signals disagree, the `bump` input (if given) overrides commit-message
  tags; otherwise the highest of the `[minor]`/`[major]` tags found across commits since the last
  tag applies; default is PATCH. The workflow creates the tag itself; it never commits a version
  bump back to the protected branch, uses a concurrency group
  (`concurrency: { group: release, cancel-in-progress: false }`) to serialize release runs, and
  fails the run instead of overwriting if the computed tag already exists.

  The version reaches the image as a new `ARG VERSION`, replacing the Dockerfile's current
  `RUN node -p "require('./server/package.json').version"` mechanism (`server/package.json`'s own
  version field is left unused by the image) and replacing `RELEASE_STAMP` and the
  `BuildInfo.releaseStamp` field (removed, not kept as a secondary field) in `build-info.json` and
  `GET /health/version`.

### Checks and build

- **FR-5 (fast checks):** before the build, one job runs the three typechecks and the three
  algorithm-test suites (client, server, hook) plus the build-script tests, the same commands as
  the `static` group in `.claude/repo_config/repo-health-checks.json` minus lint. A failure stops
  the release. The same job is offered as a pull-request check for FR-2.
- **FR-6 (per-arch build):** `linux/amd64` builds on `ubuntu-latest` and `linux/arm64` on
  `ubuntu-24.04-arm`, both natively, then a manifest list joins them.
- **FR-7 (Dockerfile build platform):** the build stages of `Dockerfile` use
  `FROM --platform=$BUILDPLATFORM`, so the client, the hooks installer and the server bundle are
  built natively and only the runtime stage is per architecture.

### Publication

- **FR-8 (GHCR image):** the workflow publishes the multi-arch image
  `ghcr.io/dataart/artisyn-log-hub:<version>` plus `:<major>.<minor>` and `:latest`, with
  `GITHUB_TOKEN` (`permissions: packages: write`). The GHCR package is public and linked to the
  repository.
- **FR-9 (runner security):** only GitHub-hosted runners; no self-hosted runner for this public
  repository. Workflow runs from first-time / outside contributors need maintainer approval
  (repository Actions setting).
- **FR-10 (GitHub Release with install kit):** the workflow creates a GitHub Release for the tag
  with: `INSTALL.md`; `docker-compose.yml` pinned to `ghcr.io/dataart/artisyn-log-hub:<version>`;
  `.env.example`; and install scripts `install.sh` (Linux/macOS) and `install.ps1` (Windows).
  Release notes list the commits since the previous tag (for the first release, with no previous
  tag, all commits up to the tagged commit).
- **FR-11 (light automatic install):** one command installs or upgrades a server, e.g.
  `curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh`
  (and a PowerShell equivalent). The script checks that Docker and Compose are present, creates
  the install directory, downloads `docker-compose.yml` and `.env.example` (re-downloading and
  overwriting them on an upgrade too, so the compose file's image tag matches the requested
  version), generates `.env` with fresh random secrets on first install only (the secret
  generation that `scripts/release.js` does today), keeps an existing `.env` unchanged on upgrade,
  runs `docker compose pull && docker compose up -d`, and prints the URL. It accepts a version
  (`latest` by default) via a `VERSION` environment variable (e.g.
  `VERSION=v0.2.0 curl -fsSL .../install.sh | sh`; PowerShell: `$env:VERSION = 'v0.2.0'; ...`),
  consistent across both scripts. On Docker/Compose missing, an unresolved version/tag, or a
  failed `docker compose pull`, the script exits non-zero with a clear message and does not
  delete or modify an existing `.env`; a missing `.env` during an "upgrade" run is treated as a
  fresh install rather than an error. `INSTALL.md` documents the same steps by hand.

### Removal of in-app release downloads

- **FR-12 (remove the feature):** remove release downloads from the app and everything that
  exists only for them. Inventory (2026-10-20, grep for `RELEASES_HOST_DIR`,
  `RELEASE_LINK_SECRET`, `release-token`, `ReleaseDownloads`, `releases/download`,
  `RELEASE_STAMP`):
  - `Dockerfile`: the `ARG RELEASE_STAMP` lines and the `build-info.json` generation step
    (superseded by FR-4's `ARG VERSION`);
  - server: `server/src/releases/` (module, service, types, `release-download.controller.ts`,
    `release-token.ts` and its algorithm spec), the release-link endpoint in
    `admin/admin-panel.controller.ts` and `admin/dto/release-download-link.dto.ts`, the release
    parts of `common/static-dir.ts`, `common/build-info.ts` and `system-info/`;
    `RELEASES_HOST_DIR` and `RELEASE_LINK_SECRET` in `server/.env.example`, `server/README.md`
    and `known-secrets.ts` if listed;
  - client: `ReleaseDownloadsSection.tsx`, its use in `AdminSystemTab.tsx`, the API call in
    `viewer/api.ts`, the types in `models/admin.ts`, the section in
    `public/help/security-hardening.md`;
  - build and release: `scripts/release.js`, `scripts/zip-dir.js` if nothing else uses it,
    `scripts/__tests__/release.test.js`, the `release` npm script, `/release`, `/releases/` and
    `/server/releases/` in `.gitignore`, the releases bind mount in
    `release-template/docker-compose.yml`; `release-template/` becomes the FR-10 install kit;
  - tests: `tests/scenarios/platform/s-rel-02.spec.ts`, `tests/scenarios/helpers/releases.ts`,
    the release steps in `s-plat-01.spec.ts`, legacy `tests/e2e/admin-releases.spec.ts`, the
    release routes in `server/test/contract/registry/f01-infra.ts`;
  - docs: `docs/knowledgebase/algorithms/release-link-token.md` (and its row in
    `algorithms/README.md`), the release parts of `api-reference.md`, `server-endpoint-map.md`,
    `static-asset-serving.md`, `system-info-and-cluster.md`, `client-component-map.md`, and the
    `docs/qaa-overview` scenario docs 01, 04, 05 and `14-algorithm-units.md`;
  - tooling: `RELEASE_STAMP` in `.claude/skills/big-prod-e2e-test/` (and its
    `scripts/__tests__/big-prod-e2e-test.test.js` rows), the release section of
    `.claude/skills/security-check/SKILL.md`, and `.claude/skills/post-impl-check-release/` if it
    only checks the zip bundle.
- **FR-13 (backward compatibility):** the hook API and the installer endpoints are not touched.
  Removing `/api/v1/releases/download` breaks only old in-app links, which expire in 24 h anyway.

## Acceptance Criteria

- [ ] `release` exists; after the public switch a force-push or a direct push by a
      non-maintainer to `release` is rejected (FR-1, FR-2).
- [ ] A push to `release` starts the release workflow; a pull request runs only the FR-5 check
      (FR-3, FR-5).
- [ ] Two pushes in a row produce `v0.1.0` then `v0.1.1`; a `workflow_dispatch` with
      `bump=minor` produces `v0.2.0`; no commit is pushed back to `release` (FR-4).
- [ ] `GET /health/version` of the released image reports the release version (FR-4).
- [ ] A type error or a failing algorithm test on `release` stops the run before any image is
      pushed (FR-5).
- [ ] `docker pull ghcr.io/dataart/artisyn-log-hub:<version>` works anonymously on an amd64 and
      an arm64 host and resolves to the right architecture (FR-6, FR-7, FR-8).
- [ ] The GitHub Release holds `INSTALL.md`, `docker-compose.yml`, `.env.example`,
      `install.sh` and `install.ps1`, and no image tar (FR-10).
- [ ] On a clean Linux host with Docker, the one-line `install.sh` starts the app and prints its
      URL; running it again with a newer version upgrades the app and keeps `.env` (FR-11).
- [ ] No workflow uses a self-hosted runner; outside-contributor runs wait for approval (FR-9).
- [ ] Nothing from the FR-12 inventory is left: the grep above finds no hits outside this task,
      and Admin → System shows no Release Downloads section (FR-12).
- [ ] Tests follow the repo test policy: the removed scenario, contract rows and algorithm doc go
      away with the feature; the version computation (FR-4), if written as a script, gets an
      algorithm doc with examples and its table test, or rows in the build-script tests.

## Open Questions

- FR-4: is `[minor]` / `[major]` in a commit message enough, or should the bump follow
  Conventional Commits (`feat:` → minor, `BREAKING CHANGE` → major, e.g. via release-please)?
- FR-8: should `:latest` move on every release, or only on non-`0.x` versions?
- Who counts as a "maintainer" for FR-2's branch-protection push restriction — specific GitHub
  usernames, an existing team, or a new team to create — and/or which built-in GitHub role (e.g.
  Maintain or Admin) should the push-allowlist reference?
- Since a GHCR package pushed via `GITHUB_TOKEN` from a workflow defaults to private visibility
  even in a public repository, how should the pipeline make the
  `ghcr.io/dataart/artisyn-log-hub` package public — a one-time manual visibility change by the
  owner after the first push, or an automated workflow step calling the package visibility API
  with a PAT that has `packages:write` org scope?
- Given FR-6 runs two fully separate native per-architecture builds, should the
  platform-independent stages (client build, hooks-installer build, server ncc bundle) be
  intentionally duplicated once per architecture job as an accepted cost, or should their output
  be built once and shared between the two per-arch jobs (e.g. via a shared build job and
  artifact upload)?

## Common sense considerations

- FR-11's install/upgrade script re-downloads and overwrites `docker-compose.yml` and
  `.env.example` on every run, including upgrades, so the pinned image tag always matches the
  requested version; the existing `.env` is left untouched.
- `Dockerfile`'s `ARG RELEASE_STAMP` and its `build-info.json` generation step move into the
  FR-12 removal inventory; `RELEASE_STAMP`/`BuildInfo.releaseStamp` are removed, not kept, since
  FR-4 already states the version build arg replaces them.
- FR-4's version bump precedence: the `workflow_dispatch` `bump` input overrides commit-message
  tags; otherwise the highest `[minor]`/`[major]` tag across commits since the last tag applies;
  default is PATCH.
- The release workflow serializes runs with a concurrency group and fails instead of overwriting
  if the computed tag already exists.
- The first release's notes list all commits up to the tagged commit (no previous tag to bound
  them).
- A specific install version is selected via a `VERSION` environment variable, consistent across
  `install.sh` and `install.ps1`.
- FR-11's script exits non-zero with a clear message on missing Docker/Compose, an unresolved
  version, or a failed `docker compose pull`, never touches an existing `.env` on failure, and
  treats a missing `.env` on upgrade as a fresh install.

## Notes

- Local timing measurements behind the "about 20 s" FR-5 check budget: see `notes.md`.
