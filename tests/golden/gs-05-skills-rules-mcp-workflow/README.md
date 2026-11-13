# GS-05 harness

One root session on `feature/billing` (claude-sonnet-4-6) with a two-agent workflow (claude-haiku-4-5),
W1 Thursday 10:00:00–10:03:30.

- `/clear` in the old `<command-name>`-first shape (neither a prompt nor tracked), then P1
  `/adlc:review src/` in the new `<command-message>`-first shape (a prompt, tracked as a skill), then
  P2 "Research the billing flow" with `Skill(adlc:review-deep)`, `Read`, `mcp__postgres__query` ×2,
  `mcp__playwright__browser_click` ×1 and `Workflow(ResearchWorkflow)`.
- The startup block (everything before the first assistant line `msg_gs05_001`) is, in order: `mode`;
  a `prompt_snapshot` (`gs05-0000p`) with four `systemPrompt` blocks — 2800 B starting `You are`,
  700 B starting `# Memory` (the memory index), the 34 B `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker
  and a 316 B session part `# Environment` (working directory `/work/repo-gold/src`, a
  `~/.claude/projects/…/MEMORY.md` path and `/tmp/gs05-scratch/notes.txt`, contains
  `GS05-SESSION-MARKER`), plus the flags `cliPrefix`, `reminderFold`, `contextRendering` and an
  invented object flag `gs05Extra`; a `date` attachment (`gs05-0000d`, 35 B as JSON); the
  `skill_listing` (83 B = 44 + 39); the `deferred_tools_delta` (`gs05-0006`) listing six MCP
  tools (postgres 21 + 27 = 48 B, playwright 31 B, then the claude.ai stub connector
  `mcp__claude_ai_Gmail__authenticate` 35 B + `…__complete_authentication` 46 B = 81 B and the
  user-level `mcp__context7__get_docs` 24 B; each name + 1), announced before the first MCP call; an
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
- Right after the first assistant line (`gs05-0003`) a second, late `prompt_snapshot` (`gs05-0003p`)
  carries the tool definitions in the real shape — each item's `schema` is the whole wire tool
  `{name, description, input_schema}`: `Read` (a Markdown table, a `/home/dev/notes.md` path,
  `GS05-TOOL-MARKER` and a literal `<system-reminder>` tag in its description; an input schema with
  a `C:\Users\dev\file.txt` example), `Bash` (`server: "gs05-mcp"`), and the built-ins `Artifact`
  (700 B) and `PowerShell` (350 B) with ASCII `x` filler descriptions. No `api-request-shape` is
  logged, so it is the source of the anatomy's Tool definitions row (it sits after the anchor; the
  tool set is the one of the first request).
- System context anatomy (total 800 + 8000 + 0 = 8800 tokens, cpt 3.5): system prompt 890
  (2800 + 316 = 3116 B; the 34 B boundary marker is not prompt text), memory 200, tool definitions
  408 (`Read` 299 B + `Bash` 79 B + `Artifact` 700 B + `PowerShell` 350 B = 1428 B, name +
  description + input-schema JSON), environment 10, MCP servers 153 (48 + 350 + 31 + 81 + 24 =
  534 B), skills 24, instruction files 1500, system reminders 100, first prompt 72 → attributed
  3357, harness internals 5443 (61.9 %).
- System prompt viewer: 3 parts (shared 2, session 1; 2800 + 700 + 316 = 3816 B ≈ 1090 tokens),
  4 tools (`Read` 299 B + `Bash` 79 B + `Artifact` 700 B + `PowerShell` 350 B = 1428 B ≈ 408
  tokens), total 5244 B ≈ 1498 tokens; every absolute path is masked (`src`,
  `~/.claude/projects/<project-slug>/…`, `<outside>/notes.txt`).
- Startup context recommendations (`expected.json` `recommendations`, algorithm doc
  `startup-recommendations.md`): 8 rows in catalog order — rare built-in tools (`Artifact` 700 B ≈
  200), two shells (`PowerShell` 350 + `Bash` 79 ≈ 123), claude.ai connectors not signed in
  (`claude_ai_Gmail` 81 B ≈ 23), user-level MCP servers (`context7` 24 B ≈ 7), auto-memory
  (`MEMORY.md` 700 B ≈ 200), project CLAUDE.md (`CLAUDE.md` 3500 + `CLAUDE.local.md` 700 ≈ 1200),
  project MCP servers (`postgres` 398 + `playwright` 31 ≈ 123) and plugin skills (`adlc@artisyn`
  83 B ≈ 24) → ≈ 1900 tokens, 21.6 % of 8800.
- The artisyn log carries the harness self-report as one fixed-id `harness-snapshot` (plus its
  `harness-snapshot-ref`): skills `adlc:review-deep` and `adlc:review` (`plugin`, `adlc@1.0.0`,
  git `outside-repo`), `unused-skill` (`project`, `untracked`) and `gold-sync` (`org-synced`, masked
  path `~/.claude/skills/synced/<org>/gold-sync/SKILL.md`, empty body — the server leaves it out of the
  skill inventory, so `inventory`/`harnessUsage` do not change), MCP servers `postgres` and
  `playwright` (`configSource: "project"`) and `context7` (`configSource: "user"`, connected, one
  tool `get_docs`; claude.ai connectors are not in the snapshot), and `systemContext` (6300 B: CLAUDE.md 3500 B `tracked`, CLAUDE.local.md 700 B
  `ignored`, rules db.md `tracked` and ui.md `untracked`). The literal `snapshotId` is kept on purpose:
  the server never recomputes it.
- Workflow agents are uploaded with `workflowRunId`: W1 edits `src/report.ts` **without** a
  `toolUseResult` (+1 −0 from the inputs), W2 runs `Skill(adlc:review-deep)` and `Read`. The
  completion notification reports 45 000 ms, 2 agents, 6 500 tokens.
- Agent meta labels (the hook's `.meta.json` `description` / `workflowPhase`): W1 is uploaded with
  `agentDescription` `load-config` and `workflowPhase` `Config`; W2 has neither, so it keeps the
  prompt fallback label and shows `—` in the Agents table's Phase column.
- Cost: root 0.0735 + W1 0.0080 + W2 0.0045 = **$0.0860**; work time 60 + 90 = **150 s**.

Checks: both slash-command shapes, skill/rule/MCP/workflow rows, the System context anatomy tab, workflow
agents without `toolUseResult`, sub-sessions in Harness usage.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
