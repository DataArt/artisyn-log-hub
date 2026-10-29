# GS-05 harness

One root session on `feature/billing` (claude-sonnet-4-6) with a two-agent workflow (claude-haiku-4-5),
W1 Thursday 10:00:00–10:03:30.

- `/clear` in the old `<command-name>`-first shape (neither a prompt nor tracked), then P1
  `/adlc:review src/` in the new `<command-message>`-first shape (a prompt, tracked as a skill), then
  P2 "Research the billing flow" with `Skill(adlc:review-deep)`, `Read`, `mcp__postgres__query` ×2,
  `mcp__playwright__browser_click` ×1 and `Workflow(ResearchWorkflow)`.
- The startup block (everything before the first assistant line `msg_gs05_001`) is, in order: `mode`;
  a `prompt_snapshot` (`gs05-0000p`) with two `systemPrompt` blocks — 2800 B starting `You are` and
  700 B starting `# Memory` (the memory index); a `date` attachment (`gs05-0000d`, 35 B as JSON); the
  `skill_listing` (83 B = 44 + 39); the `deferred_tools_delta` (`gs05-0006`) listing the three MCP
  tools (postgres 21 + 27 = 48 B, playwright 31 B), announced before the first MCP call; an
  `mcp_instructions_delta` (`gs05-0000m`) with a 350 B `postgres` block; the `instructions`
  attachment; a `session_context` (`gs05-0000s`: `userEmail` 16 B + `gitStatus` 334 B = 350 B); then
  the two user lines (130 + 122 = 252 B). All filler text is ASCII.
- The `instructions` attachment (`gs05-0000i`) lists the initial instruction files: User
  `/home/golden/.claude/CLAUDE.md` (1050 B, shown as `~/.claude/CLAUDE.md`), Project
  `/work/repo-gold/CLAUDE.md` (3500 B — the same file as the snapshot's `CLAUDE.md`, so the anatomy
  files drill-down shows it once) and Local `/work/repo-gold/CLAUDE.local.md` (700 B, contains
  `GS05-LOCAL-MARKER`, which must never appear in the UI).
- Rules `.claude/rules/db.md` (700 B) and `ui.md` (1400 B) arrive as `nested_memory` attachments
  (on demand, 0 at start); the skill body is 1750 B. An `isInitial: true` `skill_listing` attachment
  names `adlc:review-deep` and `adlc:review` — `unused-skill` is in the harness snapshot but never
  listed, so the anatomy skills drill-down has no row for it.
- System context anatomy (total 800 + 8000 + 0 = 8800 tokens, cpt 3.5): system prompt 800, memory
  200, environment 10, MCP servers 123, skills 24, instruction files 1500, system reminders 100,
  first prompt 72 → attributed 2829, harness internals 5971 (67.9 %).
- The artisyn log carries the harness self-report as one fixed-id `harness-snapshot` (plus its
  `harness-snapshot-ref`): skills `adlc:review-deep` and `adlc:review` (`plugin`, `adlc@1.0.0`,
  git `outside-repo`), `unused-skill` (`project`, `untracked`) and `gold-sync` (`org-synced`, masked
  path `~/.claude/skills/synced/<org>/gold-sync/SKILL.md`, empty body — the server leaves it out of the
  skill inventory, so `inventory`/`harnessUsage` do not change), MCP servers `postgres` and
  `playwright`, and `systemContext` (6300 B: CLAUDE.md 3500 B `tracked`, CLAUDE.local.md 700 B
  `ignored`, rules db.md `tracked` and ui.md `untracked`). The literal `snapshotId` is kept on purpose:
  the server never recomputes it.
- Workflow agents are uploaded with `workflowRunId`: W1 edits `src/report.ts` **without** a
  `toolUseResult` (+1 −0 from the inputs), W2 runs `Skill(adlc:review-deep)` and `Read`. The
  completion notification reports 45 000 ms, 2 agents, 6 500 tokens.
- Cost: root 0.0735 + W1 0.0080 + W2 0.0045 = **$0.0860**; work time 60 + 90 = **150 s**.

Checks: both slash-command shapes, skill/rule/MCP/workflow rows, the System context anatomy tab, workflow
agents without `toolUseResult`, sub-sessions in Harness usage.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
