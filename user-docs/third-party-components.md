# Third-Party Components & Licenses

Artisyn Log Hub is built on open-source software. This page lists every third-party component that
is part of the delivered product — what runs on the server, what runs in your browser, and what
installs into your project — with what each one does and the license it ships under.

Build and development tooling is not listed: compilers, bundlers, linters, formatters, test
runners and type definitions are not part of the product.

## Infrastructure

| Component | Version | License | Role |
|---|---|---|---|
| PostgreSQL | 18.4 | PostgreSQL License | The only datastore — holds all sessions, telemetry, users, teams and repository config. Runs as a separate service, not bundled into the application image. |
| `plpgsql` | 1.0 | PostgreSQL License | PostgreSQL's built-in procedural language, used by migrations. The only installed database extension. |
| Node.js | 24.22.1 | MIT (bundled: V8 — BSD-3-Clause, OpenSSL — Apache-2.0, ICU — Unicode-3.0) | Runtime for the server process and for the telemetry hook on your own machine. |
| Alpine Linux (`node:24.22.1-alpine` base) | 3.x | Mixed (musl libc MIT, BusyBox GPL-2.0, other packages MIT/BSD) | Base operating system inside the container. |
| Docker / Docker Compose | host-provided | Apache-2.0 | Runtime platform — the product is delivered and run as a Docker image. |

## Server

The application server: HTTP API, authentication, log ingestion, analytics queries and
scheduled jobs.

| Package | Version | License | Role |
|---|---|---|---|
| `@nestjs/core`, `@nestjs/common` | 11.1.22 | MIT | Application framework — dependency injection, modules, controllers. |
| `@nestjs/platform-express` | 11.1.22 | MIT | Binds NestJS to the Express HTTP server. |
| `@nestjs/config` | 4.0.4 | MIT | Loads and validates environment configuration. |
| `dotenv` | 17.4.2 | BSD-2-Clause | Loads the `.env` file at server start and in the database tooling (migrations, seed). |
| `@nestjs/passport` | 11.0.5 | MIT | Wires the Passport authentication layer into NestJS. |
| `@nestjs/schedule` | 6.1.3 | MIT | Cron scheduling for background jobs (session retention purge, attribution runs). |
| `@nestjs/serve-static` | 5.0.5 | MIT | Serves the built web client and static assets. |
| `@nestjs/terminus` | 11.1.1 | MIT | Health-check endpoint. |
| `drizzle-orm` | 0.45.2 | Apache-2.0 | Type-safe SQL query builder and schema definition for PostgreSQL. |
| `pg` | 8.21.0 | MIT | PostgreSQL client driver and connection pool. |
| `connect-pg-simple` | 10.0.0 | MIT | Stores HTTP sessions in PostgreSQL. |
| `express-session` | 1.19.0 | MIT | Server-side session cookies. |
| `passport` | 0.7.0 | MIT | Authentication middleware. |
| `passport-local` | 1.0.0 | MIT | Email-and-password authentication strategy. |
| `@azure/msal-node` | 7.1.0 | MIT | Azure Entra ID (SSO) sign-in flow. |
| `argon2` | 0.44.0 | MIT (bundles the Argon2 reference C implementation: CC0-1.0 OR Apache-2.0) | Password hashing (Argon2id). |
| `helmet` | 8.2.0 | MIT | Sets protective HTTP response headers. |
| `rate-limiter-flexible` | 11.2.0 | ISC | Rate limiting on login, sign-up and password-reset endpoints. |
| `class-validator` | 0.15.1 | MIT | Validates incoming request payloads. |
| `class-transformer` | 0.5.1 | MIT | Converts request payloads into typed objects. |
| `archiver` | 7.0.1 | MIT | Creates the zip archives for session export and log download. |
| `yauzl` | 3.4.0 | MIT | Reads the zip archives on session import. |
| `multer` | 2.4.0 | MIT | Receives the uploaded zip file on repository import. |
| `nodemailer` | 10.1.1 | MIT-0 | Sends confirmation and password-reset email. |
| `pino` | 10.3.1 | MIT | Structured application and SQL logging. |
| `pino-pretty` | 13.1.3 | MIT | Human-readable log formatting. |
| `rxjs` | 7.8.2 | Apache-2.0 | Observable streams used throughout NestJS interceptors and guards. |
| `reflect-metadata` | 0.2.2 | Apache-2.0 | Runtime type metadata that NestJS decorators rely on. |

Supporting packages shipped alongside them include `express`, `body-parser`,
`cookie-signature`, `pg-pool`, `pg-protocol` and `sonic-boom` (all MIT); `glob`, `minipass`,
`path-scurry`, `jackspeak` and `package-json-from-dist` (BlueOak-1.0.0, a permissive
OSI-approved license); and `type-fest` (MIT OR CC0-1.0).

## Web client

The browser application: session browser, log viewer, analytics and reports.

| Package | Version | License | Role |
|---|---|---|---|
| `react`, `react-dom` | 19.2.6 | MIT | UI framework. |
| `react-router-dom` | 7.18.4 | MIT | Client-side routing. |
| `@tanstack/react-query` | 5.100.14 | MIT | Server-data fetching, caching and background refresh. |
| `@tanstack/react-table` | 8.21.3 | MIT | Sorting, grouping and virtualization for data tables. |
| `radix-ui` | 1.4.3 | MIT | Accessible UI primitives (dialog, popover, tabs, tooltip) that the app's own components build on. |
| `tailwindcss` | 4.3.0 | MIT | Utility CSS framework — the entire visual style. |
| `tailwind-merge` | 3.6.0 | MIT | Resolves conflicting Tailwind classes when composing components. |
| `clsx` | 2.1.1 | MIT | Conditional CSS class composition. |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Defines component style variants (button sizes, badge colors). |
| `lucide-react` | 0.577.0 | ISC | Icon set. |
| `recharts` | 3.8.1 | MIT | Bar, line and area charts in analytics and reports. |
| `d3` | 7.9.0 | ISC | Scales, axes and layout math behind the custom visualizations. |
| `react-day-picker` | 10.0.1 | MIT | Calendar control for date-range pickers. |
| `react-markdown` | 10.1.0 | MIT | Renders markdown — prompts, assistant replies and these help articles. |
| `remark-gfm` | 4.0.1 | MIT | GitHub-flavored markdown support (tables, task lists) for the renderer above. |
| `rehype-slug` | 6.0.0 | MIT | Adds ids to help-article headings so links can jump to a section. |
| `github-slugger` | 2.0.0 | ISC | Turns heading text into those ids (used by `rehype-slug`). |
| `jszip` | 3.10.2 | MIT (dual-licensed MIT OR GPL-3.0-or-later; used under MIT) | Builds the zip files for in-browser session and statistics export. |
| `@react-pdf/renderer` | 4.5.1 | MIT | Generates PDF reports. |

Supporting packages include `victory-vendor` (MIT AND ISC, chart internals for Recharts), `pako`
(MIT AND Zlib, compression for JSZip), `png-js` (MIT, image decoding for the PDF renderer),
`robust-predicates` (Unlicense, geometry for D3) and `tslib` (0BSD).

The app's own UI primitives — buttons, dialogs, tables and so on — are written for this project
on top of Radix UI; no third-party source file is copied into the codebase. The app loads no web
fonts, analytics or CDN assets: every asset is served by the Log Hub server itself.

## Telemetry hook and installer

Both are delivered to you and installed into your own project.

| Component | Third-party dependencies | Role |
|---|---|---|
| Telemetry hook (bundled version 2.20.0) | **None** | Captures Claude Code session events in your project and uploads them. It uses only Node.js built-in modules, so installing it adds no third-party code to your project. |
| `artisyn-hooks-installer` 1.0.66 | **None** | The installer that puts the hook into a project. Ships as a single JavaScript file. |

## Summary

**606** unique packages make up the delivered product's dependency set — the server and client
dependencies plus everything they pull in transitively. The telemetry hook and its installer add
nothing, having no third-party dependencies at all. The full list, with the licence text of every
non-MIT package, is in `THIRD_PARTY_NOTICES.md` at the root of the source repository.

| Count | License |
|---:|---|
| 513 | MIT (including `jszip`, used under MIT) |
| 57 | ISC |
| 16 | Apache-2.0 |
| 6 | BSD-3-Clause |
| 4 | BSD-2-Clause |
| 4 | BlueOak-1.0.0 |
| 1 | MIT-0 |
| 1 | 0BSD |
| 1 | Unlicense |
| 1 | MIT AND ISC |
| 1 | (MIT AND Zlib) |
| 1 | (MIT OR CC0-1.0) |
