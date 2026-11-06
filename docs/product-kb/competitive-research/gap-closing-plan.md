---
type: "Research"
title: "Gap-closing plan — what to build, skip and correct after the competitive study"
description: "Product plan derived from the 14-tool parity study: corrected matrix verdicts (install effort, ROI metrics, live view, first-value), ranked proposals with effort, reuse points, backward compatibility and offline checks, screenshot-derived UI ideas per Log Hub page, rejected ideas and the first increments."
tags:
  - competitive-research
  - product
timestamp: "2026-11-01T00:00:00+04:00"
---

# Gap-closing plan

Companion to `README.md` (the matrix) and `docs/product-kb/competitors.md`. Every claim about
Log Hub below was checked against the KB or the code on 2026-11-01; the matrix verdicts were made by
research agents from a short baseline and several are wrong (see "Verdict corrections").

## Summary

- **Build, in this order:** (1) budgets and alerts, (2) an Outcomes panel from data Log Hub already stores
  (commits, PRs, lines, accept/reject, active users), (3) deterministic waste-pattern detection with a
  flagged-sessions view, (4) "running now" markers and a per-agent swimlane from data already uploaded,
  (5) an MCP server over the REST API. Items 1–3 are each one task of size M or smaller.
- **Out of scope here:** other coding agents. They are planned by the owner as a separate track
  (decision recorded 2026-11-01).
- **Skip:** SSO/SCIM parity with Langfuse, evals/LLM-as-judge, PromQL/Prometheus,
  WebSocket/SSE hook-event streaming, plan-limit (Pro/Max) prediction, a 3D graph, per-event AI summaries.
- **Corrected view of the matrix:** T6 "install effort" (9 ahead) is wrong for the team persona and
  overstated for the solo one; A10 "ROI metrics" (7 ahead) ignores `commit_count` / `pr_count` /
  `lines_added` and the Productivity views that already exist; C4 "live view" (9 ahead) ignores the 5-second
  OTEL session tab and the 15-second new-session poll; README idea 4 "upload existing history" is already
  how the hook works. The real gap count is **A11 alerts (10)**, A10 partially (edit decisions, DAU trend,
  PR linkage), T9 query access (6), and A8 recommendations (2).
- **Alerts are indeed "not hard":** stored per-session cost (`session_costs`), a cluster-safe scheduler
  pattern and a nodemailer `MailService` already exist. The minimal design below is one migration, one
  module and one settings screen; the only real design work is scope resolution and dedup.
- **Positioning check:** every proposal below answers *why* (which sessions, which pattern, which
  harness element), not only *how much*. Pure "how much" features (5-hour blocks, plan-limit gauges) are
  taken only where they are a cheap read over existing tables.

## Verdict corrections

| Row | Matrix says | Evidence | Corrected verdict |
|---|---|---|---|
| T6 Install effort | **C** for 9 tools | Server: one `curl … \| sh` / `irm … \| iex` line, `.env` generated, Postgres in the compose file (`user-docs/install-server.md`). Hook: one `npx` line copied from API Keys → Install, which runs `--self-check` (`hook/INSTALL_HOOK.md` § 1). The hook uploads the repo's **pre-existing** `~/.claude/projects/<slug>` transcripts as backlog on the first `Stop` (`hook/.claude/telemetry_tool/session-files.js` `findProjectSlugDirs`, `docs/knowledgebase/hook-system-overview.md` § "Upload order"), so the first dashboard is not empty. | **Team admin persona: `=` or `LH`** against every SaaS vendor (those need an OTel collector config pushed to every machine plus a vendor account). **Solo dev persona: `C` only for ccusage / Usage Monitor / ccboard / Hindsight / agents-observe** — they need no Docker and no server. Honest count: 5, not 9, and only for a persona Log Hub does not primarily target. |
| A10 Productivity / ROI | **C** for 7 tools | `session_stats.commit_count`, `pr_count`, `lines_added`, `lines_removed`, `work_time_ms`, `turn_count` (`docs/knowledgebase/db-tables.md` § `session_stats`); Analytics views **Productivity** and **Productivity Counters**; Executive Summary KPI "active users" with adoption % in team view (`client/.../executive-summary/KpiTiles.tsx`). Edit accept/reject is derivable today: `PermissionDenied` / rejected outcomes (`algorithms/tool-call-outcome.md`). | `=` against claude-code-otel, Grafana, Dynatrace, Coralogix (they chart the same counters). **C stays** for Anthropic, Datadog, Jellyfish (merged-PR attribution, cycle time) — closed only by git-outcome linkage, which is a later increment. |
| C4 Live view | **C** for 9 tools | Session OTEL tab polls a `since=` delta every 5 s while the session is live (`docs/knowledgebase/otel-tabs.md` § "Client polling"); session list polls for new sessions every 15 s (`useNewSessionPoll.ts`, `user-docs/session-list.md`); the hook uploads on every prompt. No SSE/WebSocket in the code base (grep: none). | `=` against ccboard, Hindsight, cc-otel, Grafana, Datadog, Dynatrace (they also poll or refresh). **C stays** for agents-observe and disler (true per-hook-event push with swimlanes). Count 2, not 9. |
| README idea 4 "backfill existing history" | listed as a gap | See T6 row: backlog upload already covers the installed repo's history. | Already done for the installed repo. What is missing is only history of **other** repos (install the hook there) — not a feature gap. |
| A11 Alerts | **C** for 10 tools | No `budget` / `alert` code anywhere (grep over `client/src`, `server/src`). | Correct. The one real gap. |
| T9 Query access | **C** for 6 tools | REST API with session cookie and API-key routes only (`api-reference.md`). | Correct; the cheapest closer is an MCP server (P5), not PromQL. |

## Proposals (ranked by value × effort × fit)

### P1 — Budgets and alerts (A11) — effort **M**

- **Problem / competitors:** 10 of 14 have it. UI references: Anthropic's "$123.77 of $300.00 · 41% used ·
  resets …" progress bar; Usage Monitor's stacked gauges with a status dot per dimension (`shots/claude-code-usage-monitor/scnew.png`);
  ccboard's 4-level alerts and "N.x avg" daily spike; Dynatrace's "New alert" button on a trend chart.
- **Minimal version:**
  1. Table `budgets` (`scope_kind` user|team|repo, `scope_id`, `period` day|week|month, `limit_usd`,
     `warn_pct` default 80, `channels` jsonb {inApp, email}, `created_by`, `enabled`) and `budget_alerts`
     (budget, period_start, level warn|exceeded, amount, sent_at, channels_sent) — one row per
     (budget, period, level) is the dedup key.
  2. `BudgetAlertScheduler`, copy of `ModelPricingScheduler` (`server/src/model-pricing/model-pricing.scheduler.ts`)
     with the DB-claim pattern of `AiToolVersionsScheduler` so one cluster worker evaluates per tick
     (every 5 min). Evaluation = one SQL per scope over `session_costs` joined to root sessions through
     `treeCostCtes` (`server/src/logs/reports/session-tree-cost.sql.ts`) and the team/repo access helpers
     the Cost by User report already uses. Period boundaries in the budget's IANA tz (the OTEL facts route
     already validates `tz` with `Intl.DateTimeFormat`).
  3. Delivery: in-app `notifications` (bell in the top nav, unread count, list; `GET /api/v1/notifications`)
     always; email through `MailService.send` (`server/src/mail/mail.service.ts`) when SMTP is configured.
     `isConfigured()` currently allows SMTP only in auth modes 2/3 — relax it to "SMTP_HOST set" for
     notification mail (startup validation unchanged). Modes 1/4 without SMTP get in-app only; say so in
     the settings UI.
  4. UI: a "Budgets" card in repository Settings (personal), the team page (team owner/managers), Admin
     (global) — one shared component; the Analytics Cost view and the Executive Summary get a budget
     progress bar with "resets <date>".
- **Extensions:** daily spike alert ("today is 3.1× the 30-day average", ccboard) as a second rule kind
  with no limit; 5-hour UTC block table and current-block burn rate — a read over `otel_cost_buckets`
  (5-minute UTC rollups already exist, `otel-tabs.md` § "Buckets") where OTEL coverage exists, labelled
  "Claude Code estimate". Anthropic-side spend caps stay authoritative; Log Hub alerts are advisory.
- **Reuse:** `session_costs` and `SessionCostRecomputeService`; schedulers above; `MailService`;
  `OtelKpiTiles` for the gauge; access helpers `resolveTeamScope` / `assertRepoAccess`.
- **Backward compatibility:** server-only, no hook change, additive tables; old hooks unaffected.
- **Offline:** yes — SMTP relay is the deployer's; in-app needs nothing.
- **Risks:** double send across cluster workers (solved by the claim row); cost arrives late
  (upload queue, sub-agent rollup) so a period can cross the threshold after its end — evaluate the
  previous period once more on the next tick; team scope semantics in `restricted` teams (reuse the
  analytics gate: only owner/managers may create team budgets).

### P2 — Outcomes panel from data already stored (A10, partly A8) — effort **S–M**

- **Problem / competitors:** cc-otel, Grafana, Dynatrace, Coralogix show commits / PRs / lines / accept
  rate / active-time tiles and DAU-WAU-MAU; Anthropic shows an adoption funnel and per-tool accept rate.
  UI: Grafana's productivity tile row and "Lines added vs removed"; Anthropic's funnel bars.
- **What already exists:** `commit_count`, `pr_count`, `lines_added/removed`, `work_time_ms`,
  `turn_count` per session; tree-scoped rollup helpers (`session-metrics-scope.md`); Productivity and
  Productivity Counters views; rejected tool calls (`tool-call-outcome.md`); OTEL **metrics** lines
  (`claude_code.commit.count`, `lines_of_code.count`, `code_edit_tool.decision`, `active_time.total`)
  are written to chunk files by the receiver (`otel-receiver.js` `collectMetrics`) and uploaded into
  `logs_otel`, but `otel-chunk.ts` skips every non-`logs` line (line ~190) — stored, never read.
- **Minimal version:** an **Outcomes** view in Analytics and a row in the Executive Summary: commit
  commands, PR-create commands, lines added/removed, Edit/Write accept rate (success vs rejected), active
  users per day/week with the DAU/WAU ratio, all with vs-previous-period deltas. Labels must be honest:
  "git commit invocations", not "commits merged".
- **Extensions:** read `code_edit_tool.decision` and `active_time.total` from the OTEL metrics lines in
  the projection drain (new table or extra columns on `otel_cost_buckets`) to cross-check the transcript
  figures; later (L, separate decision) link sessions to merged commits via a `post-commit` hook line.
- **Backward compatibility:** old hooks already ship these metrics; nothing to change hook-side.
  **Offline:** yes. **Risk:** over-claiming ROI — keep the "Data source and limitations" block.

### P3 — Detected patterns ("why it cost that much", deterministic) (A8) — effort **M**

- **Problem / competitors:** Datadog's Detected Problems — pattern definition as predicates, flagged
  sessions list, estimated savings, "View Recommendation", Fix Library (`shots/datadog/7.png`, `8.png`);
  Anthropic `/usage` "Trim CLAUDE.md · 49k tokens per request"; ccboard's z-score anomaly table.
- **What already exists:** the LLM Turn-End Cost Advisor (per turn, costs money, prose); the OKF access
  extractor already identifies paired identical Reads (FR-6 in `algorithms/okf-access-extraction.md`);
  tool outcomes, Bash analysis (`@loghub/bash-view`: runs / changes / reads), `commit_count`, context
  anatomy (startup block size), harness usage counts (never-used skills/MCP).
- **Minimal version:** 4–6 deterministic patterns computed at ingest into `session_patterns`
  (session_id, pattern_key, evidence jsonb, est_wasted_usd): repeated identical Read, retry loop
  (same Bash command ≥ 3× after errors), commit without any test/lint run in the session, oversized
  startup context (> N tokens from sysctx anatomy), ≥ 50 % cost in sub-agents with no result used, never-
  used MCP server loaded every turn. Surface as a chip in the session list, a "Patterns" panel on the
  repository (count, est. savings, flagged sessions drawer) and one line each in the Executive Summary.
  "Fix" links go to the shipped `user-docs/tuning-your-setup.md` anchors — offline, no PR-deploying library.
- **Extensions:** per-repo pattern thresholds in Settings; feed detected patterns into the advisor prompt.
- **Backward compatibility:** server-side over stored transcripts, backfill with the existing
  recompute sweeper pattern. **Offline:** yes. **Risk:** false positives — every pattern needs a doc in
  `docs/knowledgebase/algorithms/` with an examples table (test policy kind 1) before it ships.

### P4 — Running-now markers and a per-agent swimlane (C4, cheap half) — effort **S–M**

- **Competitors / UI:** agents-observe's Activity swimlane (one lane per sub-agent, icons on a time axis,
  1m/5m/10m/60m zoom) and green live dot per session; ccboard's "running / waiting for input" status;
  disler's pulse strip with `xN` collapsed badges.
- **Minimal version:** (a) session list: a green "running" dot when `otel_session_state.rt_last_at` or the
  last `artisyn` upload is < 2 min old, grey "ended" otherwise — data exists, one SQL field; (b) session
  view: a swimlane strip above Logs built from the sub-agent transcripts' timestamps the Harness usage
  tree already assembles (`harness-usage-tab.md`) — no new upload, no new table.
- **Not in scope:** SSE/WebSocket push and streaming raw hook events (hook change + new transport +
  cluster fan-out = L; polling at 5 s already looks live).
- **Backward compatibility:** old hooks without realtime show "ended" only. **Offline:** yes.

### P5 — MCP server over the Log Hub API (T9) — effort **S–M**

- **Competitors:** Langfuse, Dynatrace, Grafana MCP servers; ccusage statusline.
- **Minimal version:** a stdio MCP server shipped in the hook installer tarball (plain JS, same rules as
  the hook) exposing `list_sessions`, `session_summary`, `session_cost_breakdown`, `repo_patterns`,
  `harness_usage` over the existing REST routes with the user's API key from `log-hub.local.json`;
  installer flag `--mcp` writes the `.mcp.json` entry. Lets Claude Code answer "why was my last session
  expensive?" from inside the terminal — a *why* feature.
- **Backward compatibility:** new optional component; needs API-key access to the read routes that are
  session-cookie-only today (add an API-key guard to the handful of read routes used). **Offline:** yes.

### P6 — Session-view tables borrowed from the hook dashboards — effort **S** each

- **By-prompt cost table** (agents-observe `shots/agents-observe/tokens.png`): every user prompt with
  duration, tool count, tokens, cost, sorted by cost, hover tooltip with tokens × rate per item. Data is in
  the parsed transcript (`parseSessionLogs`, per-turn usage); the Charts tab's Context Growth step rows
  are the nearest existing piece. Fits the Statistics tab.
- **By-agent table** (same screenshot): agent, type, duration, tools, requests, tokens, model, cost —
  the Harness usage tree has the nodes; add the metrics columns from `deriveSessionUsage`.
- **Session outline sidebar** (Langfuse `shots/langfuse/session.png`): a compact per-turn list
  (prompt / tools / assistant) next to the Logs pane for jumping in long sessions.

### UI ideas to borrow, by Log Hub page

- **Session list:** running dot and "waiting for input" state (ccboard, agents-observe); pattern chips
  (Datadog); keep the existing cost colour coding (the z-score "outlier = red" from ccboard already exists).
- **Session view:** by-prompt and by-agent cost tables with rate tooltips (agents-observe); swimlane per
  sub-agent with zoom (agents-observe, disler); outline sidebar (Langfuse); cost split main / subagent /
  utility as a small donut on Summary (Grafana 25255's "Cost by query_source").
- **Repository Analytics / Reports:** KPI strip with vs-previous-period deltas on the Analytics tab (today
  only the Executive Summary has deltas — Datadog, Dynatrace); Key Insights one-liners above the charts
  (Coralogix); Top sessions by cost as a bar leaderboard (cc-otel), already a table in the Executive
  Summary; budget progress bar with reset date (Anthropic); trend chart with a "New alert" button
  (Dynatrace); 5-hour UTC block table from `otel_cost_buckets` (ccboard `shots/ccboard/tui-06-costs-billing-blocks.png`);
  "with vs without" cards for a harness element — sessions using skill/MCP X vs not, cost and duration
  delta (Jellyfish) — a natural extension of the Harness Usage report.
- **Team / Admin:** budgets table and alert log; "power users" card and a users table with model chips
  (Coralogix); repositories not attached to any team as a governance filter in Admin → Repos (Coralogix's
  managed vs unmanaged).

## Rejected or deferred

- **Other agents (Cursor, Codex, Copilot) — out of scope of this plan.** The owner will add them as a
  separate track (decision recorded 2026-11-01); the open task folders
  `docs/tasks/todo/2026-06-20-codex-hooks/` and `2026-08-05-copilot-session-upload/` stay as they are.
  When that track starts, keep the positioning in mind: cost rows alone would put Log Hub among the
  crowded "how much" tools. The value is in bringing the *why* layer (harness, context, tool outcomes)
  to each agent.
- **SSO/SCIM parity with Langfuse — defer.** Mode 4 Azure OAuth exists (`deployment-auth-mode.md`); SCIM
  only on a concrete enterprise request.
- **Evals, LLM-as-judge, annotation queues, custom dashboard builder — reject.** Generic LLM-observability
  features; Session Attributes already cover classification.
- **PromQL / Prometheus `/metrics`, Grafana datasource — defer.** Teams with Grafana can scrape later; no
  product value for the *why* questions. P5 (MCP) closes T9 more cheaply.
- **Plan-limit (Pro/Max) prediction and `rate_limits` capture — defer.** Log Hub prices in USD for teams;
  subscription quotas are opaque and the data would need the hook to own the user's statusline.
  Revisit only if Claude Code exposes rate limits in a hook payload.
- **SSE/WebSocket hook-event streaming — reject** (see P4). **CI gate report — defer** (small, but no
  demand yet; the REST API already allows a script). **Light no-Docker single-user mode — defer (L):**
  PGlite-in-Node is plausible but touches migrations, advisory locks and cluster mode; decide only if the
  solo-dev persona becomes a target.
- **TTS, per-event AI summaries, generated session names — reject** (novelty, not analysis; names are a
  S nice-to-have at most).
- **3D execution graph — marketing asset, not a product feature.** PoC
  `docs/pocs/2026-11-01-2137-session-galaxy-3d/` replays a real 41-agent session as an animated 3D galaxy
  (cost-sized agents, tool-call dots, failures in red, end card with cost centres). It works on real data
  at 60 fps and keeps some *why* (where the money went). Use it for the site / deck / video; in the product
  at most an optional "Galaxy" tab on the session view. The practical counterpart is PoC
  `docs/pocs/2026-11-01-2253-session-map-2d/`: a light 2D session map (one column per workflow run, agent
  cards with cost, tool mix, context and failures, a call log per agent, a scrubbable timeline). It is
  the recommended shape for P4/P6 as a "Map" tab of the session view.
- **Transcript secret/credential audit (ccboard) — defer, M.** It does fit "what data is exposed to the
  model", but it is a new analysis area; schedule after P1–P3.

## Suggested order

1. **Increment 1 — P1 Budgets and alerts** (in-app + email, user/team/repo, day/week/month, warn/exceeded)
   plus the budget bar on Cost view and Executive Summary. Closes the only row where 10 tools lead.
2. **Increment 2 — P2 Outcomes panel + P4(a) running-now dot.** Mostly SQL over existing columns; ships the
   A10 correction visibly and makes the "live" story concrete in the session list.
3. **Increment 3 — P3 Detected patterns** (4 patterns, algorithm docs, repository Patterns panel, session
   chips). The feature that most strengthens "why, not how much"; P5 (MCP server) follows once the
   patterns route exists so the agent can be asked about them.

Each increment: scenario steps in `tests/scenarios/` (one new scenario only for budgets), contract rows for
new routes, algorithm docs for pattern rules, user-doc page updates in `user-docs/` (offline help), and a
`docs/product-kb/competitors.md` refresh of the "Gaps they expose" list.

## LLM observability as a market

Question: is "LLM observability" (Langfuse, Arize, Braintrust, LangSmith, Helicone, Phoenix, W&B Weave) a
niche worth entering? Synthesis of the parity study and `langfuse.md`, checked on 2026-11-01.

- **Who buys it.** Platform teams that build their own LLM applications. Claude Code is a side data source
  for them, not the product they run. Langfuse has ~36.8k stars, but its Claude Code plugin has 29 stars,
  9 open issues and no Claude-Code-specific analysis (`langfuse.md`, the Claude Code rows A3–A8).
- **Position: do not enter; take only the narrow slice that already exists.** Tracing and evals of
  Log Hub's own LLM apps, prompt versions and OTel GenAI ingestion would blur the positioning in the same way
  as other-agent support (see "Rejected or deferred"). The Claude Code-specific part is already here: native
  OTel metrics and logs are accepted, and traces arrive through the hook (per the OTel tab KB article; the
  span path was not re-checked here).
- **Outward instead of inward.** MCP over the REST API (P5) gives platform teams access to Log Hub data
  without Log Hub joining their category. An OTLP export is deferred until someone asks for it.
- **Not verified:** the size of the LLM observability market and its share on Claude Code (no figures in
  the repo, no web research done); whether Arize, Braintrust, LangSmith, Helicone, Phoenix or Weave ship
  Claude Code integrations (not studied); whether Claude Code spans carry `gen_ai.*` attributes (no hit in
  `server/src`, `hook/` or the KB; the only `gen_ai.*` mention in the study is Dynatrace's Copilot SDK example).

## KB articles to move into `knowledgebase/product/`

Already moved: `product-purpose-and-data-capture.md`, `competitors.md`, `legacy-design-decisions-map.md`.
Other candidates, with the reasons not to move them yet:

- `ui-principles.md` — a product-level part exists (light-only, english only, no-access/error states), but
  most of it is implementation (Tailwind, ResizeObserver). It is cited by 8 client comments and
  `.claude/skills/ui-components/SKILL.md`. Move only with those references updated, or split the product rules out.
- **Do not move** (referenced by code, scripts or the test suite): `token-byte-ratio.md` (hook
  `send-logs-hook.js:79`, its mirror, and a frozen legacy fixture that must not change), `algorithms/**`
  and `test/**` (read by the algorithm loader and tests), `model-pricing-research.md` (cited by a migration),
  `task-checks-guide.md` (cited by `docs/tasks/todo/index.md`).
- **Stay as reference** (implementation): `data-retention.md` (service and env mechanics; if a retention
  policy is needed, write a new short article in `product/`), `session-id-vs-sessionid.md`, `api-reference.md`,
  `db-*.md`, `hook-*.md`, `otel-*.md`, `log-schema/**`.
- Housekeeping: `product-purpose-and-data-capture.md` names neighbouring articles as bare file names in
  inline code; add `../` if they should become links.
