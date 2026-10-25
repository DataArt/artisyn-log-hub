# 2026-10-23: CI/CD Scans (Security, Supply Chain, Malware) and Where Their Results Live

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** ci | server | client | hook | installer
**Owner:** denis.tsyplakov
**Created:** 2026-10-23

## Description

Raw idea (owner, 2026-10-23 / 2026-10-24), collected from one conversation:

1. Add a Snyk scan to the pipeline — the trigger does not matter. Wanted: vulnerabilities in
   packages; and whatever else is worth scanning. Secret scanning is already done by the owner
   and is **not touched** by this task.
2. Run the perf test asynchronously in the pipeline and attach its result somewhere — **deferred
   by the owner (2026-10-24), not part of this task.**
3. "The scanners have run — where do the result files go? I would commit them to the repo, but
   that triggers the next scan — how is this done properly?"
4. Add VirusTotal: on pull requests (not on every push); results at the end of the PR text and
   also as "security scan results" that can feed a badge; when a release is built, the scan
   results are attached to it.
5. Use what GitHub itself offers for scanning and follow its best practices.
6. Everything in **one** task: CI/CD scans.

Current state (2026-10-24):

- The repository is **public** (`gh repo view` → `PUBLIC`): GitHub-hosted Actions minutes are
  free, and GitHub-native security features (secret scanning + push protection, Dependabot,
  dependency review, CodeQL, SARIF upload to the Security tab, artifact attestations) are free.
- `.github/workflows/gitleaks.yml` is the only workflow: it scans the **full history** on every
  pull request and on push to `main`/`release`, plus `workflow_dispatch`; gated by the repository
  variable `GITLEAKS_ENABLED`; the gitleaks binary is sha256-pinned, actions are pinned by SHA,
  `permissions: contents: read`. `.gitleaks.toml` exists; `.githooks/pre-commit` and `pre-push` run
  gitleaks locally (`scripts/gitleaks-scan.js`). See `docs/knowledgebase/git-hooks.md`
  § "CI scan and branch protection", which also lists secret scanning + push protection as part of
  the setup.
- Ruleset `protect-main-release`: `main` and `release` require a pull request and the gitleaks
  `scan` check; deletion and force-push are blocked.
- Dependency manifests in scope: npm lock files in the repo root, `server/`, `hook/` and
  `artisyn-hooks-installer/`; `bun.lock` in the repo root and in `client/`. Out of scope: the test
  fixture projects under `.claude/skills/big-prod-e2e-test/fixtures/`, `docs/pocs/`, and the
  dogfooded `.artisyn/marketplace/` copy (generated from `hook/`).
- One production `Dockerfile` (all stages on `node:22.23.4-slim`), plus `docker-dev/Dockerfile`;
  compose files `release-template/docker-compose.yml` (ships to users),
  `tests/scenarios/docker-compose.yml`, `server/artisyn-log-run-local/docker-compose.yml`.
- `pr-merge-checks.md` lists files that Claude Code, the hook, npm or git **execute** on every
  contributor's machine (`.artisyn/config/log-hub.json`, `.claude/settings.json`, `.mcp.json`, the
  hook sources) and says "CI does not catch a malicious change in them" — reviewed by hand only.
- The hook reaches end users through the installer tarballs, so a compromised dependency there
  reaches every user's machine.
- Releases: `2026-10-20-github-release-pipeline` (todo) defines the release workflow — a push to
  `release` builds the GHCR image and a GitHub Release with the install kit (FR-10 there). Not
  implemented yet.

## Variants and cost

Effort is engineer-days with Claude-assisted implementation. CI time is per run on a
GitHub-hosted runner.

| Part | Variant | Scope | Effort | CI time |
|---|---|---|---|---|
| Security | **S-A — minimal** | FR-1, FR-27, FR-28 | 0.5–1 day | PR: 1–2 min |
| Security | **S-B — recommended** | S-A + FR-4 … FR-8, FR-35 | 2–3 days | PR: 3–4 min; nightly ~10 min (image build) |
| Security | **S-C — full** | S-B + FR-9 … FR-12 | 3–4 days | PR: 5–8 min (CodeQL); nightly ~15 min |
| Security | first-scan triage | fix or suppress what the first full scan finds | 0.5–2 days, unknown until the first run | — |
| Malware + release | **V — VirusTotal + release attachments** | FR-29 … FR-34 | 1.5–2 days (release part after `2026-10-20-github-release-pipeline`) | PR: 2–5 min, only when shipped files change; release: 5–10 min |
| Results | **R — storage + badges** | FR-23 … FR-26 | 1 day (shared by all parts) | — |

Chosen scope (owner, 2026-10-24): **S-B + V without the release part (FR-29 … FR-31) + R**, all checks report-only (nothing blocks a merge). S-C (FR-9 … FR-12) and FR-32 … FR-34
are out of scope for now; CodeQL was dropped because a scan takes 5+ minutes.

## Functional Requirements

### Security — S-A (minimal)

- **FR-1 (dependency vulnerabilities):** Snyk Open Source over the in-scope manifests (Current
  state; `snyk test --all-projects` with the out-of-scope paths excluded) on every pull request and
  on push to `main`, reporting `high`/`critical` findings that have a fix (report-only: the check
  stays green and the findings go to the FR-23 summary). `snyk monitor` on
  `main` records the dependency snapshot so new CVEs in already-merged code are reported without a
  new push. The Snyk CLI does not read `bun.lock`: the job runs `bun install --frozen-lockfile` in
  `client/` first, so Snyk resolves `client/package.json` from the installed `node_modules`.
  Production dependencies (Snyk's default) and devDependencies (`--dev`) are both reported,
  in separate rows. The CLI version is pinned in the workflow, and every Snyk
  call passes `--remote-repo-url=https://github.com/DataArt/artisyn-log-hub` so Snyk counts the
  project as public (free-plan test limits apply to private repositories only). On fork PRs (no `SNYK_TOKEN`)
  the Snyk step is skipped with a notice in the job summary; FR-28 is the fork-safe dependency check there, and Snyk runs on the push to
  `main` after merge.
- **FR-2, FR-3:** reserved — secret scanning (`gitleaks.yml`, `.gitleaks.toml`, the git hooks,
  push protection) already exists and this task does not change it.
- **FR-27 (GitHub security settings, no CI time):** enabled and documented in
  `docs/knowledgebase/git-hooks.md` (or a new CI security KB article): Dependabot alerts and Dependabot security
  updates; private vulnerability reporting with a `SECURITY.md`; the default `GITHUB_TOKEN` permission set to read-only; approval required
  for workflow runs from first-time contributors.
- **FR-28 (dependency review):** `actions/dependency-review-action` on every pull request reports
  (`fail-on-severity` not set; `warn-only`) when the PR adds a dependency with a `high`/`critical` advisory, and flags GPL/AGPL licences in
  production dependencies. It needs no secret, so it also covers fork PRs.

### Security — S-B (recommended, adds to S-A)

- **FR-4 (executable-config guard):** a Node script on every pull request automates the
  machine-checkable items of `pr-merge-checks.md`. Rules:

  | File | Rule |
  |---|---|
  | `.artisyn/config/log-hub.json` | `serverUrl` empty or `^http://(localhost\|127\.0\.0\.1):\d+/?$`; `turnEndCostAdvisorModel` and `sessionAttributionLlmModel`, when present, match `^[A-Za-z0-9._:\-\[\]]+$` (absent passes); `telemetryDir` empty or relative |
  | `.claude/settings.json` | no `hooks`; `OTEL_EXPORTER_OTLP_*_ENDPOINT` on `127.0.0.1`/`localhost`; every `extraKnownMarketplaces` entry has `source.source == "directory"` and `path == "./.artisyn/marketplace"` (any hashed name, e.g. `artisyn-e798dd87`); `enabledPlugins` only `*@<such marketplace>` or `*@claude-plugins-official` |
  | `.mcp.json` | each stdio server's `command` + pinned `package@version` in `args` is on the allowlist; any `url` is on `127.0.0.1`/`localhost` |
  | `.artisyn/config/log-hub.local.json` | not tracked |
  | any guarded file | missing file passes; a file that does not parse as JSON fails naming the file; a deleted file passes the guard but still needs the FR-5 review |

  The manual list stays for what a script cannot judge.
- **FR-5 (CODEOWNERS):** `.github/CODEOWNERS` requires the maintainer's review for the FR-4
  files, `hook/`, `artisyn-hooks-installer/` and `.github/`.
- **FR-6 (npm supply chain):** `lockfile-lint` allows only `https://registry.npmjs.org` in the
  in-scope npm lock files (explicit list); `npm audit signatures` verifies registry signatures; the
  built installer tarballs are scanned like the sources (FR-1).
- **FR-7 (workflow hygiene):** `actionlint` and `zizmor` lint `.github/workflows/`; third-party
  actions are pinned by commit SHA; every workflow declares minimal `permissions:`; no workflow
  uses `pull_request_target` (consistent with `2026-10-20-github-release-pipeline` FR-3).
- **FR-8 (container and Dockerfile):** the production image is built and scanned by
  `snyk container test <image> --file=Dockerfile` nightly and on PRs that change a Dockerfile;
  it reports base-image OS CVEs and CVEs of the Node.js runtime binary in the image, and
  recommends a base-image upgrade. On pull requests `hadolint` lints `Dockerfile` and
  `docker-dev/Dockerfile`; the compose files (`release-template/docker-compose.yml` first) are
  checked by `docker compose -f <file> config`. Trivy is not used.
- **FR-35 (Node.js runtime freshness):** on every PR and nightly, a Node script reads the Node
  version from the Dockerfiles' `FROM node:<version>` lines and checks it (1) against the Node.js
  security releases (`is-my-node-vulnerable`) — a vulnerable version is reported as an error row; (2) against the
  latest patch of the same major line (`https://nodejs.org/dist/index.json`) — a lagging patch
  is a warning. Rationale: the `slim` image has no `ca-certificates` package; Node uses its own
  bundled root CA store, so a distrusted or removed root CA arrives only with a Node release and
  no CVE scanner reports it. Dependabot version updates for the `docker` ecosystem open the
  base-image bump PRs.

### Security — S-C (full, adds to S-B)

- **FR-9 … FR-12 — out of scope for now.**
- **FR-9 (SAST):** CodeQL (default setup: JavaScript/TypeScript and GitHub Actions; free for
  public repositories, results in the Security tab with Copilot Autofix suggestions) over
  `server/`, `client/`, `hook/` and `.github/workflows/` — SQL injection, XSS, path traversal,
  command injection (`claude-invoke-async.js` runs through `cmd.exe`). Snyk Code is the
  alternative if CodeQL proves too noisy.
- **FR-10 (licences):** a licence policy fails on copyleft licences (GPL/AGPL) in production
  dependencies (FR-28 enforces it on PRs); its output feeds `THIRD_PARTY_NOTICES.md`.
- **FR-11 (SBOM):** a CycloneDX/SPDX SBOM of the image is attached to each release (FR-33).
- **FR-12 (posture):** OpenSSF Scorecard weekly (`ossf/scorecard-action`, results to the Security
  tab, its badge in `README.md`); Dependabot version updates (or Renovate) for npm, the Dockerfile
  base image and GitHub Actions.

### Malware and release — V (VirusTotal, attestations, release attachments)

- **FR-29 (what VirusTotal scans):** the files that reach users' machines: the built hook
  installer tarballs and the release install kit (`install.sh`, `install.ps1`, any zip). Not the
  container image (over the VirusTotal size limit; FR-8 covers it) and not the sources (FR-1,
  FR-9 cover them). A file is first looked up by SHA-256; it is uploaded only when VirusTotal does
  not know the hash.
- **FR-30 (when):** on pull requests only — never on every push — and only when the PR changes
  `hook/`, `artisyn-hooks-installer/` or `release-template/` (the workflow is not a required
  check, so a path filter is allowed); (release runs: FR-33, out of scope). Fork PRs (no
  `VIRUS_TOTAL_KEY`) skip it with a notice.
- **FR-31 (verdict):** non-blocking. Any engine detection makes the check neutral and lists the
  engines and the VirusTotal permalink (`https://www.virustotal.com/gui/file/<sha256>`); an API
  error or timeout makes it neutral with the reason, never red.
- **FR-32 … FR-34 — out of scope for now (no release work in this task).**
- **FR-32 (attestations and immutable releases):** release assets and the GHCR image get build
  provenance via `actions/attest-build-provenance` (verifiable with `gh attestation verify`); the
  GitHub Release is published as immutable, so assets and the tag cannot change after publishing.
- **FR-33 (release attachments):** the release workflow creates the release as a draft, runs the
  scans on the exact files it will publish, attaches the results, then publishes. Attached assets:
  `security-scan-results.json` and `.md` (FR-24 format), the SARIF files, the SBOM (FR-11) and
  `SHA256SUMS`. The release notes get a "Security scan" section: per asset its SHA-256, the
  VirusTotal detections (`0/<engines>`) and permalink, and the Snyk Container totals for the image.
- **FR-34 (dependency on the release pipeline):** FR-32/FR-33 are implemented in the release
  workflow of `2026-10-20-github-release-pipeline`; if that task lands later, the PR part (FR-29 …
  FR-31) ships first.

FR-13 … FR-22 are reserved for the deferred perf part, so the remaining FR ids stay stable.

### Results — R (where scan output goes)

Scan output is **never committed to `main` or to a PR branch**: it is generated data,
it churns on every run, and a commit there is exactly what starts the next scan.

- **FR-23 (per-run output):** every run keeps its raw output as a workflow artifact (SARIF,
  JSON, HTML) and a short table in `$GITHUB_STEP_SUMMARY`. For PRs, one `security-report`
  workflow (triggered by `workflow_run` of the scan workflows, so it also works for fork PRs)
  writes the **security summary** — one row per scanner: tool, status, findings by severity, link
  to the run / Security tab / VirusTotal; the existing gitleaks `scan` check is shown read-only —
  into a bot-owned block at the **end of the PR
  description**, between `<!-- security-scan:start -->` and `<!-- security-scan:end -->`, replacing
  only that block.
- **FR-24 (results branch and badge data):** a bot commits to a dedicated **orphan branch**
  `ci-reports` that shares no files with `main`: `security-scan-results.json` (unified format:
  commit, date, per tool — version, status, counts by severity, link), shields.io endpoint JSON
  files under `badges/`. Updated by the nightly
  `main` scans and by release runs. `README.md` shows a "security scan" badge via
  `https://img.shields.io/endpoint?url=<raw URL of badges/security.json on ci-reports>`, next to
  the workflow status badges and the Scorecard badge (FR-12). Loop prevention, in this order of
  reliance:
  1. the push uses the workflow's `GITHUB_TOKEN` — GitHub does not start new workflow runs for
     events caused by `GITHUB_TOKEN` (except `workflow_dispatch` / `repository_dispatch`);
  2. every scan workflow filters `on.push.branches: [main, release]`, so the results branch never
     matches;
  3. the commit message carries `[skip ci]` as a belt-and-braces guard.
  A PAT or GitHub App token must not be used for that push — it would trigger runs and defeat
  rule 1.
- **FR-25 (security dashboards):** `snyk monitor` results live in the Snyk UI. SARIF from Snyk /
  zizmor / Scorecard is uploaded with `github/codeql-action/upload-sarif`, so
  findings appear in the Security tab (next to Dependabot) and as PR annotations, with
  dismissals tracked there instead of in files.
- **FR-26 (suppressions are the only scan files in the repo):** what does belong on `main` is
  hand-written policy: `.snyk` (ignores with reason and expiry) and the FR-4 allowlists. Changing them is a reviewed
  PR (FR-5 CODEOWNERS). A workflow that is or may become a required check never uses `paths-ignore` (a skipped required
  check stays "Expected — waiting"); it detects docs-only changes in a first job and skips the scan
  steps inside the job so the check still reports success. Non-required workflows may use
  `paths-ignore` only for docs-only changes (e.g. `docs/**`), never for these policy files.

## Non-Functional Requirements

- Scans never print secret values in logs, summaries, PR text or comments.
- `SNYK_TOKEN`, `VIRUS_TOTAL_KEY` and other secrets live in repository secrets and are not
  exposed to fork PR runs.
- PR scans stay within the CI time stated per variant; anything slower runs nightly.
- Every job has a hard `timeout-minutes`.
- `permissions:` are minimal: `contents: read` by default; `pull-requests: write` only in the
  comment/summary-posting workflows; `contents: write` only in the FR-24 results-branch job and the
  release job; `security-events: write` only for FR-25 SARIF upload; `id-token: write` and
  `attestations: write` only in the FR-32 release job.
- Every new workflow follows the conventions of `gitleaks.yml`: actions pinned by SHA,
  `persist-credentials: false`, sha256-verified CLI downloads, `timeout-minutes`, a
  `vars.*_ENABLED` gate.
- No new check is a required check and none fails a merge; every check is report-only. Making
  any of them blocking (and adding it to `protect-main-release`) is a later decision after the
  owner has reviewed the reports.

## Acceptance Criteria

- [ ] A PR adding a dependency with a known high-severity, fixable CVE gets it reported in the
      security summary while all checks stay green — also when the package is added only to
      `client/` (bun) or only to `hook/` (FR-1); the same PR from a fork gets it from dependency
      review and shows the Snyk-skipped notice (FR-1, FR-28).
- [ ] After the first CI runs, Snyk → Settings → Usage shows no growth of the Open Source test
      counter, and the Snyk projects have the GitHub remote URL set (FR-1).
- [ ] Dependabot alerts, private vulnerability reporting and
      `SECURITY.md` are on; a PR adding a GPL production dependency is flagged by dependency review
      (FR-27, FR-28).
- [ ] S-B: a PR setting a model name to `sonnet & calc` or `serverUrl` to a non-localhost host
      is reported by the guard naming the file and key, while the current `main` reports nothing
      (FR-4); a PR touching `hook/` requests the maintainer's review (FR-5); a non-npmjs lock-file
      entry is reported (FR-6); an action pinned by tag is reported by the workflow lint (FR-7); the nightly run
      reports base-image and Node runtime CVEs and an invalid compose file is reported (FR-8); a
      Dockerfile on a Node version with a security release is reported as an error, one behind the
      latest patch as a warning (FR-35).
- [ ] V: a PR changing `hook/` gets VirusTotal rows in the security summary; a PR touching only
      `server/` does not run VirusTotal; a VirusTotal outage leaves the check neutral (FR-29 …
      FR-31).
- [ ] R: a PR with a seeded finding gets exactly one security summary block at the end of its
      description, updated on reruns, and the author's text above it is untouched — also for a
      fork PR (FR-23); SARIF from Snyk shows up in the Security tab with a PR
      annotation (FR-25); the `README.md` badge reflects `ci-reports`; no workflow commits to
      `main` or to a PR branch, and a commit to `ci-reports` starts no workflow run (visible in
      the Actions list) (FR-24).
- [ ] Tests follow the repo test policy: the FR-4 guard's rules get an algorithm doc in
      `docs/knowledgebase/algorithms/` with an examples block (the FR-4 rule table rows) and its
      table test (build-script tests); if the FR-23 block replacement adds a new
      algorithm, the same. The workflows get no tests of their
      own — they are verified by deliberately failing test PRs.

## Open Questions

(none)

## Common sense considerations

- The repository is public, so CI minutes, SARIF upload and branch protection are no longer
  blockers; FR-25 applies now.
- Secret scanning (gitleaks, push protection) is out of scope and stays unchanged.
- Snyk runs on every PR: the repository is public, so its tests do not use the free-plan quota.
- The owner provides `SNYK_TOKEN` and `VIRUS_TOTAL_KEY` (both repository secrets exist).
- The six high findings in `server/` production dependencies are fixed in this task
  (multer 2.5.0 incl. an `overrides` entry for `@nestjs/platform-express`, nodemailer 10.2.1,
  body-parser 2.4.0, qs 6.16.1).
- VirusTotal uses the Public API key: at most ~10 PRs/day fits its 4 requests/min and 500/day limits.
- New workflows follow the `gitleaks.yml` conventions; new blocking checks join
  `protect-main-release`.
- Scan scope is the explicit manifest list; fixtures, `docs/pocs/` and the dogfooded marketplace
  copy are excluded.
- Fork PRs skip Snyk with a notice; dependency review is their dependency check.
- FR-4 rules and edge cases are as in its rule table, matching the current tracked files.
- Compose files are checked by `docker compose config`, not hadolint.
- Trivy is dropped; Snyk Container scans the image (it detects the Node runtime binary).
- The security summary is one bot-owned block for all scanners, posted via `workflow_run`.
- The results branch `ci-reports` is required (badge data), not optional.
- Required-check workflows skip docs-only changes inside the job, never via `paths-ignore`.
- VirusTotal is non-blocking and looks up hashes before uploading.

## Notes

- Related: `2026-10-20-github-release-pipeline` (release workflow, install kit, runner rules),
  `2026-08-13-perf-harness-reliability` (prerequisite for the deferred perf part), `.claude/skills/security-check/`
  (manual invariants audit — FR-4 may reuse some checks).
- Prototype results (Snyk, VirusTotal, Snyk Container, Node runtime checks): `notes.md`.
- GitHub references for implementation: "Security hardening for GitHub Actions", "Quickstart for
  securing your repository", OpenSSF Scorecard checks.
