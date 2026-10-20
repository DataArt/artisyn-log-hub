---
name: post-impl-check-performance-no-auto
description: "Performance audit of a task's code changes: N+1 queries, slow operations, memory leaks, bundle size. Manual-only (-no-auto): run when explicitly asked."
argument-hint: <task-folder-name>
---

You are performing a performance audit of the code changes introduced by a task.

Task: $ARGUMENTS

**Locate the changed files** (skip if the caller already provided them): read the task's
`impl-plan.md` — glob `docs/tasks/todo/$ARGUMENTS/impl-plan.md`, fallback
`docs/tasks/done/$ARGUMENTS/impl-plan.md`. Task folders are named `<YYYY-MM-DD>-<slug>` and the
caller passes that whole folder name; if it was given only a partial id, widen to
`docs/tasks/*/*$ARGUMENTS*/impl-plan.md`. (Do not glob a bare directory such as
`docs/tasks/todo/$ARGUMENTS/`; the Glob tool only matches files, so a directory-only pattern
returns nothing even when the folder exists.) Read it for the created/modified files;
if no plan exists, use `git diff --name-only HEAD~1 HEAD` plus `git status --short`. Read each
identified file, focusing on repository/service query logic, controllers/routes (pagination,
filtering), frontend components (render logic), and `package.json` dependency changes.

## Audit categories

**N+1 Queries**
- Loops (`.forEach`, `for...of`, `.map`) that call repository methods or make DB queries inside each iteration
- Loading related entities one at a time instead of using JOIN or eager loading
- Sequential `await` calls inside a loop that could be batched with `Promise.all`

**Missing Pagination on List Endpoints**
- List endpoints (`GET /resource`) that return all records without `.take()`, `.limit()`, `LIMIT`, or pagination parameters
- Missing `page`/`limit` or `cursor` query parameters on list routes

**Synchronous Operations That Should Be Async**
- CPU-intensive operations blocking the event loop (large data transformations, sorting, parsing)
- File system reads done synchronously (`readFileSync`, `existsSync` in request paths)
- Synchronous cryptographic operations on large data

**Memory Leaks**
- Event listeners added without corresponding cleanup (`.removeEventListener`, `.off`, `useEffect` cleanup)
- Closures holding large arrays or buffers beyond their useful lifetime
- Streams not properly closed; intervals/timeouts not cleared on component destruction

**Expensive Computations in Render Functions (Frontend)**
- Complex filtering/sorting/mapping computed directly in render without memoization
- Large transformations recalculated on every render tick
- Missing `useMemo` (or equivalent) for expensive derived values

**Large Bundle Additions**
- New dependencies that are known to be large when a lighter alternative exists
- Entire libraries imported when only one function is needed
- Dynamic imports missing for lazy-loadable routes or heavy components

**Missing Database Query Result Limits**
- Queries without `.take()`, `LIMIT`, or equivalent that could return unbounded result sets
- Aggregation queries running over entire tables without date/scope filters

## Severity and reporting

- **HIGH**: direct throughput/scalability impact under real load (N+1 in a list endpoint, unbounded result set on a hot path, leak in a long-running service)
- **MEDIUM**: noticeable degradation under moderate load or large data (sync file read in request path, missing pagination on a growing table, expensive render computation)
- **LOW**: limited-impact optimization opportunity (suboptimal import style, missing memoization on a rarely-rendered component)

Report each finding as `[SEVERITY] <file>:<line> — <description>`, then a one-line count summary.
If none: `No performance issues found.`
