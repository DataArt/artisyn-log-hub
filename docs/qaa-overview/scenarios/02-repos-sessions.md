# Scenarios: Repositories and Sessions (REPOS / SESSIONS / HOOK-STATE / navigation)

## Group scope

- The repository list (personal and team), the repo summary, URL normalization and deduplication.
- Repo settings: file categories, the cache threshold, session attributes, team versus personal override.
- Zip export and import (scope `all` / `dateRange` / `sessionIds`, "the longer one wins" conflicts, bootstrap import), statistics export and Recompute.
- The session list (branches, user, hook sessions, attributes, order, auto-refresh), favorites, deletion, retention.
- Session tree metrics (root versus tree).
- The "Installed Hooks" page, the issues badge, outdated, the upgrade command.
- The left navigation, hash routing and deep links, the data-collection consent gate where it affects these screens.

The group has no dead features or features hidden behind a flag. Retention auto-deletion has no admin UI (the closed task admin-data-retention-tab is mentioned in the KB as "not implemented yet", although `AdminDataRetentionTab.tsx` exists in the code; the retention scenario is built on the API, and we do not touch the admin UI, which is the ADMIN area).

Cross-cutting assumptions (checked by reading the code):
- Seeding: `seedRepoWithSessions` (`tests/e2e/helpers/seed.ts`) sends real `POST /api/v1/logs` with an API key; it supports `subAgents`, `artisynEvents` (including `hook-status`), `claudeEvents`, `daysAgo`, `branch`, `role`.
- Roles: `owner` (also admin, `muaddib@arrakis.test`), `regular`, `nonowner` (`tests/e2e/helpers/credentials.ts`).
- UI: a hash router, paths `#/repos/:id`, `#/teams/:tid/repos/:rid`, `#/repos/:id/hook-state`, `#/api-keys`, `#/admin`; an unknown route goes to `/main`.
- The session delete button is labelled "Remove", the dialog is "Remove Session?", the confirmation is "Delete"; the button is visible only to the owner and admin (`SessionDetailPane.tsx`).
- Repo settings tabs: Display, File Categories, Analysis, Session Attributes, Maintenance, Import/Export.

## Scenario table

| ID | Title | Layer | Priority | Old tests replaced (approx.) |
|---|---|---|---|---|
| S-REPO-01 | One project with different remote URLs is one repository record | API | P0 | 30 |
| S-REPO-02 | Left panel: personal and team repositories, expanding, deep link, 404 | UI | P1 | 28 |
| S-REPO-03 | Repo summary and the access boundaries to someone else's repo | API | P0 | 22 |
| S-REPO-04 | Deep links and the hash router: reload, back/forward, unknown route, admin route | UI | P1 | 14 |
| S-REPO-05 | The data-collection consent gate also blocks a repo deep link | UI+API | P0 | 13 |
| S-REPO-06 | File categories: add, see in the session and in analytics, delete, bad values | UI+API | P1 | 25 |
| S-REPO-07 | Team versus personal settings; a non-owner of the team cannot write | API | P0 | 14 |
| S-REPO-08 | Analysis and attributes: cache threshold, validation, read-only for a non-owner | UI+API | P2 | 55 |
| S-REPO-09 | Exporting a whole repo to zip and importing it into another repo through the UI | UI | P0 | 16 |
| S-REPO-10 | Export by date range and by session list: exactly the right set; broken archives | API | P1 | 24 |
| S-REPO-11 | Import: conflicts (longer overwrites, shorter does not), bootstrap import, the author is kept, foreign sessions/authors/parents block the import (409) | API | P0 | 10 |
| S-REPO-12 | Export and import: who is not allowed (outsider, non-owner of the team, someone else's job) | API | P0 | 8 |
| S-REPO-13 | Statistics export and "Recompute all sessions" | UI+API | P2 | 18 |
| S-REPO-14 | The team config is one record per (team, URL) and lives together with the link | API | P0 | 0 |
| S-REPO-15 | Two teams on one URL: `teamId` picks the team, without it the lowest id wins | API | P0 | 0 |
| S-REPO-16 | Team analytics is computed with the team config for the sessions of all members | UI+API | P0 | 0 |
| S-SLIFE-01 | Session list: order, fields, hidden sessions, grouping, auto-refresh | UI+API | P1 | 35 |
| S-SLIFE-02 | Branches: the counters match the list, an empty branch, the filter | UI+API | P1 | 16 |
| S-SLIFE-03 | Other people's sessions in a personal repo and hook sessions: filters and the "hidden" banner | UI | P1 | 24 |
| S-SLIFE-04 | Filter by session attribute | API+UI | P2 | 20 |
| S-SLIFE-05 | Favorites: the star, reload, isolation between users, team | UI+API | P1 | 16 |
| S-SLIFE-06 | The owner deletes a session from the UI; an outsider, and a repeated upload | UI+API | P0 | 8 |
| S-SLIFE-07 | Deleting a root cascades to sub-agents and grandchildren, data and contexts | API | P0 | 6 |
| S-SLIFE-08 | Retention: an old session with its tree disappears, a young and a soft-deleted one do not | API | P0 | 22 |
| S-SLIFE-09 | Tree metrics: root versus tree for lines, cost, time | UI+API | P0 | 22 |
| S-SLIFE-10 | Team session visibility: transparent, restricted, raw logs only for the owner | API | P0 | 18 |
| S-HSTATE-01 | Hooks are installed: menu, issues, state page, upgrade command | UI+API | P1 | 20 |
| S-HSTATE-02 | A hook upgrade clears the problems; an upload without a status does not erase them | API+UI | P1 | 10 |
| S-HSTATE-03 | Hook state: other people's repos, 401/403/404, list filtering | API | P0 | 9 |

Total: 26 scenarios (P0: 13, P1: 10, P2: 3), replacing about 500 old tests (with overlaps between scenarios, see each section).

Count by priority: P0 = REPO-01, 03, 05, 07, 09, 11, 12, SESS-06, 07, 08, 09, 10, HOOK-03 (13); P1 = REPO-02, 04, 06, 10, SESS-01, 02, 03, 05, HOOK-01, 02 (10); P2 = REPO-08, 13, SESS-04 (3).

---

## Repositories

### S-REPO-01. One project uploaded with different remote URLs is seen as one repository
- **Layer:** API
- **Priority:** P0
- **Data/roles:** user `regular` with an API key (created through `POST /api/v1/api-keys`). A unique run suffix `RUN` in the project name, to avoid conflicts.
- **Steps:**
  1. For sessions S1..S6 send `POST /api/v1/logs?sessionId=Sn&type=artisyn` (+ `type=claude`) with `git.repo` in the first line of the artisyn log: (S1) `git@github.com:acme/proj-RUN.git`, (S2) `https://github.com/acme/proj-RUN`, (S3) `https://github.com/acme/proj-RUN.git`, (S4) `http://GitHub.com/acme/proj-RUN/`, (S5) `https://user:token@github.com/acme/proj-RUN.git`, (S6) `git@gitlab.corp.example:grp/other-RUN.git` (a different project).
  2. `GET /api/v1/repositories` as `regular`.
  3. `GET /api/v1/repositories/:id/summary` for the repo of project `proj-RUN`.
  4. `GET /api/v1/repositories/:id/sessions`.
  5. Repeat the S1 upload with the same body (dedupe).
  6. Upload session S7 with `git.repo` = `git@dev.azure.com:v3/org/proj/repo` and session S8 with no remote (a bare path `C:\work\x`); check that both create separate records and the server does not crash.
- **Check:**
  - The list has exactly 2 repos with `RUN` (proj-RUN and other-RUN) plus the S7 and S8 records; for proj-RUN `repoUrl === 'https://github.com/acme/proj-RUN'` (lower-case host, no `.git`, no `/`, no login and token, https).
  - `summary.sessionCount === 5` (S1..S5), `userCount === 1`; the session list holds all 5 ids.
  - Uploading S1 again creates neither a second repo nor a duplicate session (`sessionCount` is still 5).
  - Azure SSH becomes `https://dev.azure.com/...`; `repoUrl` never contains `token`.
  - A bare Windows path does not crash `POST /logs` (201) and is not merged with the others.
- **Replaces:** `server/src/logs/repo-url-normalizer.spec.ts` (21 tests, all except the degenerate ones), `server/test/repo-backfill.spec.ts` (8; except "DI wiring", see "What we lose"); the repo fragments of `server/test/logs.e2e-spec.ts`; the normalization block of `repositories.service.spec` (not counted).
- **What we lose:** the unit combinations (legacy `vs-ssh.visualstudio.com`, `git://`, self-hosted Gitea, the function's idempotency): this is a pure function, and it is cheap and sensible to keep ONE compact table-driven unit test (the owner decides, but a 10-row table is better than 21 tests). The backfill migration of legacy data (question G4 to the owner): not needed for a clean install, not covered. A bare Windows path (`C:\work\x`) gives `https://work/...` (question G15): the scenario does not pin the result, only "does not crash".

### S-REPO-02. The left panel shows personal and team repositories, and you can navigate through them
- **Layer:** UI
- **Priority:** P1
- **Data/roles:** `owner` with two personal repos (A: 3 sessions, B: 1 session) and an empty repo C (created through import, it has 0 logs); team `Team-X` (owner) with repo A in `team_repositories` and a second repo D without sessions; `regular` is a member of Team-X.
- **Steps:**
  1. As `owner` open `/#/main`: "Select an item from the left panel" is visible.
  2. In the left panel expand the "My Repos" section: check the 3 rows (A, B, C), collapse and expand.
  3. Expand `Team-X`: the repositories load on expand (the request `GET /teams/:id/repositories` is not sent while the team is collapsed). A and D are visible.
  4. Click A in "My Repos": the URL becomes `#/repos/<A>`, the header shows the repo URL, "3 sessions", "1 user" (no "Private repo view" badge — removed by 2026-10-21-private-repo-visibility); row A is highlighted.
  5. Click A inside `Team-X`: URL `#/teams/<tid>/repos/<A>`, the row is highlighted in the team.
  6. Click B: the session list and the selection are reset (the selected session of A does not stay).
  7. Type `#/repos/999999999` by hand: a page with the "not found / no access" state, the left panel stays alive.
  8. As `regular` open `#/teams/<tid>/repos/<A>`: they see the session list according to the team mode (details in S-SLIFE-10); this repo is not in their "My Repos".
  9. Browser back/forward moves between A and B.
- **Check:** the numbers in the header (3 / 1), C is in "My Repos" despite 0 logs (the owner sees their repo), D shows "0 sessions", the badge only on the personal route, the 404 state for a non-existent id, the active row highlight, the team expands lazily, `regular` does not have someone else's personal repo in the list.
- **Replaces:** `tests/e2e/repo-panel.spec.ts` (Repository View personal/team route, Left nav Team Repos, My Repos, back/forward, switching repos: 12 tests of 16, except three about favorites and two about Charts); `client/.../AppLeftNav.test.tsx` (7); the "ownership visibility" block of `server/test/repositories.e2e-spec.ts` (1); the GET branch of `team-repositories.e2e-spec.ts` (6); part of `repository-view.test.tsx` (about 5 tests on the header and states).
- **What we lose:** the AppLeftNav unit combinations (collapsed icon mode, scrolling to the active item): cosmetics. The "Loading session list" and "a background refresh error does not wipe the list" states (repository-view.test, ~6 tests) are not covered: these are toasts, and the maintenance cost is high.

### S-REPO-03. The repo summary is correct, and someone else's repo is off limits
- **Layer:** API
- **Priority:** P0
- **Modes:** A and C. The expectations depend on the mode: in mode A (`AUTH_MODE=none`) the import does not create placeholder users and reassigns all logs of an imported session to the importer.
- **Data/roles:** `owner` with repo A (3 sessions: 2 by owner, 1 imported with the author `ghost@example.com`: in mode C it becomes a placeholder user → `userCount` 2; in mode A the session is reassigned to `owner` → `userCount` 1); `nonowner`; `regular` is a member of team `Team-X` with repo A; repo E without logs; repo `F` not added to the team.
- **Steps:**
  1. `owner`: `GET /api/v1/repositories/:A/summary` → `sessionCount`, `userCount`.
  2. `owner`: `GET .../:E/summary`.
  3. `nonowner`: `GET /api/v1/repositories/:A/summary`, `/sessions`, `/contexts`, `/settings`, `/hook-state` (403 each).
  4. `nonowner`: `GET /api/v1/repositories/999999999/summary` → 404.
  5. `owner`: `GET .../:A/summary?teamId=0` and `?teamId=-1` → 400.
  6. `regular` (member): `GET .../:A/summary?teamId=<Team-X>` → 200 with the numbers of the whole team, without teamId → 403. `regular` uploads 2 sessions into their own row of the same URL: the team `summary` for both and through either row is the sum of all members' rows (5 sessions; 3 authors in mode C and 2 in mode A; with no narrowing by access mode); the personal `summary` is only one's own row.
  7. `nonowner` (not a member): `?teamId=<Team-X>` → 403.
  8. `owner`: `?teamId=<Team-X>` for repo F, which is not added to the team → 403.
  9. Without a cookie: every request → 401.
  10. `GET /api/v1/repositories` for `nonowner`: A is absent; for `owner`: E is present (0 logs).
- **Check:** A: `sessionCount 3`, `userCount 2` in mode C and `1` in mode A (steps 1 and 6, personal view); team totals `{ 5, 3 }` in mode C and `{ 5, 2 }` in mode A; E: both 0; the codes 401/403/404/400 strictly as above; the 403 body has no repo data.
- **Replaces:** `server/test/repositories.e2e-spec.ts` (10), the access part of `repo-details.e2e-spec.ts` (~6: repo contexts, 403/404), "another user cannot access" in `repo-settings.e2e-spec.ts` (1), the 403 branches of `session-stats-export` on someone else's repo (2), the 401/403/404 branches of `sessions.e2e-spec.ts` for `/sessions`, `/sessions/ids`, `/sessions/branches` (~9) and `teamId validation` (2 of 44).
- **What we lose:** one 401/403 for each of ~30 endpoints (question G21): we check access to someone else's repo on 5 typical routes, not on all of them. The others share one guard (`assertRepoAccess`), the risk is low.

### S-REPO-04. Deep link and hash router: a session link survives a reload, an unknown route goes to main
- **Layer:** UI
- **Priority:** P1
- **Data/roles:** `owner` with repo A (2 sessions, the second has a sub-agent); `regular` (not admin); an unauthenticated browser.
- **Steps:**
  1. Without logging in open `/#/repos/<A>`: redirect to `#/login`. Log in as `owner`: after login we come back to `#/repos/<A>` (saved `from`).
  2. In the repo select the second session, tab "Info": the URL contains the selected session and `tab=info` (search parameters inside the hash).
  3. `F5`: the same session, the same tab, the same repo are open.
  4. Copy the URL and open it in a new tab of the same user: identical state.
  5. Back returns to the previous state (for example, the Analytics tab), forward returns to the session. Switching tabs does not litter the history: `replace`.
  6. Type `/#/nonexistent/path`: it goes to `#/main`.
  7. As `regular` open `/#/admin`: redirect to `#/main`, the left panel has no "Admin Panel" link. As `owner` the link is there and `#/admin` opens.
  8. An API call that returns 401 (an expired session: delete the cookie and click a repo): redirect to `#/login`; whereas a 403 (someone else's repo `/#/repos/<foreign>`) does NOT kick you out to the login page, it shows "No access".
- **Check:** the URL values after each step, the selected session and tab after reload, the redirects, the different behaviour of 401 versus 403, the admin link visibility by role.
- **Replaces:** `tests/e2e/auth-guard.spec.ts` (2 tests 401/403; keep the third, keep-alive, separately or in PLATFORM), `repo-panel.spec.ts` "Back/forward" (2) and "clicking a session shows detail" (1), the `AdminGuard`/routing tests of `repository-view.test.tsx` on the tab in the URL (~5), the `useRepositoryViewState` tests if any, `MainNav.test.tsx` 10 tests (half each: logout, email), the non-admin redirect check of `admin-panel.spec` (not counted, ADMIN area).
- **What we lose:** keep-alive (`use-keep-alive`, question G23) is not covered by the scenario: the auth session is not part of this group. Lazy loading of chunks (code splitting) is not checked separately; a breakage is visible at once in every scenario.

### S-REPO-05. Until the user accepts data collection, they see neither the application nor the repositories
- **Layer:** UI+API
- **Priority:** P0
- **Data/roles:** a new user `consent-RUN@example.com` (registered through the API, with no `dataCollectionNotice` record); they already have a repo R (created through an API key and a session upload), so that the deep link leads to a real page.
- **Steps:**
  1. Log in as the new user and open `/#/repos/<R>`: the consent screen is shown (`data-collection-consent-screen`), with no top or left navigation under it, no session list, and the network log has no `/repositories/<R>/sessions` requests (data requests are not sent).
  2. Repeat for `/#/api-keys`, `/#/teams`, `/#/main`, `/#/repos/<R>/hook-state`: the same screen everywhere.
  3. The text says: "Stored session data is purged after N days", where N equals `GET /api/v1/sessions/retention-days` (30 by default), with no `{{RETENTION_DAYS}}`; there is a warning about secrets ("If the assistant handles secrets").
  4. `GET /api/v1/repositories` through the API by the same user returns 200 (server ingest and the API are not blocked by consent, the block is only in the UI; record this in the scenario as documented behaviour).
  5. Click "I understand and accept": the screen disappears, repo R is visible in the left panel.
  6. `F5`: the consent screen does not come back; log out and in again: it does not come back.
  7. (Nudge) Another new user without repos and teams lands on `#/api-keys` once per browser session after accepting.
- **Check:** no navigation and no data requests before consent, N in the text equals the API value, consent persists, the new-user nudge.
- **Replaces:** `tests/e2e/data-collection-consent.spec.ts` (3), `client/.../data-collection-consent-screen.test.tsx` (10, optionally keeping 1 on the placeholder substitution), the notice part of `server/test/user-settings.e2e-spec.ts` (not counted, PLATFORM/AUTH area, agree with the owner of that group).
- **What we lose:** asking again when the notice text changes (the hash, `notice-hash.ts`) is not checked; decide whether a separate scenario is needed in the AUTH group.

### S-REPO-06. Custom file categories: added, seen in the session and in analytics, deleted, bad values are rejected
- **Layer:** UI+API
- **Priority:** P1
- **Data/roles:** `owner`, repo A with two sessions: the first has Read/Edit for `src/a.ts`, `docs/guide.md`, `img/logo.png`; the second `test/a.test.ts`.
- **Steps:**
  1. `GET /api/v1/repositories/:A/settings`: the default categories (including `docs`, `tests` or the actual names from `DEFAULT_FILE_CATEGORIES`), no user override.
  2. UI: Settings → File Categories: add category `png_files` with the pattern `\.png$`, Save.
  3. Open the first session, the Logs tab: the turn's file section has "Png_files" with `logo.png`.
  4. Analytics → Files: category `png_files` is present, count `1`.
  5. Go back to Settings, delete the override (Delete override / reset): Analytics → Files has no `png_files`, Logs has no "Png_files"; the files are back in the default categories.
  6. API: `PUT .../settings/user` with an empty category name → 400; with the pattern `([` → 400; with two identical names → 400; with `null` → 200 (deletes the override).
  7. After Save check that `session_file_stats` were recomputed (seen as the number of files in the category in the analytics API: `analytics/timeline` or `analytics/...files`).
  8. `nonowner` tries `GET/PUT .../settings/user` of someone else's repo → 403.
- **Check:** the category name and count on three screens before and after deletion; 400 for three kinds of bad input; 403 for an outsider.
- **Replaces:** `tests/e2e/repo-file-categories.spec.ts` (3), `server/test/repo-settings.e2e-spec.ts` (11 without the team branch, see S-REPO-07), `client/.../RepositorySettings.test.tsx` (5), the `classifyFile` fragments of `claude-extractor.spec.ts` (not counted).
- **What we lose:** the regexp subtleties (case, `^`/`$`) and the classification order stay with the `classifyFile` unit test (keep it as is; it is a pure function outside the group).

### S-REPO-07. Team settings apply to all its members in the team view, personal ones override them only in the personal view; a non-owner of the team cannot write
- **Layer:** API
- **Priority:** P0
- **Modes:** A, B, C (the bug 2026-10-16-team-vs-personal-config showed up only in C).
- **Data/roles:** `owner` (owner of team `Team-X`, transparent), `regular` (member), `nonowner` (not in the team), `otherOwner` (owner of another team), `admin`. All four uploaded a session to one URL (each has their own `repositories` row); the URL is added to `Team-X`.
- **Steps:**
  1. `regular`: `PUT .../settings/team` on their own row, on the owner's row and with `?teamId=<Team-X>` → 403 "Only the team owner can edit team config".
  2. `owner`: `PUT .../settings/team?teamId=<Team-X>` `{ team_docs: '^docs/', 55 000 }` → 200; the `userConfig` of both members stayed `null` (AC-3); the DB has exactly one `team_repo_config` row for the link.
  3. `regular`: `GET .../settings?teamId=<Team-X>`: `team_docs`, `teamId`, `canEditTeamConfig = false`; `cache-read-ratio?teamId` → 55 000 / `team`.
  4. `owner`: `PUT .../settings/user` `{ my_cat, 70 000 }`: in the personal view owner has `my_cat`, in the team view `team_docs`; `teamConfig` is unchanged for both (AC-3).
  5. Threshold (AC-2): with `teamId` owner gets 55 000 / `team` (the personal one is ignored), without `teamId` 70 000 / `user`; `regular` gets 55 000 / `team` in both views; after the personal one is deleted, owner without `teamId` gets 55 000 / `team`.
  6. AC-13: `regular` saves their own `member_cat`; `GET .../settings?teamId` on the owner's row returns `userConfig = member_cat`; `nonowner` with `?teamId` → 403; `?teamId=0` → 400; `regular` `PUT settings/team?teamId` on the owner's row → 403; `admin` `GET settings?teamId` → 200.
  7. AC-11: `owner` `PUT settings/team?teamId` with `null` → `teamConfig = null`, 0 rows in `team_repo_config`, the team `effectiveConfig` = the default (`knowledgebase`, `docs`), threshold `default` for both; a repeated `addTeamRepo` does not seed.
  8. `otherOwner` (owns another team without this URL): `PUT .../settings/team` → 403.
  9. `nonowner`: `PUT .../settings/team` → 403 on their own row and on the owner's row.
- **Check:** 403/400 in items 1, 6, 8, 9; the values of `team_docs`, `thresholdSource` per view; the override does not leak into the team view; one team config record.
- **Replaces:** the team branch of `repo-settings.e2e-spec.ts` (1), `team-repo-config.e2e-spec.ts` (1), part of `repositories.service.spec.ts` (`getEffectiveCacheThreshold` ~6 tests), none from `team-access-mode`; it closes gap F.1 #8.
- **What we lose:** the mock-DB parsing in `repositories.service.spec` (a unit test with mocks; low value).

### S-REPO-08. Analysis and attribute settings: the cache threshold survives a reload, bad values are rejected, a non-owner sees them read-only
- **Layer:** UI+API
- **Priority:** P2
- **Data/roles:** `owner` with repo A in `Team-X`; `regular` is a member.
- **Steps:**
  1. Settings → Analysis: enter 42 in the "High cache-creation" field, Save, `F5`: the value is 42. Enter 150 and -1: Save is blocked (the button is disabled), API `PUT .../settings/user` with 150 → 400.
  2. Settings → Session Attributes: add attribute `jira_ticket` (label "Jira", prompt "Ticket id", type string), Save, reload: saved. Try to rename the key of a saved attribute: not allowed.
  3. Add a duplicate key, the key `Bad Key!`, a 13th attribute (more than 12 in total), a 61-character label, a 1001-character prompt: Save is blocked for each, the API answers 400.
  4. Enable the Advisor and Attribute Extraction settings (if the tab has switches for them), Save, reload: the state is kept.
  5. `PUT .../settings/user` with `sessionAttribution` in the personal config → rejected (the personal config does not accept it).
  6. As `regular` in `Team-X`: everything on the Session Attributes tab is read-only, the caption says "Managed by team owner", there is no Save button.
- **Check:** the values after reload, 400/blocking for each rule, read-only for a non-owner.
- **Replaces:** `tests/e2e/cache-read-ratio.spec.ts` (2), `SessionAttributionSettings.test.tsx` (13), `repositories.service.spec.ts` `validateConfig` (~35 of 44); it closes gap F.3 #26.
- **What we lose:** each of the 35 `validateConfig` cases individually (changing the type of a saved key, edge values of `minSessionCostUsd`): we take one representative per rule. If the edge matters to the owner, keep `validateConfig` as one table-driven unit test.

### S-REPO-09. The owner exports a repo to zip and imports the archive into another repo through the UI
- **Layer:** UI
- **Priority:** P0
- **Data/roles:** `owner`; repo A with 3 sessions (branches `main`, `feat/x`, one has a sub-agent; prompts "Fix login", "Add export", "Refactor db"); an empty repo B (created by a separate seed with 1 session "Other"); `regular` is a non-owner member of team `Team-X` with repo A.
- **Steps:**
  1. `owner` → repo A → Settings → Import/Export: the mode switch, scope "All". A preview is visible: "3 sessions" and an approximate size.
  2. "Start export": a progress indicator, then "Export ready"; download the zip (download link); the file starts with `PK` and contains `meta.json`.
  3. Open repo B → Settings → Import/Export → choose the downloaded zip: the preview says "3 sessions in archive".
  4. "Import": "3 sessions imported".
  5. Repo B: the session list now holds 4 (Other + three), branches `main` and `feat/x` are present, the prompts "Fix login", "Add export", "Refactor db" are as they were (`firstPrompt`).
  6. Open the imported session with the sub-agent: the agent tree and the cost are the same as in A (checked against the API `GET .../analytics/timeline` of both repos: the `totalCost` values are equal).
  7. Import the same zip into B a second time: "0 imported / 3 skipped (identical)", or the same 4 sessions without duplicates (`sessionCount` stays 4).
  8. Log in as `regular` in the team: in `#/teams/<tid>/repos/<A>` → Settings → Import/Export it says "Only the repository owner can start an export.", and there is no "Start export" button.
- **Check:** the numbers 3/4, the prompts and branches, the identical cost, no duplicates on repeat, read-only mode for a non-owner.
- **Replaces:** `tests/e2e/repo-export-import.spec.ts` (4 tests: the round trip and three "visibility" ones), `client/.../ImportExportSection.test.tsx` (3), the test "preserves userId/gitBranch/firstPrompt across a full round trip" of `server/test/repository-export-import.spec.ts` (1); `session-stats-export` is not touched. About 8 really, 16 with the closest `ExportScopePicker`/`useExportImportJobPoll` unit tests.
- **What we lose:** the analysis of the 422 error state in `ImportExportSection.test` (pinned in S-REPO-10 by the step about a broken zip).

### S-REPO-10. Export by date range and by selected sessions returns exactly the right sessions; broken archives are rejected
- **Layer:** API
- **Priority:** P1
- **Data/roles:** `owner`, repo A with 5 sessions: S1 (10 days ago, `main`), S2 (5 days), S3 (5 days, branch `x`), S4 (1 day), S5 (today); empty repos B1, B2, B3 of the same owner. For the broken zip archives: files built by a NodeJS script (no python) with `yazl`/`archiver` or from ready-made bytes.
- **Steps:**
  1. `GET /repositories/:A/export-import/scope?scope=all` → `sessionCount 5`.
  2. `...?scope=dateRange&from=<-6d>&to=<-4d>` → `sessionCount 2` (S2, S3). Without `from`/`to` with `scope=dateRange` → 400.
  3. `...?scope=sessionIds&sessionIds=S1,S4` → 2; without `sessionIds` → 400.
  4. `POST /repositories/:A/export` with `scope=dateRange` (the same range) → 202 `{ jobId }`; poll `GET .../export/:jobId/status` until `done` (processed = total = 2); `download` while `running` → 409.
  5. Download the zip and upload it to B1: `POST .../import/upload` → preview, `confirm` → job `done`: B1 holds exactly S2 and S3. The same for `sessionIds` → B2 holds exactly S1 and S4.
  6. Broken archives into B3: a zip without `meta.json`, a zip with a wrong `meta.json` version, a zip with broken JSON, a zip with a file `../evil`, a zip with the absolute paths `/etc/passwd` and `C:/x`: each `POST .../import/upload` → 4xx (422) with a clear text; B3 stays empty.
  7. In parallel with an export (with 30+ sessions), a plain `GET /api/v1/repositories` answers quickly (it is not blocked).
- **Check:** strictly the sets S2,S3 and S1,S4 in the target repos; 400/409/422 as described; B3 has no side files outside its folder (zip-slip).
- **Replaces:** `server/src/logs/export-import-zip.spec.ts` (7), `repository-export-import.service.spec.ts` (14, except the pure mock logic), the tests "download 409" and "concurrent request resolves promptly" of `repository-export-import.spec.ts` (2); it closes gap F.2 #19.
- **What we lose:** the internal batching (`EXPORT_IMPORT_CHUNK_SIZE=25`) and the details of the `session.json` format: checked indirectly through the round trip. The cleanup scheduler of old export jobs (F.2 #17) is not covered either: raise it as a separate question to the owner.

### S-REPO-11. Import: a session conflict is resolved by "the longer one wins"; bootstrap import creates a repo and a team; the import does not touch other people's data
- **Layer:** API
- **Priority:** P0
- **Modes:** A and C. In mode A (`AUTH_MODE=none`) there are no ownership checks, and all logs of imported sessions are reassigned to the importer; in mode C any conflict (`foreign-session`, `foreign-author`, `foreign-parent`) blocks the whole import with `409`.
- **Data/roles:** `owner` and `regular`. The owner's repo A with session S1 (3 turns). Archive Z1 from A (export).
- **Steps:**
  1. In A upload 2 more turns into S1 (`POST /logs` with a longer log), export → archive Z2 (S1 with 5 turns).
  2. Import Z1 (the short version) into A: S1 in A keeps 5 turns, "skipped/unchanged".
  3. Create repo B with S1 at 3 turns (imported from Z1); import Z2 into B: S1 in B is updated to 5 turns ("overwritten").
  4. Import Z2 into B once more: no changes (an equal length does not overwrite).
  5. An archive with an author who does not exist in the system (`userEmail=ghost@example.com`):
     - mode C: after the import the session's `userEmail` is ghost, a placeholder user is created in the DB, the repo's `owner` is the importer; `GET /repositories` for `owner` shows the repo;
     - mode A: there is no `users` row for ghost, the session has `userId = owner.id` and `userEmail = owner.email` (the import reassigns the logs to the importer).
  6. Bootstrap: `POST /repositories/bootstrap-import/upload` (without an existing repo) with archive Z1 → `confirm`: a personal repo named `meta.sourceRepoUrl` is created and the sessions are linked to it; a repeated bootstrap of the same archive uses the same repo (it does not create a second one).
  7. `regular` does a bootstrap import of a fresh archive with the session `r11-<run>-reg` of their own authorship under the same `repoUrl`: a new repo is created, it is reused on a repeat, and the team gets a name with the suffix "(2)" (both modes). Then `regular` uploads archive Z1 (S1, author `owner`) through bootstrap upload:
     - mode C: `409`, `conflicts` holds `{S1,'foreign-session'}` and `{S1,'foreign-author'}`; the S1 logs did not change, the S1 `logs.user_id` is still `owner`;
     - mode A: `201`, the import completes, all `logs` rows of S1 get `user_id = regular.id`.
  8. Another user (`regular`) tries `confirm` on someone else's uploadToken and `status` on someone else's job: 404/403.
  9. (C only, AC-1, through `:repoId/import`.) `regular` uploads a hand-made archive of 7 turns with id S1 and their own authorship into their repo: `409` with exactly `[{S1,'foreign-session'}]`; the S1 logs did not change, `logs.user_id` is `owner`; the S1 `sessions` row (`id`, `parent_session_id`, `workflow_run_id`) matches the snapshot; the `regular` repo has no S1.
  10. (C only, AC-4.) `regular` uploads an archive with `r11-<run>-race` of their own authorship (`201`); then `owner` uploads `r11-<run>-race` through the hook; `confirm` → `409`, a repeated `confirm` → `404` with the same `message`; `logs.user_id` stays `owner`.
  11. (C only, AC-5.) `regular` uploads an archive with a new session `r11-<run>-spoof`, author `owner.email`: `409` with `[{…,'foreign-author'}]`, no `sessions` row, the `users` count did not change.
  12. (C only, AC-6.) `regular` uploads an archive with a new session `r11-<run>-child` of their own authorship and `parentSessionId = S1`: `409` with `[{…,'foreign-parent'}]`, no `sessions` row for the child.
  13. (C only, FR-4.) `owner` imports into A a hand-made archive of S1 with 7 turns and the unknown author `r11-<run>-ghost2@arrakis.test`: the S1 claude log has 14 lines (keep-longer wrote it), all S1 `logs.user_id` are `owner.id`, there is no `users` row for this email.
  14. (C only, author normalization.) `regular` uploads a new session with the author `  OWNER.EMAIL ` (upper case and spaces around it): `409` with `foreign-author`.
  15. (Both modes, validation.) `regular` uploads an archive with two `session.json` for the same id: `422`.
  - Steps 2–4 (one's own keep-longer, AC-2) run in both modes. In mode A the bodies of steps 9–14 are skipped: `AUTH_MODE=none` has no ownership checks, and mode A is covered by step 7.
- **Check:** the S1 turn count in each case; the `userEmail` and `userId` of the imported sessions per mode; a single repo after the double bootstrap; the team name `Name (2)`; the refusal to an outsider; `409` with the exact `conflicts` list for each conflict type (`foreign-session`, `foreign-author`, `foreign-parent`) without changing other people's data; `404` with the kept message on a repeated `confirm`; `422` on a duplicate id.
- **Replaces:** `server/test/repository-export-import.spec.ts` (the remaining 7 of 8: "overwrites when longer", "leaves untouched when shorter or equal", "bootstrap import", "retries numbered suffix", "404 other user status"), part of `repository-export-import.service.spec.ts`.
- **What we lose:** nothing significant; the "(2)" suffix only for one collision case.

### S-REPO-12. Export and import are forbidden to anyone who is not the owner
- **Layer:** API
- **Priority:** P0
- **Data/roles:** `owner` (repo A, `Team-X` owner), `regular` (member of Team-X), `nonowner` (an outsider).
- **Steps:**
  1. `nonowner`: `POST /repositories/:A/export`, `GET .../export-import/scope`, `POST .../import/upload` → 403 each.
  2. `regular` (a team member, but not the owner): the same calls with `teamId` → 403 (the UI shows it as "Only the repository owner can ...", see S-REPO-09).
  3. `nonowner`: `GET .../export/<owner's jobId>/status` and `.../download` → 404/403 (the file does not leak).
  4. Without a cookie → 401 on all.
  5. `owner` with another user's `repoId` in the URL → 403.
  6. `GET /repositories/:A/sessions/export-scope` (statistics export) for `regular` and `nonowner`: 403, for the team owner: 200.
- **Check:** strictly 401/403/404, and that after the attempts no session appeared in A and no job file was created.
- **Replaces:** the UI part of the "non-owner member" test from `repo-export-import.spec.ts` (strengthens it at the API level), the 403 branches of `session-stats-export.e2e-spec.ts` (4); it closes the F-REPOS gap "a non-owner cannot start an export through the API".
- **What we lose:** nothing.

### S-REPO-13. Session statistics export and "Recompute all sessions"
- **Layer:** UI+API
- **Priority:** P2
- **Data/roles:** `owner`, repo A: S1 (yesterday), S2 (3 days ago, another author `ghost`), S3 (30 days ago); the `session_stats` row of S1 is wiped/distorted (through a soft corruption: a manual `POST /logs` of a short log, then the full one).
- **Steps:**
  1. UI: Settings → Maintenance (or the Session Statistics Export section) → choose the range "last 7 days" → list: S1 and S2.
  2. Filter by user `ghost` → only S2; by a user without sessions → 0 rows.
  3. Run the export (CSV/download): the file holds the columns `sessionId, firstPrompt, startTime, endTime, userEmail` for the selected sessions.
  4. API `GET .../sessions/export-scope?from=&to=` without `from` → 400, with a malformed date → 400, `teamId=0` → 400.
  5. "Recompute all sessions": the UI shows "Recomputed stats for 3 sessions.", `POST .../recompute-all-sessions` → `{ recomputed: 3 }`; the S1 tokens are restored from the stored log (checked against the `GET /sessions/:id/logs` usage before and after).
  6. `nonowner` on the same two routes → 403.
- **Check:** the row set, the filters, the message texts, the recomputed numbers.
- **Replaces:** `server/test/session-stats-export.e2e-spec.ts` (16), the `SessionExportSection`/`MaintenanceSection` unit tests if any (2).
- **What we lose:** the team branches (members without an acknowledge do not get into the export): check them in the TEAMS/Access mode group when moving.

### S-REPO-14. The team config is one record per (team, URL) pair, and it lives together with the team–repository link
- **Layer:** API
- **Priority:** P0
- **Modes:** A, C.
- **Data/roles:** each step has its own users and URL: `owner` (owner of a transparent team), members; `db` only counts the `team_repo_config` rows.
- **Steps:**
  1. FR-5 / AC-8: `owner` links to the team a URL that nobody has uploaded yet → exactly one `team_repo_config` row with `TEAM_CREATION_DEFAULT_CONFIG` (`docs`). `owner` uploads a session and saves `team_docs`; a member uploads the URL for the first time and sees `team_docs` with `?teamId`. AC-4: adding the URL again keeps `team_docs` and one row.
  2. AC-5: the same setup twice with the opposite order of the owner/member uploads (the `repositories` row ids are swapped) → the same `effectiveConfig` and threshold (55 000 / `team`) for both.
  3. AC-7: a third member uploaded the URL, and the config was saved through their `repoId`; they delete their account (`POST /api/v1/auth/delete-account`) → the config row is in place, owner and the member see `team_docs`.
  4. AC-10: with a second team (keeper) on the same URL: `unlink` → 0 rows for the link, the keeper's config is unchanged; linking again seeds `docs`, or the owner's personal config (`mine`) when there is one; `remove` and deleting the team → 0 rows for the link, the keeper is untouched.
- **Check:** the number of `team_repo_config` rows per link, the seeding, the independence from the row order, surviving an account deletion, the cascade by link.
- **Replaces:** nothing (new functionality from 2026-10-16-team-vs-personal-config).
- **What we lose:** migration 0072 is not tested (the owner's decision, AC-9 dropped).

### S-REPO-15. A user in two teams with one URL: `teamId` picks the team, without it the lowest id wins
- **Layer:** API
- **Priority:** P0
- **Modes:** A, C.
- **Data/roles:** `owner` owns T1 and T2 (T1 was created earlier and has the lower id), `member` and `second` are members of both; `t3Owner` owns T3, which also links the URL. Everyone uploaded a session to the URL.
- **Steps:**
  1. AC-12: `owner` `PUT settings/team` without `teamId` → T1 is written (`t1_cat`), T2 keeps the seeded `docs`.
  2. AC-12: `PUT settings/team?teamId=T2` → only T2 changes; `GET settings` and `GET :repoId` with `?teamId=T1`/`T2` for `member` return the config of that team.
  3. FR-13: without `teamId`, T1 wins for `member` in `GET settings`, `GET :repoId` and in the hook's `GET /api/v2/post-turn-analysis/config?repoUrl=&sessionId=` (API key; the response shape `{ advisor, attribution }` is unchanged, `advisor.fileCategories` = `t1_cat`).
  4. AC-1: `member` and `second` save different personal configs; each sees their own in the personal view; in the team view `member` sees T2's config.
  5. `t3Owner` `PUT settings/team?teamId=T1` → 403; they write their own T3 (200), T1 did not change.
- **Check:** the team choice by `teamId` for GET and PUT, the lowest-id rule, the hook response, the separation of personal configs, 403 for the owner of another team.
- **Replaces:** nothing (new functionality).
- **What we lose:** nothing.

### S-REPO-16. Team analytics is computed with the team config for the sessions of all members
- **Layer:** UI+API
- **Priority:** P0
- **Modes:** A.
- **Data/roles:** a transparent team (`owner` + `member`); both uploaded a session with `reads` of `docs/guide.md` and `src/app.ts`; the URL is linked to the team; `member` has the personal config `member_src` (`^src/`).
- **Steps:**
  1. Before saving, the team `analytics/timeline?teamId` for `member` shows the seeded `docs` for the sessions of both.
  2. AC-6 / FR-7: `owner` saves `team_docs` → in the team view `member` sees `team_docs` (without `docs`) for the sessions of both; `cache-read-ratio?teamId` gives 55 000 / `team`, `sessionsWithoutCauseData = 0`; the DB has team rows of `session_file_stats`/`session_cause_stats` for both sessions.
  3. The personal timeline of `member` does not change; the personal `cache-read-ratio` without `teamId` gives `sessionsWithoutCauseData = 0` (personal cause rows are always written).
  4. UI (FR-12): `member` opens `#/teams/<T>/repos/<R>?mtab=settings&stab=file-categories` → the first category is `team_docs`; in the personal `#/repos/<R>` it is `member_src`.
  5. FR-9: after `PUT settings/team?teamId` with `null`, the team timeline has the default categories (`docs`), not `team_docs`; the personal one did not change.
  6. "Recompute all sessions": the team statistics rows are deleted through `db` (simulating old data), `POST recompute-all-sessions?teamId` by owner (201) → the rows are back for both sessions.
- **Check:** the categories of the team timeline by the team config for other people's sessions, the threshold and the cause scope, the untouched personal view, the UI calls with `teamId`, the recompute.
- **Replaces:** nothing (new functionality).
- **What we lose:** nothing.

---

## Sessions

### S-SLIFE-01. A repo's session list: order, fields, hidden sessions, grouping, a new session appearing
- **Layer:** UI+API
- **Priority:** P1
- **Data/roles:** `owner`, repo A: S1 "Fix login" (branch `main`, ended 3 h ago), S2 "Add export" (`feat/x`, 1 h ago), S3 "Refactor db" (no branch, yesterday), S4 without a first prompt (only service events), S5 OTEL-only (only a `claude-otel` log, no claude/artisyn), S6 with a sub-agent "Subtask".
- **Steps:**
  1. `GET /api/v1/repositories/:A/sessions`: ordered by `COALESCE(endTime, updatedAt)` descending (S2, S1, S3), the row shape (`sessionId`, `firstPrompt`, `gitBranch`, `startTime`, `endTime`, `userEmail`, `isFavorite=false`, `cost`, `subagentStats` for S6).
  2. S4 and S5 are not in the list; `GET /sessions/ids` matches the list as a set; `GET /sessions/:S5` → 404, S5 does not get into an export (S-REPO-10).
  3. `?branch=main` → only S1; `?branch=` (empty) → only S3 (no branch); `?branch=nonexistent` → empty.
  4. UI: open repo A; in the grouping selector: "By branch" (the first branch expanded, the others collapsed), "By date" ("Today"/"Yesterday" sections or dates), "By user". In each grouping S1, S2, S3 are visible and S4, S5 are not.
  5. Click row S1: the detail with "Fix login" opens on the right; the tab does not jump to Advisor. The S6 detail shows "+sub-agents".
  6. Without closing the page, upload a new session S7 "Hot fix" through the API key: within the polling interval (15 s by default) a "new session" indicator appears, and after a refresh S7 is in the list; the selected session is not reset.
  7. Cut the network (by intercepting the request, `page.route` abort) for the next poll: the list is not cleared, an error toast is shown; once the network is back, the toast goes away.
- **Check:** the order, the exclusion of S4/S5, the branch filters, the first branch expanded, all three groupings, S7 appearing without a reload, the list holding up on a network error.
- **Replaces:** `server/test/sessions.e2e-spec.ts` (~15 tests of the `/sessions` and `/sessions/ids` block: shape, order, no-prompt, userEmail, branch ×3), `repo-details.e2e-spec.ts` (~12: contexts, `firstPrompt`/`gitBranch`/start/end, subagentStats), a fragment of `logs-otel.e2e-spec.ts` (1), `client/.../new-session-poll.test.ts` (4), `session-list-refresh.test.ts` (4), `use-open-branches.test.ts` (4), `session-item-advisor-badge.test.tsx` (2; the Advisor bulb is not covered, see "Not covered"), part of `repository-view.test.tsx` (~8).
- **What we lose:** "firstPrompt is chronologically first with mixed hook formats" (`repo-details`, 1 test) and all the old hook formats: a complex fixture case. If hook backward compatibility matters (per CLAUDE.md it does), keep 1 API test with two formats in the INGEST group. An invalid `VITE_SESSION_POLL_INTERVAL_MS` is not covered.

### S-SLIFE-02. Branches: the numbers in the selector match the list, an empty branch is visible, the filter narrows
- **Layer:** UI+API
- **Priority:** P1
- **Data/roles:** repo A: 3 sessions on `main`, 2 on `feat/x`, 1 without a branch; one session on `main` has a sub-agent.
- **Steps:**
  1. `GET .../sessions/branches`: 3 entries (`main`, `feat/x`, `null`), sorted by `latestEndTime` descending; `sessionCount` 3/2/1, `totalCost`, `totalLinesChanged`.
  2. For each branch `GET .../sessions?branch=...`: the list length equals `sessionCount` (a sub-agent is not counted as a separate session).
  3. UI "By branch": the branch headers show the same numbers; the branch without a name is labelled "(no branch)" or similar; it expands on click.
  4. Through `teamId` a team member gets the same set of branches (in transparent mode).
  5. Someone else's repo: 403; a non-existent id: 404.
- **Check:** 3/2/1 in the API and the UI at the same time, the branch order, equality with the filter.
- **Replaces:** the branches block of `sessions.e2e-spec.ts` (8 of 44 + 1 team branch) and partly `use-open-branches`, the "branch entries" tests of `team-cross-member-sessions` (2).
- **What we lose:** nothing.

### S-SLIFE-03. A personal repo shows "my sessions" by default; hook sessions can be hidden; a banner says what is hidden
- **Layer:** UI
- **Priority:** P1
- **Data/roles:** repo A of `owner`: 2 of their own sessions; 2 sessions imported as user `bob@example.com` (through S-REPO-11); 1 `owner` session is a hook-service one (the artisyn log has the `hook_service` event).
- **Steps:**
  1. Open A, grouping "By branch": the 2 own sessions and (unless hidden) the hook session are visible; the banner "2 sessions hidden — uploaded under bob@example.com (2)" and a "Show all" button.
  2. Click "Show all": bob's sessions appear, the banner disappears.
  3. Settings → Display: enable "Hide hook-service sessions": the hook session is gone from the list; `GET .../sessions/ids?hideHookSessions=true` matches the UI; reload: the checkbox stays on.
  4. "By user": shows everyone who uploaded (owner and bob), ignoring the email filter.
  5. API: `GET .../sessions/ids?filterByUserEmail=bob@example.com` → only bob's sessions.
- **Check:** the numbers in the banner (2 and "bob (2)"), the visible set after each action, the checkbox persisting.
- **Replaces:** `client/.../session-list-helpers.test.tsx` (27), the `/ids` tests of `sessions.e2e-spec.ts` on `hideHookSessions` and `filterByUserEmail` (2), part of `repository-view.test.tsx` (~5).
- **What we lose:** the attribute chips in the row and the edge combinations of filters (a unit table): represented in S-SLIFE-04.

### S-SLIFE-04. The session attribute filter narrows the list and the counters
- **Layer:** API+UI
- **Priority:** P2
- **Data/roles:** repo A; the settings have the attribute `jira_ticket` (string); 4 sessions: A=ABC-1, B=ABC-2, D=explicit null, C=no attribution. Attribution seeding: `POST /api/v2/session-attribution`, or an insert into `session_attribution` through a DB helper (see the question to the owner).
- **Steps:**
  1. API: `?attr=jira_ticket:eq:ABC-1` → only A, the field `attribution.values.jira_ticket='ABC-1'`; `?attr=jira_ticket:isnull` → D; `?attr=jira_ticket:unattributed` → C; two `attr=` for one key → A and B (OR).
  2. For the numeric attribute `sprint` (is/any/gte/lte): values 3, 5, 7 → `gte:5` gives 5 and 7, `lte:5` gives 3 and 5.
  3. A malformed operator/key → 400.
  4. UI: "Filter by attribute": the popup shows the values with counters "ABC-1 (1)", "ABC-2 (1)", "Not determined (2)"; choose ABC-2: the list = B, the branches and counters updated; remove the filter: 4 sessions.
  5. Cross-check: `analytics/timeline?attr=...` and `sessions/branches?attr=...` give the same numbers (the narrowing is uniform).
- **Check:** the sets for each operator, 400, the counters in the UI.
- **Replaces:** the session-list branch of `server/test/attribute-filter-threading.e2e-spec.ts` (4; the other 9, on analytics, belong to the ANALYTICS group), `AttributeFilterPopover.test.tsx` (5), the attribute part of `session-list-helpers.test` (~4); it closes F.3 #25.
- **What we lose:** the group keeps only the narrowing of the list and the branches; the "5 independent call sites" (analytics and reports) move to the scenarios of the ANALYTICS/REPORTS group.

### S-SLIFE-05. Favorites: the star, reload, isolation between users, the team route
- **Layer:** UI+API
- **Priority:** P1
- **Data/roles:** `owner` has repo A (S1, S2), team `Team-X` with repo A, `regular` is a team member (transparent mode).
- **Steps:**
  1. `owner` opens S1 in the UI and clicks the star: it is gold in the header and in the list; `POST .../favorite {favorite:true}` returned `{ isFavorite: true }`.
  2. `F5`: the star stays. A repeated `POST favorite:true` is idempotent (`isFavorite: true`).
  3. `GET .../sessions` has `isFavorite:true` for S1 and false for S2; `GET .../analytics/timeline` the same.
  4. `regular` opens S1 through `#/teams/<tid>/repos/<A>`: the star is NOT gold (isolation); they set their own through `?teamId=` → S1 is a favorite for `regular`; for `owner` S1 is still a favorite independently, S2 is not.
  5. `owner` removes the S1 star: the list and the timeline for owner say `false`; for `regular` S1 stays a favorite.
  6. Errors: `favorite` missing or not a boolean → 400; a session not from this repo → 404; the repo is not accessible → 403; without a cookie → 401.
  7. Delete session S1 (owner): `regular`'s favorite record disappears (no dangling rows; `GET .../sessions` does not fail).
- **Check:** persistence after reload, the independence of the two users, 400/403/404/401.
- **Replaces:** the "Session favorites" block of `repo-panel.spec.ts` (3), the favorite block of `sessions.e2e-spec.ts` (15, including "user isolation", which checked nothing in the old code), the favorite tests of `team-cross-member` (1).
- **What we lose:** nothing (the isolation gap from the catalog is closed).

### S-SLIFE-06. The owner deletes their session from the interface, an outsider cannot, a repeated upload is ignored
- **Layer:** UI+API
- **Priority:** P0
- **Data/roles:** `owner` and `nonowner`; the admin is `owner` (admin). Repo A of owner `regular`: sessions S1 "Keep me", S2 "Delete me"; `regular` is the owner of A (so that owner-admin is "someone else"). The `regular` API key is kept for the repeated upload.
- **Steps:**
  1. As `regular` open repo A, select S2, click "Remove": the dialog "Remove Session?" with the text "This will permanently delete all logs and data for this session. This action cannot be undone."; "Cancel" closes it without deleting.
  2. "Remove" again → "Delete": S2 disappears from the list, the selection is cleared, `sessionCount` in the header dropped by 1; `GET /sessions/<S2>` → 404 and the logs are not accessible; Raw Logs → 404.
  3. `POST /api/v1/logs?sessionId=S2&type=claude` with the same API key (a repeated upload): the response is 2xx, but the data does not come back (S2 is still not in the list, there are no new `logs` rows).
  4. `DELETE /api/v1/sessions/<S2>` once more → 404; a non-existent id → 404; without a cookie → 401.
  5. As `nonowner` (has access to the URL, but is not the session owner): `DELETE /sessions/<S1>` → 403; the "Remove" button is not shown in the UI on `#/repos/<A>` (if there is access at all).
  6. As an admin who is not the session owner: `DELETE /sessions/<S1>` → 403; S1 stays for `regular` (the admin role grants no data access — 2026-10-21-private-repo-visibility).
- **Check:** the dialog text, the disappearance from the list and the counters, 404 on the logs, a repeated upload does not resurrect, 403 for an outsider and for an admin (deleting is owner-only).
- **Replaces:** `server/test/session-delete.e2e-spec.ts` (6 of 12: owner, admin, 403, 404, 404 repeated, re-upload, 401, "no longer appears in list"; the other 4 are in S-SLIFE-07); it closes the gap "no e2e of deletion from the UI".
- **What we lose:** nothing.

### S-SLIFE-07. Deleting a root session removes its sub-agents and grandchildren, their data and the orphaned contexts
- **Layer:** API
- **Priority:** P0
- **Data/roles:** `owner`; root R, children C1 and C2 (`parentSessionId=R`), grandchild G under C1 (`parentSessionId=C1`); a separate session X in the same repo with the same context (CLAUDE.md `ctx-shared`) and one more context `ctx-only-R`, unique to the R tree.
- **Steps:**
  1. Before deletion: `GET .../sessions/R/logs` has `subagentStats` for C1, C2, G; in `analytics/timeline` the total cost of R = the sum of the three levels (see S-SLIFE-09).
  2. `DELETE /sessions/R` as the owner → 204.
  3. `GET .../sessions/C1/logs`, `.../C2`, `.../G` → 404/no data; the session list has none of the four; the repo's `sessionCount` dropped by 1; X stayed.
  4. The context `ctx-only-R` is not returned by the repo's `GET .../contexts`; `ctx-shared` stays (X holds it).
  5. A repeated upload of the logs of grandchild G and child C2 (the hook sends them with `parentSessionId`) is ignored; they are still not in the list.
  6. `GET /users/me` favorites/stats: `user_favorite_sessions` for R are removed (checked through `GET .../sessions` for another user: no errors).
- **Check:** all four sessions are not accessible, X and the shared context are intact, 404 on the descendants, a repeated upload of the descendants does not resurrect them.
- **Replaces:** the tests "child sessions soft-deleted", "grandchild (2 levels deep)", "orphan contexts removed", "204 owner... data is purged" of `session-delete.e2e-spec.ts` (4).
- **What we lose:** a direct check of `deleted=true` (soft deletion) and of the `deleted_session_log` records: this is internal DB state visible only to the admin (it is acceptable to check it through an admin "deleted sessions" API, if there is one).

### S-SLIFE-08. Auto-deletion by age (retention): an old session disappears together with its tree, a young one and an already deleted one are not touched
- **Layer:** API
- **Priority:** P0
- **Data/roles:** `owner`, repo A. Sessions: OLD (root + child + grandchild, the earliest `logs.created_at` 31 days ago), YOUNG (29 days), EMPTY (a root without `logs` rows), SOFT (soft-deleted by the user, 40 days), OLD2 with an upload queue entry (an `upload_queue` row in status `partially_uploaded` and a chunk file on disk).
- **Steps:**
  1. `GET /api/v1/sessions/retention-days` as a plain user: `{ days: 30 }`; without a cookie → 401.
  2. "Age" OLD, OLD2 and SOFT: shift `logs.created_at` 31/40 days back (a DB helper `backdateSession(sessionId, days)` in e2e; needed for the scenario, see the question to the owner).
  3. Wait for a scheduler tick (in e2e the server runs with `SESSION_RETENTION_CHECK_INTERVAL_MS=1000`; if needed, `waitFor` up to 10 s).
  4. Check through the API: OLD, its child and grandchild are gone (404, not in the list), OLD2 is gone and its `upload_queue` row and file are deleted (`GET /admin/upload-queue` does not have the row), YOUNG stayed, EMPTY stayed, SOFT stayed soft-deleted (no repeated audit record).
  5. For OLD there is a `deleted_session_log` audit record with `deletedByUserId = null` (automatic deletion) for every active session of the tree (through an admin API/query, if there is one), and no record for the already soft-deleted descendant.
  6. Concurrency: two parallel cleanup calls on the same root give no error (checked implicitly by a repeated tick with no failures in the log).
  7. UI: the owner's repo list has no OLD, the repo Summary `sessionCount` dropped.
- **Check:** who disappeared, who stayed, the audit with a `null` author, the queue cleaned up, the 30-day window in the API.
- **Replaces:** `server/test/session-retention.e2e-spec.ts` (10), `server/src/sessions/session-retention.service.spec.ts` (11, a unit test with mocks: ticks, reading env); it closes the gap "no e2e for retention".
- **What we lose:** reading env on every tick and the batch size of 200 (`SESSION_RETENTION_PURGE_BATCH_SIZE`): configuration details without user value; the owner may keep 1 unit test on the "oldest-first, batch" order.

### S-SLIFE-09. Session metrics are computed over the whole agent tree, not only the root
- **Layer:** UI+API
- **Priority:** P0
- **Data/roles:** `owner`, repo A. Root R (an orchestrator: 0 lines of code of its own, 1 min of its own work 10:00-10:01), children C1 (10:00-10:30, +40 lines, 2 files, including MultiEdit), C2 (10:10-10:40, +10 lines, 1 file), grandchild G under C1 (10:05-10:20, +25 lines); all on one branch `main`. Known model prices from the seed: the cost is computed as the sum of the three levels. Separately, a session P without sub-agents (+7 lines).
- **Steps:**
  1. `GET .../analytics/timeline?startDate=..&endDate=..`: for R `linesChanged = 40+10+25 = 75`, `linesChangedOwn = 0`; the tree's `filesEditedWritten` is 3 (union or sum, as the KB defines), `totalCost` = the cost of the root + C1 + C2 + G (the grandchild included); for P `linesChanged === linesChangedOwn = 7`. Sub-agents are not returned as timeline rows (the list has R and P).
  2. `GET .../sessions/branches`: `main.totalLinesChanged = 75 + 7 = 82`, `totalLinesChangedOwn = 7`; `totalWorkTimeMs` = the union of the intervals (10:00-10:40 = 40 min + P), not the sum (not 1+30+30+15 min).
  3. `GET .../sessions/R/logs`: the `subagentStats` of C1, C2, G have their own `linesChanged` (40, 10, 25); their sum equals the tree's `linesChanged` from item 1; G is nested under C1.
  4. `GET .../reports/executive-summary`: `totalLinesChanged` = 82 and `avgCostPerLine` = the total cost of the trees / 82 (both on the same scale).
  5. UI: open R: the header has a "+sub-agents" label next to the cost; on Summary the "Delegation" and "Code impact" tiles agree (no "95% delegated, 0 lines"): lines = 75; the Agent Tree in Charts shows G under C1.
  6. Call all four endpoints again: the numbers did not change, nothing is recomputed or duplicated (idempotent; reopening does not double).
- **Check:** 75 versus 0, 82 versus 7, time as a union, the sum of the sub-nodes equals the tree, the ratio on one scale, no double counting on repeat.
- **Replaces:** `server/test/session-tree-metrics.e2e-spec.ts` (15), the tests "totalCost includes grandchild" and "cache rollup 3-level" of `repositories-analytics.e2e-spec.ts` (2; the other 28, on analytics, are outside the group), the tree fragment of `session-cost-consistency` (not counted), `harness-session-tree.test.ts` is not mine (HARNESS), `repo-details` `subagentStats` (3).
- **What we lose:** `MultiEdit` in a plain chain (included in the data), the raw JSONB fallback for a root without `session_stats` (counted exactly once): a rare legacy case; 1 server test can be kept.

### S-SLIFE-10. What team members see: transparent shows the sessions, restricted only one's own; raw logs always only for the owner
- **Layer:** API
- **Priority:** P0
- **Data/roles:** `Team-X` (transparent), `Team-Y` (restricted); `userA` (repo owner, session SA), `userB` (member, session SB, disclosure accepted), both in both teams, repo A added to both; `nonowner` outside the teams.
- **Steps:**
  1. Transparent: `userB` `GET /repositories/<repoA>/sessions?teamId=<X>` → SA and SB; through their own repoId with teamId → the same; without teamId → only SB.
  2. `GET .../sessions/branches?teamId=<X>`: the branches of both; `GET .../contexts` has userA's contexts; `analytics/timeline` and `analytics/work-time` sum both.
  3. Restricted (`teamId=<Y>`): `userB` sees only SB; `sessions/branches` only their own; userA's `contexts` → 403; `analytics/timeline` and `work-time` → 403.
  4. Raw logs: `userB` `GET .../sessions/SA/logs` with teamId, without teamId, through their own repoId, in both modes → always 403 (raw is owner-only).
  5. The team owner (`userA` as owner) can read a member's logs with `?teamId` (the owner exception, T-70).
  6. A member who has not acknowledged the disclosure does not get into `export-scope` or the lists (visibleUserIds).
  7. `nonowner`: any of this → 403.
- **Check:** the SA/SB sets per mode, 403 on the logs and on analytics in restricted, the team-owner exception.
- **Replaces:** `server/test/team-cross-member-sessions.e2e-spec.ts` (16). OVERLAP with the TEAMS group (access modes): agree so that one copy stays in the final list.
- **What we lose:** the analytics details per mode stay with the ANALYTICS group.

---

## Hook state

### S-HSTATE-01. The user has an installed hook: the "Installed Hooks" menu, issues, the state page and the upgrade command
- **Layer:** UI+API
- **Priority:** P1
- **Data/roles:** a new user `hookuser` without API keys and repos; then one key and repo H, where the hook sent a `hook-status` event: `hookVersion '0.0.1'` (certainly older than the baseline), a `logTail` with `[error]` and `[result]` lines, `nonUploadableLogs` (`big-session.jsonl`, "timeout after 10000ms (size=12.0MB)"), one recommendation `timeout-on-upload`.
- **Steps:**
  1. A fresh user (without keys): the left panel has no "Installed Hooks" section.
  2. Create an API key (`/#/api-keys`) without a hook: the section appears, but has no repo rows (a repo without `hook-status` is not in `GET /repositories/hooks`).
  3. Upload a session with `hook-status` into H: the menu has row H with an orange dot and "2 issues" (outdated +1, recommendations +1).
  4. Click the row: URL `#/repos/<H>/hook-state`; the card says "Hook outdated, 1 recommendation", "Installed version 0.0.1 • Latest version X.Y.Z", "Last activity" with a relative time.
  5. Below: the recommendation card "Log uploads are timing out — consider raising SEND_LOGS_TIMEOUT_MS"; the table of unavailable logs with `big-session.jsonl`; the "Errors & warnings" section has the line about `invalid SEND_LOGS_TIMEOUT_MS`, but not the `[result]` line; a dark block with the log tail.
  6. "Copy upgrade cmd": the button changes to "Copied!", the clipboard (Playwright `clipboard.readText`) holds the command `npx "http://localhost:5173/static/artisyn-hooks-installer.tgz?v=<latest>" upgrade`; on a page without `latestVersion` the link has no `?v=`.
  7. The manual page refresh button re-requests the state.
  8. API: `GET /repositories/hooks` has H with `outdated: true`, `issueCount: 2`.
- **Check:** the issue count (2), the versions, the recommendation text, the content of the error list filtered by `[error]/[fail]/[warn]`, the exact command in the clipboard.
- **Replaces:** `tests/e2e/hook-state.spec.ts` (3), `server/test/hook-state.e2e-spec.ts` (6 of 11: the version/outdated filter, issueCount, logTail, field mapping), `client/.../HookStatePage.test.tsx` (15 of 15, optionally keeping 1 unit test of copying); it closes the gap "Installed Hooks without keys".
- **What we lose:** `HK/recommendations.test.js` and `send-logs-hook.test.js` are hook level (the HOOK group, not mine).

### S-HSTATE-02. After a hook upgrade the problems disappear; an upload without a status does not erase them
- **Layer:** API+UI
- **Priority:** P1
- **Data/roles:** the same H from S-HSTATE-01 (outdated, 1 recommendation). Assumption: the current version `LATEST` is taken from `GET /repositories/:H/hook-state` (`latestVersion`).
- **Steps:**
  1. Upload one more session WITHOUT `hook-status`: the H state does not change (still `0.0.1`, 1 recommendation, 2 issues).
  2. Send a new `hook-status` with `hookVersion = LATEST`, no recommendations, an empty `nonUploadableLogs`, a `logTail` without errors.
  3. `GET /repositories/hooks`: `outdated false`, `issueCount 0`.
  4. UI: the "Installed Hooks" menu shows H with a green dot and "OK"; the page: "Hook up to date", a green card, no recommendations block and no table of unavailable logs.
  5. Send a `hook-status` with `hookVersion = LATEST`, but with one recommendation: the card "Hook has open issues" (orange, not "outdated"), issues = 1.
- **Check:** an upload without a status erases nothing; a new status replaces everything; the three card states (outdated / open issues / up to date) and the matching menu counters.
- **Replaces:** `server/test/logs-hook-status.e2e-spec.ts` (5), `hook-state.e2e-spec.ts` (3 of 11: up to date, 0 issues); it closes the gap "recommendations disappear after a successful run" at the UI level.
- **What we lose:** the hook's own mechanism for creating and clearing recommendations (`recommendations.test.js`) stays in the hook tests.

### S-HSTATE-03. The hook state does not leak to outsiders and returns clear errors
- **Layer:** API
- **Priority:** P0
- **Data/roles:** `owner` has repo H with a hook state (the logs contain paths and error texts); `nonowner`; the owner's repo Q without `hook-status`; `regular` is a member of a team with repo H (but not the owner).
- **Steps:**
  1. Without a cookie: `GET /repositories/hooks` and `GET /repositories/:H/hook-state` → 401.
  2. `owner`: `GET /repositories/:Q/hook-state` → 404 ("not reported yet"); an unknown id → 404; `GET /repositories/hooks` does not have Q (`hookVersion IS NULL`).
  3. `nonowner`: `GET /repositories/:H/hook-state` → 403; `GET /repositories/hooks` does not have H (only their own).
  4. `regular` without team access to H → 403; with `teamId`, per the mode rules, as the owner decides (pin the actual behaviour).
  5. UI: `nonowner` opens `#/repos/<H>/hook-state`: "No access"; `owner` on `#/repos/<Q>/hook-state`: "No hook state reported yet".
- **Check:** strictly the codes and the texts of the page states, and that the 403/404 body has no `logTail`.
- **Replaces:** `hook-state.e2e-spec.ts` (the rest: 401 ×2, 404 ×2, 403, "only caller's own repos" = 6, partly overlapping with HOOK-01), the 404/403 cases of `HookStatePage.test.tsx` (2).
- **What we lose:** nothing.

---

## Not covered by scenarios (deliberately)

- The `repo-url-normalizer.spec.ts` unit test: scenario S-REPO-01 takes 6 URL variants. I propose keeping one compact table-driven unit test (10 rows) instead of 21 tests; the rest duplicates the API.
- `repo-backfill.spec.ts` (URL backfill over the whole shared table, migrations): not needed after the migration squash and for a clean install (question G4). The only meaningful test (upload-time dedup) is already in S-REPO-01.
- The internals of the zip (`session.json` and batches of 25), the cleanup scheduler of export jobs (F.2 #17): not user behaviour; the owner decides whether a separate test is needed.
- Automatic compaction/the "Loading session list" states, "a background refresh does not wipe the list" (except one step in S-SLIFE-01), `viewport-popover-clamp`, `CU/settings` (an invalid poll interval): cosmetics and expensive maintenance.
- The Advisor bulb in the session row (`session-item-advisor-badge.test.tsx`, 2 tests: the regression "a click on the row does not jump to Advisor"): needs Advisor data; I recommend moving it to the Advisor/ATTRIBUTION scenario rather than keeping it here.
- The unit combinations of `validateConfig` (35 cases), reduced to representatives in S-REPO-08.
- The details of `useNewSessionPoll`/`useOpenBranches` as hooks: covered through behaviour in S-SLIFE-01.
- The "401 on every endpoint" tests (question G21): replaced by checks of typical routes in S-REPO-03 and S-REPO-12.
- Keep-alive (`auth-guard.spec` "Keep-alive fires") and the "Help modal" feature: outside the group (PLATFORM / UI-SHELL).

## Questions for the owner (on this group)

1. Retention (S-SLIFE-08) needs two things that e2e does not have now: a helper to shift `logs.created_at` (direct SQL) and an e2e server with `SESSION_RETENTION_CHECK_INTERVAL_MS` of about 1 s (the server ticks once every 30 min by default, and per CLAUDE.md starting it is not our job). Do you agree to add the helper and the start parameter, or should one jest test `session-retention.e2e-spec.ts` stay as an exception to "one runner"?
2. Attribution seeding for S-SLIFE-04: use the public `POST /api/v2/session-attribution` (403 for another user, fixtures with Advisor are needed) or a DB helper?
3. S-REPO-05: the server API is not blocked by consent (the block is only in the UI). Is this the intended behaviour, or should the server also refuse before consent?
4. S-SLIFE-10 overlaps with TEAMS (access modes): who owns the scenario?
5. S-HSTATE-03 item 4: what should a team member see on the hook-state of someone else's repo (the code does not pin it now)?
