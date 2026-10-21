# Implementation plan — 2026-10-21-private-repo-visibility

## TL;DR

- **Auth model change (high blast radius):** every `role === 'admin'` bypass in data-access paths is removed: `assertRepoAccess`, `assertRepoOwnerOrAdmin` (renamed `assertRepoOwnerOrTeamOwner`), session raw logs, export-scope, recompute-all-sessions, `TeamAccessGuard`, `listTeams`, `getMembers`, `sendInvitation`/`cancelInvitation`, `SessionsService.deleteSession`.
  - `TeamOwnerOrAdminGuard` is deleted, and its routes use `TeamOwnerGuard`.
  - `AdminOrTeamOwnerGuard` (retention) is untouched.
- **Privacy boundary = application data views (UI + API).** Debugging and operational data stays as is: the upload-queue raw-file download (`GET /admin/upload-queue/:id/file`) and server/error logs. The Data Collection Notice says explicitly that anyone with database access can read all sessions and prompts, and it discloses the debugging data too.
- **New admin endpoints:**
  - `GET /api/v1/admin/teams/:teamId/members` (identity only)
  - `POST /api/v1/admin/teams/:teamId/owner` (FR-8 Set new owner)
  - `DELETE /api/v1/admin/team-repos/:teamRepoId` (orphan team-link delete, replacing the admin path through the team route)
- **Changed responses:**
  - `GET /api/v1/admin/repos` now fills `teamName` for real `repositories` rows.
  - `GET /api/v1/teams` returns only the teams the caller belongs to, for admins too.
- **Client:** removes the "Private repo view" badge and all "Teams as Admin" / "View as Admin" / "Viewing as Admin" UI. Adds a "Set new owner" dialog to Admin → Teams.
- **User-facing texts:** rewrites the Data Collection Notice, the disclosure bullets, the security-hardening help and the README. The notice's consent hash changes, so every user re-consents once; this is by design.
- **DB:** no schema change, no migration.

## Reference

- Requirements: [requirements.md](requirements.md)
- Answered questions: [open_questions_ru.md](open_questions_ru.md)
- Research archive: [research/findings-1.md](research/findings-1.md)

## Design Decisions

### Access rules (server)

1. **Personal and team routes:**
   - Personal route (no `teamId`): only the `repositories` row owner passes, whatever their role.
   - Team route (`teamId`): team membership plus team policy only, with no role override.
2. **`assertRepoOwnerOrAdmin`** is renamed `assertRepoOwnerOrTeamOwner`. It does the same check minus `user.role !== 'admin'`.
3. **`TeamOwnerOrAdminGuard`** without its admin branch is byte-identical to `TeamOwnerGuard`. Its three routes switch to `TeamOwnerGuard`, and the guard file is deleted.
4. **`listTeams(userId)`** drops the `isAdmin` parameter and the all-teams branch. Responses keep `isMember: true`, so old clients keep working.
5. **`getMembers`:** only the team owner sees `disclosureAcknowledgedAt`.
6. **Invitations:** `sendInvitation` / `cancelInvitation` lose the `inviterRole` / `callerRole` admin override. Their message becomes "Only the team owner…".
7. **`SessionsService.deleteSession`** becomes owner-only. The `requesterRole` parameter is removed, and the controller stops passing it.
8. **Session raw-logs route:** the gate becomes `sessionOwnerRow?.userId !== user.id`. The team-owner / trainer / transparent rules after it are unchanged.
9. **Non-member admin opening `#/repos/<id>`:** the server answers 403, and the client keeps its existing "No access" empty state (`RepositoryView.tsx:283-297`). No new UI.
10. **Out of scope:**
    - `GET /api/v1/repositories` keeps listing repos whose logs the caller authored (`repositories.controller.ts:357-387`). This is not an admin rule.
    - Debugging and operational data (requirements FR-1 "Privacy boundary") is not touched:
      - `GET /admin/upload-queue/:id/file` and its "Download file" button, together with contract rows F09-file*, S-INGEST-04 step 1 and the logger / NDJSON-parser messages, all stay as they are.

### Admin panel

11. **Admin Repos `teamName`:** for a real `repositories` row, `teamName` is `string_agg(t.name, ', ' ORDER BY t.name)` over `team_repositories tr JOIN teams t` where `tr.repo_url = repositories.repo_url`. It is `null` when no team links the URL.
    - Real rows never carry `teamId` / `teamRepoId`. Those fields keep marking orphan rows (`id === null`).
12. **Orphan row delete:** orphan rows (a `team_repositories` link with no `repositories` row) are deleted through the new `DELETE /api/v1/admin/team-repos/:teamRepoId`.
    - `AdminService.removeOrphanTeamRepo(teamRepoId)` deletes that `team_repositories` row only if no `repositories` row has the same `repo_url`. `team_repo_config` goes by FK cascade.
    - It returns 404 when the link is missing or is not an orphan. A linked repo with data stays deletable only through `DELETE /admin/repos/:id`.
13. **FR-8 Set new owner:**
    - `AdminService.getTeamMembers(teamId)` returns `{ userId, email, isOwner }[]`, ordered by email. It returns 404 for an unknown team.
    - `AdminService.setTeamOwner(teamId, userId)` returns 404 for an unknown team, then calls `TeamsService.transferOwnership(teamId, <current ownerId>, userId)`. That returns 400 "New owner must be a current team member" for a non-member. The method returns the updated team row.
    - The previous owner stays a member (existing behaviour). The body reuses `TransferOwnershipDto` (`{ userId: number }`).
    - `AdminModule` imports `TeamsModule`, which already exports `TeamsService`, with a plain import. `AdminModule` is not part of the Teams↔Logs `forwardRef` cycle. Use `forwardRef(() => TeamsModule)` only if Nest reports an undefined import at boot.

### Texts (FR-7)

14. **Data Collection Notice:** replace the "Who can see it" section of `client/public/help/data-collection-notice.md` with exactly the text below. The identify-only wording is unconditional, so no new placeholder or `HelpModal` substitution is needed.

    ```markdown
    ## Who can see it

    - **Your own repositories are private to you.** In LogHub, their sessions, prompts and
      transcripts are visible only to you, whatever role anyone else holds in LogHub.
    - **Repositories shared into a team follow that team's access mode.** In a `transparent` team
      every member can read your sessions, including your prompts. In a `restricted` team the team
      owner and members holding the ADLC trainer role can read your sessions and prompts, members
      holding the manager role see your sessions and their statistics but not your prompt text, and
      other members do not see your sessions.
    - **Administrators get no access to session data through their admin role.** The admin panel
      covers users, retention and system settings and shows only counts and totals (sessions,
      tokens, cost). An administrator sees your team sessions only through a role they hold in
      that team, like anyone else.
    - **Anyone with access to the LogHub database can read everything.** The rules above describe
      what the LogHub application shows. Whoever has direct access to the LogHub database or
      server — typically the people who operate it — can read all stored sessions of all users,
      including every prompt and transcript, regardless of these rules. Debugging data is not
      covered by these rules either: administrators can download the raw file of an upload that is
      queued or failed to process, and server logs may contain fragments of session data.
    - **Administrators can reset your password.** An admin can issue a password-reset link for any
      account; whoever uses that link can sign in as you.
    - **Identify-only sign-in does not verify identity.** If this server runs without passwords
      (identify-only sign-in), whoever signs in with your email address acts as you and sees what
      you see.
    ```

15. **`DISCLOSURE_RESTRICTED_BULLETS`** (`client/src/viewer/lib/access-mode-copy.ts:43-48`):
    - Bullet 0 becomes `'The team owner can read all of your sessions, including your prompts.'`
    - Append a 5th bullet: `'Application administrators get no access through their admin role — only through a role they hold in this team.'`
    - The transparent bullets do not change.
16. **`security-hardening.md` l.281-282 and `README.md` l.198:** replace "admin … can read any session's logs" with "the admin role grants no access to session data in the app; admins see sessions only through their own repositories or a team role (server operators can still reach the database and logs directly)".

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/src/logs/repositories.service.ts` | drop the admin bypass (l.158-160); rename `assertRepoOwnerOrAdmin` (l.201-220); fix doc comments l.140, 309-312, 356, 424-428, 512-514, 537-540 | DD 1, 2 |
| `server/src/logs/repositories.controller.ts` | raw-logs gate l.1808-1836; export-scope l.2296-2307; recompute l.2318-2342; comments l.140-150, 1658-1669 | DD 8 |
| `server/src/logs/repository-export-import.controller.ts` | callers l.243, 266, 321, 360, 415, 481 → `assertRepoOwnerOrTeamOwner` | DD 2 |
| `server/src/logs/repository-export-import.service.ts` | comment l.1020 → new name | DD 2 |
| `server/src/sessions/sessions.service.ts`, `sessions.controller.ts` | owner-only delete | DD 7 |
| `server/src/common/guards/team-access.guard.ts` | remove the admin branch l.40-43 | — |
| `server/src/common/guards/team-owner-or-admin.guard.ts` | **delete** | DD 3 |
| `server/src/teams/teams.controller.ts`, `teams.module.ts` | `TeamOwnerGuard` on the l.108/173/183 routes; `listTeams(user.id)`; drop the guard provider | DD 3, 4 |
| `server/src/teams/teams.service.ts` | `listTeams`, `getMembers`, `sendInvitation`, `cancelInvitation`, comment l.978-979 | DD 4-6 |
| `server/src/admin/admin.service.ts` | `teamName` on real rows; `getTeamMembers`, `setTeamOwner`, `removeOrphanTeamRepo`; inject `TeamsService` | DD 11-13 |
| `server/src/admin/admin-panel.controller.ts` | 3 new routes | API changes |
| `server/src/admin/admin.module.ts` | import `TeamsModule` | DD 13 |
| `client/src/viewer/pages/repository/RepositoryHeader.tsx` | remove the badge l.25-27 | FR-5 |
| `client/src/viewer/pages/repository/RepositoryView.tsx` | remove `isAppAdmin` (l.93-112) | — |
| `client/src/viewer/pages/repository/SessionDetailPane.tsx` | drop admin from `canSeeRawLogs` (l.124) and from the Delete button (l.342) | — |
| `client/src/viewer/components/AppLeftNav.tsx` | remove `adminOnlyTeams`, `adminSectionOpen` and the "Teams as Admin" accordion | keep the l.153/361 Admin Panel link |
| `client/src/viewer/pages/teams/TeamsPage.tsx` | remove `AdminTeamCard`, the "View as Admin" badge, the "Teams as Admin" section and roleLabel `'Admin'` | — |
| `client/src/viewer/pages/teams/TeamDetailPage.tsx` + `tabs/TeamMembersTab.tsx`, `TeamRepositoriesTab.tsx`, `TeamInvitationsTab.tsx` | remove `viewingAsAdmin` and the `isAdmin` prop | — |
| `client/src/models/admin.ts` | `AdminTeamMember`; `AdminRepo.teamName?: string \| null` | API changes |
| `client/src/viewer/api.ts` | `fetchAdminTeamMembers`, `setAdminTeamOwner`, `removeAdminOrphanTeamRepo`; fix comments l.1345, 1376 | — |
| `client/src/viewer/pages/admin/tabs/AdminReposTab.tsx` | orphan delete via the new admin route | DD 12 |
| `client/src/viewer/pages/admin/tabs/AdminSetTeamOwnerDialog.tsx` | **new** — FR-8 dialog | Visual/UX notes |
| `client/src/viewer/pages/admin/tabs/AdminTeamsTab.tsx` | Actions column with "Set new owner" | — |
| `client/src/viewer/lib/access-mode-copy.ts` | bullets | DD 15 |
| `client/src/models/teams.ts` l.33, `pages/teams/tabs/members/TeamMemberRow.tsx` l.23 | doc comments without the admin wording | — |
| `client/public/help/data-collection-notice.md` | notice text | DD 14 |
| `client/public/help/security-hardening.md`, `README.md` | wording | DD 16 |
| KB: `authorization-and-authentificaiton.md`, `server-endpoint-map.md`, `api-reference.md`, `client-component-map.md`, `ui-principles.md`, `legacy-design-decisions-map.md`, `upload-queue.md`, `session-export-import.md` | access-model docs | FR-7 |
| `docs/qaa-overview/scenarios/01-auth-access-admin.md`, `02-repos-sessions.md`, `03-session-view-reports-golden.md`, `05-api-db-contract.md` | scenario design docs follow the new model | FR-7 |
| `server/test/contract/registry/` f08, f10, f11, f12, f13, f14, f17, f18, f20, f21, f23 | contract rows | Test coverage plan |
| `tests/scenarios/` s-acc-01, s-sess-12, s-slife-06, s-slife-08, s-repo-07, s-repo-12 (comment only), s-team-02, s-adm-01 | scenario steps | Test coverage plan |
| `tests/e2e/repo-panel.spec.ts` | remove 2 legacy badge tests | — |

## API changes

All admin routes sit under the existing class guards `SessionAuthGuard, AdminGuard` (`admin-panel.controller.ts:48-49`).

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/v1/admin/teams/:teamId/members` | GET | `teamId` int | 200 `AdminTeamMember[]` = `{ userId: number; email: string; isOwner: boolean }[]`, ordered by email; 404 unknown team; 403 non-admin |
| `/api/v1/admin/teams/:teamId/owner` | POST, `@HttpCode(200)` | body `TransferOwnershipDto` `{ userId: number }` | 200 updated team row `{ id, name, ownerId, createdAt, accessMode }`; 400 not a member; 404 unknown team; 403 non-admin |
| `/api/v1/admin/team-repos/:teamRepoId` | DELETE, `@HttpCode(204)` | `teamRepoId` int | 204; 404 missing or not an orphan (DD 12); 403 non-admin |
| `/api/v1/admin/repos` | GET | — | real rows gain `teamName: string \| null` (DD 11); orphan rows unchanged |
| `/api/v1/teams` | GET | — | admins get only their own teams (same shape as other users, `isMember: true`) |

Status changes for a non-member admin:

- **Team routes now 403:** `GET /teams/:teamId`, `/members`, `/repositories`, invitations, acknowledge-disclosure, remove member, and unlink / remove team repo.
- **Repo, session, report, analytics and export-import routes now 403:** on someone else's personal repo and on the team route.
- **`DELETE /sessions/:sessionId` now 403** for someone else's session.

## Test coverage plan

Only two of the three allowed kinds apply (CLAUDE.md → Test policy). No algorithm doc covers access control, so there are no algorithm tests.

### API contract (`server/test/contract/registry/`)

- **Flip existing rows:**
  - F10-list-admin → `{ status: 200, bodyText: '[]' }`. The world-v1 admin (id 1) is in no team.
  - F10-get-admin → 403.
  - F11-remove-admin → 403, with no write.
  - F18-delete-by-admin → 403, with no write.
  - F08-repos: the read SQL gains `team_name` (DD 11) and the field `teamName: 'team_name'`.
- **New rows (admin vs data), all → 403:**
  - Admin on R3 and on R1 personal routes: GET repo, summary and contexts (f14); session list, branches and logs (f17).
  - Admin on R1 with `?teamId=@T1.id`: f17 list.
  - Admin export-scope and recompute-all-sessions on R1, personal and `?teamId=@T1.id` (`f17-sessions.ts`), and the export/import routes on R1 (`f23-export-import.ts`).
  - Admin on R1 for one analytics route (`F20-timeline-admin`, mirroring `F20-timeline-outsider`) and one report route (`F21-executive-summary-admin`, mirroring `F21-executive-summary-outsider`).
  - Admin on a T2 invitation (f13).
  - Admin unlink / remove team repo (f12).
- **New routes (f08):**
  - **Set owner:**
    - admin, T1 → member: 200, with a write delta on `teams` row T1, `owner_id` → `@member.id`
    - admin → outsider: 400
    - unknown team (999): 404
    - member actor: 403
  - **Team members:**
    - admin: 200, with a read oracle `{ userId, email, isOwner }` from `team_members JOIN users`
    - unknown team (999): 404
    - member actor: 403
  - **Orphan delete:**
    - admin on link 1 (R1 url, not an orphan): 404
    - member actor: 403
    - The 204 path is covered by the S-ADM-01 step, because world-v1 has no orphan link.

### Scenario (extend existing; no new file)

- **S-ACC-01** step 4 → "ADMIN: every read of the foreign repo → 403, no prompt text" (AC-1).
- **S-SESS-12** step 6 → the admin gets no Raw Logs tab and no prompt; the API returns 403 with and without `teamId`.
- **S-SLIFE-06** step 6: admin DELETE → 403.
- **S-SLIFE-08** setup: the delete is done by the owner.
- **S-REPO-07** l.182: admin settings `?teamId` → 403.
- **S-TEAM-01:** follows the bullets through their constants; no edit.
- **S-TEAM-02:**
  - Non-member admin: absent from `GET /teams`; 403 on team detail, members, repositories and session list (AC-4 and the AC-9 403s).
  - Admin invited as a plain member: sees exactly what m1 sees, and `disclosureAcknowledgedAt` is null for them (AC-5, DD 5).
  - UI step: no "Teams as Admin", "View as Admin" or "Viewing as Admin" (AC-6).
- **S-ADM-01:**
  - New step: the admin sets a new owner from Admin → Teams; picking a non-member returns 400 through the API (AC-9).
  - New step: the Repos tab shows an orphan team link with no links in the row, and the admin deletes it (AC-3).
- **AC-2 / AC-6, owner side:** covered by existing owner steps staying green (S-ACC-01 step 1, S-REPT-01 step 6a `users=all`). `isAppAdmin` never gated the owner's `?users=all` toggle.
- **Legacy `tests/e2e/repo-panel.spec.ts`:** delete the two "Private repo view" badge tests (l.128-153).

## Visual/UX notes

- **Admin → Teams:**
  - A new last column, "Actions", holds a `size="sm"` `variant="outline"` button, "Set new owner", on each row.
  - The dialog (`ui/dialog`) has the title "Set new owner — <team name>" and the line "Current owner: <ownerEmail>".
  - It contains a `<select>` with the same classes as `TeamMembersTab.tsx:190-201` and the placeholder "Select member…", listing non-owner members by email.
  - Buttons: "Cancel" / "Set owner".
  - States: "Loading members…"; "This team has no other members." (Set owner disabled); an inline `text-destructive` error.
  - On success the dialog closes and `['admin-teams']` is invalidated.
- **Admin → Repos:** the columns are unchanged. Team now shows names for linked real rows, and rows contain no links.
- **Removed UI:**
  - left-nav "Teams as Admin" accordion
  - Teams page "View as Admin" badge and section
  - team detail "Viewing as Admin" banner
  - repository header "Private repo view" badge
- No wireframe changes needed.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Repo & session access checks | 7 | core FR-6 fix |
| 2 | Team access | 6 | guards + TeamsService |
| 3 | Admin panel API | 5 | needs chunk 2 (`TeamsService`) |
| 4 | Client: remove admin browsing UI | 7 | needs chunks 1-2 server behaviour |
| 5 | Client: admin panel | 5 | needs chunk 3 routes |
| 6 | Texts | 5 | after UI |
| 7 | KB & design docs | 6 | after code settles |
| 8 | Tests: contract registry | 7 | — |
| 9 | Tests: scenarios (access) | 7 | — |
| 10 | Tests: scenarios (admin panel, legacy) | 4 | — |

### Chunk 1 — Repo & session access checks
- [ ] `server/src/logs/repositories.service.ts`: delete the admin early return l.158-160; rewrite the doc comment l.140 to state per-route rules (Design Decision 1).
- [ ] Same file: rename `assertRepoOwnerOrAdmin` → `assertRepoOwnerOrTeamOwner`, drop `&& user.role !== 'admin'` (l.208), update its doc comment; update the six callers in `repository-export-import.controller.ts` (l.243, 266, 321, 360, 415, 481) and the comment at `repository-export-import.service.ts:1020`.
- [ ] Same file: rewrite admin-justifying comments at l.309-312, 356, 424-428, 512-514, 537-540 to say the personal route is owner-only.
- [ ] `repositories.controller.ts` l.1808-1836: gate becomes `sessionOwnerRow?.userId !== user.id`; update comments l.1808, 1819-1820, 1835-1836 to drop admin references.
- [ ] `repositories.controller.ts` export-scope l.2296-2307 and recompute-all-sessions l.2318-2342: remove `user.role !== 'admin' &&`; update comments to "team owner" only.
- [ ] `repositories.controller.ts`: reword admin comments at l.140-150 (`teamScopeUserFilterSql`) and l.1658-1669 (`assertSessionVisibleBySessionId`).
- [ ] `server/src/sessions/sessions.service.ts` `deleteSession` (l.78-112): remove `requesterRole` param and the admin override (l.108); update caller `sessions.controller.ts:42`.

### Chunk 2 — Team access
- [ ] `server/src/common/guards/team-access.guard.ts`: remove the admin branch l.40-43 and narrow the `user` type to `{ id: number }`.
- [ ] `teams.controller.ts`: replace `TeamOwnerOrAdminGuard` with `TeamOwnerGuard` on the routes at l.108, 173, 183; delete `server/src/common/guards/team-owner-or-admin.guard.ts`; remove it from `teams.module.ts` providers/imports.
- [ ] `teams.service.ts` `listTeams` (l.84-126): drop `isAdmin` param and admin branch (Design Decision 4); `teams.controller.ts:45` calls `listTeams(user.id)`.
- [ ] `teams.service.ts` `getMembers` (l.232-267): `canSeeAcknowledgement = caller !== undefined && caller.id === team.ownerId`; update doc comment.
- [ ] `teams.service.ts` `sendInvitation` (l.684) and `cancelInvitation` (l.798-801): remove the role override and the role parameters plus their controller arguments; message "Only the team owner…".
- [ ] `teams.service.ts` l.978-979: rewrite the "An app admin passes TeamAccessGuard" comment.

### Chunk 3 — Admin panel API
- [ ] `admin.module.ts`: add `TeamsModule` to `imports` per Design Decision 13; inject `TeamsService` into `AdminService`.
- [ ] `admin.service.ts` `getRepos`: add `teamName` to real rows per Design Decision 11 (sub-select in the select list); keep orphan rows unchanged; extend `RepoRow` type.
- [ ] `admin.service.ts`: add `getTeamMembers(teamId)` and `setTeamOwner(teamId, userId)` per Design Decision 13.
- [ ] `admin.service.ts`: add `removeOrphanTeamRepo(teamRepoId)` per Design Decision 12.
- [ ] `admin-panel.controller.ts`: add `GET teams/:teamId/members`, `POST teams/:teamId/owner` (`@HttpCode(200)`, `TransferOwnershipDto`), `DELETE team-repos/:teamRepoId` (`@HttpCode(204)`), all with `ParseIntPipe`, per API changes.

### Chunk 4 — Client: remove admin browsing UI
- [ ] `RepositoryHeader.tsx`: delete the "Private repo view" badge (l.25-27) and any now-unused imports/props.
- [ ] `RepositoryView.tsx` l.93-112: remove `isAppAdmin` from `canSeeTeamWideTabs` and `showRestrictedNotice`; fix the l.95 comment.
- [ ] `SessionDetailPane.tsx`: remove `user?.role === 'admin' ||` from `canSeeRawLogs` (l.124) and from the Delete-button condition (l.342).
- [ ] `AppLeftNav.tsx`: remove `adminSectionOpen` (l.41), `adminOnlyTeams` (l.29-30 default and comment, l.74-76, l.93-97 effect) and the "Teams as Admin" accordion (l.255-283); keep `isAdmin` for the Admin Panel link (l.153, 361).
- [ ] `TeamsPage.tsx`: remove roleLabel `'Admin'` (l.23), `AdminTeamCard` (l.51-60), `adminOnlyTeams` (l.83-86), the "View as Admin" badge (l.94-96), the section l.124-131; empty state checks `myTeams` only.
- [ ] `TeamDetailPage.tsx`: remove `isAdmin`, `viewingAsAdmin` and the "Viewing as Admin" banner (l.40, 49-59); stop passing `isAdmin` (l.74, 84, 92).
- [ ] `TeamMembersTab.tsx` (`canRemove={isOwner}`), `TeamRepositoriesTab.tsx` (`canRemove = isOwner`), `TeamInvitationsTab.tsx` (cancel when `isOwner`): drop the `isAdmin` prop from each.

### Chunk 5 — Client: admin panel
- [ ] `client/src/models/admin.ts`: add `AdminTeamMember { userId: number; email: string; isOwner: boolean }`; change `AdminRepo.teamName` to `teamName?: string | null`; widen the `AdminReposTab.tsx` l.94 cell cast to `string | null | undefined`.
- [ ] `client/src/viewer/api.ts`: add `fetchAdminTeamMembers(teamId)`, `setAdminTeamOwner(teamId, userId)`, `removeAdminOrphanTeamRepo(teamRepoId)` following `removeAdminRepo`.
- [ ] `AdminReposTab.tsx` l.33-37: orphan branch calls `removeAdminOrphanTeamRepo(row.teamRepoId!)`; drop the `removeTeamRepository` import.
- [ ] Create `AdminSetTeamOwnerDialog.tsx` (props `team: AdminTeam`, `open`, `onOpenChange`): `useQuery(['admin-team-members', team.id], enabled: open)`, select of non-owner members, mutation `setAdminTeamOwner`, states per Visual/UX notes.
- [ ] `AdminTeamsTab.tsx`: add `actions` column (`enableSorting: false`, `enableGlobalFilter: false`) rendering a "Set new owner" button that opens `AdminSetTeamOwnerDialog`.

### Chunk 6 — Texts
- [ ] `client/public/help/data-collection-notice.md`: replace the "Who can see it" section with the exact text in Design Decision 14.
- [ ] `client/src/viewer/lib/access-mode-copy.ts`: update `DISCLOSURE_RESTRICTED_BULLETS` per Design Decision 15.
- [ ] `client/public/help/security-hardening.md` l.281-282 and `README.md` l.198: wording per Design Decision 16.
- [ ] Doc comments `client/src/models/teams.ts:33`, `client/src/viewer/api.ts:1345, 1376`, `TeamMemberRow.tsx:23`: acknowledgement is visible to the team owner only; drop admin-sees-all phrasing.
- [ ] `client/src/viewer/pages/repository/RepositoryView.tsx` l.95 comment: drop "app admin" wording if Chunk 4 left any.

### Chunk 7 — KB & design docs
- [ ] `docs/knowledgebase/authorization-and-authentificaiton.md`: rewrite §"What the app-level admin bypass…" (l.375-387) as "The admin role grants no data access" (Design Decisions 1-8, plus the privacy boundary of Design Decision 10); l.411-413 per Design Decision 2, l.425-427 per Design Decision 1, l.441-443 per Design Decision 8; list the three new admin routes.
- [ ] `server-endpoint-map.md` / `api-reference.md`: document the three new admin routes and `teamName` (API changes); fix guard legend l.28 and admin notes at endpoint-map l.444, 459, 740, 762, 834, 840, 841, 848, 850; api-reference l.1058-1166, 2386, 2588, 2621-2623.
- [ ] `client-component-map.md`: l.141, 399, 460-461 per Chunks 4-5; add `AdminSetTeamOwnerDialog`.
- [ ] `ui-principles.md` l.26-28: remove the "Context badge — personal route" rule; `legacy-design-decisions-map.md` l.38: mark T-7 badge "removed (2026-10-21-private-repo-visibility)".
- [ ] `upload-queue.md` l.64-66: note the staged-file download is debugging data outside the privacy boundary (Design Decision 10); `session-export-import.md`: "owner-or-team-owner gate".
- [ ] `docs/qaa-overview/scenarios/01-auth-access-admin.md` (S-ACC-01 step 4 per Chunk 9; S-TEAM-07 l.521-538 rewritten as "non-member admin: no team in `GET /teams`, 403 on team routes; Set new owner only via Admin → Teams"; l.379 per Design Decision 15), `02-repos-sessions.md` l.92-93, 432, `03-…golden.md` S-SESS-12 step 6, `05-api-db-contract.md` l.25, 148.

### Chunk 8 — Tests: contract registry
- [ ] `f10-teams-core.ts`: F10-list-admin → `expect: { status: 200, bodyText: '[]' }` (drop `read`); F10-get-admin → `expect: { status: 403 }`.
- [ ] `f11-team-members.ts` F11-remove-admin (reword its l.133 `TeamOwnerOrAdminGuard` comment to `TeamOwnerGuard`) and `f18-session-delete-retention.ts` F18-delete-by-admin → `expect: { status: 403 }`, remove `write`.
- [ ] `f08-admin-repos-teams.ts` F08-repos: add `team_name` sub-select per Design Decision 11 and field `teamName: 'team_name'`.
- [ ] `f08-admin-repos-teams.ts`: add rows for the three new admin routes per Test coverage plan → New routes.
- [ ] `f14-repositories.ts`, `f17-sessions.ts`: add `*-admin` 403 rows mirroring the existing `*-outsider` rows (R1 personal, R1 `?teamId=@T1.id`, R3).
- [ ] `f17-sessions.ts` (export-scope, recompute-all-sessions on R1, personal and `?teamId=@T1.id`) and `f23-export-import.ts` (export/import routes on R1): add admin 403 rows.
- [ ] `f12-team-repos.ts` (unlink/remove), `f13-invitations.ts` (T2 invitation), `F20-timeline-admin` in `f20-analytics.ts`, `F21-executive-summary-admin` in `f21-reports.ts`: add admin 403 rows mirroring the `*-outsider` rows.

### Chunk 9 — Tests: scenarios (access)
- [ ] `tests/scenarios/auth/s-acc-01.spec.ts` step 4: admin GETs every path in `reads` → 403 and no response contains `sessions[0].prompt`; rename the step; update header comment.
- [ ] `tests/scenarios/view/s-sess-12.spec.ts` step 6: admin opens the session → no `tab-session-raw-logs`, no `FIRST_PROMPT`; `logsPath()` and `logsPath(teamId)` → 403.
- [ ] `tests/scenarios/sessions/s-slife-06.spec.ts` step 6 (l.137-138): admin DELETE → 403 and the session stays; `s-slife-08.spec.ts` l.58, 88: perform the child delete as the owner.
- [ ] `tests/scenarios/repos/s-repo-07.spec.ts` l.182: admin GET settings `?teamId` → 403.
- [ ] `tests/scenarios/auth/s-team-02.spec.ts`: new step — non-member admin: team absent from `GET /api/v1/teams`; 403 on team detail, members, repositories, session list `?teamId`, invitation create, remove member, unlink team repo.
- [ ] `s-team-02.spec.ts`: new step — an admin invited and accepted as a plain member gets the same session list and prompt visibility as m1; their `GET /teams/:id/members` rows have `disclosureAcknowledgedAt` null (Design Decision 5).
- [ ] `s-team-02.spec.ts`: new UI step — the non-member admin (via `browserAs`) sees no "Teams as Admin" in the left nav and no "View as Admin" on `#/teams`; `#/teams/<id>` shows no "Viewing as Admin" and no member list.

### Chunk 10 — Tests: scenarios (admin panel, legacy)
- [ ] `tests/scenarios/auth/s-adm-01.spec.ts`: new step — teamOwner invites `regular`; admin opens Admin → Teams, "Set new owner" → `regular`; `GET /api/v1/teams/:id` as regular shows `ownerId === regular.id`; API set-owner to a non-member → 400.
- [ ] `s-adm-01.spec.ts`: new step — teamOwner links a never-uploaded URL; Admin → Repos shows it with the team name and no link; admin deletes it; row gone.
- [ ] `tests/scenarios/repos/s-repo-12.spec.ts` l.8 header comment: `assertRepoOwnerOrAdmin` → `assertRepoOwnerOrTeamOwner`.
- [ ] `tests/e2e/repo-panel.spec.ts`: delete the two "Private repo view" badge tests (l.128-153).
