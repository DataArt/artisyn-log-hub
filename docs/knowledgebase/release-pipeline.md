---
type: reference
title: Release Pipeline
description: How a release is published - push to the release branch runs .github/workflows/release.yml, which computes the version from the root package.json line and the git tags, builds the multi-arch GHCR image, builds and scans the install kit, attests everything and publishes the GitHub Release; plus the install scripts, verification commands, the local test bundle and the owner rollout checklist
tags: [ci, release, github-actions, docker, ghcr, install]
timestamp: 2026-10-25
---

# Release Pipeline

A release is a **multi-arch image on GHCR** (`ghcr.io/dataart/artisyn-log-hub`, `linux/amd64` +
`linux/arm64`) plus a **GitHub Release** whose assets are a pull-based install kit. Nothing is
built on the user's machine and no image file is downloaded: the installers fetch a compose file
that pins the image tag, and Docker pulls it.

| Piece | File |
|---|---|
| Release workflow | `.github/workflows/release.yml` (`name: release`) |
| Fast checks (also the PR gate) | `.github/workflows/checks.yml` (`name: checks`, job `fast-checks`) |
| Version and run state | `scripts/ci/release-version.js` — algorithm doc `algorithms/release-version.md` |
| Install kit and `SHA256SUMS` | `scripts/release-kit.js` — algorithm doc `algorithms/release-assets.md` |
| Release notes | `scripts/ci/release-notes.js` — same doc |
| VirusTotal scopes | `scripts/ci/virustotal-scan.js` (`scopeFor`) — same doc; see [CI Security Scans](ci-security-scans.md) |
| Kit templates | `release-template/` (`INSTALL.md` → `README.md`, `docker-compose.yml`, `.env.example`, `install.sh`, `install.ps1`) |
| Image build | repo-root `Dockerfile` (`ARG VERSION`, `ARG GIT_COMMIT` → `build-info.json`, see [System Info & Cluster](system-info-and-cluster.md)) |

## Trigger

- Every **push to the `release` branch** starts a run (normally the merge of a `main` → `release`
  PR, which `protect-main-release` requires).
- **Run workflow** (`workflow_dispatch`, no inputs) re-runs the pipeline by hand, e.g. to finish a
  run that failed after its tag was created. The `plan` job refuses any ref other than
  `refs/heads/release`, so dispatching on another branch fails at once.
- Runs are serialised (`concurrency: release`, never cancelled): a second push waits for the first.
- `release.yml` is not a required check; `checks.yml` (job `fast-checks`) is, for PRs into `main`
  and `release` — see [Git Hooks and Secret Scanning](git-hooks.md).

## Version rules

- The root `package.json` `version` (`X.Y.Z`, starts at `1.0.0`) names the **release line `X.Y`**.
  Its `PATCH` field is ignored — nobody bumps it per release.
- The released version is computed from the **strict tags** (`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`,
  peeled to their commit): `vX.Y.(highest PATCH on the line + 1)`, or `vX.Y.0` when the line has no
  tags yet. Non-strict `v*` tags (`v1.2`, `v1.2.3-rc1`, `v01.2.3`) are ignored everywhere.
- **Raising `MAJOR.MINOR`:** change the root `package.json` `version` to the new line (e.g.
  `1.0.0` → `1.1.0`) in a normal PR into `main`, then merge `main` into `release`. The first run
  on the new line releases `v1.1.0`. A line **lower** than the line of the highest existing tag is
  refused ("no going back"), so a stale `package.json` on `release` cannot release an old line.
- The version is baked into the image as `VERSION` and shown by the Admin → System **Build** tile,
  `GET /api/v1/admin/system` (`build.version`) and the public `GET /health/version`.

## Run states

The `plan` job runs `scripts/ci/release-version.js` (`planRun`), which checks these rules in
order and writes `mode`, `version`, `tag`, `line`, `previous_tag` to the job outputs. Every row is
table-tested in `algorithms/release-version.md`.

| # | Condition | Result |
|---|---|---|
| 1 | root `package.json` `version` is not `X.Y.Z` | `fail`: "root package.json version must be X.Y.Z, got …" |
| 2 | a strict tag points at HEAD and its release is `published` | `fail`: "nothing to release: vX.Y.Z is already published" |
| 3 | a strict tag points at HEAD (release `none` or `draft`) | `resume`, version = that tag (the highest one if several) |
| 4 | line `X.Y` is lower than the line of the highest strict tag | `fail`: "version line X.Y is lower than vA.B.C — no going back" |
| 5 | the computed tag already exists on another commit | `fail`, nothing is overwritten |
| 6 | otherwise | `full` |

- `previous_tag` is the highest strict tag lower than the version, or empty; it starts the commit
  list of the release notes.
- The release state comes from `gh release view <tag> --json isDraft` (non-zero exit = `none`).
  The job has `contents: write` only so its token can see drafts.
- `resume` skips `build` and `manifest` and reuses the staging image `IMAGE:sha-<commit>` the
  failed run already pushed. Finish a failed release with **Run workflow** on `release` or by
  re-running the failed run — no new commit is needed.

## Full-run order

`plan` → `checks` → `build` (amd64 + arm64) → `manifest` → `kit` → `vt-scan` → `publish`.

| Job | Does |
|---|---|
| `plan` | Run state and version (above). |
| `checks` | Calls `checks.yml`: client/server/tests typechecks, client/server/hook algorithm tests, build-script tests. A release is never built from a commit that fails them. |
| `build` | Full mode only. One native runner per arch (`ubuntu-latest`, `ubuntu-24.04-arm`), `docker/build-push-action` with `VERSION=<version>`, `GIT_COMMIT=<sha>`, `provenance: mode=max`, `sbom: true`, pushed **by digest only** (no tag). |
| `manifest` | Full mode only. Joins both digests into the staging index `IMAGE:sha-<commit>`. |
| `kit` | Secret-free: `node scripts/release-kit.js --version <version> --commit <sha> --out …`, uploaded as artifact `release-kit`. |
| `vt-scan` | VirusTotal on the zip, `install.sh`, `install.ps1` (scopes `release-zip`, `install-sh`, `install-ps1`). Report-only: no `VIRUS_TOTAL_KEY` → `skipped` rows; a failure or the 40 min timeout never blocks `publish`. |
| `publish` | Runs when `plan`, `checks` and `kit` succeeded and either the mode is `resume` or `manifest` succeeded. Steps below. |

`publish` steps:

1. Checkout, setup-node, setup-buildx, login to GHCR.
2. Resolve the digest of `IMAGE:sha-<commit>`; a missing index fails with
   "staging image :sha-<sha> not found".
3. Attest the image (`actions/attest-build-provenance`, pushed to the registry).
4. Full mode only: create the tag `vX.Y.Z` through the REST API (`gh api …/git/refs`). An existing
   tag must already point at this commit. No checkout ever holds a write credential.
5. Download `release-kit` and `vt-rows` (the latter may be missing).
6. Render the notes and `CHANGES.md` with `scripts/ci/release-notes.js` (commit range
   `<previous_tag>..<sha>`; `CHANGES.md` = the `docs/changelog/` entries added in that range),
   then attest every kit file and `CHANGES.md`.
7. Create the **draft** release (`gh release create --draft --verify-tag`), or upload the assets
   with `--clobber` and replace the notes on an existing draft.
8. Tag the image `X.Y.Z`, `X.Y` and `latest` from the staging digest.
9. Publish the release: `gh release edit <tag> --draft=false --latest`.

A run that stops after step 4 leaves a tag (and at most a draft) on the commit; the next run on
the same commit finishes it in `resume` mode. A run that stops before the tag exists leaves no tag
or release (at most a staging image), and the next run is a `full` run that computes the same
version again.

## GHCR tags

| Tag | Set by | Meaning |
|---|---|---|
| `sha-<commit>` | `manifest` | staging index of one release commit; reused by `resume` |
| `X.Y.Z` | `publish` step 8 | the release; pinned by the kit's `docker-compose.yml` |
| `X.Y` | `publish` step 8 | newest patch of a line |
| `latest` | `publish` step 8 | newest release |
| `local`, `local-<stamp>` | local builds only, never pushed | `scripts/local-loghub.js`, `npm run local-release-bundle` (the big-prod-e2e-test stand uses its own local `artisyn-log-hub:big-test-<stamp>`) |

The image name is hardcoded lowercase in the workflow, the scripts and the installers — it is never
derived from `github.repository`.

## Install kit

Assets of each GitHub Release (built by `scripts/release-kit.js` from `release-template/`):

| Asset | Source |
|---|---|
| `README.md` | `INSTALL.md`, `{{VERSION}}` / `{{GIT_COMMIT}}` filled |
| `docker-compose.yml` | template with `image: ghcr.io/dataart/artisyn-log-hub:{{VERSION}}` filled |
| `env.example` | `.env.example` unchanged — GitHub renames assets whose names start with `.`; the installers save it as `.env.example` |
| `install.sh` | unchanged (POSIX `sh`, LF via `.gitattributes`) |
| `install.ps1` | unchanged (Windows PowerShell 5.1 and pwsh 7) |
| `artisyn-log-hub-<version>.zip` | the five files above under one folder `artisyn-log-hub/`, with `.env.example` named with the dot |
| `SHA256SUMS` | `<sha256>  <name>` for the zip and every loose file, sorted by name |
| `CHANGES.md` | "What's new": every `docs/changelog/` entry added since the previous release tag, newest first (all entries on the first release). Written by the `publish` job, attested, but not in `SHA256SUMS` |

So every change that should show up in a release needs its `docs/changelog/` entry (the
`changelog` skill) before it reaches `release`. An entry edited after a release is not repeated in
the next `CHANGES.md`; only newly added files count.

`release-template/LOCAL-BUNDLE.md` belongs to the local test bundle and is never shipped.

### Install scripts

```sh
curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.ps1 | iex
```

Both do the same steps, install and upgrade alike: check Docker, Compose and the daemon;
download `docker-compose.yml` and `env.example` of `VERSION` (`latest` by default, `X.Y.Z` or
`vX.Y.Z`); refuse a downgrade unless `FORCE=1` (migrations are forward-only; the check is skipped
when the installed compose file has no `X.Y.Z` tag, e.g. an old zip bundle or `local`); keep the
previous compose file as `docker-compose.yml.prev`; generate `.env` with random
`POSTGRES_PASSWORD` / `SESSION_SECRET` and `NODE_ENV=production` on the first install only (an
existing `.env` is never opened for writing); `docker compose pull` (restoring the previous
compose file on failure) and `docker compose up -d`; print the install dir and the URL
(`PUBLIC_BASE_URL` or `http://localhost:5003`). The install dir is `INSTALL_DIR`, default
`$HOME/artisyn-log-hub` / `%USERPROFILE%\artisyn-log-hub`. The user-facing guide is
`release-template/INSTALL.md`.

## Verification commands

The notes of every release end with a "Security scan" section: the image digest, a
`File | SHA-256 | VirusTotal` table and these commands.

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify <file> -R DataArt/artisyn-log-hub
gh attestation verify oci://ghcr.io/dataart/artisyn-log-hub:<version> -R DataArt/artisyn-log-hub
```

This is the release-verification part (FR-32 / FR-33) of the `2026-10-23-ci-cd-scans` task. To
check a published image's baked-in version: `GET /health/version` → `{version, gitCommit}`.

On the first draft after a change to the kit, check that the `env.example` asset kept its name.

## Local test bundle

`npm run local-release-bundle` (`scripts/local-release-bundle.js`) builds an offline bundle —
**not a published release** — to hand the current working tree, uncommitted changes included, to a
colleague for a manual test.

- One folder plus `.zip` per architecture under `release/` (gitignored): the image exported as a
  tar, `docker-compose.yml` filled with `VERSION=local-<stamp>`, a ready `.env`, `.env.example`
  and `INSTALL.md` rendered from `release-template/LOCAL-BUNDLE.md` (how to load the image tar and start it).
- Image tag `ghcr.io/dataart/artisyn-log-hub:local-<stamp>`, built from `.` with
  `GIT_COMMIT=<HEAD>`, suffixed `-dirty` when the working tree has changes.
- `BUNDLE_ARCHS=amd64` limits the architectures; `BUNDLE_STAMP=YYYYMMDD-HHMMSS` reuses a stamp.
- It shares `gitCommit`, `hostArch`, `applyPlaceholders` and `generateReleaseEnv` with
  `scripts/release-kit.js`, and never touches GHCR or GitHub Releases.

`scripts/local-loghub.js` (the developer's own local install) builds the same Dockerfile with
`VERSION=local` and the tag `ghcr.io/dataart/artisyn-log-hub:local`.

## Owner rollout checklist

Settings, not files — do these once:

1. After the first PR run of `checks.yml`, add the status check `fast-checks` to the
   `protect-main-release` ruleset next to `scan`.
2. After the first release push, make the GHCR package `artisyn-log-hub` public and link it to the
   repository.
3. Enable immutable releases in the repository settings.
4. Set Actions → "Require approval for all outside collaborators" (first-time and outside
   contributors).
