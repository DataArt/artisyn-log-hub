# 2026-10-24: Update Vulnerable Dev Dependencies (Snyk)

**Status:** todo
**Priority:**
**Type:**
**Module(s):** client | server | hook | root
**Owner:** denis.tsyplakov
**Created:** 2026-10-24

## Description

Update vulnerable devDependencies reported by Snyk Open Source (dev) on main: 1 critical, 13 high
(11 fixable). Packages and projects (from ci-reports REPORT.md, 2026-10-24):

- esbuild@0.18.20 (critical, fixed 0.28.1, server/package-lock.json);
- qs@6.15.1 (fixed 6.16.1, server/package-lock.json);
- brace-expansion@1.1.15 (5 high, fixed 1.1.20/2.1.6/3.0.8/5.0.11, root package-lock.json);
- js-yaml@4.1.1 (3 high, fixed 4.3.2, hook/package-lock.json);
- @vitest/mocker@4.1.11 (fixed 4.1.12, client);
- postcss-selector-parser@6.0.10 (fixed 6.1.5/7.1.6, client);
- picomatch@4.0.7 and uri-js@4.4.1 (client, no fix yet).

Goal: the Snyk dev row has no fixable high/critical; no behaviour change; full test set green.
Report source: https://github.com/DataArt/artisyn-log-hub/blob/ci-reports/REPORT.md

These are development and build dependencies: they do not ship in the product image, so the
README security badge does not count them, but they run on developer machines and in CI.

## Functional Requirements

- FR-1: Every fixable critical or high issue in the Snyk Open Source (dev) row is resolved by
  moving the affected package to a fixed version, in the project where Snyk reports it:
  esbuild and qs in `server/`, brace-expansion in the root, js-yaml in `hook/`, @vitest/mocker
  and postcss-selector-parser in `client/`.
- FR-2: Packages that are transitive dependencies are moved to a fixed version through the
  normal update of their parent or, when no parent release carries the fix, through the package
  manager's override/resolution mechanism.
- FR-3: Issues with no fixed version yet (picomatch, uri-js in `client/`) are left as they are and
  stay listed in the report.
- FR-4: Lock files are updated together with the manifests (`package-lock.json` for root,
  `server/`, `hook/`; `bun.lock` for `client/`).
- FR-5: No application, hook or build behaviour changes.

## Acceptance Criteria

- [ ] After the change, the Snyk Open Source (dev) row on a PR (and in `REPORT.md` after merge)
      shows 0 fixable critical/high issues; only issues without a fixed version remain.
- [ ] esbuild, qs, brace-expansion, js-yaml, @vitest/mocker and postcss-selector-parser resolve to
      a fixed version (or newer) in their lock files.
- [ ] picomatch and uri-js are unchanged unless a fixed version has appeared by implementation
      time.
- [ ] `npm ci` / `bun install --frozen-lockfile` succeed in every changed project, and lockfile-lint
      and npm signatures stay green.
- [ ] The full check set (`adlc-lh:check-health` with `finalRun: true`) is green.

## Notes

<!-- Append timestamped notes here as work progresses -->
