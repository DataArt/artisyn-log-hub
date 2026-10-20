# T-16: Delete Repo — Personal Cleanup & Team Confirmation Dialogs

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** client | server
**Owner:** denis.tsyplakov
**Created:** 2026-06-16

## Description

Two related repo-management improvements:

1. **Personal view** — allow a user to delete a repo they own. Deleting removes:
   - The user's `repositories` row (which cascades through `log_repositories`).
   - All `logs` rows for that user that were linked to this repo.
   - If no other `repositories` row (and no `team_repositories` row) references the same `repo_url`, purge any remaining shared data completely.

2. **Teams view** — wrap both "Add repo" and "Remove repo" actions in a confirmation modal dialog before executing, preventing accidental mutations.

## Functional Requirements

### Personal view — Delete Repo
- A "Delete repo" action (button or context menu) is present in the personal repository view (e.g. `RepositoryView.tsx` header or settings area).
- Clicking it opens a confirmation dialog (use existing `confirm-dialog.tsx` / `dialog.tsx` primitive) showing the repo URL and warning that all associated logs will be deleted.
- On confirm, call `DELETE /api/v1/repositories/:repoId` (new endpoint).
- Server logic:
  1. Verify the authenticated user owns the repository (`repositories.user_id = currentUser.id`).
  2. Delete all `logs` rows for this user linked to this repo (via `log_repositories`).
  3. Delete the `repositories` row (CASCADE handles `log_repositories`).
  4. Check if any other `repositories` or `team_repositories` row references the same `repo_url`. If none exist, no further cleanup is needed (all data is already user-scoped).
- After deletion, navigate away from the deleted repo (back to the repo list / home).
- Invalidate the repository list query cache on success.

### Teams view — Confirmation Dialogs for Add & Remove Repo
- **Remove repo**: before calling `DELETE /api/v1/teams/:teamId/repositories/:repoId`, show a confirmation modal that names the repo URL being removed.
- **Add repo**: before calling `POST /api/v1/teams/:teamId/repositories`, show a confirmation modal asking the user to confirm the repo URL they are about to add.
- Both dialogs must have a primary "Confirm" action and a "Cancel" action. Cancel must not send any request.
- The relevant components are `TeamRepositoriesTab.tsx`.

## Non-Functional Requirements

- The confirmation dialogs must be consistent with the existing `confirm-dialog.tsx` UI primitive used elsewhere in the app.
- No new HTTP endpoints are added for the teams view (confirmation is purely client-side).
- The new `DELETE /api/v1/repositories/:repoId` endpoint must follow existing patterns in `server/src/logs/repositories.controller.ts` and `server-conventions.md`.

## Acceptance Criteria

- [ ] Personal view has a visible "Delete repo" trigger in the repository header/settings area.
- [ ] Clicking "Delete repo" shows a confirmation dialog with the repo URL and a data-loss warning.
- [ ] On confirm, the server deletes the user's logs linked to the repo and then removes the `repositories` row.
- [ ] After deletion, the client navigates away and the repo no longer appears in the left nav.
- [ ] Teams view "Remove repo" shows a confirmation dialog before sending the DELETE request.
- [ ] Teams view "Add repo" shows a confirmation dialog before sending the POST request.
- [ ] Cancelling any dialog sends no request and leaves the current state unchanged.
- [ ] `npm run build` — zero errors.
- [ ] `npm run lint` — zero errors.
- [ ] All existing tests pass; new tests cover the delete endpoint.

## Open Questions

- Should regular team members (non-owners) ever see a "delete" button in personal view? (Currently only the owning user's personal repos are shown in personal view, so this should be implicitly scoped correctly.)
- Should the personal delete also clean up `session_stats` and `session_file_stats` for sessions that belonged to the deleted logs? (Those cascade from `sessions`, which is weakly referenced — confirm cascade behaviour before implementing.)
