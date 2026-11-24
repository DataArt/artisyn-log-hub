---
type: "Task"
title: "Session Cost Diagnosis and Antipattern Detector"
description: "\"why was this session expensive\" on the session Summary tab: an exact cost split (prompts, sub-agents, utility calls) plus a deterministic catalog of named antipatterns (cache expired after idle, context bloat, huge tool result, huge nested CLAUDE.md, oversized startup, unused MCP, …) with evidence, est. waste, fixes and links to the turn; shared predicates in packages/, repository Patterns panel (gap-closing-plan P3, AgentsView `session diagnose` parity)"
---

# 2026-11-02: Session Cost Diagnosis and Antipattern Detector

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | client | shared (`packages/`)
**Owner:** denis.tsyplakov
**Created:** 2026-11-02
**Tracker:** GH-81 https://github.com/DataArt/artisyn-log-hub/issues/81

## Description

This task merges two ideas (2026-11-21):

- **Session cost diagnosis** (was `2026-11-13-session-cost-diagnosis`, GH-144): a one-click "why
  was this session expensive" view per session, inspired by AgentsView v0.47.0
  `session diagnose <id>` (https://github.com/kenn-io/agentsview/releases/tag/v0.47.0, morning
  check 2026-11-13): where the cost came from, with links to the exact turns.
- **Antipattern detector** (this task, GH-81): a deterministic catalog of named patterns with exact
  predicates, evidence, estimated waste and a fix.

They are one feature: a cost driver that is avoidable *is* an antipattern finding (a cache rebuild
after idle = pattern #1, a huge tool result carried in context = #10, a 200k+ context = #2), so they
share predicates, evidence, waste estimates and the place in the UI.

### What already exists (do not rebuild)

- **Session Summary tab** (`client/.../session-log/summary/`, default landing tab):
  - "Detected issues" — client-side detector registry `summary/detectors/registry.ts`
    (`context-compression`, `context-ceiling-pressure`, `low-cache-read-ratio`, three
    `change-surface-*`, `claude-version`), thresholds in `detectors/thresholds.ts`, each finding
    with severity, evidence and `onGoToTurn` deep link into Logs. **New patterns are added to this
    registry**, not to a new tab.
  - `SummaryPromptCostTable` — cost per prompt, already the prompt's full impact (main thread +
    that turn's sub-agents and workflow-agent share), clickable to the turn.
  - Executive band — session cost (main + sub-agents), peak context, delegation tile.
- **Context Growth chart** — per-step context delta (off-by-one fixed in
  `2026-10-22-context-growth-item-modal`) and a step details modal: the jump target for
  tool-result findings.
- **Sub-agent cost** — `subagentStats` in the `/logs` payload (`selectSubagentStats`), OTEL
  fallback for CC < 2.1.307 (`2026-11-03-otel-cost-attribution` FR-6); cost by skill / MCP / agent
  on the OTEL tabs.
- **Advisor evidence** (`2026-11-11-advisor-evidence-advice`, hook `advisor-evidence.js`, algorithm
  doc `algorithms/advisor-evidence.md`): per-call price, cache rebuilds with cause and extra cost,
  per-prompt cost, largest tool results, failed calls by tool. It runs only in the hook, only feeds
  the LLM prompt, and the user sees only the Advisor's prose. Its rules (pricing per call, rebuild
  rule 6-8, prompt split rule 9-10) are the reference for the server/shared implementation here.

### What is missing

1. A deterministic, visible split of the session cost by driver (today only per prompt).
2. Named avoidable-cost patterns with a waste estimate and a fix (today only compaction / ceiling /
   low cache-read ratio, without $).
3. Anything per repository: findings are computed in the browser per opened session only.

### Antipattern research

Raw idea: a deterministic detector of fixed, named antipatterns in Claude Code sessions — the
"Detected patterns" item P3 of `docs/product-kb/competitive-research/gap-closing-plan.md` (Datadog's
"Detected Problems"). The existing Turn-End Cost Advisor is an LLM that gives generic prose advice;
this feature instead searches for a fixed catalog of patterns with exact predicates, so a finding is
reproducible, countable per repository and has a concrete fix.

The first known candidate was "the session exceeded ~70% of the context window / was compacted".
To decide WHAT to detect, a research pass (2026-11-02) measured candidates over the maintainer's
real transcripts (~400 main sessions, ~1,700 sub-agents, ~50k API calls in the LogHub, cyberberg,
at-authors and telemetry projects) and catalogued what competitors detect.

#### Research findings — catalog of candidates

Numbers are measured on that corpus unless marked as an estimate. Dollar figures are approximate
(two research passes priced differently: `model_pricing` rows vs list prices; ratios are reliable,
absolute sums are not).

The "70% of window" form rarely fires: 97% of calls run on `claude-opus-5-5` with a 1M window, only
5 sessions reached 70% and only 4 auto-compactions happened. The real problem is absolute context
size (see #2), so thresholds must be absolute and per-model window comes from
`model_pricing.context_length` (model ids never carry `[1m]`).

| # | Pattern | Predicate (draft) | Measured frequency / cost | False-positive risk |
|---|---|---|---|---|
| 1 | Cache expired after idle | gap > cache TTL actually used (main 1 h, sub-agent 5 m, from `usage.cache_creation`), then `cache_read < 0.5 × previous context` and `cache_creation > 20k` | 14% of sessions, ~$200. Clean split: all 85 main gaps > 60 min missed, all 720 gaps of 5–60 min hit. Sub-agents: 73 of 76 misses follow a long foreground Bash | low |
| 2 | Context bloat / multi-task session | call context > 200k, or ≥ 15 prompts with peak > 300k | 22% of sessions exceed 200k; cache reads above 200k ≈ 18% of main-session cost; 6% of sessions carry 44% of cost | medium |
| 3 | Huge nested CLAUDE.md loaded mid-session | `nested_memory` attachment > 20k chars | 50 loads in 43 transcripts, ~$70; a 370 KB / 250 KB CLAUDE.md caused both 967k auto-compactions | very low |
| 4 | Oversized startup context | first-call context > 50k (main) / > 40k (sub-agent) | median 57k main / 48k sub-agent (skill listing ~7k tokens, CLAUDE.md, deferred tools); every 10k always-loaded tokens ≈ $215 on the corpus (estimate) | low |
| 5 | Expensive model on mechanical sub-agents | Opus sub-agent, ≤ 3 tool calls, no Edit/Write, description/phase matches check/build/lint/typecheck/judge | 229–342 agents, $80–137; Haiku/Sonnet would save ~$55–110 (estimate) | low–medium |
| 6 | Shell escaping failure | failed shell call with `unexpected EOF while looking for matching`, `syntax error near unexpected token`, `unterminated quoted string`, or `node -e` failing with `SyntaxError` | 13–14% of sessions, ~31% of all failed shell calls; heredoc used ~2,300 times despite the CLAUDE.md rule | low |
| 7 | Commit without a check | `git commit` after Edit/Write with no test/lint/typecheck/build (or check-health) after the last edit | 19 of 41 commits (46%) | medium (check may run in a sub-agent / earlier turn) |
| 8 | Exit code masked by pipe | build/test/lint piped to `tail`/`head`/`grep`, result text shows failure, `is_error = false` | 573 runs; the tool-outcome algorithm counts them as successes | medium |
| 9 | MCP server loaded but never used | server tools in `deferred_tools_delta`, no `mcp__<server>__` call in the session tree | webstorm 0 of 367 sessions, Salesforce 0 of 288, Canva/Figma/Miro 0 | low |
| 10 | Huge single tool result | context grows > 20k between consecutive calls (minus previous output) | 406 events, ~$175; typical: a workflow sub-agent reading a whole `impl-plan.md` | medium |
| 11 | Sleep / polling loop | ≥ 3 `sleep` / `Start-Sleep` calls, or a harness "Blocked: sleep" error | 8% of sessions | low |
| 12 | Repeated workflow step / reviewer | same workflow step description ≥ 2× per session, or Agent prompts with word-set Jaccard ≥ 0.9 | ~$130 + ~$68 | high (repeats are often deliberate) |

Informational friction signals (show, do not grade as "bad"): user pushback right after an agent
turn ("нет", "стоп", "я же просил", "wrong", …) in 15% of sessions; agent retraction ("вы правы",
"you're right", "my mistake") in 8%; a turn with ≥ 100 tool calls without a user checkpoint (16% of
cost, mostly intended `/implement` runs); git write operations not asked for in the last prompts
(19, needs manual review).

Checked and rare on this data (no detector for now): identical file re-reads (Claude Code returns a
stub for an unchanged re-read — matches the FR-6 finding in `algorithms/okf-access-extraction.md`),
retry / doom loops, Edit-failure loops, wrong-shell syntax, failed or empty sub-agents, TaskOutput
polling, cache busting without idle (4 events, mostly `/model` switch).

#### Competitors

- Datadog: Detected Problems Sankey (agent → pattern → repo), editable predicate
  (`commit_count > 0 AND push_count > 0 AND test_fix_cycle_count = 0` for "skipped checks"), flagged
  sessions list, estimated savings per repo, "Was this helpful?", Fix Library (PreToolUse hook,
  skill, pre-commit lint). Open-source marker definitions: `datadog-labs/trajectory`.
- Anthropic `/usage`: one row per recommendation with share of usage ("Trim CLAUDE.md · 49k tokens per
  request"), `f` auto-applies the fix; `/insights` is LLM-labelled friction (not deterministic).
- claude-doctor, Loop-Watchdog, agentfdr: edit thrashing (≥ 5 edits per file), error loop (≥ 3
  consecutive failures), read:edit > 10:1, correction-heavy sessions (≥ 20% prompts start with
  "no/wrong"), repeated instructions (Jaccard > 0.6 within 5 turns), generated CLAUDE.md rules.
- ccboard: z-score cost outliers (2σ / 3σ).
- AgentsView `session diagnose` (v0.47.0): per-session ranked cost drivers — context growth,
  compactions, large tool results, retries, subagents — the "why was this expensive" shape this
  task adopts for its cost split.

## Functional Requirements

### A. Cost split — "Where the cost went"

- **FR-A1 Block on the Summary tab.** The Summary tab gets a "Where the cost went" block next to the
  existing per-prompt cost table. The band's Cost tile links to it (one click from the session
  header). No new session tab, no modal.
- **FR-A2 Exact partition.** The block splits the session cost (the same figure as the Cost tile)
  into disjoint parts that add up to 100 %: the main thread, each sub-agent / workflow agent
  (top 10 by cost + one "other agents" row), utility calls. The main-thread part is further split
  by token kind (cache read, cache write, output, input). Each row shows USD, % of the session
  cost and a one-line explanation; rows are sorted by USD, descending.
- **FR-A3 Agent rows link.** An agent row links to the turn that launched it (Logs deep link,
  `onGoToTurn`); a workflow agent row opens its workflow agent modal.
- **FR-A4 Reuse, not a new formula.** All figures come from data the session pane already loads
  (`/logs` payload: per-call usage, `subagentStats` incl. its OTEL fallback, `costBreakdown`) and
  the existing cost formula (`@loghub/pricing`). If the payload lacks a figure, the server adds it to
  `/logs` (additive field) — no second cost route, no new pricing code.
- **FR-A5 Not in the split.** Retries and compactions are not cost drivers of their own: the
  research found retry / doom loops rare, and compactions are already the `context-compression`
  finding. Compaction turns stay visible as `(auto)` rows of the prompt cost table.

### B. Avoidable cost — named patterns

- **FR-B1 Catalog.** A fixed catalog of named patterns computed deterministically (no LLM call). First
  set: #1 cache expired after idle, #2 context bloat, #10 huge single tool result (the three cost
  drivers of the merged diagnosis task), #3 huge nested CLAUDE.md, #4 oversized startup context,
  #9 MCP loaded but unused. #7 commit without a check and the rest of the catalog are candidates for
  later sets.
- **FR-B2 Finding.** Each finding has the pattern key, evidence (transcript line / agent, measured
  values), an estimated waste in USD (and tokens) where the pattern has one, and a link to the exact
  turn / step: Logs turn for #1, #2, #3, #9; the Context Growth step modal for #10.
- **FR-B3 Waste is an estimate, not a share.** Waste figures may overlap (a rebuild on a 300k context
  is both #1 and #2), so they are shown as "est. avoidable $" next to the finding and never summed
  into the FR-A2 partition or into one "total waste" figure.
- **FR-B4 Same rules as the advisor.** #1 uses the advisor-evidence rebuild rules (rules 6-8:
  ≥ 20000 tokens and ≥ half the previous context, cause by model switch / TTL gap, extra cost = write
  minus reading the same tokens). Per-call prices follow its rules 1-4 through `@loghub/pricing`.
- **FR-B5 Thresholds.** Absolute token counts and the model's context window from
  `model_pricing.context_length`, never the model id. All literals live in one thresholds module.
- **FR-B6 Shown in "Detected issues".** Findings are added to the Summary tab's existing detector
  registry (`summary/detectors/`), ordered by severity and then by est. waste; the existing
  `low-cache-read-ratio` and `context-ceiling-pressure` detectors are kept or replaced by #1 / #2
  where they say the same thing (decide in the plan, no duplicate findings for one cause).
- **FR-B7 Fix text.** Every pattern has a fixed, offline "how to fix" text (a CLAUDE.md rule, a hook,
  a per-step `model:`, …) in `@loghub/recommendations` under `session.*` ids, linked to the shipped
  user docs.
- **FR-B8 Friction signals.** Informational signals (pushback, retraction, very long turns) are shown
  as information, never as a graded defect.

### C. Repository view

- **FR-C1 Server computation.** The server computes the same findings per session (needed for
  counts across sessions) with the same predicates as the client: the predicates live in a
  `packages/` package used by both (see "Shared packages" in CLAUDE.md) — no hand-kept twin.
- **FR-C2 Backfill.** Existing sessions get findings via a backfill / recompute; findings are
  recomputed when a session's logs change.
- **FR-C3 Session list.** The session list shows pattern chips.
- **FR-C4 Patterns panel.** The repository view shows a Patterns panel: per pattern — flagged
  sessions count, share of sessions, est. waste, flagged-sessions list (each opens the session on
  its Summary tab).

## Non-Functional Requirements

- Backward compatible with old hooks: everything comes from transcripts already uploaded; no hook
  change and no hook version bump. A session from an old hook / old Claude Code renders the block and
  the findings; a part whose data is missing (no `usage.cache_creation` split, no per-call usage, no
  `nested_memory` attachments) shows "not available for this session", never an error.
- Old clients: new `/logs` fields are additive; no existing field changes meaning.
- Offline: no external calls; fix texts ship with the product.
- Performance: the Summary tab stays computed from the already-loaded payload (no extra request on
  open); the repository panel reads stored findings, not transcripts.

## Tests

- **Algorithm:** a doc per pattern group in `docs/knowledgebase/algorithms/` (or one
  `session-patterns.md`) with its rows file `docs/algorithm-examples/<name>.json`, a matching and a
  near-miss row per pattern; the cost split gets rows too (partition sums to the Cost tile, agent top
  10 + other). The advisor-evidence rebuild rows (`advisor-evidence.json`, AE-R*) are reused for #1
  through a twin entry in `advisor-evidence.md` — no copied rows.
- **API contract:** the route serving the repository Patterns panel and any changed `/logs` field get
  their rows in `server/test/contract/registry/`.
- **Scenario:** a step in the existing session Summary scenario (grep `tests/scenarios/` for the
  Summary tab) opens a fixture session with a sub-agent, an idle rebuild and a big tool result and
  checks the split rows, the findings and one deep link; a step in an existing repository-view
  scenario checks the Patterns panel.

## Acceptance Criteria

- [ ] FR-A1: on a session's Summary tab, one click on the Cost tile scrolls to "Where the cost went".
- [ ] FR-A2: the rows add up to the Cost tile's figure (± rounding) and are sorted by USD; a session
      with 12 agents shows 10 agent rows + "other agents".
- [ ] FR-A3: clicking an agent row lands on the turn that launched it.
- [ ] FR-A4: no new pricing code and no second cost route; the figures match the Cost tile and the
      per-prompt table.
- [ ] FR-B1: for each first-set pattern, a fixture matching its predicate is flagged and a near-miss
      fixture is not (algorithm rows).
- [ ] FR-B2: a finding shows pattern key, evidence, est. waste where defined and a working link to
      the turn (#10: the Context Growth step modal of the offending step).
- [ ] FR-B3: a rebuild on a 300k context shows both findings, each with its own estimate, and no
      summed "total waste" anywhere.
- [ ] FR-B4: on the advisor-evidence rebuild rows the server/shared code gives the same rebuilds,
      causes and extra cost as the hook.
- [ ] FR-B5: a session on a 1M-window model is evaluated against its window from `model_pricing`.
- [ ] FR-B6: no cause is reported twice in "Detected issues".
- [ ] FR-B7: every finding shows its fix text without network access.
- [ ] FR-B8: friction signals have no severity grade.
- [ ] FR-C1: client and server import the predicates from one `packages/` package.
- [ ] FR-C2: after backfill, sessions ingested before the feature have findings.
- [ ] FR-C3 / FR-C4: a flagged session shows a chip in the list; the Patterns panel lists each
      pattern with count, share, est. waste and the flagged sessions.
- [ ] NFR: a session uploaded by an old hook renders the block and the findings with the missing parts
      marked "not available for this session", and no error.

## Open Questions

- Server storage of findings: compute at ingest into a new table (P3 draft: `session_patterns`) or
  at read time for the panel?
- Per-repo thresholds / suppression in Settings now or later?
- Feed findings into the Turn-End Cost Advisor prompt (the advisor already computes rebuilds itself)?
- Replace `low-cache-read-ratio` / `context-ceiling-pressure` with #1 / #2, or keep both and
  suppress the overlap (FR-B6)?

## Notes

- 2026-11-02: research scripts and raw reports were kept in the session scratchpad only
  (not in the repo).
- 2026-11-11: the catalog package `@loghub/recommendations` (`packages/recommendations/`) now
  exists, created by `2026-11-11-sysctx-recommendations`. Its entries use the `startup.*` id
  namespace (ids stable, never reused); this task's entries are meant to join the same package
  under `session.*`. It is wired into the client only — this task adds the server `file:`
  dependency if it needs one. See `docs/knowledgebase/repo-local-packages.md`.
- **2026-11-21:** merged `2026-11-13-session-cost-diagnosis` (GH-144) into this task and rewrote
  the requirements against what already shipped: the Summary tab's detector registry and per-prompt
  cost table (the diagnosis lives there, no new tab), the advisor-evidence rules (reused for #1 and
  per-call prices), `subagentStats` with the OTEL fallback. Dropped from the diagnosis idea:
  retries and compactions as separate cost drivers (research: retries rare; compaction is already a
  finding). Cost overlap is solved by an exact partition (FR-A2) plus non-summed waste estimates
  (FR-B3). First pattern set now #1, #2, #10, #3, #4, #9 (#7 moved to a later set).
- **2026-11-24:** not implemented yet. PR #82 (merged) carried only the research and this task
  draft — no code change; the task stays open.
