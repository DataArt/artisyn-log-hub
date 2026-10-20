---
name: post-impl-check-indexes
description: "Post-implementation check: database index audit — missing indexes on foreign keys and frequently filtered columns."
argument-hint: <task-folder-name>
---

You are performing a database index audit of the schema changes introduced by a task.

Task: $ARGUMENTS

**Locate the changed files** (skip if the caller already provided them): read the task's
`impl-plan.md` — glob `docs/tasks/todo/$ARGUMENTS/impl-plan.md`, fallback
`docs/tasks/done/$ARGUMENTS/impl-plan.md`. Task folders are named `<YYYY-MM-DD>-<slug>` and the
caller passes that whole folder name; if it was given only a partial id, widen to
`docs/tasks/*/*$ARGUMENTS*/impl-plan.md`. (Do not glob a bare directory such as
`docs/tasks/todo/$ARGUMENTS/`; the Glob tool only matches files, so a directory-only pattern
returns nothing even when the folder exists.) Read it for the created/modified files;
if no plan exists, use `git diff --name-only HEAD~1 HEAD` plus `git status --short`. Focus on:

- Migration files — in this repo, `server/drizzle/migrations/`. Look for `CREATE TABLE`,
  `ALTER TABLE`, `ADD COLUMN`, existing `CREATE INDEX` statements.
- Entity/model/schema files — column definitions, relation decorators, foreign key fields.
- Repository/service files — `WHERE`, `ORDER BY`, `JOIN ON` conditions referencing specific columns.

## Audit categories

**Foreign Key Columns Without Indexes**
- Any foreign-key column (e.g., `userId`, `repositoryId`, `sessionId`) with no corresponding index in a migration
- Note: PostgreSQL does NOT auto-create indexes on foreign keys (MySQL does)

**Columns Used in WHERE Clauses Without Indexes**
- Columns referenced in `WHERE` conditions in repository queries that lack an index
- Frequently queried filter columns (status, type, date ranges)

**Columns Used in ORDER BY Without Indexes**
- `ORDER BY` columns lacking an index, especially combined with filtering (composite index may be needed)
- Default sort columns on list endpoints that always sort by the same field

**Composite Index Opportunities**
- Columns always queried together in the same `WHERE` clause — a composite index beats two separate ones
- Columns appearing together in both `WHERE` and `ORDER BY` (covering index opportunity)

**Redundant Indexes**
- Indexes that are a prefix subset of an existing composite index; duplicate indexes on the same column

## Severity and reporting

- **HIGH**: missing index on a foreign key or high-traffic filter column that will cause full table scans at scale
- **MEDIUM**: missing index on a frequent ORDER BY or secondary filter column; suboptimal separate indexes where a composite fits
- **LOW**: redundant/duplicate index adding write overhead; minor optimization on a low-traffic path

Report each finding as `[SEVERITY] <file>:<line> — <description>`, including the suggested index
DDL or decorator (e.g. `CREATE INDEX idx_logs_session_id ON logs(session_id);`), then a one-line
count summary. If none: `No index issues found.`
