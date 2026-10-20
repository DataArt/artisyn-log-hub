---
name: post-impl-check-security-no-auto
description: "Security audit of a task's code changes: XSS, SQL injection, auth flaws, exposed secrets, CSRF, XXE. Manual-only (-no-auto): run when explicitly asked."
argument-hint: <task-folder-name>
---

You are performing a security audit of the code changes introduced by a task.

Task: $ARGUMENTS

**Locate the changed files** (skip if the caller already provided them): read the task's
`impl-plan.md` — glob `docs/tasks/todo/$ARGUMENTS/impl-plan.md`, fallback
`docs/tasks/done/$ARGUMENTS/impl-plan.md`. Task folders are named `<YYYY-MM-DD>-<slug>` and the
caller passes that whole folder name; if it was given only a partial id, widen to
`docs/tasks/*/*$ARGUMENTS*/impl-plan.md`. (Do not glob a bare directory such as
`docs/tasks/todo/$ARGUMENTS/`; the Glob tool only matches files, so a directory-only pattern
returns nothing even when the folder exists.) Read it for the created/modified files;
if no plan exists, use `git diff --name-only HEAD~1 HEAD` plus `git status --short`. Read each
identified file, focusing on server routes/controllers/services/middleware, client components/forms/
API calls, migrations, and config.

## Audit categories

**XSS (Cross-Site Scripting)**
- Unescaped user input rendered directly in HTML templates
- `innerHTML`, `dangerouslySetInnerHTML`, or equivalent without sanitization
- User-controlled data inserted into URLs or CSS without encoding

**SQL Injection**
- Raw string interpolation or concatenation in SQL queries (e.g., `WHERE id = ${userId}`)
- Use of `eval()` or similar with query strings
- Dynamic table/column names built from user input

**Authentication Flaws**
- API endpoints missing authentication guards (e.g., no `@UseGuards()`, no JWT verification)
- Missing role checks on admin or privileged endpoints
- Insecure session handling or token storage
- Hardcoded bypass conditions (e.g., `if (user === 'admin')`)

**Exposed Secrets**
- Hardcoded passwords, API keys, tokens, or connection strings in source code
- Secrets committed to non-environment-variable locations
- Debug credentials left in code

**CSRF (Cross-Site Request Forgery)**
- State-changing endpoints (POST, PUT, DELETE, PATCH) missing CSRF protection
- Missing `SameSite` cookie attributes
- Missing `Origin` or `Referer` validation on sensitive endpoints

**XXE (XML External Entity)**
- XML parsing without disabling external entity resolution
- Use of `libxml`, `DOMParser`, or similar without safe configuration

**Insecure Deserialization**
- `JSON.parse()` on untrusted input without validation
- Object deserialization from user-controlled data without schema validation

**Path Traversal**
- File paths constructed from user input without normalization or sandboxing
- Missing checks that resolved paths stay within intended directories

## Severity and reporting

- **CRITICAL**: direct exploitation possible (SQL injection in a live query, hardcoded production secret, unauthenticated admin endpoint)
- **HIGH**: significant vulnerability requiring specific conditions (XSS in a user-facing form, missing auth on a sensitive non-admin endpoint)
- **MEDIUM**: defense-in-depth issues (missing CSRF on low-impact endpoint, verbose errors leaking internals)

Report each finding as `[SEVERITY] <file>:<line> — <description>`, then a one-line count summary.
If none: `No security issues found.`
