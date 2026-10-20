---
type: "Reference"
title: "Client Feature Flags (VITE_* build flags)"
description: "How to hide an unfinished client-only feature behind a VITE_* build flag: the feature-flags.ts parser, the .env/.env.local layering, and the rules for adding and removing a flag. No flag is currently defined."
tags:
  - client
  - config
timestamp: "2026-10-14T12:00:00+04:00"
---

# Client Feature Flags (`VITE_*` build flags)

## Purpose

A way to ship an unfinished client feature **hidden by default** and turn it on per developer
machine, without a server change, a DB column, or a per-user setting. Use it for work that is
merged but not presentable yet.

This is **not** an access-control mechanism — the flag is inlined into the bundle at build time,
so it is visible to anyone who reads the JS. It only decides whether the UI is *rendered*. Any
rule about *who may see data* still belongs on the server.

## Where it lives

**`client/src/viewer/lib/feature-flags.ts`** — the only place that should read a feature
`import.meta.env` var. It exports:

| Export | What it is |
|---|---|
| `parseBooleanFlag(raw: string \| undefined): boolean` | Pure parser. Only `1` / `true` / `yes` / `on` (trimmed, case-insensitive) return `true`; unset, empty, `false`, `0`, `off` or anything else returns `false`. |

Sibling module: `client/src/viewer/lib/settings.ts` holds env-derived *tuning values*
(`SESSION_POLL_INTERVAL_MS`), not on/off feature gates — keep flags here, numbers there.

**Default-off is the whole point.** The parser treats "unset" as `false`, so every build that does
not deliberately opt in — `npm run build` for dev/prod, CI, a fresh clone, a Docker image — hides
the feature. Never invert this by defaulting a flag to `true`.

## Current flags

None. The only flag so far (`VITE_ENABLE_TOKEN_FLOW`, which hid the Charts "Token Flow" sub-tab)
was removed together with that feature.

## How to enable one locally

`client/.env.local` — gitignored (`client/.gitignore` lists both `.env` and `.env.local`), loaded by
Vite *after* `.env`, so values there win:

```dotenv
VITE_ENABLE_MY_FEATURE=true
```

Vite inlines `import.meta.env` at build/dev-server start, so a changed `.env.local` needs the client
dev server to reload (Vite watches env files and restarts itself; a browser refresh alone is not
always enough). There is no way to flip a flag on an already-built bundle.

## Adding a flag

1. Export `MY_FEATURE_ENABLED = parseBooleanFlag(import.meta.env.VITE_ENABLE_MY_FEATURE)` from
   `feature-flags.ts`, with a comment saying why the feature is hidden and when the flag should go.
2. Document it in `client/.env.example` with `=false` and a comment saying why it is off — that file
   is the only discoverable list of what exists.
3. Read the constant **once**, at the highest component that owns the whole feature, and thread a
   boolean prop down — do not import the flag into every leaf.
4. If the feature persists a UI choice (a tab id in localStorage, say), make the reader refuse to
   restore it while the flag is off, so a viewer never lands on something that renders nothing.
5. Keep the removable-ness in mind: a flag is temporary scaffolding. Deleting it should mean
   deleting the constant, its `.env.example` line, and one `&&`.

## Effect on tests

- **vitest** — test gating as pure functions (`parseBooleanFlag`, a reader taking a boolean); no
  test should read `import.meta.env`.
- **Playwright** — a spec that drives a flagged feature needs the flag set in `client/.env.local` on
  the machine serving `localhost:5173`; say so at the top of the spec.
