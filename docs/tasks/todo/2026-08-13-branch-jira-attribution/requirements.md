# T-97: Branch Attribution to JIRA Task/Epic

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):**
**Owner:** denis.tsyplakov
**Created:** 2026-08-13

## Description

Add attribution to task and epic for a branch — a branch can relate to a task tracker (JIRA)
task, one task can relate to several branches, and there could be an epic with many
tasks/branches.

Scratched at high level; more details to follow.

## Functional Requirements

- Allow a branch to be associated with a JIRA task identifier.
- Allow a single JIRA task to be associated with multiple branches (one-to-many task→branches).
- Allow a JIRA epic to be associated with multiple tasks/branches (one-to-many epic→tasks, and
  transitively epic→branches).

## Acceptance Criteria

- [ ] A branch can be linked to a JIRA task, and that link is visible/retrievable.
- [ ] A JIRA task can have multiple branches linked to it without conflict.
- [ ] A JIRA epic can be linked to multiple tasks, and branches under those tasks are traceable
      back to the epic.

## Open Questions

- Where does this attribution live (branch naming convention, commit metadata, external mapping
  store, JIRA integration API)?
- Is this attribution used for reporting/telemetry only, or does it drive any automated behavior?
- How is the epic↔task↔branch hierarchy sourced — pulled from JIRA directly, or maintained
  manually in this repo?

## Notes

<!-- Append timestamped notes here as work progresses -->
