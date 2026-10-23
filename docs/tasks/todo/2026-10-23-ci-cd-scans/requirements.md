# 2026-10-23: CI/CD Scans (Security, Supply Chain, Perf) and Where Their Results Live

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** ci | server | client | hook | installer
**Owner:** denis.tsyplakov
**Created:** 2026-10-23

## Description

Raw idea (owner, 2026-10-23), collected from one conversation:

1. Add a Snyk scan to the pipeline — the trigger does not matter. Wanted: vulnerabilities in
   packages; secrets (possibly with another tool); and whatever else is worth scanning.
2. Run the perf test asynchronously in the pipeline and attach its result somewhere.
3. "The scanners have run — where do the result files go? I would commit them to the repo, but
   that triggers the next scan — how is this done properly?"
4. Everything in **one** task: CI/CD scans.

Current state (2026-10-23):

- There is no CI at all: `main` has no `.github/` directory.
- Dependency manifests: npm lock files in the repo root, `server/`, `hook/` and
  `artisyn-hooks-installer/`; `bun.lock` in the repo root and in `client/`.
- One production `Dockerfile` (all stages on `node:22.23.4-slim`), plus `docker-dev/Dockerfile`
  and `tests/scenarios/docker-compose.yml`.
- `pr-merge-checks.md` lists files that Claude Code, the hook, npm or git **execute** on every
  contributor's machine (`.artisyn/config/log-hub.json`, `.claude/settings.json`, `.mcp.json`, the
  hook sources) and says "CI does not catch a malicious change in them" — reviewed by hand only.
- The hook reaches end users through the installer tarballs, so a compromised dependency there
  reaches every user's machine.
- Perf harness: `server/perf-tests/` (`npm run perf` from `server/`, see
  `docs/knowledgebase/server-conventions.md` § "Performance Testing Framework"). Needs a running
  server and Postgres; writes JSON + HTML reports with a baseline comparison to `tmp/perftests/`.
  It is **not trustworthy yet** — open bug `2026-08-13-perf-harness-reliability`: failed scenarios
  are reported as passing, the exit code ignores failures, and back-to-back runs on identical code
  differed by up to ±94%.
- The repository is still **private** (`gh repo view` → `PRIVATE`). Per
  `2026-10-20-github-release-pipeline`, the organisation is on GitHub Free and its included
  Actions minutes are already used up by another repository; GitHub-native security features
  (secret scanning + push protection, CodeQL, the Security tab for SARIF, dependency review) and
  branch protection are free only for public repositories.

## Variants and cost

Effort is engineer-days with Claude-assisted implementation. CI time is per run on a
GitHub-hosted runner; the perf numbers must be measured on the first run.

| Part | Variant | Scope | Effort | CI time |
|---|---|---|---|---|
| Security | **S-A — minimal** | FR-1 … FR-3 | 0.5–1 day | PR: 1–2 min |
| Security | **S-B — recommended** | S-A + FR-4 … FR-8 | 2–3 days | PR: 3–4 min; nightly ~10 min (image build) |
| Security | **S-C — full** | S-B + FR-9 … FR-12 | 4–5 days | PR: 5–8 min (SAST); nightly ~15 min |
| Security | first-scan triage | fix or suppress what the first full scan finds | 0.5–2 days, unknown until the first run | — |
| Perf | **P-A — nightly + artifact** | FR-13 … FR-16 | 1–1.5 days | 15–25 min |
| Perf | **P-B — A/B on PR (recommended)** | P-A + FR-17 … FR-20 | 3–4 days total | 25–40 min per labelled PR |
| Perf | **P-C — trend + client perf** | P-B + FR-21, FR-22 | +2–3 days | +5–10 min |
| Perf | prerequisite | `2026-08-13-perf-harness-reliability` (separate task) | 2–4 days | — |
| Results | **R — storage** | FR-23 … FR-26 | 0.5–1 day (shared by both parts) | — |

Recommended combination: **S-B + P-B + R** — about 6–8 engineer-days plus triage and the harness
fix, i.e. roughly 2–3 calendar weeks. Cheapest useful start: **S-A + R (artifacts only)** — one day.

None of it can run before the Actions-minutes problem is solved (public switch or a paid minutes
budget) — see Open Questions. A self-hosted runner would cut perf noise but is ruled out for the
public repository by `2026-10-20-github-release-pipeline` FR-9.

## Functional Requirements

### Security — S-A (minimal)

- **FR-1 (dependency vulnerabilities):** Snyk Open Source over **every** manifest
  (`snyk test --all-projects`) on every pull request and on push to `main`, failing on
  `high`/`critical` findings that have a fix. `snyk monitor` on `main` records the dependency
  snapshot so new CVEs in already-merged code are reported without a new push. If Snyk does not
  read `bun.lock` reliably, `client/` and the root `bun.lock` are scanned by `osv-scanner`.
- **FR-2 (secrets in changes):** gitleaks scans the pull-request diff and fails on a finding. A
  `.gitleaks.toml` allowlists the known fake values in test fixtures (golden sessions, scenario
  fixtures) by path or regex — never by disabling rules globally.
- **FR-3 (secrets in history):** gitleaks runs once over the full git history (manual
  `workflow_dispatch`); every finding is rotated and documented, or allowlisted with a reason.
  `.artisyn/config/log-hub.local.json` (holds the API key) is an explicit rule target.

### Security — S-B (recommended, adds to S-A)

- **FR-4 (executable-config guard):** a Node script on every pull request automates the
  machine-checkable items of `pr-merge-checks.md`: model names in `.artisyn/config/log-hub.json`
  match `^[A-Za-z0-9._:\-\[\]]+$`; `serverUrl` is `http://localhost:<port>`; `telemetryDir` is
  empty or relative; `.claude/settings.json` has no `hooks`, its `OTEL_EXPORTER_OTLP_*_ENDPOINT`
  values stay on `127.0.0.1`/`localhost`, and `enabledPlugins`/`extraKnownMarketplaces` stay within
  the allowlist; `.mcp.json` server commands stay within an allowlist;
  `.artisyn/config/log-hub.local.json` is not tracked. The manual list stays for what a script
  cannot judge.
- **FR-5 (CODEOWNERS):** `.github/CODEOWNERS` requires the maintainer's review for the FR-4
  files, `hook/`, `artisyn-hooks-installer/` and `.github/`.
- **FR-6 (npm supply chain):** `lockfile-lint` allows only `https://registry.npmjs.org` in every
  npm lock file; `npm audit signatures` verifies registry signatures; the built installer tarballs
  are scanned like the sources (FR-1).
- **FR-7 (workflow hygiene):** `actionlint` and `zizmor` lint `.github/workflows/`; third-party
  actions are pinned by commit SHA; every workflow declares minimal `permissions:`; no workflow
  uses `pull_request_target` (consistent with `2026-10-20-github-release-pipeline` FR-3).
- **FR-8 (container and Dockerfile):** nightly, the production image is built and scanned (Snyk
  Container or Trivy) for base-image OS CVEs; `hadolint` (or `trivy config`) lints the Dockerfiles
  and compose files on pull requests.

### Security — S-C (full, adds to S-B)

- **FR-9 (SAST):** Snyk Code or CodeQL over `server/`, `client/` and `hook/` (SQL injection, XSS,
  path traversal, command injection — `claude-invoke-async.js` runs through `cmd.exe`).
- **FR-10 (licences):** a licence policy fails on copyleft licences (GPL/AGPL) in production
  dependencies; its output feeds `THIRD_PARTY_NOTICES.md`.
- **FR-11 (SBOM):** a CycloneDX/SPDX SBOM of the image is attached to each release (hooks into
  `2026-10-20-github-release-pipeline`).
- **FR-12 (posture):** OpenSSF Scorecard weekly; Dependabot (or Renovate) update PRs for npm, the
  Dockerfile base image and GitHub Actions.

### Perf — P-A (nightly + artifact)

- **FR-13 (trigger, non-blocking):** a `perf` workflow on `schedule` (nightly, `main`) and
  `workflow_dispatch`. Never a required check, never blocks a merge.
- **FR-14 (stand):** Postgres as a service container; the server built and started the way the
  harness expects (or the isolated scenario stand from `tests/scenarios/` reused); wait for
  health; `npm run perf`; always tear down.
- **FR-15 (artifact):** JSON and HTML reports uploaded as a workflow artifact named with the
  commit SHA.
- **FR-16 (job summary):** a markdown table — scenario, status, mean, p95, Δ% vs. baseline — in
  `$GITHUB_STEP_SUMMARY`; needs a markdown renderer in `server/perf-tests/reporter.ts` next to the
  HTML one.

### Perf — P-B (A/B on pull requests, adds to P-A)

- **FR-17 (PR trigger):** also runs on a pull request carrying the `perf` label.
- **FR-18 (A/B in one job):** on the same runner, build the PR's base commit and the PR head, run
  them interleaved (A, B, A, B, …; run count in `constants.json`) and compare medians, so the
  runner's noise hits both sides equally.
- **FR-19 (PR comment):** one sticky PR comment, updated on every run, with the FR-16 table and a
  link to the artifact. For fork PRs (read-only token) a separate `workflow_run` workflow
  downloads the artifact and posts the comment; no `pull_request_target`.
- **FR-20 (check status):** a non-blocking check: green; neutral when a scenario regresses beyond
  the gate rule set by `2026-08-13-perf-harness-reliability` (today 20%,
  `.claude/rules/server.md`); red when the harness itself failed.

### Perf — P-C (trend + client perf, adds to P-B)

- **FR-21 (trend):** nightly results feed `github-action-benchmark` charts, so slow drift that no
  single PR shows becomes visible (published to the FR-24 results branch).
- **FR-22 (client):** Lighthouse CI against the built client and `size-limit` for the bundle size
  on PRs labelled `perf` or touching `client/`, in the same sticky comment.

### Results — R (where scan and perf output goes)

Scan and perf output is **never committed to `main` or to a PR branch**: it is generated data,
it churns on every run, and a commit there is exactly what starts the next scan.

- **FR-23 (per-run output):** every run keeps its raw output as a workflow artifact (SARIF,
  JSON, HTML), a short table in `$GITHUB_STEP_SUMMARY`, and — for PRs — findings in the sticky
  PR comment (FR-19 for perf; a findings summary for security).
- **FR-24 (history in git, optional):** when history must live in git, a bot commits it to a
  dedicated **orphan branch** (e.g. `ci-reports`, or `gh-pages` for the FR-21 charts) that shares
  no files with `main`. Loop prevention, in this order of reliance:
  1. the push uses the workflow's `GITHUB_TOKEN` — GitHub does not start new workflow runs for
     events caused by `GITHUB_TOKEN` (except `workflow_dispatch` / `repository_dispatch`);
  2. every scan workflow filters `on.push.branches: [main]` (or `branches-ignore: [ci-reports,
     gh-pages]`), so the results branch never matches;
  3. the commit message carries `[skip ci]` as a belt-and-braces guard.
  A PAT or GitHub App token must not be used for that push — it would trigger runs and defeat
  rule 1.
- **FR-25 (security dashboards):** `snyk monitor` results live in the Snyk UI. After the public
  switch, SARIF from Snyk / gitleaks / Trivy / CodeQL is uploaded with
  `github/codeql-action/upload-sarif`, so findings appear in the Security tab and as PR
  annotations, with dismissals tracked there instead of in files.
- **FR-26 (suppressions are the only scan files in the repo):** what does belong on `main` is
  hand-written policy: `.snyk` (ignores with reason and expiry), `.gitleaks.toml` (allowlist),
  `.trivyignore`, the FR-4 allowlists. Changing them is a reviewed PR (FR-5 CODEOWNERS), and
  scan workflows may use `paths-ignore` only for docs-only changes (e.g. `docs/**`), never for
  these policy files.

## Non-Functional Requirements

- Scans never print secret values in logs, summaries or PR comments (gitleaks `--redact`).
- `SNYK_TOKEN` and other secrets live in repository secrets and are not exposed to fork PR runs.
- PR scans stay within the CI time stated per variant; anything slower runs nightly.
- Perf runs use their own database/schema; cleanup runs even when the run fails; every job has a
  hard `timeout-minutes`.
- `permissions:` are minimal: `contents: read` by default; `pull-requests: write` only in the
  comment-posting workflow; `contents: write` only in the FR-24 results-branch job;
  `security-events: write` only for FR-25 SARIF upload.

## Acceptance Criteria

- [ ] A PR adding a dependency with a known high-severity, fixable CVE fails the scan — also when
      the package is added only to `client/` (bun) or only to `hook/` (FR-1).
- [ ] A PR containing a fake AWS key in a source file fails; the existing test fixtures do not
      (FR-2).
- [ ] The full-history scan ran once; every finding is rotated or allowlisted with a reason (FR-3).
- [ ] S-B: a PR setting a model name to `sonnet & calc` or `serverUrl` to a non-localhost host
      fails the guard with a message naming the file and key (FR-4); a PR touching `hook/`
      requests the maintainer's review (FR-5); a non-npmjs lock-file entry fails (FR-6); an action
      pinned by tag fails the workflow lint (FR-7); the nightly run reports base-image CVEs (FR-8).
- [ ] S-C: SAST, licence, SBOM and Scorecard results are visible (FR-9 … FR-12).
- [ ] P-A: the nightly perf run on `main` produces the artifact and the summary table, and a
      failing perf run blocks nothing (FR-13 … FR-16).
- [ ] P-B: labelling a PR `perf` starts a run and yields exactly one comment, updated on reruns
      (FR-17, FR-19); two runs on a PR without server changes stay within the gate threshold for
      every scenario above the noise floor (FR-18); a test PR that deliberately slows one route is
      reported as a regression (FR-20); a fork PR gets its comment via `workflow_run` (FR-19).
- [ ] P-C: the trend chart and the Lighthouse / bundle-size rows appear (FR-21, FR-22).
- [ ] R: no workflow commits to `main` or to a PR branch; if FR-24 is chosen, a results commit
      to the results branch starts no workflow run (visible in the Actions list) (FR-23, FR-24).
- [ ] Tests follow the repo test policy: the FR-4 guard's rules get an algorithm doc in
      `docs/knowledgebase/algorithms/` with an examples block and its table test (build-script
      tests); if FR-18's median comparison adds a new algorithm, the same. The workflows and the
      markdown renderer get no tests of their own — they are verified by deliberately failing
      test PRs.

## Open Questions

- Which variants — security S-A / S-B / S-C, perf P-A / P-B / P-C?
- CI minutes: wait for the public switch (planned in `2026-10-20-github-release-pipeline`), or pay
  for minutes for the private phase? Until then nothing here runs in CI.
- Is there a Snyk organisation and a `SNYK_TOKEN`? Free-tier monthly test limits must be checked
  against "scan on every PR".
- Should FR-1 block merges (required check) or only report until the first-scan findings are
  triaged? Required checks need branch protection, which needs the public switch.
- Perf: do it only after `2026-08-13-perf-harness-reliability`, or do a reduced harness fix
  (status and exit code only) inside this task?
- Results: is the artifact + Snyk/Security-tab history enough, or is the FR-24 results branch
  wanted? Where should the perf baseline live — the latest `main` artifact or the results branch?
- After the public switch: replace gitleaks-in-PR with GitHub secret scanning + push protection,
  or run both?

## Notes

- Related: `2026-10-20-github-release-pipeline` (first workflows, branch protection, runner rules,
  minutes), `2026-08-13-perf-harness-reliability` (perf prerequisite),
  `.claude/skills/security-check/` (manual invariants audit — FR-4 may reuse some checks).
