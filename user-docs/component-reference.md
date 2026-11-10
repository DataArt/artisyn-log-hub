# Artisyn Log Hub — Component Reference

This document describes the components that make up Artisyn Log Hub, what each one does, where
it runs, and how the components talk to each other. It covers the delivered product only; build
and development tooling is out of scope.

## 1. Product overview

Artisyn Log Hub collects telemetry from Claude Code sessions in software repositories and turns it
into a browsable history of sessions, cost and context analytics, and team-level reports.

The product has four deliverable parts:

| # | Component | Where it runs | Delivered as |
|---|---|---|---|
| 1 | **Log Hub server** (API + background jobs) | Server host, in a Docker container | Docker image `artisyn-log-hub` |
| 2 | **Web client** (single-page application) | The user's browser, served by the server | Part of the Docker image |
| 3 | **PostgreSQL database** | Server host, separate container | Official `postgres` image, referenced by `docker-compose.yml` |
| 4 | **Telemetry hook** and its **installer** | Each developer's machine, inside a project | Claude Code plugin, installed with `npx` from the server |

## 2. Architecture

```text diagram=architecture
 Developer machine                                   Server host (Docker)
 ┌────────────────────────────────────┐              ┌──────────────────────────────────┐
 │ Claude Code                        │              │  app container                   │
 │   │ hook events                    │   HTTPS/HTTP │  ┌────────────────────────────┐  │
 │   ▼                                │   x-api-key  │  │ Log Hub server (Node.js)   │  │
 │ Telemetry hook (plugin) ───────────┼─────────────►│  │  REST API /api/v1, /api/v2 │  │
 │   │ local files                    │              │  │  Upload queue + workers    │  │
 │   ▼                                │              │  │  Scheduled jobs            │  │
 │ .artisyn/ai_work_dir/…             │              │  │  Static web client         │  │
 │                                    │              │  └─────────────┬──────────────┘  │
 │ OTEL receiver (loopback only) ◄────┤ Claude Code  │                │ SQL             │
 │   127.0.0.1:<port>                 │ OTLP export  │  db container  ▼                 │
 └────────────────────────────────────┘              │  ┌────────────────────────────┐  │
                                                     │  │ PostgreSQL                 │  │
 Browser ── session cookie ─────────────────────────►│  └────────────────────────────┘  │
                                                     └──────────────────────────────────┘
```

Data flow in one sentence: the hook records events and transcripts on the developer's machine,
uploads them at the end of each turn with a per-user API key, the server queues and ingests them
into PostgreSQL, and users read the result through the web client.

## 3. Log Hub server

A NestJS application on Node.js 26 (the image uses `node:26.13.0-alpine`). It is the only process that talks to the database.

### 3.1 Process model

- The container starts a **cluster primary** (`CLUSTER_MODE=primary`) that forks HTTP worker
  processes (Node.js `cluster`). The worker count and the per-worker database pool size are
  derived from the available CPUs and `DB_POOL_MAX`.
- The server listens on port `3000` inside the container. The shipped `docker-compose.yml`
  publishes it on `127.0.0.1:5003` of the host only.
- Database migrations run automatically on startup.

### 3.2 Functional modules

| Module | Responsibility |
|---|---|
| **Auth** | Establishes user sessions in one of four modes (`AUTH_MODE`): none, password, password with email confirmation, Azure Entra ID (OAuth/OIDC). Login back-off, password change, account deletion. |
| **Users / Admin** | User management, roles (`admin`, `user`), admin panel APIs. |
| **API keys** | Per-user keys used by the hook. Keys are shown once and stored only as an Argon2id hash. |
| **Logs ingestion** | `POST /api/v2/logs` accepts uploads from the hook, with chunked and gzip-compressed transfer and deduplication. It is the only upload route for logs: the legacy `POST /api/v1/logs` was removed and returns `404`, so hooks older than 1.7.0 must be upgraded. Hooks 2.29.0 and newer also post OTEL records to `POST /api/v2/otel-realtime` while a session runs (best effort; the regular upload stays the durable copy). |
| **Upload queue** | Uploaded payloads are written to a disk-backed queue (`upload-queue/`) and processed by background workers with leases, retries and statistics (Admin → Upload Queue). |
| **Repositories / Sessions** | Session list, session detail, sub-agent trees, metrics, favourites, export/import of sessions as zip archives. |
| **Analytics & reports** | Burn rate, cost, cache, tool usage, change surface, harness usage and attribute reports. |
| **Teams / Invitations** | Teams, membership, per-team access modes (`restricted` / `transparent`), manager and ADLC-trainer roles, disclosure acknowledgement. |
| **Post-turn analysis** | Stores the results of the hook's optional Turn-End Cost Advisor and session attribution runs (`/api/v2/post-turn-analysis`, `/api/v2/session-attribution`, `/api/v2/turn-end-cost-advisor`). |
| **Model pricing** | Per-model token prices used for cost calculation. Anthropic model prices are fetched from Anthropic's public pricing page once a day (`MODEL_PRICING_FETCH_ENABLED=false` turns it off). Non-Anthropic prices can be imported from OpenRouter with an admin button. Admins can set prices for models that have none and override fetched prices (Admin → Model Pricing). Models seen in telemetry without a price are added automatically and flagged as unpriced. |
| **Session retention** | Background job that permanently purges sessions older than `SESSION_RETENTION_DAYS` (default 30). |
| **Installer distribution** | Serves the hook installer package and plugin tarball under `/static/` so projects install directly from their own server. |
| **System info / health** | `GET /health`, build information, cluster and worker status, AI tool version tracking. |
| **Server logs** | Structured pino logs with daily rotation under `logs/`, old files deleted hourly (5 days of app logs, 3 days of SQL logs, 100 MB in total by default); error log viewer and archive download in the admin panel. |
| **Mail** | SMTP delivery for confirmation, password reset and password-changed notifications. Mode 3 (`password-confirm`) requires `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` and a relay reachable at startup, or the server does not start. Mode 2 (`password`): optional — with `SMTP_HOST` set, `SMTP_PORT`/`SMTP_FROM` are required and an unreachable relay only logs a warning; without it, password reset is unavailable and "Forgot password?" is disabled. Modes 1/4 never use SMTP. |

### 3.3 Server-side persistent storage

| Location (container) | Host bind mount | Content |
|---|---|---|
| PostgreSQL | `$LOG_HUB_DATA_DIR/pgdata` | All application data. |
| `/app/dist/upload-queue` | `$LOG_HUB_DATA_DIR/upload-queue` | Uploads awaiting ingestion. |
| `/app/dist/logs` | `$LOG_HUB_DATA_DIR/logs` | Server application and SQL logs. |

## 4. Web client

A React single-page application served by the Log Hub server from the same origin. It loads no
third-party fonts, analytics or CDN assets.

Main areas:

- **Home** — your repositories with their recent sessions and cost, question chips, Needs
  attention, This week, Pinned and Recent.
- **Live** — what is running right now across your repositories and teams, from OTEL data.
- **All views** — a searchable map of every screen (Ctrl+K / Cmd+K).
- **My Repos / Sessions** — session list (by branch, date or user) and session detail: Summary,
  Logs, Bash, the session charts, Session Map, System context anatomy, Harness usage, Change
  surface, Tools/MCP, OKF, OTEL and the other session tabs.
- **Repository tabs** — Analytics, Reports, Tools/MCP (MCP and monitored CLI tool calls), OKF
  (knowledge-base use), OTEL (Claude Code's own telemetry) and Settings.
- **Analytics & Reports** — per-repository and per-team reports, PDF and zip export.
- **Teams** — team membership, access mode, role grants.
- **My API Keys** — hook installation wizard and API key management.
- **Hook State** — per-repository hook health: version, recommendations, upload errors.
- **Admin panel** (admins only) — Users, Teams, Repos, Auth, Model Pricing, Data Retention,
  Upload Queue, Error Logs, System (build, cluster).
- **Help** — this documentation.

## 5. PostgreSQL database

- PostgreSQL 18, run from the official `postgres` image as the `db` service.
- Schema is managed by versioned SQL migrations shipped in the image and applied on startup.
- Main data groups: users and credentials, API keys, auth sessions (`auth_sessions`), repositories,
  sessions and raw logs (`logs`, `logs_otel`), derived per-session statistics, teams and
  memberships, upload queue metadata, model pricing, retention audit, post-turn analysis runs.
- The only database extension used is the built-in `plpgsql`.

## 6. Telemetry hook

A set of plain Node.js scripts (Node.js 18.19+ built-in modules only, no third-party
dependencies, no native or minified code) packaged as the Claude Code plugin `log-hub-hooks`.

### 6.1 What it installs into a project

| Path | Purpose |
|---|---|
| `.artisyn/marketplace/plugins/log-hub-hooks/` | The plugin: hook scripts and `hooks.json` wiring. |
| `.artisyn/config/log-hub.json` | Project configuration (server URL, context labels, upload and OTEL settings). Tracked in git. |
| `.artisyn/config/log-hub.local.json` | The user's API key. Git-ignored. |
| `.artisyn/ai_work_dir/` | Local telemetry files, `hook.log`, upload state. |
| `~/.artisyn/otel/port.json` | The shared OTEL receiver's port, one per OS user (hook 2.30.0+; older installs kept it in `.artisyn/config/otel-port.json`, which the next install or upgrade deletes). |
| `~/.claude/settings.json` (env block) | Points Claude Code's OpenTelemetry exporter at the local receiver. |
| `.claude/settings.local.json` (env block) | A mirror of the same keys for Claude Code versions before 2.1.282, plus the `artisyn.repo` resource tag. Git-ignored. |

### 6.2 Hook scripts

| Script | Trigger | Function |
|---|---|---|
| `telemetry-hook.js` | `UserPromptSubmit` | Records the prompt event; starts a throttled background upload of the current session. |
| `lifecycle-hook.js` | 12 lifecycle events | Records tool calls, permissions, sub-agents, compaction, session start/end. |
| `send-logs-hook.js` | `Stop`, `SessionEnd` | Uploads new or changed telemetry and transcript files to the server. |
| `tool-wrap-powershell.js` | `PreToolUse` (PowerShell tool only) | Wraps monitored CLI tools in a PowerShell command so their exit code and output are recorded for the Tools/MCP tab (hook 2.27.0+). Never changes a permission decision. |
| `otel-receiver.js` | Spawned by the hook | Loopback-only (`127.0.0.1`) OTLP/JSON receiver for Claude Code's own telemetry export. One receiver per OS user, shared by all of that user's repositories (hook 2.30.0+). |
| Post-turn analysis | `Stop` (opt-in) | Optional Turn-End Cost Advisor and session attribution, run with the local `claude -p` CLI; results are posted to the server. Since hook 2.31.1 that run has no tools, MCP servers or skills. |

### 6.3 Data the hook sends

- Hook event files (prompts, tool calls, lifecycle events, git context: remote URL, branch, git
  user name).
- Claude Code session transcripts for the project (including sub-agent transcripts).
- OpenTelemetry logs and metrics captured by the local receiver, and traces when you opted in to
  them; while a session runs, new records also go over the realtime channel
  (`POST /api/v2/otel-realtime`).
- For monitored CLI tools: each call's exit code and captured output (`tool-calls`).
- Aggregated code-inventory and edit-count data (per-file line counts only; file contents and
  diffs stay on the machine).

Everything is sent to the single server URL configured in `log-hub.json`, authenticated with the
`x-api-key` header.

## 7. Hook installer

`artisyn-hooks-installer` is a single JavaScript file without third-party dependencies, served
by the Log Hub server and run with `npx`. It supports three commands:

- `install` — extracts the plugin, writes configuration, allocates the OTEL port, registers the
  plugin with Claude Code and runs a receiver smoke test.
- `upgrade` — replaces the plugin with the version served by the server, keeping configuration.
- `uninstall` — removes the plugin and its configuration from the project.

See **Connecting a Repository** in this help for the step-by-step procedure.

## 8. Interfaces summary

| Interface | Direction | Protocol / auth |
|---|---|---|
| Web client ↔ server | Browser → server | HTTP(S), same origin, `httpOnly` session cookie |
| Hook → server | Developer machine → server | HTTP(S), `x-api-key` header |
| Installer download | Developer machine → server | HTTP(S), `/static/…` |
| Claude Code → OTEL receiver | Local, loopback only | OTLP/HTTP JSON on `127.0.0.1:<port>` |
| Server → PostgreSQL | Internal Docker network | PostgreSQL protocol, password auth |
| Server → SMTP relay (optional) | Outbound | SMTP, optional TLS and auth |
| Server → Azure Entra ID (Mode 4 only) | Outbound | OAuth 2.0 / OIDC |
| Server → `registry.npmjs.org` (optional) | Outbound | HTTPS, latest Claude Code version check, hourly tick, re-fetched when older than 24 h; `AI_TOOL_VERSION_CHECK_ENABLED=false` turns it off |
| Server → `api.github.com` (optional) | Outbound | HTTPS, latest Log Hub release check, at most once a day; `LOG_HUB_RELEASE_CHECK_ENABLED=false` turns it off |
| Server → `platform.claude.com` (optional) | Outbound | HTTPS, Anthropic model pricing page, once a day; `MODEL_PRICING_FETCH_ENABLED=false` turns it off |
| Server → `openrouter.ai` (on demand) | Outbound | HTTPS, non-Anthropic model prices, only when an admin presses the import button in Admin → Model Pricing |
