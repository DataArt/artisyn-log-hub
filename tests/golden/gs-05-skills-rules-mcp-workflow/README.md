# GS-05 harness

One root session on `feature/billing` (claude-sonnet-4-6) with a two-agent workflow (claude-haiku-4-5),
W1 Thursday 10:00:00–10:03:30.

- `/clear` in the old `<command-name>`-first shape (neither a prompt nor tracked), then P1
  `/adlc:review src/` in the new `<command-message>`-first shape (a prompt, tracked as a skill), then
  P2 "Research the billing flow" with `Skill(adlc:review-deep)`, `Read`, `mcp__postgres__query` ×2,
  `mcp__playwright__browser_click` ×1 and `Workflow(ResearchWorkflow)`.
- Rules `.claude/rules/db.md` (700 B) and `ui.md` (1400 B) arrive as `nested_memory` attachments; the
  skill body is 1750 B; a `deferred_tools_delta` lists the three MCP tools.
- The artisyn log carries the harness self-report: `mcp-config` (postgres, playwright),
  `skill-definitions` (`adlc:review-deep`, `adlc:review`, `unused-skill`) and `system-context`
  (CLAUDE.md 3500 B plus the two rules).
- Workflow agents are uploaded with `workflowRunId`: W1 edits `src/report.ts` **without** a
  `toolUseResult` (+1 −0 from the inputs), W2 runs `Skill(adlc:review-deep)` and `Read`. The
  completion notification reports 45 000 ms, 2 agents, 6 500 tokens.
- Cost: root 0.0735 + W1 0.0080 + W2 0.0045 = **$0.0860**; work time 60 + 90 = **150 s**.

Checks: both slash-command shapes, skill/rule/MCP/workflow rows, the context panel, workflow
agents without `toolUseResult`, sub-sessions in Harness usage.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
