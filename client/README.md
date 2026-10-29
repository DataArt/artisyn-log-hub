# Artisyn Log Hub — web client

The browser application of Artisyn Log Hub: session browser, log viewer, analytics, reports, the admin
panel and the in-app help. It is a single-page React app built with Vite. In production the server
serves the built files; in development Vite serves them and proxies the API to the server.

> **Disclaimer.** This project is not affiliated with or endorsed by Anthropic, Cursor or GitHub.
> "Claude" and "Claude Code" are trademarks of Anthropic.

## Requirements

- [Bun](https://bun.sh) — the client's package manager and script runner. `bun.lock` is the only
  lockfile; do not use `npm install` here.
- A running server on `http://localhost:3000` for `bun run dev` (see [server/README.md](../server/README.md)).

## Setup

```sh
cd client
bun install
```

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Dev server on http://localhost:5173. `/api`, `/static` and `/health` are proxied to `http://localhost:3000`. |
| `bun run build` | Production bundle in `client/dist/`, plus precompressed `.br`/`.gz` copies (`scripts/precompress.cjs`). |
| `bun run preview` | Serves `client/dist/` locally. |
| `bun run test` | Vitest, single run. |
| `bun run test:watch` | Vitest in watch mode. |
| `bun run typecheck` | `tsc` type check. `vite build` strips types without checking them, so run this before you commit. |
| `bun run lint` | ESLint with auto-fix (cache in `../tmp/`). |
| `bun run format` | Prettier over `src/`. |

The full product build (`npm run build` at the repository root) runs the client build and copies the
result into `dist/public/`.

## Structure

| Path | Contents |
|---|---|
| `index.html` → `src/main.tsx` | Entry point. Hash-routed SPA. |
| `src/viewer/pages/` | One folder per page: `login`, `signup`, `main`, `repository`, `admin`, `api-keys`, `teams`, `hook-state`, plus the email-confirmation and password-reset pages. |
| `src/viewer/components/` | Shared app components (shell, navigation, dialogs, tooltips). |
| `src/viewer/ui/` | The app's own UI primitives, built on Radix UI. |
| `src/viewer/lib/` | Viewer logic: formatting, cost math, chart helpers, feature flags. |
| `src/viewer/hooks/`, `src/viewer/context/` | React hooks and context providers. |
| `src/viewer/help/` | The in-app help: modal, link handler and the article index, which reads `../user-docs/nav.json` (alias `@loghub/user-docs`). Article bodies are the Markdown pages in the repo-root `user-docs/`; edit them there. |
| `src/viewer/api.ts` | All HTTP calls to the server. |
| `src/models/` | TypeScript types of the API responses the client uses. |
| `src/lib/` | Small shared helpers. |
| `src/viewer/__tests__/`, `src/test/` | Vitest unit and component tests and their setup. |
| `public/` | Static files copied as-is. `public/help/*.md` is generated from `user-docs/` by `scripts/user-docs/generate-help.js` (the `predev`/`prebuild` scripts) and gitignored — never edit it. |

The `@/*` import alias points at `src/viewer/*`.

## Configuration

The client has no runtime configuration; it talks to the server it is served from. Build-time feature
flags (`VITE_*`) are described in `.env.example` and `src/viewer/lib/feature-flags.ts`. Put local
values in the gitignored `client/.env.local`.

## Tests

- Runner: Vitest (the `test` block in `vite.config.ts`).
- Files: `src/**/*.{test,spec}.{ts,tsx}`.
- Setup: `src/test/setup.ts` and `src/viewer/__tests__/setup-vitest.ts`.

The browser end-to-end tests (Playwright) live in `tests/e2e/` at the repository root and drive the
running dev app.

## Licence

MIT — see [LICENSE](../LICENSE). Third-party packages are listed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
