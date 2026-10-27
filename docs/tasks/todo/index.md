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
- [2026-08-28-change-surface-scattered-fix] Revise Change-Surface Scattered Classification Rule — A 3-file change across `docs/` and `client/` is classified/flagged as "scattered" despite being a focused change; the rule needs to weigh number of top-level folders touched and total files changed against a reasonable threshold. **Scope extended 2026-08-28:** that threshold stops being a hardcoded constant and becomes a per-repository setting — "Merge surface threshold", in number of changed files, configurable separately for a private repo (personal value) and for a team, resolved user → team → default, default **10** (was a hardcoded 5); any change set at or below it is merge-safe/focused regardless of spread. Stored in the existing `repo_config.config` jsonb (no migration), edited in Repository Settings → Analysis, threaded into every `computeChangeSurface()` caller. `impl-plan.md` is stale — it plans a server-constant-only change with no config/API/UI work.
- [2026-10-20-csrf-origin-check] CSRF Origin Check for Cookie-Session Routes — low priority hardening: reject cookie-authenticated POST/PUT/PATCH/DELETE whose `Sec-Fetch-Site`/`Origin` is not the app's own origin (hook `X-API-Key` requests untouched), and drop the global `urlencoded` parser; closes the same-site-subdomain and simple-form gaps that `SameSite=Lax` leaves
- [2026-10-21-workflow-agent-meta-labels] Workflow Agent Labels From .meta.json — the hook sends each workflow sub-agent's `.meta.json` `description` (the workflow script's agent label) and `workflowPhase`; the server stores and returns them in `/logs`, and the workflow Agents table uses `description` as the row label instead of the identical harness-relay prompt start, falling back to it for old hooks (follow-up to 2026-10-21-workflow-session-readability)
- [2026-10-22-jetbrains-raw-mode-menu] Claude-Docker Full-Screen Menu Kills the JetBrains Terminal — find why the Node raw-mode menu closes the whole WebStorm terminal on Windows after a key press (minimal repro across WebStorm / conhost / Windows Terminal), then fix the full-screen menu and drop the JetBrains line-menu fallback, or file the bug upstream with the repro
- [2026-10-23-bash-view-algo-review] Bash-View Algorithm Doc — Close Round-6 Review Findings — add rows for the four holes left by the 6th AI review of bash-command-view.md, document five missing behaviours, run one fresh review and set reviewer: ai (follow-up to 2026-10-22-context-growth-item-modal)
- [2026-10-23-subdir-session-abs-paths] Subdirectory Sessions Show Absolute Paths — the viewer's display root falls back to the session cwd, so paths outside a subdirectory session stay absolute (found by /big-prod-e2e-test 20261023-192004, S10/S11)
- [2026-10-24-dev-deps-snyk-fixes] Update Vulnerable Dev Dependencies (Snyk) — move the fixable critical/high devDependency issues from the Snyk dev row (esbuild, qs, brace-expansion, js-yaml, @vitest/mocker, postcss-selector-parser) to fixed versions, no behaviour change
- [2026-10-25-jules-nightly-review] Nightly AI Quality Review of main by Google Jules — one free-plan Jules Scheduled Task runs a repo skill over main (route auth vs docs, DB index suspects, test slop vs the test policy, KB/Hook API/local-path invariants) and its report-only PR is moved to the ci-reports branch by a GitHub Action
- [2026-10-27-okf-usage-tab] OKF Usage Tab — Knowledge-Base Read/Write Heatmap — hook-detected OKF bundles, per-session/repo read-write heatmap tree with a deterministic verdict, facts route for the KB-analysis skill (no LLM in the UI)
- [2026-10-27-kb-completeness-deep] KB Analysis Skill — On-Demand Opus Analysis of Past Sessions — skill shipped with the hooks: picks sessions, analyses them with parallel specialised Opus passes against the KB as of each session, leaves a local ranked report of KB and entry fixes; nothing uploaded
