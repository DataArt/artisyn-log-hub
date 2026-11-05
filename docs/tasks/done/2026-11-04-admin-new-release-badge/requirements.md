# 2026-11-04: Admin New Release Notification

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | client
**Owner:** denis.tsyplakov
**Created:** 2026-11-04
**Tracker:** GH-99 https://github.com/DataArt/artisyn-log-hub/issues/99

## Description

Raw idea (verbatim):

> если сервер задеплоен из github и есть более новые релиз и пользователь админ показывать на админке кружочек и если админ туда заходит писать - есть более новая версия и ссылку на версию
> проверять раз в день

When the Log Hub server was deployed from a GitHub release and a newer release has been published
on GitHub, an admin user should see an indicator dot on the Admin entry; on the Admin page they
should see a message that a newer version is available, with a link to that version. The check for
new releases runs once a day.

## Functional Requirements

- FR-1: The server detects whether it was deployed from a GitHub release; the new-version check
  applies only to such deployments. A "release" is what the repository's GitHub page lists as a
  release (GitHub Releases), nothing else (not bare tags, not Docker images).
- FR-1a: Every build writes `build.origin.json` into the server root (`dist/`, next to `index.js`)
  with the branch it was built from, the version, the build time, and an `officialRelease` flag. The flag is `true`
  only for a build made by the release pipeline (`.github/workflows/release.yml`); every other build
  (local `npm run build`, a local `docker build`, the local test bundle) writes `false`.
- FR-1b: The server treats itself as deployed from a GitHub release only when `build.origin.json`
  is present, readable and has `officialRelease: true`.
- FR-1c: In the top nav, hovering the build label next to the logo and app name (`MainNav.tsx`)
  shows a tooltip with the `build.origin.json` data: branch, version, build time and whether it is
  an official release, plus the commit shown there today. All users see it.
- FR-2: The server checks GitHub for the latest published release no more often than once a day
  and remembers the result between checks.
- FR-3: The server compares the running version with the latest GitHub release and determines
  whether a newer version is available.
- FR-4: For an admin user, when a newer version is available, the Admin entry in the UI shows an
  indicator dot.
- FR-5: On the Admin page, when a newer version is available, the admin sees a message saying a
  newer version is available, with the newer version number and a link to that release.
- FR-6: Non-admin users see neither the dot nor the message.
- FR-7: The dot and the message stay until the server is upgraded to the latest release (or newer);
  opening the Admin page does not dismiss them.
- FR-8: If GitHub cannot be reached, nothing is shown — no dot, no message, no error.

## Non-Functional Requirements

- Offline first: in a network-isolated installation the failed check must be silent — no errors
  shown to users, no retries flooding the log, no effect on any other functionality.
- The check runs on the server, not in each browser, so GitHub is contacted at most once a day per
  installation.

## Acceptance Criteria

- [ ] AC-1 (FR-1, FR-1b): On a deployment not made from a GitHub release (dev run, local build,
      `build.origin.json` missing or with `officialRelease: false`), no check is performed and no
      dot/message appears.
- [ ] AC-1a (FR-1a): An image built by `release.yml` contains `dist/build.origin.json` with the
      release branch, the release version and `officialRelease: true`; a local `npm run build` /
      `docker build` produces the file with `officialRelease: false`.
- [ ] AC-1b (FR-1c): Hovering the top-nav build label shows branch, version, build time, official
      release yes/no and commit; on a server without `build.origin.json` the tooltip shows only the
      commit/version available today, with no empty or "undefined" rows.
- [ ] AC-2 (FR-2): Within 24 h after a successful check, GitHub is not contacted again, including
      across page reloads by any number of users.
- [ ] AC-3 (FR-3): Running version equal to or newer than the latest release → no "newer version"
      state; older → "newer version" state.
- [ ] AC-4 (FR-4): An admin sees the dot on the Admin entry when a newer release exists, and no dot
      when the server is up to date.
- [ ] AC-5 (FR-5): The Admin page shows "a newer version is available" with the version number and
      a working link to that GitHub release.
- [ ] AC-6 (FR-6): A non-admin user sees no dot and no message in the same situation.
- [ ] AC-7 (FR-7): After the admin opens the Admin page the dot is still shown; after the server is
      upgraded to the latest release the dot and the message are gone.
- [ ] AC-8 (FR-8, NFR offline): With GitHub unreachable, the app works normally and shows no dot,
      message or error.

## Common sense considerations

- `build.origin.json` shape: `{ "branch": string, "version": string, "builtAt": string, "officialRelease": boolean }`; `builtAt` is ISO 8601 UTC taken when the file is written; unknown values are `"unknown"`.
- The tooltip shows `builtAt` in the viewer's local time and uses the project's existing `Tooltip` component instead of the native `title`.
- The tooltip data comes from the public `GET /health/version`, extended additively with an optional `origin` object (`branch`, `version`, `builtAt`, `officialRelease`); `version` and `gitCommit` stay as they are, and a client that gets no `origin` falls back to today's tooltip. The contract registry row for the route is updated.
- In the Docker image the values come from new build-args (`GIT_BRANCH`, `OFFICIAL_RELEASE`, default `unknown` / `false`, since `.git` is not in the build context) plus the existing `VERSION`; only `release.yml` passes `GIT_BRANCH=${{ github.ref_name }}` and `OFFICIAL_RELEASE=true`.
- A local `npm run build` writes the file too (branch from git, version from the root `package.json`, `officialRelease: false`).
- The check also requires the running `version` to be a strict `X.Y.Z`; otherwise it is skipped even with `officialRelease: true`.
- The `build.origin.json` file itself is not served over HTTP (it lives outside `dist/public/`); its fields reach the client only through `/health/version`. The existing `build-info.json` stays unchanged.
- Older images have no `build.origin.json` and are treated as non-official.
- The latest release comes from `GET https://api.github.com/repos/DataArt/artisyn-log-hub/releases/latest` (drafts and pre-releases excluded); its `tag_name` must be a strict `vX.Y.Z` (the release-pipeline tag rule), otherwise no "newer version" state.
- The version comparison reuses `server/src/common/semver.ts`; the link is the release's `html_url`.
- The result is stored in the DB and the check uses the same cluster-safe claim pattern as the `ai-tool-versions` / `model-pricing` schedulers, so only one worker contacts GitHub per installation.
- At most one GitHub attempt per 24 h regardless of outcome; a failed attempt logs one `warn` line and keeps the previous stored result untouched (a never-successful check shows nothing).
- An env flag in the style of `AI_TOOL_VERSION_CHECK_ENABLED` (only literal `false` disables) is added for the contract and scenario stands; there is no UI setting.
- "Admin" means `role === 'admin'`; team owners, who also see the Admin Panel entry, get neither the dot nor the message.
- The release state is served by an admin-only endpoint (403 for anyone else), so FR-6 is enforced on the server, not only hidden in the UI.
- The dot is shown on the Admin Panel entry in both the collapsed and the expanded left nav (`AppLeftNav.tsx`).
- The message is a banner at the top of the Admin page, above the tabs, visible on every tab.
- The outbound `api.github.com` dependency is documented next to the other outbound calls in `docs/knowledgebase/system-info-and-cluster.md`.

## Open Questions

None.

## Notes

<!-- Append timestamped notes here as work progresses -->
- 2026-11-04 — user answers: the dot disappears only when the server is upgraded; if GitHub is
  unreachable nothing is shown; a "release" is what the repo's GitHub page shows as a release
  (GitHub Releases). No on/off switch was asked for.
