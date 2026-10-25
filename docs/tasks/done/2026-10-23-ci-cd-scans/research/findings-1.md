# Research findings 1 — 2026-10-24

The repo has one workflow (`gitleaks.yml`), so every scan workflow, script and policy file is new. The `server/` dependency fixes are already in the working tree.

### Requirements summary
The task adds report-only CI scans to the public repo `DataArt/artisyn-log-hub`. Nothing is a required check and nothing blocks a merge.

The owner chose scope S-B + V (pull-request part only) + R:
- **Snyk Open Source (FR-1):** on every PR and on push to `main`; `snyk monitor` on `main`. `client/` needs `bun install --frozen-lockfile` first. Production and `--dev` findings go in separate rows. Every call passes `--remote-repo-url`, and fork PRs skip Snyk with a notice.
- **GitHub settings (FR-27):** Dependabot alerts and security updates, private vulnerability reporting with `SECURITY.md`, read-only `GITHUB_TOKEN`, approval for first-time contributors.
- **Dependency review (FR-28):** `dependency-review-action` in warn-only mode, plus a GPL/AGPL flag.
- **Executable-config guard (FR-4):** a Node script checking `.artisyn/config/log-hub.json`, `.claude/settings.json`, `.mcp.json`, and that `log-hub.local.json` is not tracked.
- **CODEOWNERS (FR-5).**
- **npm supply chain (FR-6):** `lockfile-lint`, `npm audit signatures`, and a Snyk scan of the built installer tarballs.
- **Workflow hygiene (FR-7):** `actionlint`, `zizmor`, SHA pins, `permissions:` declared, no `pull_request_target`.
- **Container (FR-8):** `snyk container test` nightly and on Dockerfile PRs, `hadolint`, and `docker compose config` for the compose files.
- **Node runtime freshness (FR-35):** a script checks the `FROM node:<ver>` version against `is-my-node-vulnerable` and against the latest patch in `nodejs.org/dist/index.json`. Dependabot handles `docker` base-image bumps.
- **VirusTotal (FR-29–31):** scans the installer tarballs on PRs that touch `hook/`, `artisyn-hooks-installer/` or `release-template/`. It looks up the hash before uploading; any detection or API error makes the check neutral, never red.
- **Results (FR-23–26):**
  - A `workflow_run`-triggered `security-report` workflow writes one bot-owned block at the end of the PR description, between `<!-- security-scan:start/end -->`.
  - An orphan `ci-reports` branch holds `security-scan-results.json` and `badges/*.json`. It is pushed only with `GITHUB_TOKEN` and `[skip ci]`, and feeds a shields.io badge in `README.md`.
  - SARIF is uploaded to the Security tab.
  - `.snyk` and the FR-4 allowlists are the only scan files committed.
  - Checks that might become required skip docs-only changes inside the job, never via `paths-ignore`.

The tests are one algorithm doc for the FR-4 rules, run by `npm run test:scripts`. The workflows are verified by deliberately failing test PRs.

### Wireframes
None referenced. The only visual elements are the PR-description markdown block and the README badge.

### Knowledgebase
- `docs/knowledgebase/git-hooks.md`: the CI section documents the `gitleaks.yml` conventions, the `GITLEAKS_ENABLED` gate and the `protect-main-release` ruleset. FR-27 documentation goes here or in a new CI security article, which then needs a row in `index.md`. The uncommitted diff already adds a `key-file` subsection.
- `docs/knowledgebase/algorithms/README.md`: the doc format.
  - Required sections: Purpose, Code, Rules, Edge cases, Examples (exactly one ```` ```examples ```` JSON block of `{id,input,expected,note}`), Mutations, Where visible.
  - Front-matter starts as `reviewed: no` / `reviewer: none`, followed by a separate AI review.
  - The doc table in the README needs a new row.
  - `scripts/__tests__/algo-docs.test.js` loads every doc, so a malformed one fails there.
- `docs/knowledgebase/algorithms/sandbox-prune-classification.md`: the closest template, because it is the only algorithm under `scripts/` with a `node --test` runner (`npm run test:scripts`).
- `docs/knowledgebase/hook-installation.md` and `hook-system-overview.md`: config keys and the transparent-code rule. These only matter if the guard checks key semantics.
- `docs/knowledgebase/test/index.md`: the test policy; workflows get no tests.

### Existing patterns
- **Workflow template:** `.github/workflows/gitleaks.yml`
  - `:21` `if: vars.GITLEAKS_ENABLED == 'true' || github.event_name == 'workflow_dispatch'`
  - `:23` `timeout-minutes`
  - `:25-28` version and sha256 as job `env`
  - `:30` checkout pinned by SHA (`actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`) with `persist-credentials: false`
  - `:35-43` `curl`, then `sha256sum -c`, then `tar` for a CLI download
  - `:16-17` top-level `permissions: contents: read`
  - `:11-15` triggers: `push: branches: [main, release]`, `pull_request`, `workflow_dispatch`
- **Algorithm table test:** `scripts/__tests__/sandbox-prune.algo.test.js:1-26` loops `loadExamples('<name>')` and builds one `test(row.id)` per row with a subset `assert.deepEqual`. `package.json:25` (`test:scripts`) globs `scripts/__tests__/*.test.js`, so a new `*.algo.test.js` is picked up with no config change.
- **Example loader:** `scripts/algo-docs/load-examples.cjs`.
- **Script style:**
  - `scripts/gitleaks-scan.js:1-40` shows the header comment that documents modes and exit codes, CommonJS, and `spawnSync`.
  - `.claude/skills/nodejs-script/SKILL.md` requires CommonJS, synchronous code, built-ins only, single quotes and semicolons.
- **Guard rules source:** `pr-merge-checks.md` (repo root), §1, §2 and §4. These are the items FR-4 automates; the rest of the manual list stays.
- **Guard inputs today (all must pass):**
  - `.artisyn/config/log-hub.json`: `{"serverUrl":"","telemetryDir":"","context":[]}`. The model keys are absent.
  - `.claude/settings.json`: no `hooks`, no `OTEL_*` env. `enabledPlugins` holds `typescript-lsp@claude-plugins-official`, `log-hub-hooks@artisyn-e798dd87` and `adlc-lh@artisyn-e798dd87`. The marketplace `artisyn-e798dd87` has `source.source = "directory"` and `path = "./.artisyn/marketplace"`.
  - `.mcp.json`, which the FR-4 allowlist must cover:
    - `postgres`: `npx.cmd` with `@modelcontextprotocol/server-postgres@0.6.2`
    - `playwright`: `npx.cmd` with `@playwright/mcp@0.0.83`
    - `webstorm`: url `http://127.0.0.1:64542/stream`
- **Hook config keys:** `hook/.claude/telemetry_tool/env-context.js:64-84` (`CONFIG_DEFAULTS`). The model defaults are `sonnet` and `haiku`. Model values reach `--model` at `claude-invoke-async.js:125`.
- **Installer tarballs for FR-6 and FR-29:**
  - `scripts/build-hooks-installer.js:18-26` produces `artisyn-hooks-installer.tgz` and `hooks.tar.gz`.
  - `:31-47` accepts `--static-dir <dir>`; use it in CI so the build does not write into `server/src/public/static`.
- **Prototypes to port** (in gitignored `tmp/`, untracked):
  - `tmp/vt-proto/vt.mjs`: VirusTotal v3 hash lookup (`GET /files/<sha>`), upload on 404 (`POST /files`), polling `/analyses/<id>` every 16 s (40 polls at most), then `last_analysis_stats` / `last_analysis_results` and the permalink.
  - `tmp/snyk-proto/run.mjs`: `snyk@1.1308.3 test --all-projects --detection-depth=4 --exclude=node_modules,dist,fixtures,pocs,marketplace,tmp --json-file-output`, then per-project severity counts and the fixable high/critical filter.
  - `tmp/node-proto/` contains `is-my-node-vulnerable@^1.6.1`.
  - Both proto folders also hold local secrets (`snyk.token`, `vt.key`). Port the code only.
- **Dockerfiles:** `Dockerfile:2,9,20,34` are all `FROM node:22.23.4-slim`. `docker-dev/Dockerfile:44` pins Node with `ARG NODE_VERSION=24.22.1` and has no `FROM node:`, so FR-35 must also parse that `ARG`, or the plan must exclude it explicitly.
- **Lock files (FR-6):** every `resolved` URL is already `https://registry.npmjs.org` (counted):
  - `package-lock.json`: 117
  - `server/package-lock.json`: 1096
  - `hook/package-lock.json`: 86
  - `artisyn-hooks-installer/package-lock.json`: 31

  `bun.lock` and `client/bun.lock` contain no URLs, so `lockfile-lint` applies to the npm locks only. `docs/pocs/2026-10-22-2035-bash-pretty-format/package-lock.json` is tracked but out of scope and must be excluded explicitly.
- **Compose files (FR-8):** `release-template/docker-compose.yml`, `tests/scenarios/docker-compose.yml`, `server/artisyn-log-run-local/docker-compose.yml`.
- **Server fixes are done** (uncommitted): `server/package.json` has `multer ^2.5.0`, `nodemailer ^10.2.1` and `overrides: { "multer": "$multer" }`. The lock resolves `body-parser 2.4.0`, `multer 2.5.0`, `nodemailer 10.2.1` and `qs 6.16.1`.
- **`SECURITY.md` already exists**, pointing to DataArt's vulnerability disclosure page. FR-27 only has to turn on private vulnerability reporting and reconcile the two channels.
- **`THIRD_PARTY_NOTICES.md` exists** (`pr-merge-checks.md` §4). It is relevant if new dev tools are added as npm dependencies.
- **Health checks:** `.claude/repo_config/repo-health-checks.json:147` already runs `npm run test:scripts` in the `static` group, so the guard's algorithm test runs in the fast set automatically.
- **`.gitattributes`:** LF is enforced only for `.githooks/*`, migrations and `docker-dev/**`. Consider adding `.github/** text eol=lf` (YAML and CODEOWNERS).

### Open gaps
1. **Shared workflow pieces.** No `.github/` files exist beyond `gitleaks.yml` (no CODEOWNERS, `dependabot.yml`, `.snyk` or reusable workflow). Each workflow file, job split, artifact naming and `concurrency` setting has to be designed from scratch.
2. **Unified results format.** There is no existing FR-24 `security-scan-results.json` schema, results-JSON-to-markdown renderer, or shields.io endpoint JSON writer. The plan must define the schema: per tool, version, status, counts by severity and link.
3. **PR-description block replacement (FR-23).** Nothing existing does this. The plan must decide whether it is an "algorithm" needing its own doc and `*.algo.test.js`, as the acceptance criteria hint. It must also handle a missing block, duplicate markers and the user's text, and decide how `workflow_run` maps a run to its PR number. For fork PRs `workflow_run.pull_requests` is empty, so the PR has to be found by head SHA or from an artifact.
4. **Orphan `ci-reports` branch.** There is no bootstrap step or push pattern. The plan needs to decide who creates the branch first, and add the concurrency and retry rules.
5. **Nightly trigger.** No `schedule:` cron exists yet.
6. **Where the scripts live.** No folder exists for CI-only scripts such as `scripts/ci/`. The guard must stay testable as a pure function (like `classifyPruneCandidate`) with a CLI wrapper.
7. **FR-35 versus the script rules.** The `nodejs-script` skill requires synchronous code with no dependencies, but FR-35 needs an HTTPS fetch and the `is-my-node-vulnerable` package. The plan must choose: a CI-only exception with `npx` at a pinned version, or `spawnSync('curl')`.
8. **Pinned SHAs and checksums.** None exist yet for `snyk`, `actionlint`, `zizmor`, `hadolint`, `lockfile-lint`, `dependency-review-action`, `upload-sarif` and `github-script`. They have to be looked up at implementation time; none were computed here.
9. **`docker-dev/Dockerfile` scope for FR-35.** It declares Node through `ARG NODE_VERSION`, not a `FROM node:` line, so the plan must decide whether it is in scope.
10. **Remaining old `qs`.** `server/package-lock.json` still has `node_modules/typed-rest-client/node_modules/qs 6.15.1` (a transitive dev chain). The plan should decide whether the first Snyk `--dev` triage covers it.
11. **First-scan `--dev` triage.** It is out of the fixed scope but will show up in the summary (counts in `notes.md`: one critical esbuild in `server/`, many highs).
12. **Plan-time decisions.**
    - The FR-27 KB location: extend `git-hooks.md`, or write a new article plus an index row.
    - The `vars.*_ENABLED` variable names, e.g. `SNYK_ENABLED` and `VIRUSTOTAL_ENABLED`.
    - Who is listed as code owner in CODEOWNERS. The repo does not say who the maintainer is.
