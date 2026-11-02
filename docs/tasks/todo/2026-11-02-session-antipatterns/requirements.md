# 2026-11-02: Session Antipattern Detector (Detected Patterns)

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | client
**Owner:** denis.tsyplakov
**Created:** 2026-11-02
**Tracker:** GH-81 https://github.com/DataArt/artisyn-log-hub/issues/81

## Description

Raw idea: a deterministic detector of fixed, named antipatterns in Claude Code sessions — the
"Detected patterns" item P3 of `docs/competitive-research/gap-closing-plan.md` (Datadog's
"Detected Problems"). The existing Turn-End Cost Advisor is an LLM that gives generic prose advice;
this feature instead searches for a fixed catalog of patterns with exact predicates, so a finding is
reproducible, countable per repository and has a concrete fix.

The first known candidate was "the session exceeded ~70% of the context window / was compacted".
To decide WHAT to detect, a research pass (2026-11-02) measured candidates over the maintainer's
real transcripts (~400 main sessions, ~1,700 sub-agents, ~50k API calls in the LogHub, cyberberg,
at-authors and telemetry projects) and catalogued what competitors detect.

### Research findings — catalog of candidates

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

### Competitors

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

## Functional Requirements

- FR-1: The server computes a fixed catalog of named patterns per session deterministically from
  stored transcripts (no LLM call). First set: #1 cache expired after idle, #2 context bloat, #3 huge
  nested CLAUDE.md, #4 oversized startup context, #7 commit without a check, #9 MCP loaded but
  unused. Others in the catalog above are candidates for later sets.
- FR-2: Each finding stores the pattern key, evidence (transcript line/agent, measured values) and
  an estimated waste (tokens and/or $) where the pattern has one.
- FR-3: Thresholds use absolute token counts and the model's context window from
  `model_pricing.context_length`, not the model id.
- FR-4: Existing sessions get findings via a backfill/recompute; findings are recomputed when a
  session's logs change.
- FR-5: The session list shows pattern chips; the session view shows the session's findings with
  evidence and a jump to the offending point.
- FR-6: The repository view shows a Patterns panel: per pattern — count of flagged sessions, share
  of sessions, estimated waste, flagged-sessions list.
- FR-7: Every pattern has a fixed, offline "how to fix" text (e.g. a CLAUDE.md rule, a hook, a
  per-step `model:`), linked to the shipped user docs.
- FR-8: Informational friction signals (pushback, retraction, very long turns) are shown as
  information, never as a graded defect.

## Non-Functional Requirements

- Backward compatible with old hooks: everything is computed server-side from transcripts already
  uploaded; no hook change is required.
- Offline: no external calls; fix texts ship with the product.
- Each pattern has an algorithm doc in `docs/knowledgebase/algorithms/` with a worked-examples table
  (test policy kind 1) before it ships.

## Acceptance Criteria

- [ ] FR-1: For each first-set pattern, a session fixture matching its predicate is flagged and a
      near-miss fixture is not (algorithm doc examples table).
- [ ] FR-2: A finding exposes pattern key, evidence pointing to the transcript location, and an
      estimated waste value where defined.
- [ ] FR-3: A session on a 1M-window model is evaluated against its window from `model_pricing`.
- [ ] FR-4: After backfill, sessions ingested before the feature have findings.
- [ ] FR-5: A flagged session shows a chip in the session list and the findings in the session view.
- [ ] FR-6: The repository Patterns panel lists each pattern with count, share, estimated waste and
      the flagged sessions.
- [ ] FR-7: Every finding shows its fix text without network access.
- [ ] FR-8: Friction signals are shown without a defect/severity grade.

## Open Questions

- Which patterns go into the first set (draft: #1, #2, #3, #4, #7, #9)?
- Compute at ingest into a new table (P3 draft: `session_patterns`) or at read time?
- Per-repo thresholds/suppression in Settings now or later?
- Feed findings into the Turn-End Cost Advisor prompt?

## Notes

- 2026-11-02: research scripts and raw reports were kept in the session scratchpad only
  (not in the repo).
