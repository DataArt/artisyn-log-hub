# Implementation plan — System Context Anatomy tab

## TL;DR

- **New client tab** `sysctx` ("System context anatomy", rightmost, after Raw Logs). It is lazy-loaded and built from the existing `/logs` payload (`main` + `harnessSnapshot`), with no new request. A pure builder, `buildSysctxAnatomy()` in `session-log/sysctx-anatomy/sysctx-anatomy.ts`, gets its own algorithm doc `docs/knowledgebase/algorithms/sysctx-anatomy.md` and a vitest table test.
- **Panel removed.** `SessionContextPanel` and 8 files used only by it are deleted: 5 detail modals, `SourceBadge`, `SystemContextFilesTab` and `context-panel-helpers.ts`. A one-line `StartupContextLine` ("Startup context · T tokens → View anatomy") replaces the panel at the top of Logs.
- **Hook 2.28.0** adds `harness-git-status.js`. It sets an optional `gitStatus` on `skills[]`, `agents[]` and `systemContext.files[]` with at most 2 git processes, and `computeSnapshotId` appends it to a tuple only when set. `skill-catalog.js` gains a new **org-synced** scan of `~/.claude/skills/synced/<org>/<skill>/SKILL.md` (metadata only, empty `body`, source `org-synced`). `schemaVersion` stays 1.
- **Server:** type-only snapshot changes (`gitStatus?`, `'org-synced'`). `extractHarnessSkillInventory` **skips** `org-synced` entries, so the harness-usage report and `harness_elements` stay as today (DD 24). **No DB change.**
- **API:** no new or changed route. The `/logs` response passes the snapshot body through verbatim, so the new optional fields just appear. No contract-registry change.
- **Dead code removed with the panel:** `summary.visibleSkills` / `visibleAgents` / `mcpConfig` and their parser builders (DD 25). The per-turn skill detail gets an `ORG-SYNCED` label (DD 26).
- **Compat caveat:** hook 2.28.0 + a server without DD 24 stores org-synced names as `source: null` harness elements ("never used" rows in Harness usage). This is accepted and documented in `hook-api-versioning.md` (DD 20).
- **Docs:**
  - a new KB article `sysctx-anatomy-tab.md`;
  - `### System context anatomy` in `user-docs/session-log.md`;
  - data-collection docs (`user-docs/data-collection.md`, `hook/HOW_HOOK_WORKS.md`) for `gitStatus` and org-synced names;
  - stale panel references fixed in 6 KB/QAA docs.
- **Tests:**
  - Algorithm: a new `sysctx-anatomy.md` with a vitest table, plus new `harness-snapshot.md` rows (git status, id rule, org-synced).
  - Scenario: `s-sess-03` steps 8/8a/9 rewritten and a new step 8d, a `s-hook-09` step, and the GS-05 golden fixture extended. A `screen-registry.ts` row for the new tab.

## Reference

Requirements: [requirements.md](requirements.md). The owner's answers under its Open Questions are binding:
- org-synced skills are scanned;
- the panel shrinks to one clickable line, and the modals, per-MCP call counts and money costs are dropped.

Research archive: `research/findings-1.md`.

## Design Decisions

1. **Tab id and placement.** The id is `sysctx` and the label is "System context anatomy". It is appended **last** in `SESSION_TABS` and in the `SessionTabBar` array, after `raw-logs`, so it stays rightmost whether or not Raw Logs is visible (this matches the wireframe).
2. **No server computation.** The anatomy is computed client-side from `logsQuery.data.main` (the raw main transcript) and `logsQuery.data.harnessSnapshot`, because both are already loaded. This follows the `harness-usage` lazy-tab pattern (`SessionDetailPane.tsx:399-409`).
3. **Startup block.** The startup block is the lines of `main` before the first line with `type === 'assistant'`, `!isSidechain` and `message.usage`. Only typed `attachment` lines and `type:user` lines in it are read. All other line types (`mode`, `system`, `file-history-snapshot`, `last-prompt`, …) are ignored, and everything after the block is ignored, including compaction, `/clear` and resume re-injections. If no such assistant line exists, the startup block is the whole transcript up to the first assistant line of any kind (or all lines), and the total is unknown.
4. **Total.** The total is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of that first line's `message.usage`, with a missing field counted as 0. Lines sharing its `message.id` are not added again.
5. **Bytes and tokens.** Every measured size is the UTF-8 byte length (`TextEncoder`) of the named string. A partition's tokens are `Math.round(partitionBytes / cpt)`, where `cpt = resolveCharsPerToken(pricing, firstAssistantModel ?? summary.model)` (`log-parser.ts:66`, default 3.5). Row tokens are rounded per row and may not add up exactly to their partition.
   - **Attributed** = Σ partition tokens.
   - **Harness internals** = total − attributed, only when that is ≥ 0.
   - **Share** = tokens / denominator. The denominator is the total when it is known and ≥ attributed, otherwise attributed.
6. **Partition table.** There is one partition per kind (FR-3 vocabulary). Kinds with 0 bytes are listed in the table and not drawn in the bar.

   | kind | label | source | measured from (startup block) | children |
   |---|---|---|---|---|
   | `system-prompt` | System prompt (harness core) | `harness` | `prompt_snapshot.systemPrompt[]` blocks except the memory block | one row per block: "Block n", bytes (no heading text, FR-10) |
   | `memory` | Memory index (MEMORY.md) | `user` | the `systemPrompt[]` block whose first non-empty line is `# Memory`; plus any `instructions.files[]` whose path ends `/MEMORY.md` | one row; display `~/.claude/projects/<project-slug>/memory/MEMORY.md`, git `outside repo` |
   | `environment` | Environment (estimated) | `harness` | every other attachment type in the block that is not listed in this table and not in `{deferred_tools_record, nested_memory}`. Sized by `JSON.stringify(attachment)`, marked estimated | one row per attachment type |
   | `deferred-tools` | Deferred tool names (built-in) | `built-in` | `deferred_tools_delta.addedLines[i]` + 1 (newline) where `addedNames[i]` is not `mcp__…` | none (count shown) |
   | `mcp-server` | MCP servers | `mcp-server` | per server: names bytes (MCP lines, as above) + instructions bytes (`mcp_instructions_delta.addedBlocks[i]`) | one row per server (DD 8) |
   | `agent-types` | Subagent types | `harness` | `agent_listing_delta.addedLines[i]` + 1 (newline) | one row per type; file from snapshot `agents[]` by name |
   | `skills` | Skills listing | per row | `skill_listing` (`isInitial`) `content`, split per DD 9 | one row per skill (DD 9) |
   | `instruction-file` | Instruction files | per row | `instructions.files[].content` bytes (MEMORY.md excluded) | files drill-down (DD 10) |
   | `system-reminder` | System reminders | `system-reminder` | `session_context.context` values (string bytes per key) | one row per key name (`userEmail`, `gitStatus`) |
   | `first-prompt` | First user prompt | `user` | DD 11 | one row per user line, by role |
   | `harness-internals` | Harness internals | `harness` | total − attributed (DD 5) | none; hint per DD 13 |

7. **Kind vocabulary leftovers.** `mcp-instructions` is not a bar partition. It is the row kind of each server's instructions sub-row inside `mcp-server`, shown as the INSTR. B column.
8. **MCP join key.** `mcpKey(name) = name.replace(/[^A-Za-z0-9_-]/g, '_')`. It is applied to:
   - the `mcp__<slug>__` segment of deferred names (already a slug);
   - `mcp_instructions_delta.addedNames`, e.g. "claude.ai Claude Docs" → `claude_ai_Claude_Docs`;
   - `failedMcpServers[].name`;
   - snapshot `mcpServers[].name`.

   Row columns:
   - SERVER (display name = the instructions name if any, else the snapshot name, else the slug);
   - STATUS (`failed (<errorCode>)` if it is in `failedMcpServers`, else `connected`);
   - TOOLS (count of deferred names);
   - NAMES B, INSTR. B, BYTES, ≈ TOKENS, SHARE;
   - LOADED ON DEMAND: count of names from every `deferred_tools_record` in the **whole** transcript whose names map to that server. It is shown as an expandable name list and is not part of the size.
   - Rows are sorted by BYTES descending; the first `MCP_PREVIEW` (10) are shown, then a "Show all N servers" toggle.
9. **Skills split and source.**
   - Per-skill bytes: for each `names[i]`, find `"- " + name + ": "` in `content`. A skill's slice runs to the next found start, or to the end of the content. Names that are not found get 0.
   - Source resolution against snapshot `skills[]`, in order:
     1. exact `name` match → that entry's `source`;
     2. otherwise, for a listing name `p:x`, a snapshot entry with `source === 'org-synced'` and `name === x` → `org-synced`;
     3. otherwise → `built-in`.

     With no snapshot the source is `—`.
   - FILE / FILE SIZE / GIT come from the matched entry (`path`, `bytes`, `gitStatus` → else `unknown`).
   - Snapshot skills that are not in the listing are not shown, because they cost nothing at start.
   - `HIDDEN_SKILL_PREFIX` is **not** applied.
   - Rows are sorted by bytes descending. The first 10 are shown, then a "Show all N skills" toggle.
10. **Files drill-down.**
   - Rows are the union, keyed by normalised display path (`\`→`/`, lowercased):
     - startup `instructions.files[]`, with display path from `toUserDisplayPath` for type `User` and otherwise `normaliseClientPath(path, repoRoot)`;
     - snapshot `systemContext.files[]`.
   - A display path that is still absolute (`/…` or `X:`) becomes `<outside>/<basename>`.
   - SOURCE per file: `instructions` type `User` → `user`; `Project` / `Local`, or a snapshot-only file → `project`; a `<outside>/…` path → `user`.
   - LOADED B is the transcript bytes. FILE SIZE is the snapshot `bytes`, or `—` if there is no snapshot entry.
   - GIT is the snapshot `gitStatus` when present. Otherwise:
     - `outside repo` for `~/…`, `<plugin>@<ver>/…` (matches `/^[^/]+@[^/]+\//`) and `<outside>/…`;
     - `unknown` for anything else.
   - Snapshot-only files are listed in an "On demand — 0 at start" subgroup with LOADED 0. This covers rules (`.claude/rules/*`) and any file not in the startup `instructions`.
11. **First user prompt rule.** FR-6's literal "first `type:user` line" would select Claude Code's `<local-command-caveat>` meta line, so the partition instead sums **every non-sidechain `type:user` line in the startup block**.
   - Size per line:
     - a string `content` → its bytes;
     - an array `content` → Σ bytes of `type:'text'` parts whose text does not start with `<system-reminder>`.

     `tool_result` parts are excluded.
   - One row per line, labelled by role, never by text:
     - `isMeta` + starts `<local-command-caveat>` → "command caveat";
     - contains `<command-name>` → "slash command";
     - `isMeta` array → "injected skill/command body";
     - otherwise "typed prompt".
   - This attributes the injected skill bodies (8–20 KB in real sessions) instead of letting them inflate Harness internals.
12. **Edge banners** (wireframe `anatomy-edge-states.svg`):
   - (A) No `harnessSnapshot`: an info banner "No harness snapshot for this session — git status and size on disk are unavailable (hook older than 2.22.0)."
   - A snapshot exists but no entry has `gitStatus`: an info banner "Git status needs hook 2.28.0 or newer."
   - No `prompt_snapshot` in the startup block: an info banner "This Claude Code version did not log its system prompt — it is counted in Harness internals."
   - (B) Unknown total: a dashed bar outline, and the header reads "Total unknown — no assistant message with usage". Shares are of attributed.
   - (C) attributed > total: a warning banner "Attributed estimate exceeds measured total by N tokens". The bar is scaled to attributed and has no Harness internals partition or row.
   - The wireframe C row "Harness internals — discrepancy" and the wireframe header text "minus first user prompt" are **not** implemented (FR-6 wins).
13. **Harness internals hint.** A function `HARNESS_INTERNALS_HINT(n, p, m, a)` in `sysctx-anatomy-constants.ts`: `n` = internals tokens, `p` = its share in % (1 decimal), `m` = measured total, `a` = attributed sum; numbers use thousands separators. It returns:
    - title: `Harness internals — ≈ {n} tokens ({p} % of the startup context)`;
    - body: `Tokens that Claude Code sent in the first request but did not write to the session log, so they cannot be split further. Measured total {m} minus everything attributed above ({a}). Mostly:`;
    - bullet **Tool definitions** — `the JSON schemas and descriptions of the built-in tools (Bash, Read, Edit, Grep, Agent, …) and of MCP tools loaded at start. Usually the largest part.`;
    - bullet **Message wrapping** — `system-reminder tags, message framing and separators.`;
    - bullet **Estimate error** — `every other partition is a byte-based estimate, while the total is exact; their combined error lands here (it can be positive or negative).`;
    - closing line: `Deferred MCP tools are not here: only their names are loaded at start, shown under each MCP server.`

    It is shown by the info icon in its table row and by its bar segment tooltip. The segment is hatched with a `repeating-linear-gradient(45deg, …)` of slate-300/slate-100. The words "Unallocated" and "free" appear nowhere.
14. **Bar.**
   - A flex row, where each segment's width is `share %`. A segment with share in (0, 0.5 %) gets a `min-width: 6px` (FR-2 minimum-width option; no grouping).
   - Colours come from a fixed `KIND_COLORS` map (Tailwind 400/500 hexes, distinct per kind) in the constants file.
   - The label is shown inside a segment ≥ 64 px wide. The tooltip (`ui/tooltip`) shows the label, ≈ tokens, bytes, share and "estimated" where it applies.
   - Light theme only (`ui-principles.md` § Color scheme overrides the NFR's dark theme). Non-colour cues are the in-segment labels, the tooltip and the hatched internals segment.
15. **Selection.** One `selectedKind` state in the tab. Clicking a segment or a table row sets it. The selected segment gets `ring-2 ring-primary`, and the row gets `bg-primary/5` and `aria-selected="true"`. Selecting a row with children also expands it.
16. **One-line summary in Logs.** `StartupContextLine` replaces `<SessionContextPanel>` in `SessionLogView.tsx:200`. It uses the existing panel band style (`border-b bg-violet-500/5 px-4 py-2`, `FileText` icon), with the text "Startup context · 8,800 tokens" (or "total unknown") and a link-button "View anatomy →" that calls the new optional prop `onOpenAnatomy`. `SessionDetailPane` passes `() => onSessionTabChange('sysctx')`. The total comes from the exported `computeStartupTotal(main)`. Nothing renders when `main` is empty.
17. **Hook git status** (`harness-git-status.js`, `annotateGitStatus({ projectRoot, skills, agents, systemContext })`, mutates the entries in place):
   - Only entries of source `project`, and agents/context files whose path does not start with `../`, are "in-root" candidates. All other entries are `outside-repo`: user, plugin, org-synced, and `../…` context files.
   - Process 1: `git ls-files -z -- <":(literal)"+path …>`, with cwd = `projectRoot`, through `git()` from `git-context.js`. If there are no in-root candidates, it runs `git rev-parse --git-dir` instead, as the repo probe.
     - A `null` result (git failed, or not a repo) → return without setting **any** `gitStatus`.
     - An output path equal to a candidate → `tracked`.
     - If the joined pathspec argument length exceeds `MAX_PATHSPEC_CHARS = 24000` (a module constant) → unset all (fail-open).
   - Process 2: only when there are non-tracked candidates, `gitWithInput(['check-ignore','--stdin','-z'], root, paths.join('\0')+'\0')`.
     - Status 0 or 1 → each returned path is `ignored`, and the rest are `untracked`.
     - Any other status → leave those paths unset.
   - Each call uses the default `GIT_DEFAULT_TIMEOUT_MS` (2000 ms) of `git-context.js`. It runs inside `buildHarnessSnapshot` **before** `computeSnapshotId`, and on every hook run (the id depends on it).
18. **Snapshot id.** In `computeSnapshotId`, each tuple appends `gitStatus` only when it is a non-empty string:
    - skills `[name, source, plugin, contentHash, gitStatus?]`;
    - agents `[name, path, contentHash, gitStatus?]`;
    - context `[path, contentHash, gitStatus?]`.

    `mcp` is unchanged and `v` stays 1. A snapshot without the field keeps its id byte-for-byte. The first run of hook 2.28.0 changes the id once, which is one resend per user.
19. **Org-synced scan** (`skill-catalog.js`):
    - After the plugin section, for every subdir `<org>` of `<claudeConfigDir>/skills/synced/`, scan `scanSkillsDir(<org dir>)`.
    - Each `read` becomes `makeEntry('skill', {...read, body: ''}, 'org-synced', '~/.claude/skills/synced/<org>/' + <skillDir> + '/SKILL.md')`, with the literal `<org>` mask and the bare `name` from the frontmatter or folder.
    - It is skipped on a project/user name collision (same `projectKeys` + user key set).
    - The existing user scan already ignores `skills/synced` (it has no `SKILL.md`), so it is unchanged.
20. **Hook version.** `version.json` → `2.28.0`. `hook-api-versioning.md` gets a `>= 2.28.0` row and section:
    - optional `gitStatus` and the `org-synced` source; any server version accepts them, because the body is stored verbatim;
    - an accepted caveat: a server older than this change keeps org-synced entries in the harness-usage inventory as `source: null`, so they show as never-used rows until the server is upgraded.
21. **GS-05 fixture additions.** All filler text is ASCII. Keep the `parentUuid`/`uuid` chain consistent when inserting or moving lines. The block order before the first assistant (`msg_gs05_001`) becomes:
    1. `mode`;
    2. `prompt_snapshot` with `systemPrompt`:
       - block 1: 2800 B, starts `You are`;
       - block 2: 700 B, starts `# Memory\n`;
    3. `date` `{"type":"date","date":"2026-01-08"}` (JSON 35 B);
    4. `skill_listing` (unchanged, 83 B = 44 + 39);
    5. `deferred_tools_delta`, **moved** from line index 8. It is still announced before the first MCP `tool_use` at line 17. Sizes: postgres 21 + 27 = 48 B, playwright 31 B;
    6. `mcp_instructions_delta` `{addedNames:["postgres"], addedBlocks:[<350 B>], removedNames:[]}`;
    7. `instructions` (unchanged, 1050 + 3500 + 700 = 5250 B);
    8. `session_context` `{context:{userEmail:"dev@arrakis.test" (16 B), gitStatus:<334 B>}}` = 350 B;
    9. the two existing user lines (130 + 122 = 252 B).

    In `artisyn.jsonl`, the harness-snapshot entries get these `gitStatus` values:
    - `CLAUDE.md` `tracked`, `.claude/rules/db.md` `tracked`, `.claude/rules/ui.md` `untracked`;
    - a new `CLAUDE.local.md` context entry (700 B, any 64-hex `contentHash`) `ignored`, with `totalBytes` updated to 6300;
    - plugin skills `outside-repo`, `unused-skill` `untracked`;
    - a new skill entry `{name:"gold-sync", kind:"skill", source:"org-synced", path:"~/.claude/skills/synced/<org>/gold-sync/SKILL.md", body:"", bytes:300, gitStatus:"outside-repo"}` (not in the listing). It checks that the server skip (DD 24) leaves the `inventory`/`harnessUsage` literals unchanged;
    - the fixture's literal `snapshotId` is left as is on purpose (the server never recomputes it).
22. **GS-05 expected anatomy** (cpt 3.5, the same ratio as the existing `context.claudeMd` 3500 B → 1000 tokens):

    | kind | bytes | tokens |
    |---|---|---|
    | system-prompt | 2800 | 800 |
    | memory | 700 | 200 |
    | environment | 35 | 10 |
    | mcp-server | 429 | 123 |
    | skills | 83 | 24 |
    | instruction-file | 5250 | 1500 |
    | system-reminder | 350 | 100 |
    | first-prompt | 252 | 72 |
    | **Attributed** | | **2829** |
    | **Total** | | **8800** |
    | **Harness internals** | | **5971** (67.9 %) |

    `deferred-tools` and `agent-types` are 0.
23. **Test ids.** Their exact names, which the scenario steps rely on:
    - `sysctx-anatomy-tab`, `anatomy-total`, `anatomy-banner` (`data-variant` = `old-hook|no-git|no-prompt-snapshot|unknown-total|over-total`);
    - `anatomy-segment` (`data-kind`), `anatomy-partition-row` (`data-kind`, `aria-selected`), `anatomy-internals-hint`;
    - `anatomy-skill-row` (`data-skill-name`, `data-source`), `anatomy-file-row` (`data-path`, `data-git`), `anatomy-mcp-row` (`data-server`);
    - `startup-context-line`.
24. **Org-synced in harness usage.** The snapshot stores the bare org-synced name while usage is counted under the listing's `<prefix>:<name>`, so `extractHarnessSkillInventory` skips entries with `source === 'org-synced'`. The harness-usage report and `harness_elements` stay exactly as today (no false "never used" rows), and the `harness-usage.service.ts` source unions and guard stay unchanged.
25. **Parser dead code.** After the panel is deleted, `summary.visibleSkills`, `summary.visibleAgents` and `summary.mcpConfig` have no reader. Remove those summary fields (`types.ts`) and their builder blocks in `log-parser.ts` (~l.2317–2380, ~l.2588–2620), plus any local (`registeredSkills`, `registeredAgents`, `agentDefinitions`) whose only consumer they were (grep-verify each). Keep:
    - `skillDefinitionsMap` and `HIDDEN_SKILL_PREFIX` (per-turn `definition`, read by `PromptTurnSkillsSection`);
    - `deferredTools` (`charts/context-usage/context-data.ts`);
    - `mcpCalls` (Info/Summary tabs); `SessionLogView` just stops passing it;
    - `claudeMd`.
26. **Per-turn skill label.** `buildSkillDefinitionRows` (`prompt-turn-helpers.tsx:324-329`) maps `'org-synced'` → `'ORG-SYNCED'` explicitly instead of falling back to `'USER'`.
27. **Vocabulary shorthands used in chunks.**
    - "kind vocabulary": the `kind` column of DD 6 plus `mcp-instructions` (DD 7);
    - "source vocabulary": `harness`, `project`, `user`, `plugin`, `org-synced`, `built-in`, `mcp-server`, `system-reminder`;
    - "no text": no file, section or prompt text in the DOM — only names, paths, sizes, statuses, role labels and "Block n".
28. **User doc.** Session tabs are documented in `user-docs/session-log.md`, one `### <Tab>` per tab. The new section is `### System context anatomy`, and the `session.sysctx` screen-registry row's `docRef` is `{ file: SESSION_DOC, heading: 'System context anatomy' }`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `hook/.claude/telemetry_tool/harness-git-status.js` | new: `annotateGitStatus` | DD 17 |
| `hook/.claude/telemetry_tool/harness-snapshot.js` | call `annotateGitStatus` before the id; tuple rule; JSDoc `gitStatus?`; header comment (now spawns ≤ 2 git) | DD 17–18 |
| `hook/.claude/telemetry_tool/skill-catalog.js` | org-synced scan; `source` JSDoc union | DD 19 |
| `hook/.claude/telemetry_tool/version.json` | `2.28.0` | DD 20 |
| `hook/.claude/telemetry_tool/__tests__/harness-snapshot.algo.test.js` | new row kind `git` (git-init temp repo) | per `okf-snapshot.algo.test.js:29-66` |
| `docs/knowledgebase/algorithms/harness-snapshot.md` | rules for gitStatus, id tuple, org-synced; rows; Mutations | |
| `docs/knowledgebase/hook-api-versioning.md` | `>= 2.28.0` matrix row + section | |
| `server/src/logs/harness-snapshot.ts` | `HarnessSnapshotSkillSource` + `'org-synced'`; `HarnessGitStatus` type; `gitStatus?` on skill/agent/context entries | types only |
| `server/src/logs/artisyn-extractor.ts` | `extractHarnessSkillInventory` skips `org-synced` entries | l.426-461, DD 24 |
| `client/src/viewer/api.ts` | `HarnessSnapshot*` types: `gitStatus?`, `'org-synced'` (l.1380-1455) | |
| `client/src/viewer/pages/repository/session-log/types.ts` | `source` unions l.334, l.348 + `'org-synced'`; drop `visibleSkills`/`visibleAgents`/`mcpConfig` summary fields | DD 25 |
| `client/src/viewer/pages/repository/session-log/log-parser.ts` | remove the dead builders (`normaliseClientPath` is already exported, l.100) | DD 25 |
| `client/src/viewer/pages/repository/session-log/prompt-turn-helpers.tsx` | `'ORG-SYNCED'` source label | DD 26 |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/sysctx-anatomy.ts` | pure builder `buildSysctxAnatomy`, `computeStartupTotal`, `mcpKey`, `splitSkillListing` | DD 3–11 |
| `.../sysctx-anatomy/sysctx-anatomy-constants.ts` | `KIND_LABELS`, `KIND_COLORS`, `GIT_LABELS`, `HARNESS_INTERNALS_HINT`, `MIN_SEGMENT_PX=6`, `MIN_SHARE_FOR_NATURAL=0.005`, `LABEL_MIN_PX=64`, `SKILLS_PREVIEW=10`, `MCP_PREVIEW=10` | |
| `.../sysctx-anatomy/sysctx-anatomy.algo.test.ts` | vitest table over the new algo doc | |
| `.../sysctx-anatomy/SessionSysctxAnatomyTab.tsx` | tab: header, banners, bar, table, selection state | lazy |
| `.../sysctx-anatomy/AnatomyPartitionBar.tsx` | bar + tooltips | DD 14 |
| `.../sysctx-anatomy/AnatomyPartitionTable.tsx` | partition table + expand | DD 6, 15 |
| `.../sysctx-anatomy/AnatomyDrilldowns.tsx` | Skills / Files / MCP / generic child tables | DD 8–11 |
| `.../session-log/StartupContextLine.tsx` | one-line Logs summary | DD 16 |
| `.../session-log/SessionLogView.tsx` | swap panel → `StartupContextLine`; prop `onOpenAnatomy?` | |
| `.../session-log/SessionContextPanel.tsx`, `McpServerModal.tsx`, `SkillDetailModal.tsx`, `AgentDetailModal.tsx`, `FileDetailModal.tsx`, `RuleDetailModal.tsx`, `SourceBadge.tsx`, `SystemContextFilesTab.tsx`, `context-panel-helpers.ts` | delete | only used by the panel |
| `client/src/viewer/tab-ids.ts` | `'sysctx'` last in `SESSION_TABS` | DD 1 |
| `client/src/viewer/pages/repository/SessionTabBar.tsx` | entry `{ id: 'sysctx', label: 'System context anatomy' }` last | |
| `client/src/viewer/pages/repository/SessionDetailPane.tsx` | lazy import + switch branch; pass `onOpenAnatomy` to `SessionLogView` | |
| `docs/knowledgebase/algorithms/sysctx-anatomy.md` | new algo doc | |
| `docs/knowledgebase/algorithms/README.md`, `docs/knowledgebase/index.md` | rows for the new doc / KB article | |
| `docs/knowledgebase/sysctx-anatomy-tab.md` | new KB article: data sources, DDs 1–16, test ids | |
| `docs/knowledgebase/session-log-view.md` | panel → one line; link to the new article | |
| `docs/knowledgebase/client-component-map.md` | remove panel/modal entries (l.306-314, 377); add new files; tab order in l.167 | |
| `docs/knowledgebase/log-schema/attachment-types.md` | hand-maintained sections for `mcp_instructions_delta`, `session_context` | names/sizes only |
| `user-docs/session-log.md` | `### System context anatomy` section (offline user doc) | DD 28 |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` | l.432 (SessionContextPanel instruction) and the S-SESS-03 steps 8/8a/9 description → anatomy tab | |
| `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` | S-HOOK-09: the new git-status / org-synced step | |
| `user-docs/data-collection.md` (§ Environment snapshot, l.98-111), `hook/HOW_HOOK_WORKS.md` (§ Harness snapshot, l.192+) | `gitStatus` per file and org-synced skill names (metadata only) | `data-collection-notice.md` unchanged: no new category of data |
| `docs/knowledgebase/token-byte-ratio.md` (l.26, 69, 82), `raw-logs-renderers.md` (l.113), `legacy-design-decisions-map.md` (T-10, l.41), `client-routing-and-layout.md` (session tab list ~l.168) | stale `SessionContextPanel` / System Context references → anatomy tab | |
| `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl`, `artisyn.jsonl`, `expected.json`, `README.md` | DD 21–22 | |
| `tests/golden/check-arithmetic.mjs` | re-derive the anatomy block | |
| `tests/scenarios/view/s-sess-03.spec.ts` | rewrite steps 8, 8a, 9; new 8d | |
| `tests/scenarios/hook/s-hook-09.spec.ts` | new step: gitStatus + org-synced in the stored snapshot | |
| `tests/scenarios/tours/screen-registry.ts` | `session.sysctx` row | |
| `.artisyn/marketplace/plugins/log-hub-hooks/` | dogfooded install refresh | per `.claude/rules/hook.md` |

## API changes

None. `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs` already returns `harnessSnapshot` (the stored body, verbatim). After this change, new hooks' bodies carry:
- optional `gitStatus: 'tracked'|'untracked'|'ignored'|'outside-repo'` on `skills[]`, `agents[]` and `systemContext.files[]`;
- `skills[].source` may be `'org-synced'`.

Both changes are additive, and old clients ignore them. The harness-usage report is unchanged, because org-synced entries are skipped by the inventory extractor (DD 24).

## Database changes

None. Org-synced entries never reach `harness_elements` (DD 24).

## Test coverage plan

Per the CLAUDE.md test policy (only algorithm, contract and scenario tests):

- **Algorithm, new doc.** `docs/knowledgebase/algorithms/sysctx-anatomy.md` (a new readable algorithm) with `sysctx-anatomy.algo.test.ts` (vitest, picked up by client `bun run test`).
  - Rows cover:
    - the total rule, including a duplicate `message.id` and a sidechain line before the main line;
    - first-block cut-off (a second `prompt_snapshot`/`instructions` after a compact boundary is ignored);
    - first-prompt roles;
    - the skill listing split and source resolution, including org-synced and built-in;
    - MCP join (display name → slug), failed server, on-demand names;
    - memory block detection;
    - the environment estimate;
    - attributed > total (no internals, warning amount);
    - unknown total;
    - git fallback (`~/` → outside repo, project path without a snapshot → unknown);
    - absolute path → `<outside>/basename`.
  - The GS-05 numbers (DD 22) are one row.
- **Algorithm, extended doc.** `docs/knowledgebase/algorithms/harness-snapshot.md` gets rows run by `harness-snapshot.algo.test.js` (hook `npm test`):
  - statuses `tracked`/`untracked`/`ignored`/`outside-repo` in a git-init temp repo;
  - non-repo dir → no `gitStatus`;
  - id with status A ≠ id with status B;
  - snapshot without `gitStatus` → the same id as the pre-change canon (an existing row's literal id unchanged);
  - org-synced entry shape (masked path, empty body, collision skip).
- **Contract.** No route is added or changed, so there is no registry row.
- **Scenario.**
  - `tests/scenarios/view/s-sess-03.spec.ts` (modes A and C):
    - step 8: anatomy tab of GS-05, with the totals, partitions and skills drill-down;
    - step 8a: files drill-down with git and no text/absolute path, Logs shows the one line, and the line's link opens the tab;
    - step 8d (new): an inline-uploaded small session where attributed > total;
    - step 9: GS-01 (no snapshot) shows the old-hook banner, git `unknown` and no page error.
  - `tests/scenarios/hook/s-hook-09.spec.ts`, a new step: the real built hook stores `gitStatus` (`CLAUDE.md` tracked via `git add`, `CLAUDE.local.md` ignored via `.gitignore`, skill `hello` untracked) and an org-synced skill from the fake home, with no `body` text.
  - `tests/scenarios/tours/screen-registry.ts`: a `session.sysctx` row, which the `tour-10-registry` meta-test requires.
  - GS-05 `check-arithmetic.mjs` re-derives the anatomy literals.
  - The server-side org-synced skip (DD 24) is covered in two places:
    - the GS-05 `gold-sync` entry (DD 21) leaves the existing `inventory`/`harnessUsage` literals unchanged;
    - the `s-hook-09` step 4c asserts no `harness_elements` row for `greet`.

## Visual/UX notes

- Header row: "System context anatomy" title, then `Total 8,800 tokens · exact (input + cache write + cache read)`, and a muted info line `≈ bytes / <cpt> — only the total is exact`.
- Banners (DD 12) sit between the header and the bar. They use the existing info (sky-50/sky-700) and warning (amber-50/amber-800) panel styles.
- Bar: height 28 px, rounded, 1 px white gaps between segments. Internals are hatched. An unknown total gets a dashed slate-300 outline.
- Table columns: PARTITION · KIND · SOURCE · BYTES · ≈ TOKENS · SHARE. Numbers are right-aligned and tabular-nums. An expand chevron appears on kinds with children.
- Drill-down tables are indented by 24 px and use the columns of the wireframes:
  - skills: SKILL / SOURCE / FILE / FILE SIZE / GIT / LISTING B / ≈ TOKENS / SHARE;
  - files: PATH / KIND / GIT / FILE SIZE / LOADED B / ≈ TOKENS / SHARE, with an "On demand — 0 at start" subgroup;
  - MCP: SERVER / STATUS / TOOLS / NAMES B / INSTR. B / LOADED ON DEMAND / BYTES / ≈ TOKENS / SHARE.
- Git labels are `tracked`, `untracked`, `ignored`, `outside repo` and `unknown`, shown as small badges: emerald, amber, slate, sky, and slate-outline.
- Light theme only. An empty session (no lines) shows "No startup context recorded for this session."

## Wireframes

No wireframe edits. The deviations from the current wireframes are fixed in DD 12:
- no "minus first user prompt" in the header;
- the kind is `first-prompt`, not `user-prompt`;
- no discrepancy row in state C;
- divisor = per-model `cpt`, not 3.7;
- state D modals → one line (DD 16).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Hook: git status + id | 6 | standalone; ships first. Exception: algorithm-doc rows and table tests sit next to their code (chunks 1, 2, 4), because the doc is the spec of that code |
| 2 | Hook: org-synced + release | 6 | after 1 (same snapshot module, version bump last) |
| 3 | Server + shared types | 5 | additive types, after hook shape is fixed |
| 4 | Client: anatomy builder + algo doc | 6 | pure logic, before UI |
| 5 | Client: anatomy tab UI | 7 | needs 4 |
| 6 | Client: wiring + panel removal | 7 | needs 5 |
| 7 | Docs | 7 | after behaviour is final; kept before Tests so tests stay last |
| 8 | Tests: golden + scenarios | 8 | last |

### Chunk 1 — Hook: git status + id
- [ ] Create `hook/.claude/telemetry_tool/harness-git-status.js` exporting `annotateGitStatus({ projectRoot, skills, agents, systemContext })` per Design Decision 17, using `git`/`gitWithInput` from `git-context.js`; fail-open, never throws.
- [ ] In `harness-snapshot.js` `buildHarnessSnapshot`, call `annotateGitStatus` with the built sections before `computeSnapshotId`; update the file header comment (it now spawns at most 2 git processes).
- [ ] In `computeSnapshotId`, append `gitStatus` to skill, agent and context tuples only when it is a non-empty string, per Design Decision 18; leave `mcp` and `v` unchanged.
- [ ] Add `@property {'tracked'|'untracked'|'ignored'|'outside-repo'} [gitStatus]` to the skill, agent and context-file typedefs in `harness-snapshot.js`.
- [ ] In `__tests__/harness-snapshot.algo.test.js`, add a row kind `git` that creates a temp repo (`git init`, `GIT_CEILING_DIRECTORIES`, optional `gitAdd` and `.gitignore` lists) as in `okf-snapshot.algo.test.js:29-66`, runs `buildHarnessSnapshot` and returns entry statuses plus `snapshotId`.
- [ ] In `docs/knowledgebase/algorithms/harness-snapshot.md`, add rules and `git`-kind rows for the four statuses, the non-repo case, a status change giving a different id and no-`gitStatus` keeping the old id, plus a Mutations entry, per the Test coverage plan.

### Chunk 2 — Hook: org-synced + release
- [ ] In `skill-catalog.js` `buildSkillCatalog`, add the org-synced scan per Design Decision 19 (empty `body`, masked `<org>` path, collision skip); widen the `makeEntry` `source` JSDoc to include `'org-synced'`.
- [ ] In `harness-snapshot.md`, add `gitStatus` to the shape text, the `org-synced` path shape (`~/.claude/skills/synced/<org>/<skill>/SKILL.md`) to rule 6, and a `catalog` row for an org-synced skill (masked path, `source: org-synced`, empty body, a project collision skipped).
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.28.0`.
- [ ] Add the `>= 2.28.0` matrix row and section to `docs/knowledgebase/hook-api-versioning.md` per Design Decision 20.
- [ ] Run `npm run build:hooks-installer` and refresh `.artisyn/marketplace/plugins/log-hub-hooks/` per `.claude/rules/hook.md`; then run the `update-install-instructions` skill.
- [ ] Run hook `npm test` from `hook/` and confirm the new `harness-snapshot` rows pass.

### Chunk 3 — Server + shared types
- [ ] In `server/src/logs/harness-snapshot.ts`, add `'org-synced'` to `HarnessSnapshotSkillSource`, export `type HarnessGitStatus = 'tracked'|'untracked'|'ignored'|'outside-repo'`, and add `gitStatus?: HarnessGitStatus` to the skill, agent and context-file interfaces.
- [ ] In `server/src/logs/artisyn-extractor.ts` `extractHarnessSkillInventory` (l.426-461), `continue` on entries with `source === 'org-synced'`, per Design Decision 24; update its JSDoc.
- [ ] In `client/src/viewer/api.ts` (l.1380-1455), mirror the server: `'org-synced'` in the skill source union, and `gitStatus?` on skill, agent and context-file types.
- [ ] Widen `source` in `session-log/types.ts` (l.334, l.348) with `'org-synced'`; in `prompt-turn-helpers.tsx` `buildSkillDefinitionRows`, add the `'ORG-SYNCED'` label per Design Decision 26.
- [ ] Run server `npm run typecheck` and client `bun run typecheck`.

### Chunk 4 — Client: anatomy builder + algo doc
- [ ] Create `session-log/sysctx-anatomy/sysctx-anatomy-constants.ts` with the constants listed in Files to create/modify, `HARNESS_INTERNALS_HINT` per Design Decision 13, and the kind/source/git vocabularies per Design Decision 27.
- [ ] Create `sysctx-anatomy.ts` with the types `AnatomyPartition`, `AnatomyRow` and `SysctxAnatomy` (total, attributed, internals, overBy, cpt, flags for banners) and helpers `computeStartupTotal`, `mcpKey` and `splitSkillListing` per Design Decisions 3, 4, 8 and 9.
- [ ] Implement `buildSysctxAnatomy({ main, snapshot, repoRoot, charsPerToken })` per Design Decisions 3–12 (the partition table in Design Decision 6), returning partitions in table order plus drill-down rows; import `normaliseClientPath` and `resolveCharsPerToken` from `log-parser.ts` and `toUserDisplayPath` from `instruction-files.ts`.
- [ ] Write `docs/knowledgebase/algorithms/sysctx-anatomy.md` (Purpose, Code, Input and output, Rules = Design Decisions 3–11 restated, Edge cases, an examples block with the rows listed in the Test coverage plan including GS-05 per Design Decision 22, Mutations, Where visible).
- [ ] Create `sysctx-anatomy.algo.test.ts` loading that doc's examples via `scripts/algo-docs/load-examples.cjs`, following `workflow-agent-rows.algo.test.ts`.
- [ ] Add the doc row to `docs/knowledgebase/algorithms/README.md` and an index line to `docs/knowledgebase/index.md`; run client `bun run test` and `bun run typecheck`.

### Chunk 5 — Client: anatomy tab UI
- [ ] Create `AnatomyPartitionBar.tsx`: segments, widths, minimum width, colours, labels, tooltips, hatched internals, dashed unknown outline and selection ring per Design Decisions 13–15; test ids per Design Decision 23.
- [ ] Create `AnatomyPartitionTable.tsx`: the columns from Visual/UX notes, an expand chevron for kinds with children, row selection per Design Decision 15, and an info icon on the Harness internals row showing `HARNESS_INTERNALS_HINT` (`anatomy-internals-hint`).
- [ ] Create `AnatomyDrilldowns.tsx` with `SkillsDrilldown` (Design Decision 9, "Show all N skills"), `FilesDrilldown` (Design Decision 10, on-demand subgroup), `McpDrilldown` (Design Decision 8, "loaded on demand" name list, "Show all N servers") and `GenericRows` for the other kinds.
- [ ] Add git badges per the Visual/UX notes colours, with `data-git` holding the raw value (`tracked|untracked|ignored|outside-repo|unknown`).
- [ ] Create `SessionSysctxAnatomyTab.tsx` (props `mainLogs`, `harnessSnapshot`, `repoRoot`, `pricing`, `sessionModel`, `isLoading`, `error`): resolve `cpt`, `useMemo` the builder, render the header, the banners from Design Decision 12, the bar and the table, and own `selectedKind`.
- [ ] Render the empty-session text and loading/error states (`getSessionLogsErrorMessage`, as `SessionLogView` does); render no text per Design Decision 27 ("no text").
- [ ] Split any component file that exceeds the `post-impl-check-client-component-size` skill's threshold into the files listed above; run client lint and typecheck.

### Chunk 6 — Client: wiring + panel removal
- [ ] Append `'sysctx'` as the last entry of `SESSION_TABS` in `client/src/viewer/tab-ids.ts`, with a one-line comment.
- [ ] Append `{ id: 'sysctx', label: 'System context anatomy' }` as the last entry of the `tabs` array in `SessionTabBar.tsx`, after `raw-logs`.
- [ ] In `SessionDetailPane.tsx`, add a `lazy()` import of `SessionSysctxAnatomyTab` and a `sessionTab === 'sysctx'` branch passing `mainLogs`, `logsQuery.data?.harnessSnapshot`, `parsedLogs?.repoRoot`, `pricing`, `parsedLogs?.summary.model`, `isLoading` and `error`.
- [ ] Create `session-log/StartupContextLine.tsx` per Design Decision 16 (`data-testid="startup-context-line"`, total from `computeStartupTotal`).
- [ ] In `SessionLogView.tsx`, replace `<SessionContextPanel …/>` (l.200) with `<StartupContextLine main={logsData?.main} onOpenAnatomy={onOpenAnatomy} />`, add the optional `onOpenAnatomy` prop, and pass `() => onSessionTabChange('sysctx')` from `SessionDetailPane`.
- [ ] Delete `SessionContextPanel.tsx`, `McpServerModal.tsx`, `SkillDetailModal.tsx`, `AgentDetailModal.tsx`, `FileDetailModal.tsx`, `RuleDetailModal.tsx`, `SourceBadge.tsx`, `SystemContextFilesTab.tsx` and `context-panel-helpers.ts` from `session-log/`; grep that nothing imports them.
- [ ] Remove the parser dead code per Design Decision 25 (`log-parser.ts`, `types.ts`) and the `mcpCalls` prop from `SessionLogView`'s panel call; then run client lint, typecheck and `npm run build` (background).

### Chunk 7 — Docs
- [ ] Create `docs/knowledgebase/sysctx-anatomy-tab.md` (OKF front matter): data sources, partitions, banners, test ids and the hook gitStatus/org-synced link; add its line to `docs/knowledgebase/index.md`.
- [ ] Update `docs/knowledgebase/session-log-view.md`: the System Context panel is replaced by `StartupContextLine`, with a pointer to the new article; keep the `summary.claudeMd` merge section (still used).
- [ ] Update `docs/knowledgebase/client-component-map.md`: remove the entries for the deleted files (l.306-314, l.377), add the new files, and add `sysctx` to the tab order in the `SessionDetailPane` and `SessionTabBar` lines.
- [ ] Add hand-maintained sections for `mcp_instructions_delta` (`addedNames`, `addedBlocks`, `removedNames`) and `session_context` (`context.userEmail`, `context.gitStatus`) to `docs/knowledgebase/log-schema/attachment-types.md`, and note `date`/`environment`/`command_permissions` as environment-sized.
- [ ] Add `### System context anatomy` to `user-docs/session-log.md` per Design Decision 28: what the bar shows, what Harness internals means, git status values, and that hook 2.28.0+ is needed for git status.
- [ ] Update `user-docs/data-collection.md` (§ Environment snapshot) and `hook/HOW_HOOK_WORKS.md` (§ Harness snapshot): per-file `gitStatus` values and org-synced skill names/paths (metadata only, no body); leave `data-collection-notice.md` unchanged.
- [ ] Replace the stale panel references in `token-byte-ratio.md` (l.26, 69, 82), `raw-logs-renderers.md` (l.113), `legacy-design-decisions-map.md` (T-10) and `client-routing-and-layout.md` (session tabs); update `docs/qaa-overview/scenarios/03-…md` (l.432, S-SESS-03 steps 8/8a/9/8d) and `04-…md` (S-HOOK-09 new step).

### Chunk 8 — Tests: golden + scenarios
- [ ] Edit `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl` and `artisyn.jsonl` per Design Decision 21, keeping the `parentUuid` chain valid; update the fixture `README.md`.
- [ ] Add a `roots[0].anatomy` block to GS-05 `expected.json` with the Design Decision 22 numbers (`total`, `attributed`, `harnessInternals`, `partitions{kind:{bytes,tokens}}`); extend `tests/golden/check-arithmetic.mjs` to re-derive them and check `harnessInternals = total − attributed`.
- [ ] Rewrite `s-sess-03.spec.ts` step 8: open GS-05 with `tab: 'sysctx'`; check `anatomy-total` is 8,800, the partitions and internals are 5,971, the hint text has no "Unallocated", clicking a segment selects the row, the skills drill-down has 2 rows (no `unused-skill`) with `adlc:review-deep` `data-source="plugin"`.
- [ ] Rewrite step 8a: files drill-down `data-git` is `tracked` for `CLAUDE.md`, `ignored` for `CLAUDE.local.md` and `outside-repo` for `~/.claude/CLAUDE.md`, with rules under on-demand; no fixture marker text or absolute path; the Logs `startup-context-line` link opens the tab.
- [ ] Add step 8d: upload a small inline session (as step 6a does) with a 10,000-byte `instructions` file and first usage total 100; assert `anatomy-banner[data-variant=over-total]` and no `harness-internals` row.
- [ ] Rewrite step 9: GS-01 `tab: 'sysctx'` shows `anatomy-banner[data-variant=old-hook]`, files `data-git="unknown"` or `outside-repo` only, and no page errors; add a `session.sysctx` row to `tests/scenarios/tours/screen-registry.ts` (`expectTestId: 'sysctx-anatomy-tab'`, `docRef` per Design Decision 28).
- [ ] Add step `4c. harness snapshot carries git status and org-synced skills` to `tests/scenarios/hook/s-hook-09.spec.ts`; assert no `harness_elements` row is named `greet`. In setup: `git add CLAUDE.md`, write `CLAUDE.local.md` plus `.gitignore`, and a fake-home `skills/synced/org-1/greet/SKILL.md`; assert the stored `harness_snapshots.body` statuses and the org-synced entry (masked path, empty body).
- [ ] Run `node tests/golden/check-arithmetic.mjs`, then `s-sess-03`, `s-hook-09`, the golden-load spec and tours (`tour-03`, `tour-10`) via `--grep`; where the fixture edits move an existing GS-05 literal (`context`, `inventory`, `harnessUsage`, per-turn tokens), update `expected.json` and the fixture `README.md`.
