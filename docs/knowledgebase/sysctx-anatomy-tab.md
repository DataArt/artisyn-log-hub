---
type: "Architecture Guide"
title: "System Context Anatomy Tab"
description: "The session view's System context anatomy tab: where its data comes from (raw main transcript + harness snapshot, no extra request), the partitions and drill-downs, the edge-state banners, the test ids, the one-line Logs summary that replaced the System Context panel, and the hook 2.28.0 gitStatus / org-synced fields it reads."
tags:
  - client
  - session-view
  - harness
  - hook
timestamp: "2026-10-29T00:00:00+04:00"
---

# System Context Anatomy Tab

The session view's rightmost tab, **System context anatomy** (tab id `sysctx`), answers "what did
Claude Code send before the user typed anything, and how big was each part?". It shows the exact
token total of the first request and splits it into estimated partitions (system prompt, MCP
servers, skills listing, instruction files, …), with what is left over shown as **Harness
internals**.

It replaced the collapsible **System Context panel** at the top of the Logs tab
(`SessionContextPanel`, its five detail modals, `SourceBadge`, `SystemContextFilesTab` and
`context-panel-helpers.ts`, all deleted). The Logs tab now shows only a one-line summary,
`StartupContextLine`, that links here.

The computation rules and worked examples are in the algorithm doc
[System Context Anatomy Algorithm](algorithms/sysctx-anatomy.md) — this article is about the tab,
its data flow and its UI contract. Task: `docs/tasks/todo/2026-10-29-sysctx-anatomy-tab/`.

## Files

All under `client/src/viewer/pages/repository/`:

| File | Role |
|---|---|
| `session-log/sysctx-anatomy/sysctx-anatomy.ts` | Pure builder: `buildSysctxAnatomy`, `computeStartupTotal`, `splitSkillListing`, `mcpKey` |
| `session-log/sysctx-anatomy/sysctx-anatomy-constants.ts` | Kind / source / git vocabularies, `KIND_LABELS`, `KIND_COLORS`, `GIT_LABELS`, `HARNESS_INTERNALS_HINT`, preview and bar-size constants |
| `session-log/sysctx-anatomy/sysctx-anatomy.algo.test.ts` | Vitest table test over the algorithm doc's examples |
| `session-log/sysctx-anatomy/SessionSysctxAnatomyTab.tsx` | The tab: header, banners, bar, table, `selectedKind` / expanded state |
| `session-log/sysctx-anatomy/AnatomyPartitionBar.tsx` | The stacked bar and its segment tooltips |
| `session-log/sysctx-anatomy/AnatomyPartitionTable.tsx` | The partition table, expand chevrons, Harness internals hint |
| `session-log/sysctx-anatomy/AnatomyDrilldowns.tsx` | Skills / Files / MCP / generic child tables |
| `session-log/sysctx-anatomy/AnatomyCells.tsx` | Shared cells: number formatting, `GitBadge`, `DrillTable`, "Show all" toggle, hint content |
| `session-log/StartupContextLine.tsx` | One-line summary at the top of Logs |
| `SessionDetailPane.tsx` | Lazy import of the tab; passes `onOpenAnatomy={() => onSessionTabChange('sysctx')}` to `SessionLogView` |
| `SessionTabBar.tsx`, `client/src/viewer/tab-ids.ts` | `sysctx` is the **last** tab, after Raw Logs |

## Data sources — no new request

The tab is fully prop-driven and lazy-loaded, like Harness usage. Everything comes from the
`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs` response `SessionDetailPane` already
holds:

- `main` — the raw main transcript lines. Only the **startup block** is read: the lines before the
  first non-sidechain `assistant` line that has `message.usage`. Of those, only typed `attachment`
  lines and `type:user` lines count. Compaction, `/clear` and resume re-injections later in the
  session are ignored.
- `harnessSnapshot` — the hook-reported harness catalog (hook ≥ 2.22.0), used to join file sizes on
  disk, skill/agent sources and **git status** onto the transcript rows. It is never required:
  without it the tab still renders, with sources `—` and git `unknown` / `outside repo`.
- `pricing` + the first assistant model (or `summary.model`) — the bytes-per-token ratio
  (`resolveCharsPerToken`, default 3.5).
- `repoRoot` from the parsed session — display paths only.

The total is exact: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of the
first assistant line's usage. Every partition is a UTF-8 byte count divided by that ratio, so it is
an estimate; the header says so ("≈ bytes / 3.5 — only the total is exact").

No server computation, no DB table and no API change are involved.

## Partitions

One partition per kind, in table order (kinds with 0 bytes stay in the table but are not drawn in
the bar):

| Kind | Label | Measured from | Drill-down |
|---|---|---|---|
| `system-prompt` | System prompt (harness core) | `prompt_snapshot.systemPrompt[]` blocks except the memory block | one row per block, "Block n" (no text) |
| `memory` | Memory index (MEMORY.md) | the `# Memory` system-prompt block, plus any `instructions` file ending `/MEMORY.md` | one masked-path row |
| `environment` | Environment (estimated) | every other startup attachment type (e.g. `date`, `environment`, `command_permissions`), sized by `JSON.stringify` | one row per attachment type |
| `deferred-tools` | Deferred tool names (built-in) | non-MCP lines of `deferred_tools_delta` | none (count shown) |
| `mcp-server` | MCP servers | per server: MCP tool-name lines + `mcp_instructions_delta` instruction blocks | one row per server: status, tools, names B, instr. B, loaded on demand |
| `agent-types` | Subagent types | `agent_listing_delta.addedLines` | one row per type |
| `skills` | Skills listing | the initial `skill_listing` content, split per skill | one row per listed skill, with source, file, size, git |
| `instruction-file` | Instruction files | `instructions.files[].content` (MEMORY.md excluded) | files table + "On demand — 0 at start" subgroup |
| `system-reminder` | System reminders | `session_context.context` values | one row per key (`userEmail`, `gitStatus`) |
| `first-prompt` | First user prompt | every non-sidechain `type:user` line in the startup block | one row per line, by role (command caveat, slash command, injected skill/command body, typed prompt) |
| `harness-internals` | Harness internals | total − attributed (only when ≥ 0) | none; info-icon hint |

Harness internals is mostly the tool JSON schemas, message wrapping and the combined estimate
error. It is hatched in the bar, and its hint text comes from `HARNESS_INTERNALS_HINT`. The words
"Unallocated" and "free" are never used.

**No text in the DOM.** Only names, paths, sizes, statuses, role labels and "Block n" are shown —
never file, section or prompt text. Absolute paths outside the repo become `<outside>/<basename>`;
the memory index is always `~/.claude/projects/<project-slug>/memory/MEMORY.md`.

The attachment payloads the tab reads are described in
[log-schema/attachment-types.md](log-schema/attachment-types.md) (`mcp_instructions_delta`,
`session_context` and the environment-sized types).

## Git status and sources

Per-row GIT comes from the snapshot entry's `gitStatus` (`tracked`, `untracked`, `ignored`,
`outside-repo`). When the snapshot has no `gitStatus` for a row, the client falls back to
`outside repo` for `~/…`, `<plugin>@<ver>/…` and `<outside>/…` paths, and to `unknown` for anything
else. Badges: emerald / amber / slate / sky / slate-outline.

Skill SOURCE: exact snapshot name match → that entry's source; a listing name `p:x` matching an
`org-synced` snapshot entry named `x` → `org-synced`; otherwise `built-in`; no snapshot → `—`.

Both fields come from **hook 2.28.0**:

- `harness-git-status.js` (`annotateGitStatus`) sets `gitStatus` on `skills[]`, `agents[]` and
  `systemContext.files[]` with at most two git processes, before the snapshot id is computed.
- `skill-catalog.js` scans `~/.claude/skills/synced/<org>/<skill>/SKILL.md` and stores
  **org-synced** entries with metadata only (masked path, empty `body`).

Rules and examples: [Harness Snapshot Algorithm](algorithms/harness-snapshot.md). Compatibility
(old hooks, old servers, the accepted Harness-usage caveat): `hook-api-versioning.md` § "Harness
snapshot `gitStatus` and `org-synced` skills (hook `2.28.0`+)". The server stays type-only: it
stores the body verbatim and `extractHarnessSkillInventory` skips `org-synced` entries so Harness
usage is unchanged.

## Edge-state banners

`data-testid="anatomy-banner"` with `data-variant`:

| Variant | When | Tone |
|---|---|---|
| `old-hook` | no `harnessSnapshot` (hook older than 2.22.0) | info |
| `no-git` | a snapshot exists but no entry has `gitStatus` ("Git status needs hook 2.28.0 or newer.") | info |
| `no-prompt-snapshot` | no `prompt_snapshot` in the startup block — the system prompt lands in Harness internals | info |
| `unknown-total` | no assistant line with usage; the header reads "Total unknown — no assistant message with usage", the bar gets a dashed outline, shares are of attributed | info |
| `over-total` | attributed > total ("Attributed estimate exceeds measured total by N tokens"); no Harness internals partition, the bar is scaled to attributed | warning |

An empty transcript shows "No startup context recorded for this session." instead of the tab body.

## Interaction

- One `selectedKind`: clicking a bar segment or a table row selects that kind (segment
  `ring-2 ring-primary`, row `bg-primary/5` + `aria-selected="true"`) and expands it when it has
  children.
- Skills and MCP drill-downs show the first 10 rows (`SKILLS_PREVIEW`, `MCP_PREVIEW`), then a
  "Show all N …" toggle. Rows are sorted by bytes descending.
- A segment narrower than 0.5 % gets `min-width: 6px`; its label shows inside only when the segment
  is ≥ 64 px wide; the tooltip always carries label, ≈ tokens, bytes, share and "estimated".
- Light theme only (`ui-principles.md`).

## `StartupContextLine` (Logs tab)

`data-testid="startup-context-line"`, in the old panel's band style. Text: "Startup context ·
8,800 tokens" (or "total unknown") from `computeStartupTotal(main)`, plus a "View anatomy →" button
that calls `onOpenAnatomy` (hidden when the prop is absent). Nothing renders when `main` is empty.

## Test ids

The scenario steps rely on these exact names:

| Test id | Attributes |
|---|---|
| `sysctx-anatomy-tab` | root of the tab (also on the empty / error message) |
| `sysctx-anatomy-loading` | loading skeleton |
| `anatomy-total` | header total line |
| `anatomy-banner` | `data-variant` = `old-hook` / `no-git` / `no-prompt-snapshot` / `unknown-total` / `over-total` |
| `anatomy-bar` | `data-unknown-total="true"` when the total is unknown |
| `anatomy-segment` | `data-kind` |
| `anatomy-partition-table`, `anatomy-partition-row` | row: `data-kind`, `aria-selected` |
| `anatomy-internals-hint`, `anatomy-internals-hint-text` | the Harness internals info icon and its text |
| `anatomy-skill-row` | `data-skill-name`, `data-source` |
| `anatomy-file-row` | `data-path`, `data-git` |
| `anatomy-mcp-row` | `data-server` |
| `startup-context-line` | the Logs one-liner |

Coverage: the algorithm table test (`sysctx-anatomy.algo.test.ts`), the GS-05 golden fixture's
anatomy block, and `tests/scenarios/view/s-sess-03.spec.ts` (steps 8, 8a, 8d, 9); the hook side
is `tests/scenarios/hook/s-hook-09.spec.ts` step 4c. User doc: `user-docs/session-log.md`
§ "System context anatomy" (screen-registry row `session.sysctx`).
