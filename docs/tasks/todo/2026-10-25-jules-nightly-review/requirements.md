# 2026-10-25: Nightly AI Quality Review of main by Google Jules

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** ci, repo tooling (AGENTS.md, .claude/skills, .github/workflows, scripts/ci)
**Owner:** denis.tsyplakov
**Created:** 2026-10-25

## Description

Raw idea (as agreed with the owner in chat):

Nightly AI quality review of `main` by Google Jules (free plan, Scheduled Task). Decisions agreed
with the user:

- Engine: Google Jules free plan (15 tasks / 24 h), connected via the Jules GitHub App to
  `DataArt/artisyn-log-hub` only, using a dedicated service Google account (not a personal one).
  No paid Copilot, no personal Claude subscription.
- ONE Jules Scheduled Task, daily, started from branch `main`. Its prompt is one line pointing to a
  repo skill (Jules scheduled tasks cannot be edited, so all logic lives in the repo):
  "Run .claude/skills/nightly-review/SKILL.md. Do not fix anything; produce the report only."
- `AGENTS.md` at the repo root (Jules reads it automatically): a short pointer to `CLAUDE.md`,
  `docs/knowledgebase/index.md` and the nightly-review skill.
- Jules environment setup script (Node 22 is preinstalled; install bun, `npm ci` in root / server /
  hook, `bun install` in client): static checks only, no DB, no stand.
- Scope: commits on `main` since the last reviewed commit (its hash is stored in the previous report
  on `ci-reports`); a full pass over the whole of `main` once a week. A report is written even when
  nothing is found ("no violations, checked `<from>..<to>`").
- Report: `reports/<date>.md`, unified format: finding, `file:line`, why it is a problem, which check.
- Checks (all AI-judged, read-only):
  1. Every HTTP route's auth matches the docs: compare controllers / guards in `server/src` against
     `docs/knowledgebase/server-endpoint-map.md` and `authorization-and-authentificaiton.md`, in both
     directions; include the `security-check` skill invariants (e.g. no mutating GET under a cookie
     session).
  2. DB queries use indexes / no full scans: static analysis per the `post-impl-check-indexes` skill
     (`WHERE` / `ORDER BY` / `JOIN` columns in Drizzle queries vs indexes in
     `server/drizzle/migrations`). Flags suspects, not proof.
  3. No "slop" unit tests around implementation details: the test policy from `CLAUDE.md` (only
     `*.algo.*` table tests, contract registry rows, scenario steps). Owner decision: this stays an
     AI check, NOT a deterministic CI script — the AI must judge new test files, algorithm-doc
     example rows that pin internals, and scenario steps that assert mocks / internal calls.
  4. Similar checks: KB actuality (`post-impl-check-kb-actual`), Hook API backward compatibility,
     paths hard-coded to a developer machine.
- Delivery: Jules opens a PR into `main`. A GitHub Action triggered when the Jules bot opens a PR
  that changes ONLY `reports/` copies the report to the orphan branch `ci-reports` at
  `jules/<date>.md` via the existing `scripts/ci/publish-ci-reports.js` (`GITHUB_TOKEN`, Git Data
  API, `[skip ci]`), then closes the PR and deletes the Jules branch. PRs touching anything else are
  left untouched. Nothing lands in `main`.
- Open points to verify on the first manual run: whether a scheduled task auto-approves its plan and
  auto-publishes (or waits for a click), the exact Jules bot login, the PR base branch.
- Owner rollout steps (manual, by the org admin): install the Jules GitHub App on this repo only,
  configure the setup script + snapshot, create the scheduled task.

## Functional Requirements

- **FR-1 AGENTS.md.** A root `AGENTS.md` points an external agent to `CLAUDE.md`,
  `docs/knowledgebase/index.md` and `.claude/skills/nightly-review/SKILL.md`, and states that a
  nightly-review run is read-only (no code changes, report only).
- **FR-2 Nightly-review skill.** `.claude/skills/nightly-review/SKILL.md` is the single source of the
  review logic: scope resolution, the list of checks, the report format. It is usable by Jules and by
  Claude Code alike.
- **FR-3 Scope.** A daily run reviews the commits on `main` between the last reviewed commit (read
  from the latest report on `ci-reports`) and `HEAD`; a weekly run (fixed weekday) reviews the whole
  of `main`. With no previous report the run is a full pass.
- **FR-4 Check: route auth vs docs.** Every route in `server/src` is compared with
  `server-endpoint-map.md` and `authorization-and-authentificaiton.md` both ways (route missing from
  the docs, documented route missing from code, guard differs, no guard); the `security-check`
  invariants are applied.
- **FR-5 Check: DB indexes.** Drizzle queries' filter / sort / join columns are compared with indexes
  in `server/drizzle/migrations` per `post-impl-check-indexes`; findings are labelled as suspects.
- **FR-6 Check: test slop.** New or changed tests are judged against the `CLAUDE.md` test policy:
  test files outside the three allowed kinds, algorithm-doc example rows that pin implementation
  details instead of algorithm rules, scenario steps that assert mocks or internal calls.
- **FR-7 Check: other invariants.** KB actuality (`post-impl-check-kb-actual`), Hook API backward
  compatibility, paths hard-coded to a developer machine / OS.
- **FR-8 Report.** Each run writes `reports/<YYYY-MM-DD>.md` with: checked range
  (`<from>..<to>`, full / incremental), and per finding — check, `file:line`, why it is a problem.
  An empty run still writes a report saying no violations were found in that range.
- **FR-9 Jules setup.** A documented environment setup script for Jules (bun, `npm ci` in root /
  server / hook, `bun install` in client), static tooling only — no DB, no stand.
- **FR-10 Delivery workflow.** A GitHub Action runs on a PR opened by the Jules bot whose changes are
  confined to `reports/`: it publishes the report to `ci-reports` at `jules/<date>.md` with
  `scripts/ci/publish-ci-reports.js`, closes the PR and deletes its branch. A Jules PR touching any
  other path is left untouched; nothing from these PRs is merged into `main`.
- **FR-11 Rollout docs.** A KB article (and its `index.md` line) describes the setup: Jules account
  and GitHub App scope, setup script and snapshot, the scheduled task prompt, the delivery workflow,
  where reports live, and how to change the review (edit the skill, never the scheduled task).

## Non-Functional Requirements

- Zero cost: Jules free plan, `GITHUB_TOKEN` only; no paid seats, no personal subscription tokens,
  no new repository secrets.
- The delivery workflow has least-privilege permissions (`contents: write` and
  `pull-requests: write` on its own job only) and never checks out or executes code from the Jules PR.
- Jules uses a dedicated service Google account; the GitHub App is installed on this repository only.

## Acceptance Criteria

- [ ] FR-1: `AGENTS.md` exists at the repo root and references the three files; it says nightly
      review is report-only.
- [ ] FR-2: `.claude/skills/nightly-review/SKILL.md` exists, lists all checks of FR-4…FR-7 with the
      sources each one uses, and defines the report format of FR-8.
- [ ] FR-3: the skill states how the previous reviewed commit is found on `ci-reports`, the weekly
      full-pass rule, and the fallback to a full pass with no previous report.
- [ ] FR-4: a deliberately undocumented route (or a guard mismatch) on a test branch shows up in the
      report with `file:line`.
- [ ] FR-5: a query filtering on an unindexed column shows up as a suspect.
- [ ] FR-6: a non-`*.algo.*` unit test file added on a test branch shows up as a violation.
- [ ] FR-7: each of the three invariants is listed in the report (finding or "OK").
- [ ] FR-8: a run with no findings still produces a report with the checked range.
- [ ] FR-9: the setup script is documented and passes Jules "Run and Snapshot".
- [ ] FR-10: a Jules PR changing only `reports/` ends up as `jules/<date>.md` on `ci-reports`, the PR
      is closed and its branch deleted; a Jules PR changing another path is left open and untouched.
- [ ] FR-11: the KB article exists and is listed in `docs/knowledgebase/index.md`.

## Open Questions

- Does a Jules Scheduled Task auto-approve its plan and auto-publish a PR, or does it wait for a
  click? (Verify on the first manual run.)
- The exact GitHub login of the Jules bot (needed for the FR-10 trigger filter).
- The base branch of a PR opened by a task started from `main` (expected: `main`).
- Which weekday runs the weekly full pass, and how the skill detects it (date in the VM vs a marker).

## Notes

<!-- Append timestamped notes here as work progresses -->
