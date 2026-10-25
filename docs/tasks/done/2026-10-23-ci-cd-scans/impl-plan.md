# Implementation plan — 2026-10-23 CI/CD scans

## TL;DR

- **Three new workflows** in `.github/workflows/`, all report-only, so no job ever fails a merge:
  - `security-scans.yml` runs on PRs, on push to `main`/`release`, nightly and on `workflow_dispatch`. It covers Snyk OSS, dependency review, the config guard, lockfile-lint and npm signatures, actionlint and zizmor, hadolint and compose, Node runtime freshness, Snyk Container, and publishing to `ci-reports`.
  - `virustotal.yml` runs on PRs, path-filtered.
  - `security-report.yml` is triggered by `workflow_run` and writes the PR-description block.
- **New CI scripts** in `scripts/ci/`, all CommonJS and synchronous, built-ins only:
  - `config-guard.js`: `checkConfigGuard`, the FR-4 rules.
  - `security-summary.js`: `normalizeRows`, `renderSummary`, `replaceBlock`, `badgeFor`, `buildResults`.
  - `scan-rows.js`: tool output → unified row.
  - `node-runtime-check.js`, `virustotal-scan.js`, `publish-ci-reports.js`.
- **New external integrations:**
  - Snyk CLI 1.1308.3: test, monitor and container, through the `SNYK_TOKEN` secret.
  - VirusTotal v3 API, through the `VIRUS_TOTAL_KEY` secret.
  - shields.io endpoint badge.
  - SARIF upload to the GitHub Security tab.
- **Elevated token permissions, scoped per job:**
  - `security-events: write` for the SARIF jobs.
  - `contents: write` only in the `publish-results` job. It pushes the orphan branch `ci-reports` through the Git Data API with `GITHUB_TOKEN`.
  - `pull-requests: write` and `checks: write` only in `security-report.yml`, which edits PR bodies and creates the neutral VirusTotal check.
- **New policy files:** `.github/CODEOWNERS` (`@denistsyplakov`), `.github/dependabot.yml` (docker), `.snyk`, `.github/security/config-guard-allowlist.json`.
- **CI-only tools:** none are added as repo npm dependencies. The workflows download pinned binaries (snyk, actionlint, hadolint) with sha256, or install pinned packages into `$RUNNER_TEMP` (`lockfile-lint`, `is-my-node-vulnerable@1.6.1`).
- **Already done in the working tree:** the server dependency fixes (multer 2.5.0 with an `overrides` entry, nodemailer 10.2.1, body-parser 2.4.0, qs 6.16.1).
- **Docs and repo files:**
  - A new KB article, `docs/knowledgebase/ci-security-scans.md`.
  - A security badge in `README.md`.
  - A second reporting channel in `SECURITY.md`.
  - The CI note in `pr-merge-checks.md`.
  - `.github/** eol=lf` in `.gitattributes`.
  - `security-report.yml` also needs `actions: read` to download artifacts.
- **Not in this change:** DB, API endpoints and UI. Tests are two new algorithm docs, each with a `node --test` table test.

## Reference

Requirements: [requirements.md](requirements.md). Prototype evidence: [notes.md](notes.md). Research trail:
[research/findings-1.md](research/findings-1.md).

## Design Decisions

1. **Workflow split.** One `security-scans.yml` holds every scan except VirusTotal, so nightly and PR share the job definitions and `publish-results` can `needs:` them. `virustotal.yml` is separate because FR-30 allows a path filter only on non-required workflows. `security-report.yml` aggregates both.
   - The workflow `name:` values are exactly `security-scans`, `virustotal` and `security-report`. `workflow_run` and the README badge match on them.
   - `security-scans.yml` push trigger is `push: branches: [main, release]`, which is FR-24 rule 2 and the `gitleaks.yml` filter. `snyk monitor` and `publish-results` run only for `main`.
2. **Gate variables.**
   - `security-scans.yml` is gated by `vars.SECURITY_SCANS_ENABLED == 'true' || github.event_name == 'workflow_dispatch'`.
   - `virustotal.yml` is gated by `vars.VIRUSTOTAL_ENABLED == 'true'`.
   - `security-report.yml` runs when **either** variable is `'true'`, so VirusTotal rows are reported even when only VirusTotal is enabled.
   - The gate sits on the job, like `gitleaks.yml:21`. `schedule` runs also require the variable.
3. **Report-only mechanics.**
   - Every tool step has `continue-on-error: true`.
   - A following step reads `steps.<id>.outcome` and the tool's output files through `env:` and writes one row file with `node scripts/ci/scan-rows.js <tool> …`.
   - Jobs end green.
   - "Neutral" (FR-31) is a row status, plus a check run created by `security-report.yml` (Decision 13).
4. **No template injection.** No `${{ … }}` expression is interpolated into a `run:` script. Every value goes through `env:` and is read as `"$VAR"`, so zizmor's `template-injection` audit stays clean.
5. **Workflow conventions** (`gitleaks.yml`):
   - Actions are pinned by full commit SHA with a `# vX.Y.Z` comment.
   - Checkout uses `persist-credentials: false`.
   - Top-level `permissions: contents: read`; elevated permissions are granted per job only.
   - Every job has `timeout-minutes`.
   - CLI binaries are downloaded with `curl -fsSL` and checked with `sha256sum -c`; versions and sha256 values live in job `env`.
   - Pinned versions: Snyk CLI `1.1308.3` (`https://downloads.snyk.io/cli/v1.1308.3/snyk-linux`). For actionlint, hadolint, zizmor-action, `lockfile-lint` and `is-my-node-vulnerable@1.6.1`, use the latest release at implementation time.
   - Compute each sha256 by downloading into `tmp/`.
6. **Secret-free builds.** The installer tarballs are built in a `build-kit` job without secrets: `npm ci --ignore-scripts` at the root and in `artisyn-hooks-installer/`, then `npm run build:hooks-installer -- --static-dir "$RUNNER_TEMP/kit"`. The job uploads artifact `installer-kit` with `artisyn-hooks-installer.tgz` and `hooks.tar.gz`. Jobs that hold `SNYK_TOKEN` or `VIRUS_TOTAL_KEY` only download it. Every `npm ci` and `bun install` in CI passes `--ignore-scripts`.
7. **Fork PRs.**
   - A job that needs a secret reads it into a step `env` and checks for an empty value. If it is empty, the job writes a `skipped` row with the note `fork PR: no secret`, adds a `::notice::` and a `$GITHUB_STEP_SUMMARY` line, and skips the remaining steps.
   - SARIF upload and zizmor's `advanced-security` are switched off when `github.event.pull_request.head.repo.fork` is true.
8. **Docs-only PRs (FR-26).**
   - A `changes` job diffs `base.sha...head.sha` with `git diff --name-only`, after checkout with `fetch-depth: 0`.
   - It outputs `docs_only=true` when every changed path starts with `docs/`. On non-PR events it outputs `false`.
   - Scan jobs still run and skip their tool steps with `if: needs.changes.outputs.docs_only != 'true'`, writing a `skipped` row with the note `docs-only change`.
   - The same job outputs `docker_changed=true` when `Dockerfile` or `docker-dev/Dockerfile` changed.
   - No `paths-ignore` is used in `security-scans.yml`.
9. **Unified row format** (contract shared by every script; one JSON file per row, named `row-<tool>-<scope>.json`, uploaded as artifact `scan-row-<tool>-<scope>`):

   ```json
   { "tool": "snyk-oss", "scope": "prod", "version": "1.1308.3", "status": "findings",
     "counts": { "critical": 0, "high": 2, "medium": 1, "low": 0 }, "fixable": 2,
     "link": "https://github.com/DataArt/artisyn-log-hub/actions/runs/123", "note": "2 fixable high/critical" }
   ```

   - **`status` enum and how it renders:**

     | `status` | Renders as |
     |---|---|
     | `pass` | `✅ pass` |
     | `warning` | `⚠️ warning` |
     | `findings` | `❌ findings` |
     | `neutral` | `⚪ neutral` |
     | `skipped` | `⏭️ skipped` |
     | `error` | `💥 tool error` |
     | `pending` | `⏳ pending` |

   - `fixable` is optional and defaults to 0.
   - `note` is at most 200 characters.
   - `link` is optional.
   - The display label is **never** taken from the row. It comes from the label table below, keyed by `tool/scope`.
10. **Row validation (`normalizeRows`).** Rows from fork-run artifacts are untrusted, so each row is validated:
    - `tool` and `scope` match `^[a-z0-9-]{1,40}$` and the pair is in the label table;
    - `status` is in the enum;
    - counts are integers from 0 to 1,000,000;
    - `link` starts with one of `https://github.com/DataArt/artisyn-log-hub/`, `https://www.virustotal.com/gui/file/` or `https://app.snyk.io/`, otherwise it is dropped;
    - every character of `note` outside `[A-Za-z0-9 .,:;()/_@#+=%'-]` is removed.

    A row with an unknown pair is dropped. A row that fails any other check becomes `{status:'error', note:'invalid row'}`. When `tool/scope` repeats, the last occurrence wins. Output is sorted by label-table order.
11. **Label table:** tool/scope → label, FR, producing job and the condition under which the job runs.

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
    | `virustotal/installer-tgz` | VirusTotal — artisyn-hooks-installer.tgz | FR-29 | `scan` (virustotal) | PR with path match |
    | `virustotal/hooks-tgz` | VirusTotal — hooks.tar.gz | FR-29 | `scan` (virustotal) | same |

12. **Status rules per tool** (in `scan-rows.js`):
    - **Snyk OSS** (JSON from `--all-projects --json-file-output`): counts by severity over unique `id+packageName`. `fixable` counts high/critical issues with `isUpgradable || isPatchable`. Status is `findings` when `fixable>0`, otherwise `pass`. If the step failed with no JSON, status is `error`.
    - **Snyk Container:** the same, with no fixable filter. Status is `findings` when `critical+high>0`.
    - **Dependency review:** counts come from the action output `vulnerable-changes` by severity. The note gives the count of `invalid-license-changes`. Status is `findings` when high+critical>0 or the licence count is >0.
    - **lockfile-lint, npm signatures, actionlint, compose:** step outcome `success` → `pass`, otherwise `findings`, with `counts.high = 1` per failing file.
    - **zizmor:** the SARIF result count, by its level mapped to high/medium/low. Status is `findings` when the count is >0.
    - **hadolint** (`--format json`): `error`→high, `warning`→medium, `info`/`style`→low. Status is `findings` when high>0, `warning` when medium>0.
    - **config guard:** each finding counts as high, and the note lists `file:key` pairs.
    - **Node runtime:** a vulnerable version → `findings` with high=1, the "error row" of FR-35. A lagging patch → `warning`, with the note `22.23.4 < 22.23.6`.
    - **VirusTotal:** malicious+suspicious>0 → `neutral`, with the counts in `high`/`medium` and the engine names in the note. An API error or timeout → `neutral`, with the reason in the note. Zero detections → `pass`. The link is the permalink.
13. **PR block (FR-23).** `security-report.yml` runs on `workflow_run` (`types: [completed]`, `workflows: [security-scans, virustotal]`). It checks out the default branch only and never runs PR code.
    - The PR number comes from the triggering run's artifact `pr-meta` (`{"pr": <n>, "sha": "<head sha>"}`, uploaded by the `changes` job and by `virustotal.yml`). It is accepted only when `GET /pulls/<n>` is open and its `head.sha` equals `workflow_run.head_sha`.
    - The rows are the `scan-row-*` artifacts of the latest run of each of the two workflows for that head SHA. A workflow whose latest run is not completed adds its name to `meta.pending`. A workflow with no run for that SHA (usually `virustotal`, because of its path filter) contributes nothing: it is neither pending nor an error.
    - The gitleaks row is the `scan` check run on that SHA (`success`→`pass`, `failure`→`findings`, missing or in progress→`pending`).
    - `concurrency: security-report-${{ github.event.workflow_run.head_sha }}` with `cancel-in-progress: false`.
    - When the rows include `virustotal/*`, it creates (or updates by name) a check run `VirusTotal verdict` on the head SHA. Its conclusion is `neutral` if any VirusTotal row is `neutral`, otherwise `success`, and its output lists the engines and permalinks. This way a clean rerun clears an earlier neutral verdict.
14. **`renderSummary(rows, meta)` output**, with `meta = {sha, date, runUrl, pending}`. The lines, in order:
    1. `<!-- security-scan:start -->`
    2. `## Security scan`
    3. `_Commit \`<sha[0..7]>\` · updated <YYYY-MM-DD HH:MM> UTC · [runs](<runUrl>)_`. The `runUrl` must pass the link rule of Decision 10; otherwise the link is omitted.
    4. Only if `pending` is non-empty: `_Still running: <names joined by ", ">_`
    5. A blank line, then the table header `| Tool | Status | Critical | High | Medium | Low | Details |` and its separator.
    6. One table row per row: Details is `[link](<link>)` when a link exists, followed by the note.
    7. `<!-- security-scan:end -->`

    Lines are joined with `\n`. With no rows, the table is replaced by `_No scan results yet._`.
15. **`replaceBlock(body, block)` rules:**
    - A `null` body is `''`.
    - **Both markers present:** the text from the first `start` marker to the end of the last `end` marker that follows it is replaced by `block`. Text before and after is kept byte-for-byte, CRLF included.
    - **`start` without a later `end`:** everything from `start` to the end is replaced.
    - **No `start`:** the result is `body.trimEnd()`, plus `\n\n` when that is non-empty, plus `block`.
    - **Body too long:** when the result exceeds 65,536 characters, `block` is first swapped for the fallback `<!-- security-scan:start -->\n## Security scan\n_Summary too long — see the workflow runs._\n<!-- security-scan:end -->`.
    - The function is idempotent.
    - The PR is PATCHed only when the body changed.
16. **Results file and badge (FR-24).**
    - **`buildResults(rows, meta)`** returns `{schema:1, commit, date, ref:'main', rows}`, where `rows` is the normalized list. It is written as `security-scan-results.json`.
    - **`badgeFor(rows)`** looks at rows whose scope is not `dev` and whose status is not `skipped`. It returns `{schemaVersion:1, label:'security scan', message, color}`, chosen by the first matching rule:

      | Condition | `message` | `color` |
      |---|---|---|
      | any `findings` | `<n> failing` | `red` |
      | any `error` | `scan error` | `lightgrey` |
      | any `warning` or `neutral` | `<n> warnings` | `yellow` |
      | none of the above | `passing` | `brightgreen` |

      The badge is written as `badges/security.json`. devDependencies are excluded because they do not ship.
17. **Publishing to `ci-reports`.** Only the `publish-results` job publishes, and only on `schedule` or `workflow_dispatch` with `github.ref == 'refs/heads/main'`. It has `needs:` on every scan job and `if: always()`, and uses `concurrency: ci-reports`.
    - `publish-ci-reports.js` calls the Git Data API through `gh api` with `GH_TOKEN=${{ github.token }}`, never a PAT. It creates blobs, a tree **without** `base_tree`, and a commit whose parent is the current `ci-reports` head, or no parent when the ref is missing (an orphan bootstrap).
    - It then updates the ref, or creates it, with `force: false`.
    - On HTTP 422 (not a fast-forward) it re-reads the ref and retries, at most 3 times.
    - The commit message is `ci: security scan results <sha7> [skip ci]`.
    - No git credentials are persisted.
18. **SARIF (FR-25)** is uploaded with `github/codeql-action/upload-sarif` (pinned SHA) under three categories:
    - `snyk-oss`: the prod `--sarif-file-output`.
    - `snyk-container`.
    - zizmor, through `zizmorcore/zizmor-action` (pinned SHA) with `advanced-security: true`, outside fork PRs.

    Each of those jobs adds `security-events: write`.
19. **Snyk invocation.**
    - Common flags: `--all-projects --detection-depth=4 --exclude=node_modules,dist,fixtures,pocs,marketplace,tmp --policy-path=.snyk --remote-repo-url=https://github.com/DataArt/artisyn-log-hub`.
    - Before scanning, the job runs `bun install --frozen-lockfile --ignore-scripts` in `client/` (`oven-sh/setup-bun` pinned SHA, `bun-version` from job env `BUN_VERSION: 1.3.14`, the developer's current Bun).
    - The prod run is the default; the dev run adds `--dev`.
    - The kit run extracts both tarballs into `$RUNNER_TEMP/kit-src` and runs `snyk test --all-projects` there. If no manifest is found, the row is `pass` with the note `no manifests in tarballs`.
    - `snyk monitor` with the same flags runs only on `push` to `main` and on `schedule`.
20. **Node runtime check (FR-35).** `node-runtime-check.js` does three things:
    - It parses the version from `FROM node:<ver>` lines in `Dockerfile` (all stages must agree, otherwise the row is `error`) and from `ARG NODE_VERSION=<ver>` in `docker-dev/Dockerfile`.
    - It calls `is-my-node-vulnerable` by `spawnSync(process.execPath, ['-e', SNIPPET, version])`, with `NODE_PATH="$RUNNER_TEMP/imnv/node_modules"`. The snippet awaits `isNodeVulnerable(v,'linux')` and prints `1` or `0`. This keeps the script itself synchronous.
    - It fetches `https://nodejs.org/dist/index.json` with `spawnSync('curl', ['-fsSL', url])` and takes the newest version with the same major.
21. **VirusTotal (FR-29–31).** `virustotal-scan.js` is a synchronous port of `tmp/vt-proto/vt.mjs`:
    - It looks up the SHA-256 with `GET /files/<sha>` and uploads (`POST /files`) only on a 404.
    - It polls `/analyses/<id>` every 16 s, at most 40 times, sleeping through `spawnSync('sleep', ['16'])`, until `data.attributes.status === 'completed'`. It then re-reads `GET /files/<sha>`.
    - The verdict comes from `data.attributes.last_analysis_stats` (`malicious`, `suspicious`). Engine names are the keys of `data.attributes.last_analysis_results` whose `category` is `malicious` or `suspicious`.
    - The permalink is `https://www.virustotal.com/gui/file/<sha256>`.
    - All HTTP goes through `curl`. The API key is passed as `--header @-` on stdin, so it never appears in the arguments or the logs.
    - The job's `timeout-minutes` is 20.
    - `release-template/**` stays in the path filter because FR-30 names it: the release install kit will live there. Until then, such a PR re-scans the unchanged tarballs, which costs only two hash lookups.
22. **Dependabot.** `.github/dependabot.yml` has the `docker` ecosystem for `/` only, weekly. `docker-dev/Dockerfile` pins Node through `ARG NODE_VERSION` plus `NODE_SHA256`, which Dependabot cannot bump; its FR-35 warning row is fixed by hand. Dependabot alerts and security updates are repository settings (FR-27), not part of this file.
23. **CODEOWNERS (FR-5).** It lists `@denistsyplakov` for:
    - `/.artisyn/config/`
    - `/.claude/settings.json`
    - `/.mcp.json`
    - `/hook/`
    - `/artisyn-hooks-installer/`
    - `/.github/`
    - `/.snyk`
    - `/scripts/ci/`
24. **Config guard (FR-4).** The pure function `checkConfigGuard({ files, tracked, allowlist })` takes these inputs:
    - `files` maps a repo path to its content: a string, or `null` when the file is missing.
    - `tracked` is the output of `git ls-files`.
    - `allowlist` is `.github/security/config-guard-allowlist.json`.

    It returns `{ findings: [{ file, key, rule }] }`, ordered by the table row order below and then by key in file order. The `rule` ids below are the **complete** set; `key` is the value shown in the Key column, with `<name>` replaced by the actual entry name.

    | File | Key | Passes when | `rule` on failure |
    |---|---|---|---|
    | `.artisyn/config/log-hub.json` | `serverUrl` | Absent or `''`, or matches `^http://(localhost\|127\.0\.0\.1):\d+/?$`. | `server-url-not-local` |
    | `.artisyn/config/log-hub.json` | `turnEndCostAdvisorModel`, `sessionAttributionLlmModel` | Absent, or a string matching `^[A-Za-z0-9._:\-\[\]]+$`. | `model-name-invalid` |
    | `.artisyn/config/log-hub.json` | `telemetryDir` | Absent or `''`, or a string that is a relative path: not starting with `/`, `\` or `~`, not matching `^[A-Za-z]:`, and with no `..` segment. | `telemetry-dir-not-relative` |
    | `.claude/settings.json` | `hooks` | The key is absent. | `hooks-present` |
    | `.claude/settings.json` | `env.<name>`, for each key matching `^OTEL_EXPORTER_OTLP_([A-Z]+_)?ENDPOINT$` | The value parses as a URL whose hostname is `localhost` or `127.0.0.1`. | `otel-endpoint-not-local` |
    | `.claude/settings.json` | `extraKnownMarketplaces.<name>` | `source.source === 'directory'` and `source.path === './.artisyn/marketplace'`. | `marketplace-not-local` |
    | `.claude/settings.json` | `enabledPlugins.<name>` | The suffix after the last `@` names a marketplace that passed the previous rule, or is `claude-plugins-official`. | `plugin-marketplace-unknown` |
    | `.mcp.json` | `mcpServers.<name>` | A server with `command`: the command is in an allowlist entry's `commands`, and the first argument not starting with `-` equals that entry's `package`. | `mcp-command-not-allowed` |
    | `.mcp.json` | `mcpServers.<name>` | A server with `url` and no `command`: the hostname is `localhost` or `127.0.0.1`. | `mcp-url-not-local` |
    | `.mcp.json` | `mcpServers.<name>` | The server has `command` or `url`. | `mcp-server-invalid` |
    | `.artisyn/config/log-hub.local.json` | `''` | The path is not in `tracked`. | `local-config-tracked` |
    | any guarded file | `''` | The content parses as JSON. | `invalid-json` |

    - A missing file passes.
    - A file that fails `invalid-json` gets no other findings.
25. **Allowlist file:** `{ "mcpStdio": [ { "commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2" }, { "commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83" } ] }`.
26. **Script layout.** Every new script lives in `scripts/ci/`. Each exports its pure functions through `module.exports` and runs its CLI only under `require.main === module`, so the algorithm tests can `require` it. Each file starts with a header comment that documents its modes and exit codes, like `scripts/gitleaks-scan.js:1-40`. CLIs exit 0 on findings, because the checks are report-only, and exit 1 only on a usage error.
27. **`scan-rows.js` CLI contract.**
    - **Arguments every subcommand takes:** `--tool <t> --scope <s> --out <dir>`, plus optional `--version <v>` and `--link <url>`.
    - **Run URL:** workflows pass it as `--link "$RUN_URL"`, with job env `RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`.
    - **Output:** the subcommand writes `<out>/row-<tool>-<scope>.json`.
    - **When the input is missing:** if the input file is missing or unreadable, the row is `error` with the note `no output`.

    | Subcommand | Input |
    |---|---|
    | `snyk-oss` | `--json <file>` |
    | `snyk-container` | `--json <file>` |
    | `dependency-review` | env `DR_VULNERABLE_CHANGES`, `DR_INVALID_LICENSE_CHANGES` (the action's JSON outputs) |
    | `outcome` | `--outcome <steps.x.outcome>`, plus `--failed <n>` for the number of failing files (counted by the workflow loop) |
    | `zizmor` | `--sarif <file>` |
    | `hadolint` | `--json <file>` |
    | `skipped` | `--note <text>` |
28. **Raw output (FR-23).** Every scan job uploads its raw tool output (Snyk JSON and SARIF, hadolint JSON, zizmor SARIF, lockfile-lint and compose logs, the VirusTotal JSON responses) as artifact `raw-<job>`, with `retention-days: 14`, `if: always()` and `if-no-files-found: ignore`. It also writes a one-line-per-row table to `$GITHUB_STEP_SUMMARY`. Secrets are never written into these files.
29. **Dependency review configuration.**
    - `actions/dependency-review-action` v5.0.0, pinned by SHA.
    - `warn-only: true`, `fail-on-scopes: runtime`, `comment-summary-in-pr: never`. `fail-on-severity` is not set (FR-28).
    - `deny-licenses` is still an input of v5.0.0 (checked in its `action.yml`).
    - `deny-licenses: GPL-1.0-only, GPL-1.0-or-later, GPL-2.0-only, GPL-2.0-or-later, GPL-3.0-only, GPL-3.0-or-later, AGPL-1.0-only, AGPL-1.0-or-later, AGPL-3.0-only, AGPL-3.0-or-later`.
    - The step has `id: dr`, and the row step maps `steps.dr.outputs.vulnerable-changes` and `invalid-license-changes` into env.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `.github/workflows/security-scans.yml` | All scans except VirusTotal, plus nightly publish | Decisions 1–8, 11, 17–20, 27–29 |
| `.github/workflows/virustotal.yml` | VirusTotal PR scan | `on.pull_request.paths: [hook/**, artisyn-hooks-installer/**, release-template/**]`; Decision 21 |
| `.github/workflows/security-report.yml` | PR-description block and VirusTotal neutral check | Decision 13 |
| `.github/CODEOWNERS` | FR-5 | Decision 23 |
| `.github/dependabot.yml` | Docker base-image bumps | Decision 22 |
| `.github/security/config-guard-allowlist.json` | FR-4 allowlist | Decision 25 |
| `.snyk` | Snyk ignore policy (empty to start) | `version: v1.25.1`, `ignore: {}`, `patch: {}` |
| `scripts/ci/config-guard.js` | FR-4 guard: `checkConfigGuard` plus the CLI | The CLI reads the three files and `git ls-files`, then writes the row and `::warning file=<f>::` annotations |
| `scripts/ci/security-summary.js` | `normalizeRows`, `renderSummary`, `replaceBlock`, `badgeFor`, `buildResults`; CLI modes `apply-pr` and `results` | Decisions 9–16 |
| `scripts/ci/scan-rows.js` | Tool output → row file | Decisions 12, 27 |
| `scripts/ci/node-runtime-check.js` | FR-35 | Decision 20 |
| `scripts/ci/virustotal-scan.js` | FR-29–31 | Decision 21 |
| `scripts/ci/publish-ci-reports.js` | Push to the orphan `ci-reports` branch | Decision 17 |
| `docs/knowledgebase/algorithms/executable-config-guard.md` | Algorithm doc for FR-4 | Examples: one row per rule in Decision 24 |
| `docs/knowledgebase/algorithms/security-scan-summary.md` | Algorithm doc for `normalizeRows`, `renderSummary`, `replaceBlock`, `badgeFor` and `buildResults` | `input.fn` selects the function |
| `scripts/__tests__/executable-config-guard.algo.test.js` | Table test | Pattern of `scripts/__tests__/sandbox-prune.algo.test.js` |
| `scripts/__tests__/security-scan-summary.algo.test.js` | Table test | Same pattern |
| `docs/knowledgebase/algorithms/README.md` | Two new rows in the Docs table | — |
| `docs/knowledgebase/ci-security-scans.md` | New KB article | Workflows, gates, secrets, row format, `ci-reports`, FR-27 settings, owner rollout |
| `docs/knowledgebase/index.md` | Rows for the new article and the two algorithm docs | — |
| `docs/knowledgebase/git-hooks.md` | One-line pointer in "CI scan and branch protection" | — |
| `pr-merge-checks.md` | Say that §1, §2 (`.claude/settings.json`, `.mcp.json`) and §4 (lock-file URLs) are now also checked by CI | Manual review stays |
| `SECURITY.md` | Add GitHub private vulnerability reporting as a second channel | FR-27 |
| `README.md` | Security-scan badge and `security-scans` workflow badge under the title | Decision 16 |
| `.gitattributes` | `.github/** text eol=lf` | YAML and CODEOWNERS |
| `server/package.json`, `server/package-lock.json` | Production dependency fixes | Already in the working tree |

## Dependencies

There are no new npm dependencies in any `package.json`. The CI-only tools are pinned in workflow `env`, per Decision 5:

| Tool | Version | Installed by |
|---|---|---|
| Snyk CLI | 1.1308.3 | sha256-checked binary |
| actionlint | latest at implementation time | sha256-checked binary |
| hadolint | latest at implementation time | sha256-checked binary |
| zizmor | through `zizmor-action` | the action, pinned SHA |
| `lockfile-lint` | exact version | `npm install --prefix "$RUNNER_TEMP/tools" --ignore-scripts` |
| `is-my-node-vulnerable` | 1.6.1 | `npm install --prefix "$RUNNER_TEMP/imnv" --ignore-scripts` |

None of them ships with the product, so `THIRD_PARTY_NOTICES.md` is unchanged.

## Test coverage plan

The tests follow the CLAUDE.md test policy and are of one kind only: **algorithm** tests.

- **`executable-config-guard`:**
  - A new doc, `docs/knowledgebase/algorithms/executable-config-guard.md`. Its examples block has one passing and one failing row per rule in Decision 24, a row for the current tracked files (no findings), the acceptance-criterion rows (`sonnet & calc`, a non-localhost `serverUrl`), and rows for missing file, invalid JSON and tracked `log-hub.local.json`.
  - Its table test `scripts/__tests__/executable-config-guard.algo.test.js` runs under `npm run test:scripts`, which the `static` health check already runs.
- **`security-scan-summary`:**
  - A new doc for the FR-23 block replacement, which is a new algorithm as the acceptance criteria require. It also covers row validation, rendering and the badge rule.
  - Its rows cover:
    - `replaceBlock`: append to an empty body, append after author text, replace an existing block, CRLF author text untouched, text after the `end` marker kept, `start` without `end`, duplicate blocks, idempotence, and the 65,536-character fallback.
    - `normalizeRows`: an unknown pair dropped, an invalid status turned into `error`, a disallowed link removed, note sanitising, last-wins on a duplicate, and sort order.
    - `renderSummary`: the exact text for two rows, and the pending line.
    - `badgeFor`: one row for each of the four badge outcomes, and dev rows ignored.
    - `buildResults`: one row with two input rows, checking the `schema`, `commit`, `ref` and normalized `rows` fields.
  - Its table test is `scripts/__tests__/security-scan-summary.algo.test.js`.
- **Not tested, per policy:**
  - Workflows, `scan-rows.js`, `node-runtime-check.js`, `virustotal-scan.js` and `publish-ci-reports.js` get no tests. They are I/O glue, verified by the owner's test PRs in the KB rollout list.
  - There is no API contract or scenario change, because no server, client or hook behaviour changes.
  - The server dependency bump is covered by the existing fast set and the final run.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Repo policy files | 7 | No dependencies |
| 2 | Config guard script | 4 | Uses the allowlist from chunk 1 |
| 3 | Summary/results library | 6 | Pure functions used by chunks 4–7 |
| 4 | Scanner row and helper scripts | 6 | Uses the row contract from chunk 3 |
| 5 | security-scans.yml — PR core jobs | 7 | Calls the chunk 2–4 scripts |
| 6 | security-scans.yml — lint, runtime, container, publish | 8 | Extends the chunk 5 file |
| 7 | VirusTotal and report workflows | 6 | Consumes the artifacts of chunks 5–6 |
| 8 | Docs and README | 7 | Describes chunks 1–7 |
| 9 | Algorithm docs and tests | 6 | Tests last; checks chunks 2–3 |

### Chunk 1 — Repo policy files
- [ ] Create `.github/CODEOWNERS` with the paths of Design Decision 23, each owned by `@denistsyplakov`.
- [ ] Create `.github/dependabot.yml` (version 2): `docker` ecosystem, directory `/`, `schedule.interval: weekly` (Design Decision 22).
- [ ] Create `.github/security/config-guard-allowlist.json` with the exact content of Design Decision 25.
- [ ] Create `.snyk` at the repo root: `version: v1.25.1`, `ignore: {}`, `patch: {}`, and a header comment saying that every ignore needs a reason and an `expires` date.
- [ ] Add `.github/** text eol=lf` to `.gitattributes`.
- [ ] In `SECURITY.md`, add a paragraph naming GitHub private vulnerability reporting (repository Security tab → "Report a vulnerability") as an equally valid channel next to the DataArt disclosure process.
- [ ] Check that `server/package.json` and `server/package-lock.json` already contain multer 2.5.0 (with the `overrides` entry), nodemailer 10.2.1, body-parser 2.4.0 and qs 6.16.1, and that `npm ci --ignore-scripts` in `server/` succeeds.

### Chunk 2 — Config guard script
- [ ] Create `scripts/ci/config-guard.js` per Design Decision 26: export `checkConfigGuard({files, tracked, allowlist})` that implements the rules of Design Decision 24 and returns `{findings}` with the rule ids listed there.
- [ ] In the same file, add a CLI that reads the three guarded files (`null` if missing), `git ls-files` through `execFileSync`, and the allowlist from `.github/security/config-guard-allowlist.json`.
- [ ] Make the CLI print one `::warning file=<file>::<key> <rule>` line per finding and write `row-config-guard-repo.json` (Design Decision 9, status rule of Design Decision 12) to the directory given by `--out <dir>`. It exits 0.
- [ ] Run `node scripts/ci/config-guard.js --out tmp/ci` from the repo root and check that it reports zero findings on the current tracked files.

### Chunk 3 — Summary/results library
- [ ] Create `scripts/ci/security-summary.js` per Design Decision 26, with a `LABELS` table holding the rows of Design Decision 11 in order and a `STATUS_TEXT` map holding the enum of Design Decision 9.
- [ ] Implement and export `normalizeRows(rows)` per Design Decision 10.
- [ ] Implement and export `renderSummary(rows, meta)` per Design Decision 14, and `replaceBlock(body, block)` per Design Decision 15, with the marker constants `<!-- security-scan:start -->` / `<!-- security-scan:end -->`.
- [ ] Implement and export `badgeFor(rows)` and `buildResults(rows, meta)` per Design Decision 16.
- [ ] Add the CLI mode `results --rows <dir> --out <dir> --sha <sha>`, with `date` set to the current UTC time in ISO format: it reads every `row-*.json`, normalizes them, and writes `security-scan-results.json` and `badges/security.json`.
- [ ] Add the CLI mode `apply-pr`, with the flow of Design Decision 13, reading `GH_TOKEN`, `REPO`, `RUN_ID` and `HEAD_SHA` from env. It calls `gh api` / `gh run download` through `execFileSync` and creates the `VirusTotal verdict` neutral check run when needed.

### Chunk 4 — Scanner row and helper scripts
- [ ] Create `scripts/ci/scan-rows.js` with the subcommands and arguments of Design Decision 27 (`snyk-oss`, `snyk-container`, `dependency-review`, `outcome`, `zizmor`, `hadolint`). Each one maps its input to a row file per Design Decisions 9 and 12.
- [ ] Add the subcommand `skipped` (Design Decision 27) to `scan-rows.js`. It is used for fork-PR and docs-only skips (Design Decisions 7 and 8).
- [ ] Create `scripts/ci/node-runtime-check.js` per Design Decision 20. It writes `row-node-runtime-dockerfile.json` and `row-node-runtime-docker-dev.json` to `--out <dir>`.
- [ ] Create `scripts/ci/virustotal-scan.js` per Design Decision 21. It takes `--out <dir>` and the tarball paths, reads `VIRUS_TOTAL_KEY` from env, and writes `row-virustotal-installer-tgz.json` and `row-virustotal-hooks-tgz.json`.
- [ ] Create `scripts/ci/publish-ci-reports.js` per Design Decision 17. It takes `--dir <dir>` (holding `security-scan-results.json` and `badges/`) and `--sha <sha>`, and reads `GH_TOKEN` and `REPO` from env.
- [ ] Run `node scripts/ci/node-runtime-check.js --out tmp/ci` locally with `is-my-node-vulnerable@1.6.1` installed under `tmp/imnv`. Expect 22.23.4 and 24.22.1 not to be vulnerable.

### Chunk 5 — security-scans.yml: PR core jobs
- [ ] Create `.github/workflows/security-scans.yml`:
  - `name: security-scans`; `on: pull_request`, `push: branches: [main, release]`, `schedule: cron '17 3 * * *'`, `workflow_dispatch`;
  - top-level `permissions: contents: read`;
  - concurrency `security-scans-${{ github.event.pull_request.number || github.ref }}`, cancel-in-progress on PRs only;
  - a header comment explaining the gate (Design Decision 2).
- [ ] Add the job `changes`: outputs `docs_only` and `docker_changed` per Design Decision 8; on PRs it writes `pr-meta.json` and uploads artifact `pr-meta` (Design Decision 13).
- [ ] Add the job `build-kit` per Design Decision 6, with `setup-node` at Node 22 (pinned SHA).
- [ ] Add the job `snyk-oss`, which needs `changes` and `build-kit`:
  - Snyk install (sha256), Bun setup, then the prod, dev and kit runs per Design Decision 19;
  - SARIF upload (Design Decision 18);
  - `snyk monitor` per Design Decision 19;
  - fork and docs-only skips per Design Decisions 7 and 8.
- [ ] In `snyk-oss`, write the three rows through `scan-rows.js snyk-oss` and upload each as artifact `scan-row-snyk-oss-<scope>`. Add a short table to `$GITHUB_STEP_SUMMARY`.
- [ ] Add the job `dependency-review` (PRs only), configured per Design Decision 29. Its row comes from `scan-rows.js dependency-review` with the outputs passed through `env` (Design Decisions 4 and 27).
- [ ] Add the job `config-guard`: it runs `node scripts/ci/config-guard.js --out "$RUNNER_TEMP/rows"` and uploads `scan-row-config-guard-repo`.

### Chunk 6 — security-scans.yml: lint, runtime, container, publish
- [ ] Add the job `supply-chain`:
  - `lockfile-lint --type npm --validate-https --allowed-hosts npm` over exactly `package-lock.json`, `server/package-lock.json`, `hook/package-lock.json` and `artisyn-hooks-installer/package-lock.json`;
  - in those four directories, `npm ci --ignore-scripts` followed by `npm audit signatures`;
  - two rows.
- [ ] Add the job `workflow-lint`: actionlint (sha256 binary) over `.github/workflows/`, then `zizmor-action` per Design Decision 18. It writes the rows `actionlint/workflows` and `zizmor/workflows`.
- [ ] Add the job `dockerfile-lint`:
  - hadolint (sha256 binary, `--format json`) on `Dockerfile` and `docker-dev/Dockerfile`;
  - `docker compose -f <f> config --quiet --no-interpolate` for `release-template/docker-compose.yml`, `tests/scenarios/docker-compose.yml` and `server/artisyn-log-run-local/docker-compose.yml`;
  - two rows.
- [ ] Add the job `node-runtime`: install `is-my-node-vulnerable@1.6.1` into `$RUNNER_TEMP/imnv`, run `node-runtime-check.js`, and upload both rows.
- [ ] Add the job `container`. It runs on `schedule`, on `workflow_dispatch`, and on PRs when `docker_changed == 'true'`. It runs `docker build -t log-hub:scan .`, then `snyk container test log-hub:scan --file=Dockerfile --json-file-output --sarif-file-output`, uploads SARIF (`snyk-container`) and writes a row. Fork skip per Design Decision 7; `timeout-minutes: 30`.
- [ ] Add the job `publish-results` per Design Decision 17, with job-level `permissions: contents: write`:
  - download `scan-row-*` with `merge-multiple`;
  - run `security-summary.js results`;
  - run `publish-ci-reports.js`.
- [ ] Give every job in `security-scans.yml` the gate of Design Decision 2, a `timeout-minutes`, checkout with `persist-credentials: false`, and SHA-pinned actions per Design Decision 5.
- [ ] In every job of `security-scans.yml`, add the `raw-<job>` artifact upload and the step-summary table of Design Decision 28.

### Chunk 7 — VirusTotal and report workflows
- [ ] Create `.github/workflows/virustotal.yml`:
  - `name: virustotal`; `on.pull_request.paths: [hook/**, artisyn-hooks-installer/**, release-template/**]`;
  - top-level `permissions: contents: read`;
  - the `VIRUSTOTAL_ENABLED` gate (Design Decision 2);
  - a header comment for FR-30/31.
- [ ] In `virustotal.yml`, add the job `pr-meta` (artifact `pr-meta`, as in Chunk 5) and a secret-free job `build-kit` (Design Decision 6).
- [ ] In `virustotal.yml`, add the job `scan` (`timeout-minutes: 20`), which needs `build-kit`: download `installer-kit`, run `virustotal-scan.js`, upload two `scan-row-virustotal-*` artifacts and `raw-virustotal` (Design Decision 28), and add a step-summary table. Fork skip per Design Decision 7.
- [ ] Create `.github/workflows/security-report.yml`:
  - `name: security-report`; `on.workflow_run: {workflows: [security-scans, virustotal], types: [completed]}`;
  - `if: github.event.workflow_run.event == 'pull_request'` plus the either-variable gate of Design Decision 2;
  - permissions `contents: read`, `actions: read`, `pull-requests: write`, `checks: write`;
  - concurrency per Design Decision 13.
- [ ] In `security-report.yml`, check out the default branch (`persist-credentials: false`), then run `node scripts/ci/security-summary.js apply-pr` with `GH_TOKEN`, `REPO`, `RUN_ID` and `HEAD_SHA` passed through `env`. `timeout-minutes: 5`.
- [ ] Download the latest actionlint Windows binary into `tmp/` (sha256-checked) and run it over `.github/workflows/`. Fix every error it reports in the three new workflows.

### Chunk 8 — Docs and README
- [ ] Create `docs/knowledgebase/ci-security-scans.md` with OKF front matter. Cover the three workflows and their triggers, the gate variables, the secrets `SNYK_TOKEN` and `VIRUS_TOTAL_KEY`, the fork behaviour, the row format and label table (Design Decisions 9 and 11), the PR block, `ci-reports`, the badge, `.snyk`, and the allowlist.
- [ ] In the same article, add an "FR-27 repository settings" checklist for the owner: Dependabot alerts and security updates, private vulnerability reporting, workflow permissions "Read repository contents", and approval required for first-time contributors.
- [ ] In the same article, add an "Owner rollout" list:
  1. Set `SECURITY_SCANS_ENABLED` and `VIRUSTOTAL_ENABLED`.
  2. Run `security-scans` once by `workflow_dispatch` on `main` to bootstrap `ci-reports`.
  3. Open the acceptance test PRs from the requirements.
  4. Check Snyk → Settings → Usage.
- [ ] Add the article's row to `docs/knowledgebase/index.md`, and a one-line pointer to it at the end of § "CI scan and branch protection" in `docs/knowledgebase/git-hooks.md`.
- [ ] In `pr-merge-checks.md`, change the intro sentence "CI does not catch…" to say that `security-scans` (config guard, lock-file registry) checks §1, the `.claude/settings.json`/`.mcp.json` items of §2 and the lock-file URL item of §4. Manual review stays required.
- [ ] In `README.md`, add under the title the badges `https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/DataArt/artisyn-log-hub/ci-reports/badges/security.json` and the `security-scans` workflow status badge, each linking to the Actions page.
- [ ] Write `docs/changelog/<YYYY-MM-DD-HHmm>-ci-cd-scans.md` with a one-line summary, following the `changelog` skill.

### Chunk 9 — Algorithm docs and tests
- [ ] Create `docs/knowledgebase/algorithms/executable-config-guard.md` with every section the `algorithms/README.md` format requires (Purpose, Code, Rules, Edge cases, Examples, Mutations, Where the result is visible; `reviewed: no`, `reviewer: none`). Code: `scripts/ci/config-guard.js` (`checkConfigGuard`). The Rules come from Design Decision 24. The examples rows are those listed in the Test coverage plan.
- [ ] Create `scripts/__tests__/executable-config-guard.algo.test.js`, copying the pattern of `sandbox-prune.algo.test.js`: `require` the module, call `checkConfigGuard(row.input)`, and `deepEqual` `findings` with `row.expected.findings`.
- [ ] Create `docs/knowledgebase/algorithms/security-scan-summary.md`. Same README sections. Code: `scripts/ci/security-summary.js`. Rules come from Design Decisions 10 and 14–16. In the examples, `input.fn` is one of `replaceBlock`, `normalizeRows`, `renderSummary`, `badgeFor` or `buildResults`, and `input.args` is the argument list. The rows are those listed in the Test coverage plan.
- [ ] Create `scripts/__tests__/security-scan-summary.algo.test.js`: one `test(row.id)` per row, calling `mod[row.input.fn](...row.input.args)` and comparing with `assert.deepEqual` against `row.expected.result`.
- [ ] Add rows for `executable-config-guard` and `security-scan-summary` to the Docs table in `docs/knowledgebase/algorithms/README.md` (runner `node --test`, `npm run test:scripts`), and one line for each doc to `docs/knowledgebase/index.md` beside the other algorithm docs.
- [ ] Run `npm run test:scripts` from the repo root and check that both new table tests and `algo-docs.test.js` pass.
