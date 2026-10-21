## Research findings: 2026-10-21-private-repo-visibility

### Requirements summary
This is a security bug. The Data Collection Notice promises that private repos are owner-only, but today an app admin can read any repo's sessions. The fix makes the `admin` role purely administrative: it grants no access to session, prompt or transcript data, or to anything derived from them.
- **Personal route** (no `teamId`): only the owner of the `repositories` row gets data, whatever their role.
- **Team route** (`teamId`): only team membership plus the team policy (access mode and role) apply. A non-member admin gets 403 on every team endpoint. `GET /teams` returns only the admin's own teams. A non-member admin keeps no team-management powers.
- **Admin panel keeps:** the Repos table (metadata, aggregates and Delete only), retention, users, password-reset links, and a new "Set new owner" action in Admin → Teams (FR-8). It can pick only current members, through an admin-only endpoint.
- **Upload queue:** `GET /admin/upload-queue/:id/file` stops returning the raw payload.
- **Logs:** server and error logs must not contain prompt or transcript text.
- **Session delete** becomes owner-only.
- **UI removed:** the "Private repo view" badge (for everyone) and all "Teams as Admin" / "View as Admin" / "Viewing as Admin" UI.
- **Texts:** every visibility text (notice, disclosure modal, help, README, KB) must describe the new model. In auth mode `none` the notice must say identity is not verified, and it must say admins can reset passwords.
- **Open questions:** both are answered in `open_questions_ru.md`. A non-member admin has no team powers except "Set new owner". The reset-password link stays.

### Wireframes
- **`left-nav-and-teams-page.svg`:** the "TEAMS AS ADMIN" accordion, the "View as Admin" badge and the "Teams as Admin" section on `TeamsPage` are removed. Teams shows only member teams with their role label (Owner / Manager / ADLC trainer / Member). My Repos shows only owned repos.
- **`admin-repos-table.svg`:** rows are plain text with no links. Columns: Repository, Owner, Team, Sessions, Raw Uploads, Log Size, Max Upload, Last Session, First Seen, Actions (Delete). The "Delete ?" and Team-column questions in it are now settled by FR-3 and the Common-sense section. The wireframe shows a filled Team column ("Platform Team"), but the code does not populate it today (see Open gaps).
- **`private-repo-admin-blocked.svg`:**
  - A: an admin opening `#/repos/<id>?users=all` gets the existing "Repository not found" empty state, since the server returns 403/404 for summary, sessions, branches, contexts, analytics and reports. Note that `RepositoryView.tsx:283-297` renders "No access" for 403 and "Repository not found" only for 404.
  - B: the owner's view is unchanged and the badge is gone.
- **`team-disclosure-modal.svg`:** in `DISCLOSURE_RESTRICTED_BULLETS`, bullet 1 drops "and application administrators". An optional last bullet says "Application administrators get no access through their admin role — only through a role they hold in this team." The transparent bullets do not change.

### Knowledgebase
- **`docs/knowledgebase/authorization-and-authentificaiton.md`:**
  - §"Team access modes" (l.320-388) and §"What the app-level admin bypass does and does not cover" (l.375-387) list the current bypasses: `TeamAccessGuard`, `assertRepoAccess`, the session-logs route, export-scope and recompute-all. This section must be rewritten.
  - l.411-413 (export visibility "so the admin bypass keeps working"), l.425-427 (personal-view row filter skipped "because an app admin may open another user's repo") and l.441-443 (raw logs: "an app admin") must also be rewritten.
  - The `resolveTeamScope` three-state table (l.394-413) stays as it is.
- **`docs/knowledgebase/server-endpoint-map.md`:**
  - Guard legend l.28 (`TeamOwnerOrAdminGuard`).
  - Lines that need updating: l.444 (logs route), l.459 (export-scope), l.740 (export/import, `assertRepoOwnerOrAdmin`), l.762 (session delete "Owner or admin"), l.834/840/841 (TeamOwnerOrAdminGuard routes), l.848 (members acknowledgement visible to admin), l.850 (acknowledge-disclosure admin note), l.931 (upload-queue file).
  - Rule from `.claude/rules/server.md`: update this map and `api-reference.md` after any endpoint change.
- **`docs/knowledgebase/api-reference.md`:** l.69, 898-903 (upload-queue file), 1058-1166 (team route "Requires: … or admin"), 2386, 2588, 2621-2623 (`assertRepoOwnerOrAdmin`).
- **`docs/knowledgebase/client-component-map.md`:** l.141 (RepositoryHeader "Private repo view" badge), l.399 (TeamMemberRow, "app admin" sees acknowledgement), l.436 (UploadQueueEntryDetailModal "Download file"), l.460-461 (AppLeftNav / TeamAccordion "Teams as Admin"). Rule from `.claude/rules/client.md`: update this map after component changes.
- **`docs/knowledgebase/ui-principles.md`:** l.26-28 "Context badge — personal route" prescribes the "Private repo view" badge. Remove it or reword it.
- **`docs/knowledgebase/legacy-design-decisions-map.md`:** l.38 (T-7, the Private repo view badge) must point to "removed".
- **`docs/knowledgebase/user-account-flows.md`:** §"Onboarding and data-collection consent" (l.95-106). The consent hash is computed over the notice text, so editing the notice re-asks every user once. This is by design.
- **`docs/knowledgebase/upload-queue.md`:** l.64-66 describes the staged-file download.
- **`docs/knowledgebase/log-subsystem.md`:** Error Logs and Logs Archive.
- **`docs/knowledgebase/session-export-import.md`:** the "owner-or-admin gate".
- **`docs/knowledgebase/product-purpose-and-data-capture.md`:**
  - Capture in full is by design. Do not redact what gets captured; this task restricts only who can read it.
  - l.62: consent gates the UI only.
- **`docs/knowledgebase/algorithms/ndjson-tolerance.md`:** rule 7 / l.84. Server log and `errorMessage` text is built from the parser's message. Change this doc's rows only if the reason text changes.
- **`docs/knowledgebase/test/index.md` and `test/contract-tests.md`:** contract registry conventions (actors admin/owner/member/outsider/author/manager; world-v1).
- **`docs/qaa-overview/scenarios/01-auth-access-admin.md`:**
  - §S-TEAM-07 (l.521-538) is the design for "admin and someone else's team". It encodes the old bypass and was **never implemented** as a spec.
  - §S-ACC-01 step 4 ("admin reads raw logs of any session → 200").
  - l.379: the disclosure bullet text.
- **`docs/qaa-overview/scenarios/02-repos-sessions.md`:** l.92-93 (badge) and l.432 (admin DELETE session 204).
- **`docs/qaa-overview/scenarios/05-api-db-contract.md`:** l.25, l.148, l.168 (TOA rows, upload-queue file).

### Existing patterns

**Server: access checks**
- **`server/src/logs/repositories.service.ts:144-194` (`assertRepoAccess`):** the admin early return is at **l.158-160**. Every repo, session, report and analytics route goes through it. Callers are 24 in `repositories.controller.ts`, 5 in `reports.controller.ts`, 1 in `usage-analytics.controller.ts:208`, plus `buildSessionListConditions` (l.522). Removing l.158-160 is the central server fix.
- **`repositories.service.ts:201-220` (`assertRepoOwnerOrAdmin`):** admin skip at l.208. Used by all of `repository-export-import.controller.ts` (l.243, 266, 321, 360, 415, 481).
- **`repositories.service.ts:309-312, 356, 424-428, 512-514`:** doc comments that justify the admin bypass, to rewrite.
- **`repositories.service.ts:537-540` (`ownerCondition`) and `repositories.controller.ts:140-150` (`teamScopeUserFilterSql`):** both skip the user filter when there is no teamId "for the admin". With the bypass gone the personal route is owner-only through `assertRepoAccess`. The repo owner still sees imported logs written by other authors, because no user predicate is applied. `?users=all` is a client-side email filter only (`RepositoryView.tsx:200-203`).
- **`repositories.controller.ts:1658-1669` (`assertSessionVisibleBySessionId`):** the personal-view early return is commented "admin is allowed through".
- **Session-logs owner gate, `repositories.controller.ts:1818`:** `if (user.role !== 'admin' && sessionOwnerRow?.userId !== user.id)`. The comment at l.1835-1836 also needs updating.
- **export-scope, `repositories.controller.ts:2301-2307`:** `user.role !== 'admin' &&` team-owner check.
- **recompute-all-sessions, `repositories.controller.ts:2336-2342`:** same pattern as export-scope.

**Server: guards**
- **`server/src/common/guards/team-access.guard.ts:40-43`:** admin early return. Used on GET `:teamId`, GET members, acknowledge-disclosure, GET repositories, POST invitations, DELETE invitations (`teams.controller.ts:60, 83, 118, 154, 193, 211`).
- **`server/src/common/guards/team-owner-or-admin.guard.ts:39`:** `user.id === team.ownerId || user.role === 'admin'`. Used on removeMember, unlink and removeTeamRepository (`teams.controller.ts:108, 173, 183`). Without the admin branch it becomes identical to `team-owner.guard.ts:35`.
- **`server/src/common/guards/admin-or-team-owner.guard.ts:26`:** retention keeps admin access. No change.

**Server: teams service**
- **`teams.service.ts:84-107` (`listTeams(userId, isAdmin)`):** the admin branch returns all teams with an `isMember` flag. The member branch (l.109-125) already returns `isMember: true`. Keep the `isMember` field for client compatibility. Caller: `teams.controller.ts:45`.
- **`teams.service.ts:256-258` (`getMembers`):** `caller.role === 'admin'` lets an admin see `disclosureAcknowledgedAt`.
- **`teams.service.ts:684` (`sendInvitation`) and `:798-801` (`cancelInvitation`):** `inviterRole !== 'admin'` / `callerRole !== 'admin'` bypass, plus the message "Only the team owner or an admin…".
- **`teams.service.ts:978-979`:** comment "An app admin passes TeamAccessGuard…".
- **`teams.service.ts:352-377` (`transferOwnership(teamId, _currentOwnerId, newOwnerId)`):** the current owner argument is unused and the method enforces "new owner must be a member" (400). The FR-8 admin endpoint can reuse it as is.

**Server: sessions and admin panel**
- **`server/src/sessions/sessions.service.ts:78-112` (`deleteSession`):** l.108 `requesterId !== ownerUserId && requesterRole !== 'admin'`. Caller: `sessions.controller.ts:42`.
- **`server/src/admin/admin-panel.controller.ts` patterns:**
  - Class-level `@UseGuards(SessionAuthGuard, AdminGuard)` at l.48-49.
  - `GET teams` at l.195 is the place to add `POST teams/:teamId/owner` (or similar).
  - `DELETE repos/:id` at l.189-193 is an existing admin row action.
  - `GET upload-queue/:id/file` at l.109-125 is the endpoint to retire or neuter.
- **`server/src/admin/admin.service.ts:203-286` (`getRepos`):**
  - Real `repositories` rows **do not populate `teamName`** (l.240-251). Only orphan `team_repositories` rows (no `repositories` row, l.253-283) carry `teamId` / `teamRepoId` / `teamName`.
  - `getTeams` (l.351-377) returns `TeamRow { id, name, ownerEmail, createdAt, memberCount, repoCount }`.
  - `removeRepo` (l.288-349) removes every row with the URL plus the team links.
- **`server/src/admin/upload-queue-admin.service.ts:106-128` (`resolveStagedFile`):** only consumer is the file route. `listQueue` (l.53+) returns `errorMessage`.

**Log leak paths (FR-1)**
- **`server/src/logs/ndjson-parser.ts:93-110`:** `reason` is V8's `JSON.parse` message. **Verified on Node v24.18.1:** for an "Unexpected token" error, V8 embeds the input text around the error position, 10 characters before and 10 after. Examples:
  - `Unexpected token 'm', ...""prompt": my secret "... is not valid JSON`
  - `Unexpected token 'a', "abcdefghij"... is not valid JSON`
- **Where that reason ends up:**
  - The thrown `Malformed NDJSON…` message (cut to 300 chars), which becomes `upload_queue.error_message` and goes through `logger.error` (`upload-queue-scheduler.service.ts:428-446`).
  - The warn line with up to 5 reasons cut to 120 chars (`upload-queue-scheduler.service.ts:372-380`).
  - Both reach `logs/app-*.log`, so the Error Logs tab and the logs-archive zip.
- **`server/src/database/database.module.ts:40-64` and `common/sql-logger.ts:90-114`:** the SQL log records SQL text and the `err.message` only, never bind parameters.
- **`common/http-exception.filter.ts:73-91`:** logs `request.url` (query string included) and the exception message.
- **`system-info.service.ts:211-228` (`createLogsArchive`):** zips the whole `logs/` directory, `sql-*.log` included.

**Client**
- **`client/src/viewer/pages/repository/RepositoryHeader.tsx:25-27`:** the "Private repo view" badge when `teamId === undefined`. Remove it.
- **`client/src/viewer/pages/repository/RepositoryView.tsx:93-112`:** `isAppAdmin` widens `canSeeTeamWideTabs` and hides `showRestrictedNotice`. Remove it so an admin member is treated by team role.
- **`client/src/viewer/pages/repository/SessionDetailPane.tsx`:** `canSeeRawLogs` includes `user?.role === 'admin'` (l.124), and the Delete button shows for admins (l.342).
- **`client/src/viewer/components/AppLeftNav.tsx`:** `isAdmin` / `adminOnlyTeams` (l.68-76, 93-97) and the "Teams as Admin" accordion (l.255-283). `adminSectionOpen` state is at l.41. Lines 153 and 361 (`isAdmin || isTeamOwner`, the Admin Panel link) stay.
- **`client/src/viewer/pages/teams/TeamsPage.tsx`:** roleLabel `'Admin'` (l.23), `AdminTeamCard` (l.51-60), `adminOnlyTeams` (l.83-86), the "View as Admin" badge (l.94-96) and the "Teams as Admin" section (l.127-131).
- **`client/src/viewer/pages/teams/TeamDetailPage.tsx`:** `viewingAsAdmin` and "Viewing as Admin" (l.40, 49-59). It passes `isAdmin` to `TeamMembersTab` (l.74; `canRemove={isOwner || isAdmin}` at l.136), `TeamRepositoriesTab` (l.84; l.33 `canRemove = isOwner || isAdmin`) and `TeamInvitationsTab` (l.92; l.92 cancel).
- **`client/src/viewer/pages/teams/tabs/TeamMembersTab.tsx:97-106, 186-213, 253-263`:** the owner's "Transfer ownership" `<select>` of `nonOwnerMembers` by email, a `ConfirmDialog` and a `transferTeamOwnership` mutation (`api.ts:1757`). This is the pattern for the FR-8 admin picker.
- **`client/src/viewer/pages/admin/tabs/AdminTeamsTab.tsx`** (2,159 B): a `ColumnDef[]` with no actions column.
- **`client/src/viewer/pages/admin/tabs/AdminReposTab.tsx`:** `RemoveButton` (l.18-73) is the row-action pattern to copy into AdminTeamsTab (Button + `ConfirmDialog` + `invalidateQueries`). Table plumbing: `AdminDataTable` + `useDebounce` filter. The `AdminTeam` model is in `client/src/models/admin.ts:16-23`.
- **`client/src/viewer/pages/admin/tabs/UploadQueueEntryDetailModal.tsx:3, 24, 35`:** the "Download file" button (`downloadUploadQueueFile`, `api.ts:1987-2000`).
- **`client/src/viewer/lib/access-mode-copy.ts:43-48`:** `DISCLOSURE_RESTRICTED_BULLETS[0]` is the admin wording. Scenarios import these constants (s-team-01 l.24/139), so the tests follow automatically.

**Notice and help texts**
- **`client/public/help/data-collection-notice.md:18-25`:** "Who can see it". This must be rewritten. It also contradicts restricted teams today: "Anyone in the team can open those sessions and read their prompts".
- **Consent hash:** computed over the raw text before placeholder substitution (`DataCollectionConsentScreen.tsx:63, 73`; `useDataCollectionConsent.ts:49`). `RETENTION_DAYS_PLACEHOLDER` is the substitution pattern (`lib/notice-hash.ts:20`).
- **`client/src/viewer/help/HelpModal.tsx:39-43`:** renders help markdown raw, with **no placeholder substitution**.
- **Other texts to fix:**
  - `client/public/help/security-hardening.md:281-282` ("admin … can read any session's logs").
  - `README.md:198` ("The app admin can read any session's raw logs").
  - `client/src/models/teams.ts:33`, `api.ts:1345, 1376` and `TeamMemberRow.tsx:23` (doc comments).
- **Checked and clean:** `artisyn-hooks-installer/src/*.ts` and the hook README have no visibility text.

**Tests (three kinds only)**

*Contract registry (`server/test/contract/registry/`)*
- **Fixture:** in world-v1 (`fixtures/world-v1.sql.ts`) the admin is user id 1. The owner (id 2) owns T1 (transparent) and T2 (restricted). R3 is the outsider's private repo.
- **Rows that must flip:**
  - `f09-admin-upload-queue.ts:172` `F09-file` (200 with bytes)
  - `f10-teams-core.ts:101` `F10-list-admin` (minRows 2)
  - `f10-teams-core.ts:159` `F10-get-admin` (200)
  - `f11-team-members.ts:134` `F11-remove-admin` (204)
  - `f18-session-delete-retention.ts:118` `F18-delete-by-admin` (204)
- **Rows to add:**
  - admin vs R3 / R1 in `f14-repositories.ts`, `f17-sessions.ts`, `f19`, `f20`, `f21`, `f23`
  - an admin vs T2 invitation row in `f13-invitations.ts`
  - admin unlink/remove rows in `f12-team-repos.ts`
  - the new admin set-owner route in `f08-admin-repos-teams.ts`, with member, non-member-target and non-admin rows. `routes.contract-spec.ts` fails without them.

*Scenarios*
- `tests/scenarios/auth/s-acc-01.spec.ts:73-77`, step 4 "ADMIN: raw logs of any session → 200". This flips and becomes the AC-1 home.
- `tests/scenarios/repos/s-repo-03.spec.ts` ("foreign repository is closed"; steps 3, 7, 10) can take admin rows.
- `tests/scenarios/sessions/s-slife-06.spec.ts:43, 137-138`: step 6 (admin DELETE → 204) flips.
- `tests/scenarios/sessions/s-slife-08.spec.ts:58, 88`: the setup uses an admin to delete a child session. It must switch to the owner.
- `tests/scenarios/repos/s-repo-07.spec.ts:182`: admin GET settings `?teamId` → 200 flips to 403.
- `tests/scenarios/auth/s-team-01.spec.ts:139`: disclosure bullets, through the constants.
- `s-team-02` (restricted roles) is the candidate for an "admin who is a member gets their role's rights" step (AC-5).
- `s-adm-01` / `tour-02-admin` cover the admin panel, a candidate home for the Set-new-owner step (AC-9).
- S-TEAM-07 has no spec, so a non-member-admin team scenario either extends `s-team-02` or `s-acc-01`, or is the one justified new file.
- The notice-hash helpers (`tests/scenarios/helpers/notice-hash.ts:18-33`, `tests/e2e/helpers/notice-hash.ts`) read the `.md` file, so they follow text edits.

*Algorithm docs*
- None covers access control.
- `ndjson-tolerance.md` (`server/src/logs/ndjson-parser.algo.spec.ts`) is affected only if the reason text changes. Its rows NT-35 / NT-36 pin the parser message (l.326).

*Legacy e2e*
- `tests/e2e/repo-panel.spec.ts:128-153` asserts the "Private repo view" badge is shown and hidden. These two specs will break and must be removed.
- In legacy e2e, primary, admin and owner share one admin email (`tests/e2e/global.setup.ts:20-37`). That is fine for repos those users own. Any legacy spec where the admin identity reads a regular user's repo would now break; I did not find one statically.

**DB:** no schema change and no migration needed.

### Open gaps
1. **Admin "Delete" on orphan team-repo rows breaks.** For rows where `id === null`, `AdminReposTab.tsx:33-37` calls `removeTeamRepository(teamId, teamRepoId)`, which is `DELETE /teams/:teamId/repositories/:repoId` under `TeamOwnerOrAdminGuard`. Removing the guard's admin branch breaks this FR-3 action. The plan needs an admin-panel delete for `team_repositories` rows, or must drop orphan rows, which FR-3 says "lists all `repositories` rows" and does not mention.
2. **The Team column is empty for real repo rows today.** `admin.service.ts:240-251` never sets `teamName` for `repositories` rows; the wireframe and the Common-sense section expect it. The plan must define the join: a team that links the URL, and whether to require the row owner to be a member.
3. **The FR-8 member picker needs a data source.** A non-member admin gets 403 from `GET /teams/:teamId/members`. The plan needs an admin-only members list (identity only), for example `GET /api/v1/admin/teams/:teamId/members`, or members embedded in `GET /admin/teams`. It also needs the set-owner route name and HTTP verb, and whether the response or table shows the new owner (`ownerEmail`).
4. **Raw payload replacement for `GET /admin/upload-queue/:id/file`.** The plan must choose: remove the route (contract registry, client modal and KB), make it return 404/410, or return metadata only. Old clients only download from the modal, so compatibility risk is limited to the admin UI.
5. **Scrubbing prompt text from logs** has no existing helper. The confirmed leak is the V8 `JSON.parse` snippet (10 characters on each side of the error position) in `ndjson-parser.ts` reasons. It reaches `upload_queue.error_message`, `logger.error`/`warn` and so `logs-archive` and Error Logs. Also check `request.url` query strings in `http-exception.filter.ts`, and the `cause` and stack text logged for errors.
6. **The auth-mode-`none` notice wording has no conditional pattern.** The notice is static markdown with the hash computed over the raw text, and `HelpModal` shows placeholders unsubstituted. The plan must choose an unconditional sentence ("in identify-only mode…") or a new placeholder, which also means adding substitution to `HelpModal`.
7. **The `assertRepoOwnerOrAdmin` name** becomes misleading. The plan should decide whether to rename it (to something like `assertRepoOwnerOrTeamOwner`) along with its KB references.
8. **Non-member admin and invitations.** `sendInvitation` / `cancelInvitation` keep their own role checks (`teams.service.ts:684, 798`) in addition to the guard. Both must go; `TeamAccessGuard` alone would still let an admin member without `canInvite` invite through the service bypass.
9. **`GET /api/v1/repositories` lists repos where the caller only authored logs** (`repositories.controller.ts:367-384`), but the personal route already 403s non-owners. This is pre-existing and unchanged, but FR-6 "row owner only" makes it visible. The plan should decide whether to leave it.
10. **The QA design docs** (`docs/qaa-overview/scenarios/01`, `02`, `05`) describe the old admin bypass and the badge. Decide whether to update them under FR-7 ("all docs").
