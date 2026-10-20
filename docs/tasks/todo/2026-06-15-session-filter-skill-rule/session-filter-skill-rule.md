# T-12: Session List — Filter by Skill or Rule

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** client, server
**Owner:** denis.tsyplakov
**Created:** 2026-06-15

## Description

Users want to narrow the session list to only sessions that used a specific skill (e.g. `use-playwright`, `task-tracker`)
or loaded a specific rule file (e.g. `server.md`, `client.md`). Currently the session list has no such filter.

Skills are tracked in claude log `skill_listing` and `invoked_skills` attachment entries. Rules are loaded via
`nested_memory` attachments whose `displayPath` contains `.claude/rules/`. Both data sources live inside the
`body` JSONB of the `logs` row with `log_type = 'claude'`.

## Functional Requirements

- The session list panel (`SessionListPanel.tsx`) gains two optional filter controls: **Skill** and **Rule**.
- Each filter is a multi-select dropdown (or tag-input) populated with distinct values available in the repo.
- Selecting one or more skills shows only sessions that used at least one of those skills (OR match).
- Selecting one or more rules shows only sessions that loaded at least one of those rules (OR match).
- Both filters can be combined (session must match skill filter AND rule filter).
- Clearing the filter restores the full list.
- Filter values are derived from the sessions already loaded (client-side filtering is acceptable if the full
  session list is small; server-side filtering is preferred for large repos).
- Skill names come from `attachment.names` array in `skill_listing` entries and `attachment.skills[].name` in
  `invoked_skills` entries in the claude log body.
- Rule names come from the `displayPath` basename of `nested_memory` attachments whose path contains
  `.claude/rules/` (e.g. `server.md`, `client.md`).

## Non-Functional Requirements

- Filter dropdowns must not cause a network re-fetch unless server-side filtering is chosen.
- If server-side, add `skills` and `rules` query params (comma-separated) to
  `GET /api/v1/repositories/:repoId/sessions` and keep the existing branch/user-filter pattern.
- Skill and rule extraction from JSONB must not degrade the sessions list query beyond 200 ms (p95) for a
  repo with 500 sessions; use pre-computed columns or a CTE scan with a limit.

## Acceptance Criteria

- [ ] Skill filter dropdown appears in the session list toolbar; it is populated with all distinct skill names
      used across sessions in the current repo/team view.
- [ ] Rule filter dropdown appears alongside the skill filter; populated with distinct rule basenames.
- [ ] Selecting a skill hides sessions that did not invoke that skill; selecting multiple skills uses OR logic.
- [ ] Selecting a rule hides sessions that did not load that rule; combining with skill filter uses AND logic.
- [ ] Clearing the filter (×) returns the unfiltered list immediately.
- [ ] Both filters render correctly on desktop (≥1280 px) with no overflow or alignment glitches.
- [ ] Vitest unit tests cover the extraction logic (skill names from `skill_listing`/`invoked_skills`,
      rule names from `nested_memory`) when implemented client-side.
- [ ] If server-side: Playwright E2E test selects a skill filter and asserts the list is narrowed.

## Open Questions

- **Client vs server filtering:** The `RepositorySession` returned by `/sessions` does not include skills or
  rules. Two options:
  - (A) Pre-compute `skills_used` and `rules_loaded` string arrays on the `logs` row at ingest time
        (new migration + ingest-time extraction from the claude log body) and pass them through the API.
  - (B) Client-side: load all sessions, then fetch the session summaries (or a lightweight parse of each log)
        to build the filter index — viable only for small repos.
  - Option A is strongly preferred; Option B is a fallback for MVP.
- **Distinct-values endpoint:** Should a new endpoint
  `GET /api/v1/repositories/:repoId/skills` (and `/rules`) return distinct values, or should they be derived
  from the session list payload?
- **Rule display names:** Rules from `nested_memory` have a `displayPath` like `..\.claude\rules\server.md`.
  Should the filter show the basename (`server.md`) or the full display path?

## Notes

<!-- Append timestamped notes here as work progresses -->
