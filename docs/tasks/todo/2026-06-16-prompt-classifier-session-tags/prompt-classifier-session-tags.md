# T-17: Prompt Classifier — Auto-tag Sessions via `claude -p`

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook, server, client
**Owner:** denis.tsyplakov
**Created:** 2026-06-16

## Description

After a user submits a prompt in Claude Code, a `UserPromptSubmit` hook automatically classifies the prompt text by
running `claude -p "..."` and assigns one of the user-configured tags to the session. Tags are configured per-user (
stored on the server, fetched by the hook on first classification). Sessions can then be filtered and grouped by tag in
the viewer UI.

The classification happens as a side-effect — it does not block or modify the user's prompt. Running `claude -p` from a
hook spawns a non-interactive subprocess, so there is no recursion risk.

## Functional Requirements

### Hook (artisyn-hooks-installer)

- Add a `UserPromptSubmit` hook script that:
    1. Reads the user-configured tag list from the server (`GET /api/v1/tag-config`) — cached locally per session to
       avoid repeat fetches.
    2. Runs
       `claude -p "Classify this prompt into exactly one of the following tags: [tag list]. Prompt: [prompt text]. Reply with only the tag name, no extra text."`
       to obtain a tag.
    3. POSTs `{ sessionId, tag }` to `POST /api/v1/sessions/tag` using the configured API key.
    4. Runs fire-and-forget (does not delay prompt submission); log errors to stderr only.
- The hook is installed alongside the existing hooks by `artisyn-hooks-installer`.
- If the server returns an empty tag list or the endpoint is unreachable, the hook skips classification silently.

### Server

- **New table `tag_config`**: per-user ordered list of allowed tags (JSONB array of strings). One row per user.
  `PUT /api/v1/tag-config` upserts it; `GET /api/v1/tag-config` retrieves it.
- **Add `tag` column to `sessions` table** (nullable `varchar(64)`).
- **New endpoint `POST /api/v1/sessions/tag`** — authenticated by API key (`X-API-Key`):
    - Body: `{ sessionId: string; tag: string }`.
    - Validates tag is in the caller's `tag_config` list; ignores unknown tags (returns 200).
    - Upserts the `tag` column on the matching `sessions` row.
- Expose `tag` field on `RepositorySession` (returned by `GET /api/v1/repositories/:repoId/sessions`).
- Add optional `tags` query param (comma-separated) to `GET /api/v1/repositories/:repoId/sessions` for server-side
  filtering.
- Propagate `tag` field through the analytics timeline endpoint (`TimelineSession`).
- Add optional `tags` filter param to `GET /api/v1/repositories/:repoId/analytics/timeline`.
- `GET /api/v1/tag-config` must be accessible with a session cookie (for client settings UI) AND with an API key (for
  the hook).

### Client

- **Tag Config settings panel** (e.g. a new tab or section in the API Keys / Settings page):
    - Add / remove / reorder tags (plain text list; names ≤ 32 chars, alphanumeric + hyphen/space).
    - Saved via `PUT /api/v1/tag-config`.
- **Session list**: show a small tag badge on each session row when `tag` is set.
- **Filter by tag**: add a tag multi-select control to the session list filter bar; passes `?tags=` to the sessions
  endpoint.
- **Group by tag**: add "Group by tag" option alongside existing group-by controls.

## Non-Functional Requirements

- Tag classification must not add latency to prompt submission (async/fire-and-forget).
- The `claude -p` call in the hook should use `--max-tokens 20` (or equivalent) to keep classification fast and cheap.
- Avoid storing prompt text on the server; only the resulting tag is persisted.
- Tag list fetch in the hook should be cached for the duration of the Claude Code session (e.g. env-var or temp file
  keyed on session ID) to avoid an HTTP call per prompt.

## Acceptance Criteria

- [ ] After submitting a prompt in Claude Code, the session in the viewer shows the classified tag (within a few
  seconds, asynchronously).
- [ ] `GET /api/v1/tag-config` returns the user's configured tags; `PUT /api/v1/tag-config` saves them; client settings
  UI reflects the change after save.
- [ ] Session list filter by tag narrows the list correctly; sessions without a tag are excluded when any tag filter is
  active.
- [ ] Session list "Group by tag" accordion groups sessions correctly.
- [ ] If the hook cannot reach the server or `claude -p` fails, Claude Code prompt submission is unaffected (no error
  surface to user).
- [ ] The hook is installed via `artisyn-hooks-installer` alongside existing hooks.
- [ ] Server rejects a tag value not present in the user's `tag_config` list (returns 200 but does not write the tag).
- [ ] `npx vitest run` and `npx playwright test` remain fully green.
- [ ] `npm run build` and `npm lint` pass with zero errors.

## Open Questions

- Should the tag list also be sourced from a team-level config (like `repo_config`) or is per-user sufficient for now? A: Yes team only. 
- Should there be a "no tag" option in the group-by view, or only sessions with a tag are shown when grouping is active? A: yes add no tag option
- Should the hook classification run on every prompt turn or only the first prompt of a new session? A: On every prompt turn

## Notes

<!-- Append timestamped notes here as work progresses -->
