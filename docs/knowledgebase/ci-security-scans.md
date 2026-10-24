---
type: reference
title: CI Security Scans
description: The report-only security workflows (security-scans, virustotal, security-report), their triggers, the SNYK_TOKEN/VIRUS_TOTAL_KEY secrets, fork behaviour, the unified row format and label table, the PR-description block, the ci-reports branch and badge, the .snyk policy, the config-guard allowlist, the FR-27 repository settings and the owner rollout
tags: [ci, security, github-actions, snyk, virustotal, supply-chain]
timestamp: 2026-10-24
---

# CI Security Scans

Three GitHub Actions workflows scan dependencies, repository config, workflows, Dockerfiles and
the installer tarballs. They are **report-only**: every tool step has `continue-on-error: true`,
jobs end green, and no scan ever blocks a merge. Results are collected as one row per tool/scope
and shown in a bot-owned block at the end of the PR description, in the job summaries, in the
Security tab (SARIF) and, for `main`, on the orphan `ci-reports` branch that feeds the README badge.

Secret scanning is separate and unchanged: see [Git Hooks and Secret Scanning](git-hooks.md)
(`gitleaks.yml`). Its `scan` check is read into the PR block as the `gitleaks/scan` row.

## Workflows and triggers

| Workflow (`name:`) | File | Triggers | Runs when |
|---|---|---|---|
| `security-scans` | `.github/workflows/security-scans.yml` | `pull_request`; `push` to `main`, `release`; nightly `schedule` (`17 3 * * *` UTC); `workflow_dispatch` | always |
| `virustotal` | `.github/workflows/virustotal.yml` | `pull_request` with paths `hook/**`, `artisyn-hooks-installer/**`, `release-template/**` | always (within the path filter) |
| `security-report` | `.github/workflows/security-report.yml` | `workflow_run` (`completed`) of `security-scans` and `virustotal` | the triggering run came from a `pull_request` |

The workflow `name:` values are matched by `workflow_run` and by the README badge; do not rename
them. There is no enable/disable repository variable: the scans are always on. `virustotal` is separate only because a path filter is allowed only on a
workflow that is not a required check (FR-30). `security-scans` uses no `paths-ignore`.

### `security-scans` jobs

| Job | Does | Rows |
|---|---|---|
| `changes` | Diffs `base.sha...head.sha`; outputs `docs_only` (every path under `docs/`) and `docker_changed` (`Dockerfile` or `docker-dev/Dockerfile`); on PRs uploads `pr-meta` | — |
| `build-kit` | Builds the installer tarballs **without secrets** (`npm ci --ignore-scripts`, `npm run build:hooks-installer -- --static-dir …`), uploads artifact `installer-kit` | — |
| `snyk-oss` | Snyk CLI (pinned, sha256-checked) `test` prod and `--dev` over `--all-projects`, plus the extracted tarballs; `snyk monitor` only on push to `main` and nightly; SARIF category `snyk-oss` | `snyk-oss/prod`, `/dev`, `/kit` |
| `dependency-review` | `actions/dependency-review-action` (`warn-only`, GPL/AGPL `deny-licenses`); PRs only | `dependency-review/pr` |
| `config-guard` | `node scripts/ci/config-guard.js` (executable-config guard, FR-4) | `config-guard/repo` |
| `supply-chain` | `lockfile-lint` (every `resolved` URL is `registry.npmjs.org`) and `npm audit signatures` | `lockfile-lint/npm`, `npm-signatures/npm` |
| `workflow-lint` | actionlint and zizmor (SARIF category `zizmor`) | `actionlint/workflows`, `zizmor/workflows` |
| `dockerfile-lint` | hadolint over the Dockerfiles, `docker compose config` over the compose files | `hadolint/dockerfiles`, `compose/config` |
| `node-runtime` | `scripts/ci/node-runtime-check.js`: Node version of `Dockerfile` and `docker-dev/Dockerfile` vs `is-my-node-vulnerable` and the latest patch on nodejs.org | `node-runtime/dockerfile`, `/docker-dev` |
| `container` | Snyk Container on the production image; nightly, dispatch, and PRs with `docker_changed`; SARIF category `snyk-container` | `snyk-container/image` |
| `virustotal` | VirusTotal verdict of the installer tarballs for the nightly report; nightly and dispatch only (PRs use `virustotal.yml`) | `virustotal/installer-tgz`, `/hooks-tgz` |
| `publish-results` | `needs:` every scan job, `if: always()`; nightly, dispatch and push on `main` only; pushes to `ci-reports` | — |

On a docs-only PR the scan jobs still run, skip their tool steps and write `skipped` rows with the
note `docs-only change`. Every scan job uploads its raw tool output as artifact `raw-<job>`
(14 days) and writes its rows to `$GITHUB_STEP_SUMMARY`. Every `npm ci`/`bun install` in CI runs
with `--ignore-scripts`.

## Secrets

| Secret | Used by | Note |
|---|---|---|
| `SNYK_TOKEN` | `snyk-oss`, `container` | Snyk tests of a public repository do not use the free-plan quota. Projects carry `--remote-repo-url=https://github.com/DataArt/artisyn-log-hub`. |
| `VIRUS_TOTAL_KEY` | `virustotal` `vt-scan` job | Public API key: 4 requests/min, 500/day, roughly 10 PRs/day. Passed to `curl` on stdin, never in arguments or logs. |

Only jobs that download the `installer-kit` artifact hold a secret; the build itself runs
secret-free. `security-report` uses only `GITHUB_TOKEN`.

## Fork PRs

Secrets are not passed to workflows triggered from forks. A job that needs a secret checks for an
empty value; then it writes a `skipped` row with the note `fork PR: no secret`, a `::notice::` and
a job-summary line, and skips its remaining steps. For forks, dependency review is the dependency
check. SARIF upload is switched off on fork PRs, and zizmor runs in annotation mode
(`fork PR: annotations only, no SARIF`). The PR block still appears: `security-report` runs in the
base repository context through `workflow_run`.

## Row format

Each scan writes one JSON file per row, `row-<tool>-<scope>.json`, uploaded as artifact
`scan-row-<tool>-<scope>` (written by `scripts/ci/scan-rows.js`, `config-guard.js`,
`node-runtime-check.js`, `virustotal-scan.js`):

```json
{ "tool": "snyk-oss", "scope": "prod", "version": "1.1308.3", "status": "findings",
  "counts": { "critical": 0, "high": 2, "medium": 1, "low": 0 }, "fixable": 2,
  "link": "https://github.com/DataArt/artisyn-log-hub/actions/runs/123", "note": "2 fixable high/critical" }
```

| `status` | Renders as |
|---|---|
| `pass` | `✅ pass` |
| `warning` | `⚠️ warning` |
| `findings` | `❌ findings` |
| `neutral` | `⚪ neutral` |
| `skipped` | `⏭️ skipped` |
| `error` | `💥 tool error` |
| `pending` | `⏳ pending` |

`fixable` (default 0) and `link` are optional; `note` is at most 200 characters. Rows from fork
runs are untrusted, so `normalizeRows` in `scripts/ci/security-summary.js` validates each one: the
`tool/scope` pair must be in the label table (else the row is dropped), the status in the enum,
counts integers 0–1,000,000, `link` must start with `https://github.com/DataArt/artisyn-log-hub/`,
`https://www.virustotal.com/gui/file/` or `https://app.snyk.io/` (else it is dropped), and the
note is stripped to `[A-Za-z0-9 .,:;()/_@#+=%'-]`. Any other failure turns the row into
`error` / `invalid row`. The display label never comes from the row.

### Label table

| tool/scope | Label | FR | Job (workflow) | Runs on |
|---|---|---|---|---|
| `gitleaks/scan` | Gitleaks (secrets) | — | read from the checks API | — |
| `snyk-oss/prod` | Snyk Open Source (prod) | FR-1 | `snyk-oss` (scans) | PR, push main, nightly |
| `snyk-oss/dev` | Snyk Open Source (dev) | FR-1 | `snyk-oss` | same |
| `snyk-oss/kit` | Snyk — installer tarballs | FR-6 | `snyk-oss` | same |
| `dependency-review/pr` | Dependency review | FR-28 | `dependency-review` | PR |
| `config-guard/repo` | Executable-config guard | FR-4 | `config-guard` | PR, push main, nightly |
| `lockfile-lint/npm` | Lock-file registry | FR-6 | `supply-chain` | same |
| `npm-signatures/npm` | npm registry signatures | FR-6 | `supply-chain` | same |
| `actionlint/workflows` | actionlint | FR-7 | `workflow-lint` | same |
| `zizmor/workflows` | zizmor | FR-7 | `workflow-lint` | same |
| `hadolint/dockerfiles` | hadolint | FR-8 | `dockerfile-lint` | same |
| `compose/config` | docker compose config | FR-8 | `dockerfile-lint` | same |
| `snyk-container/image` | Snyk Container | FR-8 | `container` | nightly, dispatch, PR with `docker_changed` |
| `node-runtime/dockerfile` | Node runtime (Dockerfile) | FR-35 | `node-runtime` | PR, push main, nightly |
| `node-runtime/docker-dev` | Node runtime (docker-dev) | FR-35 | `node-runtime` | same |
| `virustotal/installer-tgz` | VirusTotal — artisyn-hooks-installer.tgz | FR-29 | `vt-scan` (virustotal); `virustotal` (scans) | PR with path match; nightly, dispatch |
| `virustotal/hooks-tgz` | VirusTotal — hooks.tar.gz | FR-29 | same | same |

A new scanner needs a row here and in the label table inside `security-summary.js`; otherwise its
rows are dropped.

## PR block

`security-report` (job `apply-pr`, `node scripts/ci/security-summary.js apply-pr`) checks out the
default branch only and never runs PR code. It:

1. Reads the PR number from the triggering run's `pr-meta` artifact and accepts it only when the
   PR is open and its head SHA equals the run's `head_sha`.
2. Collects the `scan-row-*` artifacts of the latest `security-scans` and `virustotal` runs for that
   SHA. A workflow still running is listed as "Still running"; a workflow with no run for the SHA
   (usually `virustotal`, path filter) contributes nothing. The gitleaks row comes from the `scan`
   check run.
3. Renders the block between `<!-- security-scan:start -->` and `<!-- security-scan:end -->`
   (heading, commit/date/runs line, one table row per tool) and replaces it in the PR description,
   or appends it at the end. The author's text outside the markers is kept byte-for-byte; the PR
   is patched only when the body changed. A body over 65,536 characters gets a short fallback block.
4. When VirusTotal rows exist, creates or updates the check run `VirusTotal verdict`: `neutral` if
   any engine flags a tarball or the API failed, otherwise `success`.

`concurrency: security-report-<head_sha>` serialises updates for one commit. The block is
deliberately the only bot-written place; there are no PR comments.

## `ci-reports` branch and badge

`publish-results` (nightly, manual and push runs on `main` — so the badge follows every merge)
builds `security-scan-results.json` (`{schema:1, commit, date, ref:'main', rows}`),
`snyk-issues.json` (the Snyk issue lists of the report), `badges/security.json` (a shields.io
endpoint document) and `REPORT.md`. A push run has no Snyk Container and no VirusTotal rows: those
(and their issue lists) are carried over from the previous publication, which the job fetches from
`ci-reports` first, with the note `as of <date> UTC` (`carryOverRows`); the next nightly run
refreshes them. It pushes the files to the orphan branch `ci-reports` with
`scripts/ci/publish-ci-reports.js`. It uses the Git Data API with `GITHUB_TOKEN` (`contents: write`
on this job only, no git credentials persisted): a tree without `base_tree`, a commit on the
current head (or no parent on the first run), a non-forced ref update with up to 3 retries. The
commit message ends in `[skip ci]`, so a commit to `ci-reports` starts no workflow.

The badge counts rows whose scope is not `dev` and whose status is not `skipped`
(devDependencies do not ship):

| Condition | Message | Colour |
|---|---|---|
| any `findings` | `<n> failing` | red |
| any `error` | `scan error` | lightgrey |
| any `warning` or `neutral` | `<n> warnings` | yellow |
| otherwise | `passing` | brightgreen |

`README.md` shows it through
`https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/DataArt/artisyn-log-hub/ci-reports/badges/security.json`,
next to the `security-scans` workflow status badge. A click on the badge opens
`https://github.com/DataArt/artisyn-log-hub/blob/ci-reports/REPORT.md`: the rows table, the
critical and high Snyk issues of each scan (prod, dev, installer tarballs, container image; id
linked to security.snyk.io, package, fixed-in versions, project file) read from the `raw-snyk-oss`
and `raw-container` artifacts, the VirusTotal verdicts with their permalinks (the nightly
`virustotal` job), and links to Code scanning and Dependabot alerts. It is rendered by
`renderReport` / `snykIssues` in `scripts/ci/security-summary.js`.

The `ci-reports` ruleset (Settings → Rules) blocks deletion and force pushes; the publisher only
fast-forwards, so it is unaffected. Do not add "require a pull request" or "restrict updates" —
`GITHUB_TOKEN` could no longer push.

## `.snyk` policy

`.snyk` (root, `--policy-path=.snyk`) is the Snyk ignore policy and starts empty
(`ignore: {}`). Every ignore entry must carry a `reason` and an `expires` date. The file is in
`CODEOWNERS`, so a change needs the maintainer's review.

## Config-guard allowlist

`scripts/ci/config-guard.js` (`checkConfigGuard`) checks `.artisyn/config/log-hub.json`,
`.claude/settings.json`, `.mcp.json` and that `.artisyn/config/log-hub.local.json` is untracked;
the rules are in the algorithm doc `algorithms/executable-config-guard.md`. Findings are reported
as `::warning file=…::` annotations and in the `config-guard/repo` row note (`file:key`).

`.github/security/config-guard-allowlist.json` lists the stdio MCP servers `.mcp.json` may start:

```json
{ "mcpStdio": [
  { "commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2" },
  { "commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83" } ] }
```

A server passes when its `command` is in an entry's `commands` and its first argument not
starting with `-` equals that entry's `package` (version included). Adding or bumping a project MCP
server means editing this file in the same PR.

## Related policy files

- `.github/CODEOWNERS`: `@denistsyplakov` reviews `/.artisyn/config/`, `/.claude/settings.json`,
  `/.mcp.json`, `/hook/`, `/artisyn-hooks-installer/`, `/.github/`, `/.snyk`, `/scripts/ci/`.
- `.github/dependabot.yml`: weekly `docker` updates for `/`, patch and minor only for `node` (a
  major bump — the next LTS — is done by hand). `docker-dev/Dockerfile` pins Node via
  `ARG NODE_VERSION` + `NODE_SHA256`, which Dependabot cannot bump; fix its `node-runtime` warning
  by hand.
- `SECURITY.md`: GitHub private vulnerability reporting as a second reporting channel.
- `pr-merge-checks.md`: the manual review list; CI covers some of its items but does not replace it.

## FR-27 repository settings

Owner checklist (Settings, not files):

- [ ] Code security → **Dependabot alerts** on.
- [ ] Code security → **Dependabot security updates** on.
- [ ] Code security → **Private vulnerability reporting** on (referenced by `SECURITY.md`).
- [ ] Actions → General → Workflow permissions: **Read repository contents and packages
      permissions** (the workflows request elevated permissions per job).
- [ ] Actions → General → Fork pull request workflows: **Require approval for first-time
      contributors**.

## Owner rollout

1. Settings → Secrets and variables → Actions → Secrets: `SNYK_TOKEN` and `VIRUS_TOTAL_KEY` must exist.
2. Run `security-scans` once by `workflow_dispatch` on `main` to bootstrap the `ci-reports`
   branch (the README badge stays broken until then).
3. Open the acceptance test PRs from the task requirements (seeded CVE dependency, bad config
   values, non-npmjs lock-file entry, tag-pinned action, Dockerfile/Node runtime, `hook/` change for
   VirusTotal, a fork PR) and check the PR block, SARIF and badge.
4. Check Snyk → Settings → Usage: the Open Source test counter must not grow from CI runs.
