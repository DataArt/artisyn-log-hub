# T-15: Session User Filtering — Personal & Team Views

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-06-16

## Description

Two related session-list filtering improvements:

1. **Personal repo view** (`#/repos/:id`, no `teamId`) — the session list currently shows all sessions uploaded to the repo, which may include sessions from other users. In personal view the list must be limited to sessions belonging to the currently logged-in user only (matched on `userEmail`).

2. **Team repo view** (`#/teams/:tid/repos/:rid`, with `teamId`) — add a user-filter control below the existing session view-type selector. The control has two modes:
   - **"Only mine" toggle** (default off) — when on, shows only the current user's sessions.
   - **User picker** (multi-select dropdown) — lists all team members by email; selecting one or more filters the session list to those users. Picker and toggle are mutually exclusive: activating one resets the other.

## Functional Requirements

- **Personal view filter:** when `teamId` is absent, `SessionListPanel` (or `RepositoryView`) filters the fetched `RepositorySession[]` client-side, keeping only rows where `session.userEmail === currentUser.email`. No API change required.
- **Team view user control:** rendered below the session view-type selector in `SessionListPanel`. Only visible when `teamId` is present.
  - "Only mine" is a toggle button (single click). When active, applies `userEmail === me` filter client-side.
  - User picker is a multi-select control listing all team members fetched from `GET /api/v1/teams/:teamId/members`. When one or more emails are selected, filters the session list to those users client-side.
  - Toggling "Only mine" clears any picker selection. Selecting a user in the picker deactivates "Only mine".
  - When neither is active, all sessions are shown (team default — unchanged behaviour).
- Current user email is read from `useAuth()` → `user.email`.
- Team members are fetched with `useQuery(['team-members', teamId])` → `GET /api/v1/teams/:teamId/members`; cached; not re-fetched on every render.

## Non-Functional Requirements

- Filtering is client-side only — no new API query params needed for this feature.
- The user picker must handle teams with many members (use a searchable dropdown if >10 members, plain list if ≤10).
- No visual regressions on the personal repo view (badge, header, session list).

## Acceptance Criteria

- [ ] Personal repo view (`#/repos/:id`) shows only sessions where `userEmail` matches the logged-in user's email.
- [ ] Personal repo view session count in the header still reflects the unfiltered server count (from `/summary`), not the filtered list length — the filter is local to the list panel.
- [ ] Team repo view (`#/teams/:tid/repos/:rid`) shows all team sessions by default (no change).
- [ ] "Only mine" toggle appears below the view-type selector in team view only.
- [ ] Activating "Only mine" hides sessions from other users; deactivating restores all.
- [ ] User picker appears beside (or below) the "Only mine" toggle in team view; lists all team member emails.
- [ ] Selecting one or more users in the picker shows only their sessions.
- [ ] Selecting a user in the picker deactivates "Only mine"; activating "Only mine" clears picker selection.
- [ ] User picker is not shown in personal repo view.
- [ ] `npm run build` — zero errors.
- [ ] `npm lint` — zero errors.
- [ ] Playwright screenshot confirms layout alignment, no glitches.

## Open Questions

- Should the "Only mine" default be `on` in team view, or `off`? (Current requirement: `off` — show all by default.)
- If a team has no sessions for the selected user, display a proper empty state ("No sessions for this user").
