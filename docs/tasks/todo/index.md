# Tasks

## Workflow

See [Task Workflow and Post-Implementation Checks](../../knowledgebase/task-checks-guide.md) for full documentation.

Skills (the `adlc-lh` plugin in `.artisyn/marketplace/plugins/adlc-lh/`): `/adlc-lh:scratch` → `/adlc-lh:review` (1-3 times) → `/adlc-lh:plan` → `/adlc-lh:implement` → `/adlc-lh:post-impl-check` → `/adlc-lh:archive`

## Task ids

Folders are named `<YYYY-MM-DD>-<slug>` (the day the task was created).

---
- [2026-06-14-top-used-analytics-table] Top Used Analytics Table — New "Top Used" analytics view: collapsible ranked tables for
  File Categories, MCP Servers, and Vision sessions with per-row hourly micro bar charts and a Top N selector.
- [2026-06-15-session-filter-skill-rule] Session List — Filter by Skill or Rule — Add multi-select Skill and Rule filter
  controls to the session list panel; sessions are narrowed to those that invoked a given skill or loaded a given rule
  file.
- [2026-06-16-session-user-filter-views] Session User Filtering — Personal & Team Views — Personal repo view shows only the
  current user's sessions; team repo view adds "Only mine" toggle + user picker below the session view-type selector.
- [2026-06-16-repo-delete-confirm-flow] Delete Repo — Personal Cleanup & Team Confirmation Dialogs — Personal view: delete
  repo + user's logs (purge completely if no other users reference the URL); Teams view: confirmation modals for both
  add and remove repo actions.
- [2026-06-16-prompt-classifier-session-tags] Prompt Classifier — Auto-tag Sessions via `claude -p` — UserPromptSubmit hook
  classifies each prompt with `claude -p` and assigns a user-configured tag to the session; server stores tags on
  sessions; client supports filter and group-by-tag in session list.
- [2026-06-19-mcp-invocation-log-tab] MCP Invocation Log Tab — Add an "MCP" tab in the per-prompt session detail view showing all MCP invocations with full input params, response payload, and error details.
- [2026-06-19-exclude-tiny-sessions] Exclude Tiny Sessions from Analytics — Add a toggle in the Productivity analytics tab to exclude very short sessions from metrics and charts, with a visible threshold and excluded-count indicator.
- [2026-06-20-codex-hooks] Codex Hook Parity — Add Codex equivalents for the Claude telemetry, guardrail, and upload hooks using `.codex/hooks.json` and provider-aware telemetry.
- [2026-06-21-session-parse-indicator] Session Log Parsing Indicator — Show a parsing indicator in the client once session logs are loaded from the server and client-side parsing begins.
- [2026-06-22-repo-analytics-context] Repo Analytics Context Metrics — Add "Context" display type to repo analytics showing max context window size and number of context window compactions.
- [2026-08-05-copilot-session-upload] Copilot Session Upload — Hook uploads Copilot events.jsonl on Stop; server parses and stores session metadata and cost; UI shows Copilot sessions in the existing list with cost per row.
- [2026-08-11-header-view-mode-switch] Header View Mode Switch — Add a Simple Dev / Full Dev / Manager view-mode switch to the header, defaulting to Full Dev (current behavior); Simple Dev and Manager are TBD placeholders that only need to be wired into the session list and session details areas.
- [2026-08-13-perf-harness-reliability] Perf Harness Reports Failed Scenarios As Passing — `npm run perf` computes mean/p95 over failed requests, prints `✓` for scenarios failing 500/500, discards status codes, and gates on an absolute +10ms instead of the 20% required by `.claude/rules/server.md`; `auth:login` also 404s under `AUTH_MODE=none` yet still reports as passing. Makes the mandated 20% regression gate unenforceable.
- [2026-08-13-branch-jira-attribution] Branch Attribution to JIRA Task/Epic — Attribute a branch to a JIRA task (one task → many branches) and a JIRA epic (one epic → many tasks/branches); scratched high-level, more detail to follow.
- [2026-08-18-session-rollover-linking] Session Rollover Linking — Claude Code can roll a continuous run over into a new top-level session id mid-run (observed: one session id continuing another mid-run), which today shows as two unrelated sessions with a confusing first-prompt. Chosen approach (Option A): a layered detection mechanism (hook-recorded `SessionStart`/`SessionEnd` fields first, transcript-uuid containment second, the CLI-internal snake_case `session_id` field as a last resort) resolves the predecessor and persists a breadcrumb link between the two session rows, with the misleading first-prompt display fixed in the same task so neither session looks broken; a fuller merged timeline/cost view was scoped and explicitly deferred (~3% continuation rate doesn't yet justify chain-aware reports).
- [2026-08-19-extract-prompts-to-md] Extract Hook LLM Prompts to Markdown Files — Move the two inline LLM prompt bodies in `post-turn-analysis-worker.js` (`hook/` src) — the cost-advisor/analysis prompt and the session-attribution/attribute-extraction prompt — out of JS template strings into two standalone `.md` files next to the JS, loaded and interpolated at runtime.
- [2026-08-28-change-surface-scattered-fix] Revise Change-Surface Scattered Classification Rule — A 3-file change across `docs/` and `client/` is classified/flagged as "scattered" despite being a focused change; the rule needs to weigh number of top-level folders touched and total files changed against a reasonable threshold. **Scope extended 2026-08-28:** that threshold stops being a hardcoded constant and becomes a per-repository setting — "Merge surface threshold", in number of changed files, configurable separately for a private repo (personal value) and for a team, resolved user → team → default, default **10** (was a hardcoded 5); any change set at or below it is merge-safe/focused regardless of spread. Stored in the existing `repo_config.config` jsonb (no migration), edited in Repository Settings → Analysis, threaded into every `computeChangeSurface()` caller. `impl-plan.md` is stale — it plans a server-constant-only change with no config/API/UI work.
- [2026-09-26-session-anomalies-otel-port] Session List Anomalies and OTEL Port Drift Fixes — Audit of one repo: "⚡ Workflow" badge false-positive on 16/19 sessions (raw `LIKE` matches the tool catalogue in Claude Code 2.1.280's new `attachment/prompt_snapshot`), unknown new transcript event types, SessionStart-only empty rows, idle lead-in inflating session span, and OTEL silently lost since 2026-09-24 because the installer never rewrites its own stale loopback endpoint (settings :50280 vs receiver :50962) and the hook never detects the mismatch.
- [2026-10-15-claude-dev-container] Claude Code Dev Container (docker-dev + local infra + hook) — a containerised development setup for this repository in three blocks: A — compose with Postgres 18.4 on a named volume instead of a Windows bind mount, plus Mailpit; B — a Linux image (Node/npm/bun, Claude Code, Chrome, Playwright), a PowerShell launch script, volumes over OS-specific directories, socat forwards with `nodelay`, a Claude profile and notes, isolating `npm run build` from the host watch backend; C — the hook inside the container (logs and OTEL get through, the `.artisyn/ai_work_dir/` shared with the host is not corrupted)
- [2026-10-16-sysctx-instruction-files] System Context — Show Instruction Files — the System Context panel does not show `CLAUDE.md` / `CLAUDE.local.md` / `~/.claude/CLAUDE.md` and rules: the client reads only the hook's `system-context` event, which is sent only when the harness fingerprint changes; take the files from the `instructions` / `nested_memory` attachments of the Claude log
- [2026-10-20-csrf-origin-check] CSRF Origin Check for Cookie-Session Routes — low priority hardening: reject cookie-authenticated POST/PUT/PATCH/DELETE whose `Sec-Fetch-Site`/`Origin` is not the app's own origin (hook `X-API-Key` requests untouched), and drop the global `urlencoded` parser; closes the same-site-subdomain and simple-form gaps that `SameSite=Lax` leaves
- [2026-10-20-github-release-pipeline] GitHub Release Pipeline (release branch, Actions, GHCR) — start after the repo is public: protected `release` branch; on push, automatic semver tag, ~20 s typecheck + algorithm-test gate, native amd64/arm64 builds, multi-arch image on `ghcr.io/dataart/artisyn-log-hub`, GitHub Release with `INSTALL.md` and one-line `install.sh` / `install.ps1`; removes the in-app release downloads (`server/src/releases/`, Admin → System section, `scripts/release.js` zips)
