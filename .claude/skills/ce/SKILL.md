---
name: ce
description: "Use when researching code structure in server/ or hook/ — who calls a function, which controller serves an HTTP route, how projects depend on each other. Uses the CodeExplorer (`ce`) code graph instead of grep, but only where it was measured to beat grep; skip it for client React code, text/string search and docs."
---

# ce — CodeExplorer code graph

`ce` (a dotnet global tool, `ce help`) indexes the repo into a graph (functions, types, endpoints,
calls, projects) under `.codeexplorer/`. It is optional: if `ce` is not on PATH, skip this skill
silently and use grep / WebStorm MCP.

## Setup / refresh

- Workspace is already initialised in the repo root (`.codeexplorer/settings.json` holds the
  excludes; the DB `graph.db` is ignored by `.codeexplorer/.gitignore`). On a fresh clone without
  it: `ce init loghub`, then copy the excludes below.
- The index does **not** auto-update. Before the first `ce` query in a session (and after you
  changed the files you are about to query) refresh it — a full rescan takes ~20 s:
  `timeout 180 ce scan --clear > /dev/null 2>&1`
  Always wrap it in `timeout`: ce 1.48.6 once hung forever at
  "PostIndexAnalyzer: Normalizing architectural edges" (with `.claude/` fixtures indexed).
- Excludes (`.codeexplorer/settings.json → exclude`): `.claude/**`, `.artisyn/**`,
  `artisyn-hooks-installer/**`, `dist/**`, `tmp/**`, `docs/**` — otherwise skill fixtures (C#/Java
  sample projects) and the dogfooded hook copy pollute results with duplicates.

## Use ce for (measured: better than grep)

| Question | Command |
|---|---|
| Which controller/file serves route X | `ce search "auth identify" -k Endpoint` — resolves the global `/api/v1` prefix, returns `POST:/api/v1/auth/identify → server/src/auth/auth.controller.ts` |
| Who calls server method X (NestJS DI `this.service.x()`) | `ce callers validateUser` — returns the *calling method* (`AuthController.signup`), not just a line |
| Who calls a plain function across server/hook/packages | `ce callers normalizeToolName` (`--tests` to include tests) |
| Ad-hoc structural questions | `ce query "<cypher>" --no-truncate` (schema: `ce help`) |
| Project map | `ce status` |

## Do NOT use ce for (measured: worse than grep)

- **Client React components** — many `export function X({...})` components are not indexed at all
  and JSX usage `<X/>` / `lazy(() => import(...))` is not a call: `ce callers RepoToolsTab` returns
  nothing while it is used in two places. Use grep / WebStorm MCP.
- Literal strings, config keys, SQL text, comments, docs — grep.
- `ce contracts` — hung > 60 s on this repo; don't use.

## Caveats when reading results

- `callers` matches **by name across projects**: functions with the same name in different
  places (e.g. the hook's plain-JS copy vs `packages/tool-monitor`) are merged. Check the project
  column / path before trusting it.
- The `Location` line in `callers` is the **start of the calling function**, not the call site.
- Treat results as a lead, not proof: when completeness matters (renames, removing a function),
  confirm with grep — ce can miss call sites.
