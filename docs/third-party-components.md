---
title: Third-Party Components and Licenses
generated: 2026-09-02
scope: artisyn-log-hub — shipped product only (no build or development tooling)
---

# Third-Party Components and Licenses

Inventory of every third-party component that is **part of the delivered product** — what runs in
the container, what runs in the user's browser, and what installs into the user's project — with
the role each one plays and the license it ships under.

**Build and development tooling is deliberately out of scope.** TypeScript, Vite, Bun, ncc,
ESLint, Prettier, Jest, Vitest, Playwright/Chromium, the Nest CLI, drizzle-kit, all `@types/*`
packages, the `*-win32-x64-msvc` native shims and the CI runner never reach a user and are not
listed here. Their licenses are all MIT/Apache-2.0/ISC; if a full audit of the toolchain is ever
needed, regenerate it with the procedure in §6 pointed at `devDependencies`.

**Verification method** — license values were read from the `license` field of each package's own
installed `package.json` under `node_modules` (not from a registry lookup or from memory), and
every missing or non-obvious value was resolved by reading the package's actual `LICENSE` file.
The PostgreSQL version was read from a live `select version()`.

The user-facing version of this inventory is the **Data and security → Third-Party Components** help
article (`user-docs/third-party-components.md`, also published on the site); keep the two in sync.

---

## 1. Infrastructure

| Component | Version in use | License | Role |
|---|---|---|---|
| **PostgreSQL** | **18.4** (Debian build `18.4-1.pgdg13+1`) | PostgreSQL License (permissive, BSD/MIT-style) | The only datastore — sessions, telemetry, users, teams, repo config. Runs as an external service: it is *not* declared in `docker-compose.yml`; the app reaches it via `DATABASE_URL`. |
| `plpgsql` (PostgreSQL extension) | 1.0 | PostgreSQL License (ships with core) | Default procedural language, used by migrations. The **only** installed extension — no third-party PG extension is used. |
| **Node.js** | 24.22.1 (`node:24.22.1-alpine`) | MIT (bundled: V8 — BSD-3-Clause, OpenSSL — Apache-2.0, ICU — Unicode-3.0) | Runtime for the server process and for the telemetry hook on the user's machine. |
| **Alpine Linux** (`alpine` base) | 3.x | Mixed (musl libc MIT, BusyBox GPL-2.0, other packages MIT/BSD) | Base operating system inside the container. |
| **Docker / Docker Compose** | host-provided | Apache-2.0 | Runtime platform — the product is delivered and run as a Docker image. |

---

## 2. Server runtime dependencies (`server/package.json` → `dependencies`)

Bundled into `dist/` by `ncc`, so all of these ship inside the image.

| Package | Version | License | Role |
|---|---|---|---|
| `@nestjs/core` | 11.1.22 | MIT | Framework core — DI container, module graph, lifecycle |
| `@nestjs/common` | 11.1.22 | MIT | Decorators, pipes, guards, interceptors |
| `@nestjs/platform-express` | 11.1.22 | MIT | Express HTTP adapter |
| `@nestjs/config` | 4.0.4 | MIT | Env-var loading and typed config access |
| `@nestjs/passport` | 11.0.5 | MIT | Passport integration for the auth guards |
| `@nestjs/schedule` | 6.1.3 | MIT | Cron jobs — session retention purge, attribution runs |
| `@nestjs/serve-static` | 5.0.5 | MIT | Serves the built SPA and `/static` assets |
| `@nestjs/terminus` | 11.1.1 | MIT | `/health` endpoint |
| `drizzle-orm` | 0.45.2 | Apache-2.0 | SQL query builder + schema definitions (PostgreSQL dialect) |
| `pg` | 8.21.0 | MIT | PostgreSQL driver and connection pool |
| `connect-pg-simple` | 10.0.0 | MIT | PostgreSQL-backed HTTP session store |
| `express-session` | 1.19.0 | MIT | Session cookie middleware |
| `passport` | 0.7.0 | MIT | Authentication middleware |
| `passport-local` | 1.0.0 | MIT | Email/password strategy (auth Modes 2/3) |
| `@azure/msal-node` | 2.16.3 | MIT | Azure Entra ID OAuth flow (auth Mode 4) |
| `argon2` | 0.44.0 | MIT (bundles the Argon2 reference C implementation, dual **CC0-1.0 OR Apache-2.0**) | Argon2id password hashing |
| `helmet` | 8.2.0 | MIT | Security response headers |
| `rate-limiter-flexible` | 11.2.0 | ISC | Rate limiting on auth and upload routes |
| `class-validator` | 0.15.1 | MIT | DTO validation |
| `class-transformer` | 0.5.1 | MIT | Plain-object → DTO instance conversion |
| `archiver` | 7.0.1 | MIT | Zip creation — session export, log archive download |
| `yauzl` | 3.4.0 | MIT | Zip reading — session import |
| `nodemailer` | 9.0.4 | MIT-0 | Outbound SMTP — email confirmation, password reset |
| `pino` | 10.3.1 | MIT | Structured app + SQL logging |
| `pino-pretty` | 13.1.3 | MIT | Dev-readable log formatting |
| `pino-roll` | 4.0.0 | MIT | Daily log-file rotation |
| `rxjs` | 7.8.2 | Apache-2.0 | Observables used by NestJS interceptors/guards |
| `reflect-metadata` | 0.2.2 | Apache-2.0 | Decorator metadata that NestJS DI depends on |

Notable transitives bundled with the above: `express`, `body-parser`, `cookie-signature`,
`pg-pool`, `pg-protocol` and `sonic-boom` (all MIT); `glob`, `minipass`, `path-scurry`,
`jackspeak` and `package-json-from-dist` (BlueOak-1.0.0, a permissive OSI-approved license);
`type-fest` (MIT OR CC0-1.0); and `pause` (MIT).

---

## 3. Web client runtime dependencies (`client/package.json` → `dependencies`)

Bundled into the SPA served from `dist/public`, subject to tree-shaking.

| Package | Version | License | Role |
|---|---|---|---|
| `react` / `react-dom` | 19.2.6 | MIT | UI framework and DOM renderer |
| `react-router-dom` | 7.18.2 | MIT | Hash-based client routing |
| `@tanstack/react-query` | 5.100.14 | MIT | Server-state fetching, caching, background polling |
| `@tanstack/react-table` | 8.21.3 | MIT | Table sorting/grouping/virtualization |
| `radix-ui` | 1.4.3 | MIT | Headless a11y primitives underneath `viewer/ui/*` |
| `tailwindcss` | 4.3.0 | MIT | Utility CSS framework |
| `tailwind-merge` | 3.6.0 | MIT | Conflict resolution when composing Tailwind classes |
| `clsx` | 2.1.1 | MIT | Conditional class-name composition |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Component style variants |
| `lucide-react` | 0.577.0 | ISC | Icon set |
| `recharts` | 3.8.1 | MIT | Bar/line/area charts in Analytics and Reports |
| `d3` | 7.9.0 | ISC | Scales, axes and layout math for custom visualizations |
| `d3-sankey` | 0.12.3 | BSD-3-Clause | Sankey layout for the tool-flow diagram |
| `date-fns` | 4.4.0 | MIT | Date formatting and arithmetic |
| `react-day-picker` | 10.0.1 | MIT | Calendar widget for `DateRangePicker` |
| `react-resizable-panels` | 4.11.2 | MIT | Drag-resizable split panes in the session view |
| `react-markdown` | 10.1.0 | MIT | Markdown rendering — prompts, replies, help articles |
| `remark-gfm` | 4.0.1 | MIT | GFM tables/task-lists for the markdown renderer |
| `rehype-slug` | 6.0.0 | MIT | Heading ids in help articles (anchor links) |
| `github-slugger` | 2.0.0 | ISC | Heading text → id slugs (dependency of `rehype-slug`) |
| `jszip` | 3.10.1 | (MIT OR GPL-3.0-or-later) — MIT elected, see §5 | Client-side zip building for session/statistics export |
| `@react-pdf/renderer` | 4.5.1 | MIT | PDF report generation |

Notable client transitives: `victory-vendor` 37.3.6 (`MIT AND ISC`, chart internals via
`recharts`), `pako` 1.0.11 (`MIT AND Zlib`, deflate via `jszip`), `png-js` 2.0.0 (MIT, via
`@react-pdf/renderer`), `robust-predicates` 3.0.3 (Unlicense, geometry via `d3`),
`tslib` 2.8.1 (0BSD).

The `client/src/viewer/ui/` primitives (`button.tsx`, `dialog.tsx`, `table.tsx`, …) are
**first-party code written for this repo**, composed on top of `radix-ui` — not a vendored copy of
shadcn/ui or any other package, and there is no `components.json`. No third-party source file is
vendored anywhere in `client/src` or `server/src` (a repo-wide scan for third-party
copyright/SPDX headers found none), and no web fonts, analytics or CDN assets are loaded —
`client/index.html` references only the local favicon.

---

## 4. Telemetry hook and installer

Both are delivered to users and installed into their own projects.

| Sub-project | Third-party runtime dependencies | Role and notes |
|---|---|---|
| `hook/` (bundled hook version 2.17.2) | **None** | Captures Claude Code session events in a user's project and uploads them. Deliberately dependency-free: every `require` in `hook/.claude/telemetry_tool/*.js` resolves to a Node built-in (`child_process`, `crypto`, `fs`, `http`, `https`, `net`, `os`, `path`, `zlib`) — that is what makes the hook installable into any project without an `npm install`. |
| `artisyn-hooks-installer/` (1.0.57) | **None** | The `npx` installer that places the hook into a project. Ships as `dist/index.js` only. |

### 4a. Documentation site renderer (build tooling, not shipped)

Root `devDependencies` used only by `scripts/site/build-site.mjs` (`npm run build:site`) to
pre-render `user-docs/` into the static GitHub Pages site. They never reach `dist/`, the image or
a user's project; they are listed here because the site they build is published.

| Package | Version | License | Role |
|---|---|---|---|
| `unified` | 11.0.5 | MIT | Processor pipeline for the markdown → HTML render |
| `remark-parse` | 11.0.0 | MIT | Markdown parser (mdast) |
| `remark-gfm` | 4.0.1 | MIT | GFM tables/task-lists in the site pages |
| `remark-rehype` | 11.1.2 | MIT | mdast → hast conversion |
| `rehype-slug` | 6.0.0 | MIT | Heading ids (github-slugger), same anchors as the in-app help |
| `rehype-stringify` | 10.0.1 | MIT | hast → HTML serialisation |

The site's "Why Log Hub" deck (`site/deck/index.html`) loads one more component in the visitor's
browser — not an npm dependency, not in `dist/`, the image or the in-app help:

| Component | Version | License | Role |
|---|---|---|---|
| reveal.js (from jsDelivr, pinned version + SRI `sha384`) | 5.2.1 | MIT | Slide engine of the site deck only (`reset.css`, `reveal.css`, `reveal.js`, notes plugin) |

---

## 5. The one non-permissive-license entry

| Component | License | Role | Note |
|---|---|---|---|
| `jszip` 3.10.1 | (MIT OR GPL-3.0-or-later) | In-browser zip building for session and statistics export | Dual-licensed by its author and used unmodified as a library; **MIT is the elected option**, so no GPL obligation arises. Record the election in any generated NOTICE file. |

Every other shipped component is under a standard permissive license — MIT, ISC, BSD, Apache-2.0,
MIT-0, 0BSD, BlueOak-1.0.0, Unlicense or CC0. The MPL-2.0 (`lightningcss`) and CC-BY-4.0
(`caniuse-lite`) components that appear in a full-tree audit are build-time only and are not part
of the delivered product.

---

## 6. Regenerating this document

The inventory is derived, not hand-maintained. To refresh it after a dependency change:

1. **Direct shipped dependencies** — read the `dependencies` (not `devDependencies`) blocks of
   `server/package.json` and `client/package.json`, and pull each resolved version and `license`
   from the matching installed `node_modules/<pkg>/package.json` (falling back from the
   sub-project's own `node_modules` to the hoisted root one).
2. **Shipped transitive closure and license histogram** — BFS from those direct dependencies,
   following each visited package's `dependencies` + `optionalDependencies` with Node's
   resolution order (own `node_modules`, then walk up), skipping `@types/*` (erased at build) and
   the `*-win32-x64-msvc` shims (not present in the Linux image). De-duplicate by `name@version`
   and histogram the `license` field.
3. **Resolve the outliers** — anything matching
   `/GPL|AGPL|LGPL|MPL|SSPL|CDDL|EPL|EUPL|CPAL|OSL|CC-BY|UNKNOWN|UNLICENSED/` should be checked
   against its actual `LICENSE` file; the `package.json` field is often absent or wrong.
4. **PostgreSQL** — `select version()` and `select extname, extversion from pg_extension`
   against the target database.
5. **Infrastructure** — re-read the `FROM` lines and any global `npm install -g` calls in
   `Dockerfile`.
6. **Sync the help article** — mirror any change into
   `user-docs/third-party-components.md` (the user-facing Data and security page; the in-app copy in
   `client/public/help/` is generated from it).

Write throwaway scripts under `tmp/` (gitignored), per `CLAUDE.md`. Node.js or PowerShell only.

---

## 7. Summary

### 7.1 License distribution across the shipped closure

**586** unique `name@version` packages make up the delivered product's dependency closure — the
`server/` and `client/` `dependencies` plus everything they pull in transitively. The telemetry
hook and its installer add nothing, having no third-party dependencies at all.

| Count | License |
|---:|---|
| 488 | MIT |
| 58 | ISC |
| 16 | Apache-2.0 |
| 10 | BSD-3-Clause |
| 4 | BlueOak-1.0.0 |
| 3 | BSD-2-Clause |
| 1 | MIT-0 |
| 1 | 0BSD |
| 1 | Unlicense |
| 1 | MIT AND ISC |
| 1 | (MIT AND Zlib) |
| 1 | (MIT OR CC0-1.0) |
| 1 | (MIT OR GPL-3.0-or-later) |

There is no AGPL, SSPL, LGPL, MPL, CDDL/EPL, commercial or proprietary component in the shipped
product, and no `UNLICENSED` third-party package. The single dual-licensed entry is `jszip`
(§5), used under its MIT option.

### 7.2 Known gaps

- The 586-package closure is an **upper bound**. The client build tree-shakes unused modules and
  `ncc` bundles only what the server's module graph actually imports, so some of these packages
  contribute no code to the final artifacts. Determining the exact set would require reading the
  build output's module manifest.
- Only license *fields* are inventoried, not full license *texts*. MIT/BSD/Apache-2.0 all ask for
  their copyright notices to be reproduced, so if Log Hub is ever distributed as a binary or a package a
  `NOTICE` / `THIRD-PARTY-LICENSES` bundle would need generating at build time from this closure.
- Versions are those resolved on a Windows development machine. The Linux image resolves the same
  packages with platform-specific native binaries substituted (all MIT).
