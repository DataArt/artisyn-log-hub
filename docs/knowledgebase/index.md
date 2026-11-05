---
okf_version: "0.1"
---

# Knowledgebase Index

Before reading any KB file, check this index to find the right file. Do not glob the knowledgebase
directory.
After adding, removing, or renaming any KB file, update this index.

Each line says **when to read** the article and names its key files or terms, nothing more — the
article itself holds the details. Keep new lines to one or two sentences.

## Client

* [Client Components Structure](client-component-map.md) - Read when you do not know which folder holds a UI area (skip it for a change inside a file you already found): folder-level map of `client/src`, entry files, owning KB articles, and modules not where their name suggests (`tab-ids.ts`, session tab bar and lens, `MainNav`). Not a per-file list — find files with grep/glob
* [Client Component Hierarchy](client-routing-and-layout.md) - Read before touching SPA routing, the provider tree / consent gate, lazy chunks (~8, never more than 10), URL state (`lens=`, `session=`, tab params), per-user browser storage keys, window events or `location.state` tab seeding
* [UI Principles](ui-principles.md) - Read before implementing any UI behaviour: access messaging, error handling, light-only colour scheme, chart patterns
* [Client Feature Flags](client-feature-flags.md) - Read before hiding an unfinished client feature behind a `VITE_*` build flag (`lib/feature-flags.ts`)
* [Session Log View](session-log-view.md) - Read before touching the session Logs tab or the `/logs` payload: the payload contract (`agent-` prefix rules, descendant loading, client-only types), the Workflow tool lifecycle (rejected-before-launch = failed), log parser, tool-call core, `ToolCallView` and the Bash tab, Context Growth steps, nested `claude -p` sessions
* [Session Map Tab](session-map.md) - Read before touching the session Map tab (`session-log/session-map/`) or `GET …/logs/delta`: delta → merge → parse → model flow, polling and reload, `/logs` watermark suspension, tool families, file list
* [Raw Logs Renderer Subsystem](raw-logs-renderers.md) - Read before touching `session-log/raw-logs/`: layers, dependency graph, adding a renderer
* [System Context Anatomy Tab](sysctx-anatomy-tab.md) - Read before touching the `sysctx` session tab or the Logs `StartupContextLine`: data sources, partitions, banners, test ids
* [Harness Usage Tab](harness-usage-tab.md) - Read before touching the session "Harness usage" tab: the five element kinds, slash-command shapes, tree assembly rules, why it bypasses `parseSessionLogs`
* [Executive Summary Report](executive-summary-report.md) - Read before changing the Executive Summary report or its PDF (sections, cost rollup, the CSP `'wasm-unsafe-eval'`)
* [Bytes-per-Token Ratio](token-byte-ratio.md) - Read before using or changing `BYTES_PER_TOKEN` (3.5) and what it must not be used for

## Server and API

* [Server HTTP API map](server-endpoint-map.md) - Read before adding or changing an HTTP route: guards legend, access rules (admin grants no session-data access), error / body-limit / security-header conventions, hook-route backward compatibility, a controller index and the routes with non-obvious behaviour. Not a route list — grep the controllers
* [Twins Registry and Cross-Cutting Rules](twins-and-cross-cutting-rules.md) - Read before changing any constant, regex or rule that may also exist in another package (server / client / hook / installer), and before adding an env var, a lazy chunk, an installer-written setting, a background job or a Workflow status rule
* [Server Conventions](server-conventions.md) - Read before writing server code: gotchas (Drizzle array binding → `malformed array literal`, never read transcripts in list/analytics endpoints), DB query patterns, Argon2id hashing, perf-test framework, pino logging
* [Server Log Subsystem](log-subsystem.md) - Read before touching the server's own operational logs (not session telemetry): pino loggers, rotation, hourly retention sweep, logs lost on container recreate
* [Upload Queue](upload-queue.md) - Read before touching `POST /api/v2/logs` ingest or adding any background job/queue (the house `SKIP LOCKED` + lease pattern): staging, claim, 900 KB chunks, malformed-line tolerance, worker stats, admin Upload Queue tab
* [Repository Identity](repo-identity.md) - Read before touching how `repositories.repo_url` is derived: URL normalisation, local `<email>/<path>` identities, team add-repo mapping, the startup merge
* [Session Data Retention](data-retention.md) - Read before touching the session purge job (`SESSION_RETENTION_*` env vars, eligibility, audit) or the hook-side OTEL file prune
* [Session Export, Import and Statistics Export](session-export-import.md) - Read before touching repository export/import or the statistics export: zip format, `export_import_jobs`, import validation and merge
* [System Info & Cluster](system-info-and-cluster.md) - Read before touching `server/src/cluster/` (worker launch, `CLUSTER_MODE`), the System Info API/tab or the `ai-tool-versions` scheduler
* [Static Asset Serving](static-asset-serving.md) - Read before touching how the built SPA or server static files are served: the three `static-dir.ts` runtime layouts (installer 404 trap), brotli/gzip precompression, `Accept-Encoding` negotiation, `/assets/` cache policy
* [Repo-Local Packages](repo-local-packages.md) - Read before touching `packages/` (`@loghub/pricing`, `@loghub/bash-view`) or sharing code between server and client: linking, alias, Docker, package rules

## Database

* [Database Structure — cross-table rules](db-tables.md) - Read before writing queries or ingest logic that span tables: core ER diagram and the rules the DDL cannot show (session trees, soft vs hard delete and cascades, extracted `logs` fields, hook upload replaces `logs.body` vs keep-longer on zip import, OTEL rows, derived per-session tables, pricing, team vs personal scoping)
* [DB Schema - Code Location and Structure](db-schema-code.md) - Read when adding or changing a table: Drizzle schema location (`server/src/database/schema/index.ts`), DI wiring, the hand-written migration with `COMMENT ON` then `npm run db:state` (**never run `drizzle-kit generate`**), Drizzle limitations
* [Current DB State (DDL)](db_state.sql) - First stop for any table or column name and schema question: the current DDL with table and column comments (not the migration history); regenerated by `npm run db:state`, never edit by hand

## Cost, sessions and analytics

* [LLM Call Math](llm-call-math.md) - Read before any token or cost formula: `TokenBreakdown`, `computeCost`, cache and vision costs, sub-agent aggregation, utility calls, the session price date, `costBreakdown` / `totalCost`
* [Session Metric Scope (root vs tree)](session-metrics-scope.md) - Read before adding or showing ANY session metric: additive metrics are summed over the root and all sub-agents, canonical helpers, the double-count trap, per-surface status
* [Change Surface](change-surface.md) - Read before counting changed files / folders / modules: the concentration formula, union-never-SUM, path normalisation, `repo_code_inventory` denominators
* [Turn-End Cost Advisor and Session Attributes](turn-end-cost-advisor.md) - Read before touching the post-turn analysis hook/worker, the advisor or session attributes (`attr=` filters, `attr:<key>` group-by)
* [Claude Code Version Check](claude-version-check.md) - Read before touching `server/src/ai-tool-versions/`, per-session Claude Code version extraction or the `claude-version` detector
* [Researching Model Pricing & Context Length](model-pricing-research.md) - Read before writing a `model_pricing` backfill migration: where to look up current prices and context windows
* [session_id vs sessionId](session-id-vs-sessionid.md) - Read before joining on a transcript's snake_case `session_id`: it is a `--resume` artifact, never an attribution key

## Hook

* [Hook System Overview](hook-system-overview.md) - Read first for any hook change: where the source lives (`hook/.claude/telemetry_tool/`) vs the installed and dogfooded copies, event wiring, non-obvious scripts, path resolution, upload pipeline (namespaces, manifest, lock, gzip/chunks, injected lines), design rules (fail-open, transparent code, every Node.js LTS, CommonJS)
* [Hook Installation Guide](hook-installation.md) - Read before touching install / upgrade / uninstall or the hook config: gotchas (marketplace dedup by folder path, `npx` caches by name+version), `log-hub.json` keys (OTEL, `okf`, `toolWrap`), per-user OTEL state, the user-scope and project `settings*.json` env blocks
* [Hook API Versioning](hook-api-versioning.md) - Read before changing any hook-facing route or payload: `/api/v2/logs` (v1 removed), the hook-version × route compatibility matrix, body limits, receiver contracts, additive fields by hook version, and the hook-side behaviour history by version
* [OTEL Receiver](otel-receiver.md) - Read before touching `otel-receiver.js`, `otel-register.js`, `user-state.js` or the receiver install steps: the per-user shared receiver (2.30.0), register / hello / routing, legacy per-project mode, restarts, chunk layout, realtime sender
* [Log Schema Reference](log-schema/index.md) - Read when you need the shape of a Claude Code transcript line: message types, assistant/user structure, attachment sub-types

## Feature subsystems (OTEL, OKF, Tools/MCP)

* [OTEL Tabs](otel-tabs.md) - Read before touching `server/src/logs/otel/`, the repository / session / team OTEL tabs or `POST /api/v2/otel-realtime`: channels, `otel_*` tables, classification, states, access, per-session OTEL status, compatibility matrix
* [OKF Usage](okf-usage.md) - Read before touching the session or repository OKF tab (incl. the article drill-down and the OKF thresholds settings), `server/src/logs/okf/`, `session_okf_access` / `session_okf_event` / `session_okf_pointer` / `okf_snapshots` or the hook's OKF snapshot upload
* [Tool Monitoring (Tools/MCP tab)](tool-monitoring.md) - Read before touching the Tools/MCP tab, `server/src/logs/tool-monitoring/`, `packages/tool-monitor/` or the hook's CLI tool wrapper: channels, config merge, shims, safety, routes

## Auth and accounts

* [Authorization and Authentication](authorization-and-authentificaiton.md) - Read before touching auth or any data-access check: the admin role grants no session-data access, the four `AUTH_MODE`s, startup validation, rate limits, route gating, Mode 1's local-caller gate, team access modes and roles
* [User Account Flows](user-account-flows.md) - Read before touching invites, signup, password reset, admin reset link / email rename, the data-collection consent or the new-user nudge
* [Deployment Auth Mode](deployment-auth-mode.md) - Read before changing a deployed instance's auth: why Mode 4 never falls back, how `AZURE_*` and other env vars reach the container, verifying the live mode

## Build, CI, release and dev environment

* [Release Pipeline](release-pipeline.md) - Read before touching `release.yml` / `checks.yml`, `scripts/release-kit.js`, `release-template/` or when cutting a release: versioning, job order, GHCR tags, install kit, local test bundle, Node.js version
* [CI Security Scans](ci-security-scans.md) - Read before touching `security-scans.yml`, `virustotal.yml`, `scripts/ci/` or the config-guard allowlist, or when a scan row / PR security block looks wrong
* [Git Hooks and Secret Scanning](git-hooks.md) - Read before touching `.githooks/`, gitleaks config or when a commit/push is blocked by the scan
* [Claude Code Dev Container (sandboxes)](docker-dev-container.md) - Read before touching `scripts/claude-docker*` or `docker-dev/`, or when a sandbox misbehaves: sandbox model, launcher rules and deletion guards, mounts, `TEST_DATABASE_URL`, provisioning, prune rules, Windows menu quirks, limitations (commands: `--help`)
* [User Docs and Site](user-docs-and-site.md) - Read before editing `user-docs/`, the in-app help menu or the GitHub Pages site/deck: `nav.json`, link rules, the help generator, the site renderer

## Tests and algorithm docs

* [Test Knowledgebase](test/index.md) - Read before writing or changing tests: suites (scenarios, contracts, algorithm tables, legacy e2e), the 80 % scenario-coverage target, run commands, the scenario stand and contract registry
* [Task Workflow and Post-Implementation Checks](task-checks-guide.md) - Read before running or adding a post-implementation check: the `/adlc-lh:*` lifecycle in short, the checks, discovery and naming
* [Algorithm Docs (doc-driven table tests)](algorithms/README.md) - Read before writing a unit test for an algorithm: one doc per algorithm plus its rows file `docs/algorithm-examples/<name>.json` (the test table — read it only to change rows); required sections and review. Lists every algorithm doc, including those not repeated below
* [Cost Formula](algorithms/cost-formula.md) - Read before touching the per-call cost formula or its twins (`@loghub/pricing`, hook `post-turn-analysis-worker.js`)
* [Work Time](algorithms/work-time.md) - Read before touching session work-time (idle gaps) in `claude-extractor.ts` or its hook twin
* [Upload Error Classify](algorithms/upload-error-classify.md) - Read before touching how ingest errors are classified (`upload-error.ts`)
* [Password Policy](algorithms/password-policy.md) - Read before touching `PASSWORD_POLICY` (`any` / `mid` / `long`), its limits and where it is enforced
* [Anthropic Pricing Page Parse](algorithms/anthropic-pricing-parse.md) - Read before touching `parseAnthropicPricing` (model table, web-search price, prompt-length tiers)
* [Harness Snapshot](algorithms/harness-snapshot.md) - Read before touching the hook's harness catalog build or its `snapshotId` hash
* [OTEL Shared Routing](algorithms/otel-shared-routing.md) - Read before touching the shared receiver's `routeRecord`, pending spool, register validation or forwarding
* [OTEL Status Reason](algorithms/otel-status-reason.md) - Read before touching `otel-status.js` (effective scope, config warnings, ok / partial / none, reasons)
* [OTEL Live Tree](algorithms/otel-live-tree.md) - Read before touching the Live view's node-key grammar or `buildOtelLiveTree` (placement under teams / No team, retention, DISTINCT-root totals, agent liveness)
* [Workflow Agent Rows](algorithms/workflow-agent-rows.md) - Read before touching the "#" numbering in the workflow Agents table
* [Session List Flags](algorithms/session-list-flags.md) - Read before touching `session_stats` `main_model` / `has_workflow` / `has_main_assistant`
* [System Context Anatomy](algorithms/sysctx-anatomy.md) - Read before touching `sysctx-anatomy.ts` (startup block, per-partition token estimates)
* [Tool-Call Sections and Permission Attribution](algorithms/tool-call-sections.md) - Read before touching `session-log/tool-calls.ts`: which section a call is listed in, which call a permission event belongs to
* [Tool-Call Outcome](algorithms/tool-call-outcome.md) - Read before touching `classifyToolOutcome` (client or its server twin): success / failure / unresolved and the Logs status
* [Bash Command View](algorithms/bash-command-view.md) - Read before touching `packages/bash-view/` or the client loader: command layout, FILES summary, `readAccess` kinds
* [OKF Access Extraction](algorithms/okf-access-extraction.md) - Read before touching `okf-access-extractor.ts` or `okf-pointers.ts`: how a transcript becomes `session_okf_access` rows, code events and article pointers
* [OKF Task Context](algorithms/okf-task-context.md) - Read before touching `okf-task-context.ts`: which user entries count as the task
* [OKF Verdict](algorithms/okf-verdict.md) - Read before touching `okf-verdict.ts` or `okf-thresholds.ts`: the thresholds, upkeep, session share, agent entry, repo rules, stale files, levels
* [OKF Value Signals](algorithms/okf-value-signals.md) - Read before touching `okf-value-signals.ts`: article area, yield, searched after, routing miss, dead pointers, catalog
* [OKF Snapshot](algorithms/okf-snapshot.md) - Read before touching the hook's `okf-snapshot.js`: bundle detection, `git check-ignore` flags, `okfSnapshotId`
* [Tool Output Format](algorithms/tool-output-format.md) - Read before touching Tools/MCP `output-format.ts`: JSON / table / plain detection and re-alignment
* [Tool Wrapper Fidelity](algorithms/tool-wrapper-fidelity.md) - Read before changing the hook's CLI tool wrapper: fidelity and fail-open rows, the env-gated check project
* [Sandbox Prune Classification](algorithms/sandbox-prune-classification.md) - Read before touching `classifyPruneCandidate` in `scripts/claude-docker/prune.mjs`
* [Log Retention](algorithms/log-retention.md) - Read before touching `planLogCleanup` / `LogRetentionService`: which `logs/app-*` / `sql-*` files are deleted by age and size cap
* [Executable-Config Guard](algorithms/executable-config-guard.md) - Read before touching `checkConfigGuard` (`scripts/ci/config-guard.js`) or its allowlist
* [Security Scan Summary](algorithms/security-scan-summary.md) - Read before touching `scripts/ci/security-summary.js`: row validation, PR block, badge

## Product

* [Product Purpose and Full Data Capture](product/product-purpose-and-data-capture.md) - Read before proposing redaction or "privacy fixes" to capture: the product captures session data in full by design
* [Competitors](product/competitors.md) - Read before positioning, pitching or prioritising features: 14 tools by category and the gaps they expose
* [Legacy Design Decisions Map](product/legacy-design-decisions-map.md) - Read when you meet a bare legacy task id (T-NN): its topic, summary and the KB section with the current behaviour
