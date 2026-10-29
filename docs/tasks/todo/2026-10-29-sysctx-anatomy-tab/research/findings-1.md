# Research findings 1 — 2026-10-29 (plan-deep)

**Requirements summary**
The task adds a new session tab, **System context anatomy**, placed rightmost. It shows the session's startup context like a disk partition manager: a bar of partitions sized by a byte-based token estimate from `resolveCharsPerToken`, a partition table, and drill-downs to files, skills and MCP servers. Every file row shows a git status. The tab shows names, paths, sizes and statuses only, never text.

The total is exact: `input + cache_creation + cache_read` of the first non-sidechain assistant usage, de-duplicated by `message.id`. Only the first startup block counts. The first user prompt is its own partition and is not subtracted. "Harness internals" = total − attributed; it is hatched and comes with the hint text from FR-6. If attributed > total, a warning shows and there is no Harness internals partition. If there is no usage, the total shows as unknown.

The tab replaces the System Context panel at the top of Logs. `summary.claudeMd` stays.

The hook adds an optional `gitStatus?: 'tracked'|'untracked'|'ignored'|'outside-repo'` on `skills[]`, `agents[]` and `systemContext.files[]`:
- It joins the snapshot id tuple only when set.
- `schemaVersion` stays 1.
- It costs at most 2 batched git calls (`ls-files -z`, `check-ignore --stdin -z`) from `getGitRoot`.
- It ships in hook 2.28.0. Old hooks and old sessions keep working, with git status shown as `unknown`.

**Owner answers (binding, inline under Open Questions in requirements.md; `open_questions_ru.md` has both answers blank):**
1. Org-synced skills: "yes start scan - we need to understand the whole picture". The hook scans `~/.claude/skills/synced/<org>/<skill>/SKILL.md`, metadata only, with the path masked as `~/.claude/skills/synced/<org>/...` and a new source `org-synced` that is part of the snapshot id.
2. Panel features: "from the current panel, just one line in the current design that says the startup context is T tokens; it can be clicked to go to the tab with details". So the detail modals, per-MCP call counts and pricing costs are all dropped.

**From `notes.md`:**
- A byte estimate is accepted.
- The tab is the rightmost one.
- Git status is in `snapshotId`, so a status change resends the snapshot.

**Wireframes**
- `wireframes/anatomy-tab-overview.svg`:
  - Header line: "Total 55,513 tokens · exact … input + cache write + cache read".
  - Info line "≈ bytes / 3.7 — only the total is exact".
  - Partitions under 0.5 % get a 6 px minimum width; zero-size partitions are grouped into one striped "small partitions" segment that is still clickable.
  - Table columns: PARTITION / KIND / SOURCE / BYTES / ≈ TOKENS / SHARE.
  - Skills expanded: SKILL / SOURCE / FILE (SKILL.md) / FILE SIZE / GIT / LISTING B / ≈ TOKENS / SHARE, sorted by tokens, with "Show all 78 skills".
  - The tab sits after Raw Logs, with "🗑 Remove" further right.
- `wireframes/anatomy-drilldown-files-mcp.svg`:
  - Instruction files: PATH / KIND / GIT / FILE SIZE / LOADED B / ≈ TOKENS / SHARE.
  - An "ON DEMAND — 0 at start" subgroup holds path-scoped rules, showing `paths:` and FILE SIZE with LOADED 0.
  - MCP servers: SERVER / STATUS (connected, or failed + error code) / TOOLS / NAMES B / INSTR. B / LOADED ON DEMAND / BYTES / ≈ TOKENS / SHARE, with "Show all 14 servers".
  - Each server has a "loaded on demand" panel listing names from `deferred_tools_record`.
- `wireframes/anatomy-edge-states.svg`:
  - A: old hook, with an info banner and git `unknown`; FILE SIZE is "—" with no snapshot.
  - B: unknown total, with a dashed bar outline and shares of the attributed sum.
  - C: attributed > total, with a ⚠ banner.
  - D: Logs tab with the panel removed.
- Conflicts between the wireframes and the requirements:
  1. The overview header says "minus first user prompt". FR-6 says the prompt is not subtracted.
  2. The overview first-prompt row has kind `user-prompt` and the text "subtracted, shown for reference". FR-3 uses `first-prompt`.
  3. Edge state C shows a row "Harness internals — discrepancy −1,204". FR-6 says no such partition.
  4. Edge state D calls the modals an open question. That is now answered: they become one clickable line.
  5. The divisor 3.7 comes from the PoC. The code uses per-model `charsPerToken`, falling back to `BYTES_PER_TOKEN = 3.5` (`log-parser.ts:54`).
  6. The NFR asks for "light and dark themes", but `docs/knowledgebase/ui-principles.md:18` says light-only.

**Knowledgebase**
- `docs/knowledgebase/session-log-view.md`:
  - Line 26 and § "System Context Files / Rules — sources and merge" (466–486): the merge goes snapshot → `instructions` → on-demand `nested_memory`, keyed by path with `\`→`/` and lowercased, later source wins. User paths become `~/.claude/…`. Text is never kept.
  - Lines 703–705: the parser ignores `prompt_snapshot` and `deferred_tools_record`. Skills, Agents and MCP come only from `harnessSnapshot`. Pre-2.22.0 hooks have no snapshot, and that was an accepted break.
- `docs/knowledgebase/algorithms/harness-snapshot.md`:
  - Rule 6: path shapes are `project` (relative), `user` (`~/.claude/<rel>`), `plugin` (`<name>@<ver>/<rel>`).
  - Rule 7: the canon tuples.
  - Rule 1: scans `skills/<dir>/SKILL.md` only one level deep, so `skills/synced/…` is never found today.
  - Examples HS-01…HS-12 use kinds `catalog` / `compare` / `probe`. Add rows here for the new gitStatus and org-synced behaviour, plus a Mutations entry.
- `docs/knowledgebase/hook-api-versioning.md:65-71`: the hook-version matrix needs a `>= 2.28.0` row, in the same style as the 2.26.0 and 2.27.0 sections (487+, 529+).
- `docs/knowledgebase/log-schema/attachment-types.md`: `prompt_snapshot` (line 376) is hand-maintained and only has `type` and `systemPrompt`. `mcp_instructions_delta`, `session_context`, `environment` and `model` are not documented; add them by hand.
- `docs/knowledgebase/token-byte-ratio.md`: `BYTES_PER_TOKEN` is 3.5 and it is an estimate only.
- `docs/knowledgebase/harness-usage-tab.md`: the pattern for a lazy session tab that bypasses `parseSessionLogs` and makes no extra request.
- `docs/knowledgebase/client-component-map.md:306-314,377`: entries for `SessionContextPanel`, the four modals, `SystemContextFilesTab`, `SourceBadge` and `context-panel-helpers.ts`. Update these when the panel is removed.
- `docs/knowledgebase/algorithms/okf-snapshot.md`: an existing batched `git check-ignore --stdin -z` design, with a fail-closed variant (the new field fails open by leaving `gitStatus` unset).
- `docs/knowledgebase/test/index.md` → `test/scenarios.md`: golden fixtures and scenario helpers.
- `tests/golden/README.md`: fixture layout. Literals live in `expected.json`; `check-arithmetic.mjs` re-derives them.
- `.claude/rules/client.md:44` (Path display) and `.claude/rules/hook.md`: bump the hook version, run `npm run build:hooks-installer`, refresh `.artisyn/marketplace/plugins/log-hub-hooks/`, run the `update-install-instructions` skill, and lint.

**Existing patterns**

PoC:
- `docs/pocs/2026-10-29-1504-sysctx-anatomy/anatomy.cjs`:
  - `splitSkillListing` (~l.150): splits the listing per skill on `- <name>: `.
  - Deferred-name grouping by `/^mcp__(.+?)__/` (~l.200).
  - `failedMcpServers[{name,errorCode}]`.
  - `mcp_instructions_delta.addedNames/addedBlocks`.
  - `agent_listing_delta.addedTypes/addedLines`.
  - `session_context.context{userEmail,gitStatus}`.
  - Small env attachments sized by `JSON.stringify` length.
  - Path masking in `makeDisplay`, including `<org>`.
  - The reference for the client-side builder.
- `docs/pocs/.../sample-output.md`: real numbers (total 55,513; 78 skills; 11 system-prompt blocks).

Hook:
- `hook/.claude/telemetry_tool/harness-snapshot.js`:
  - `computeSnapshotId` (~l.330) is where `gitStatus` gets appended to the tuple when set.
  - `buildSystemContext` (~l.160) also picks up `../CLAUDE.md` from the parent dir, so it has an `outside-repo` case.
  - `buildAgentDefinitions` reads `.claude/agents/<n>/AGENT.md`.
  - `buildHarnessSnapshot` (~l.400) is the place to add git-status enrichment.
- `hook/.claude/telemetry_tool/skill-catalog.js`:
  - `scanRoot` / `scanSkillsDir` (l.163–240), `userEntryPath` (l.91) and `makeEntry` (l.277).
  - `buildSkillCatalog` (l.442) is where the org-synced scan goes; `userEntryPath` would expose the org uuid unless masked.
- `hook/.claude/telemetry_tool/git-context.js`: `git()` (l.26), `gitWithInput()` (l.~60, exit status preserved), `getGitRoot` (l.100). Both helpers use `windowsHide: true` and a 2000 ms default timeout.
- `hook/.claude/telemetry_tool/okf-snapshot.js:286-307` `checkIgnored`: a batched `check-ignore --stdin -z` call to copy.
- `hook/.claude/telemetry_tool/send-logs-hook.js:1258-1320`: builds the snapshot on every run before the known-id check. Git status therefore runs on every artisyn upload of the current session.
- `hook/.claude/telemetry_tool/post-turn-analysis-worker.js:434`: also calls `buildSkillCatalog`, so it will pick up org-synced entries too.
- `hook/.claude/telemetry_tool/version.json`: currently `2.27.0`.

Hook tests:
- `hook/.claude/telemetry_tool/__tests__/harness-snapshot.algo.test.js`: `prepareDir` writes files to temp dirs with no `git init`. Kinds `catalog` / `compare` / `probe` (l.103–165); the `user:` key maps to `CLAUDE_CONFIG_DIR`.
- `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js:29-66`: the `git init` + `GIT_CEILING_DIRECTORIES` temp-repo pattern for git-dependent rows.

Server:
- `server/src/logs/harness-snapshot.ts`:
  - `extractHarnessSnapshot` checks only the id, `schemaVersion === 1`, the arrays and `systemContext`. The body is stored verbatim, so new fields pass through with no server logic change.
  - Optional field and the `org-synced` source go into `HarnessSnapshotSkillSource` (l.43) and the entry interfaces.
- `server/src/logs/artisyn-extractor.ts:426-461`: `extractHarnessSkillInventory` maps any source other than project/user/plugin to `null`. It needs `org-synced`.
- `harness_elements.source`: `varchar(16)` with no CHECK constraint (`server/drizzle/migrations/0053_harness_element_skill_source.sql`). No migration needed.
- No new route: the tab reads `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs` (`main` + `harnessSnapshot`). Registry `server/test/contract/registry/f17-sessions.ts` changes only if the response changes.

Client:
- `client/src/viewer/api.ts:1380-1455`: the client `HarnessSnapshot*` types. `source` is a closed union; add `gitStatus?` and `org-synced`.
- `client/src/viewer/pages/repository/session-log/log-parser.ts`:
  - `resolveCharsPerToken` at l.66.
  - `HIDDEN_SKILL_PREFIX = 'anthropic-skills:'` at l.61, which filters org-synced skills out of `skillDefinitions`. The anatomy must not reuse that filter.
  - Snapshot → `skillDefinitions` / `mcpConfig` / `claudeMd` at l.2315–2380.
  - `registeredSkills` from `skill_listing` (`isInitial`) at l.2588–2608.
  - `deferredTools` at l.2545.
  - `claudeMd` merge at l.2782.
  - First assistant usage loop at l.1914.
- `client/src/viewer/pages/repository/session-log/instruction-files.ts`: `toUserDisplayPath`, `classifyInstructionRole`, `extractInstructionFiles` (UTF-8 byte sizes), `mergeInstructionFiles`. Reuse these for the files drill-down.
- `client/src/viewer/pages/repository/session-log/SessionContextPanel.tsx`: to be removed. It is rendered only at `SessionLogView.tsx:12,200`. `McpServerModal`, `SkillDetailModal`, `AgentDetailModal`, `FileDetailModal`, `RuleDetailModal`, the session-log `SourceBadge` and `SystemContextFilesTab` are used only by this panel, so they become dead code.
- `client/src/viewer/tab-ids.ts:11-35` `SESSION_TABS`: add the new id. `SessionTabBar.tsx:44-95`: the tab array, where Raw Logs is conditional and currently last.
- `client/src/viewer/pages/repository/SessionDetailPane.tsx:52-80`: the `lazy()` tab pattern. The tab switch is at l.330–455; `harness-usage` gets `mainLogs` / `subagentLogsMap` and makes no fetch.
- `client/src/viewer/pages/repository/useRepositoryViewState.ts:30`: `parseSessionTab` validates against `SESSION_TABS`.

Tests:
- `tests/scenarios/view/s-sess-03.spec.ts`: steps 8 (l.226), 8a (l.249) and 9 (l.390) use testids `sysctx-panel`, `sysctx-tab-*`, `sysctx-skill-row` with `data-skill-name`, and `sysctx-file-row` / `sysctx-rule-row` with `data-file-type`. These are the steps to rewrite. They are the only test users of `sysctx-*`.
- `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl`, startup block (lines 0–4, before the first assistant):
  - `mode`, then `skill_listing` (`isInitial`, content 83 chars: `adlc:review-deep` = 44, `adlc:review` = 39).
  - `instructions`: User 1050 + Project 3500 + Local 700 = 5250 B.
  - user `/clear` command (130 chars), then user `/adlc:review src/` (122 chars).
  - First assistant `msg_gs05_001` usage: 800 + 8000 + 0 → **total 8800**.
  - `deferred_tools_delta` is line 8, *after* the first assistant, so it is outside the startup block. It must be moved or duplicated earlier.
  - The fixture has no `prompt_snapshot`, `mcp_instructions_delta`, `session_context` or `agent_listing_delta`.
  - `expected.json` `roots[0].context` / `.inventory` is where to add the anatomy literals.
- `tests/golden/gs-01-simple/`: has no harness snapshot and already has a `prompt_snapshot` line (the old-hook / FR-9 case, step 9).
- `tests/scenarios/hook/s-hook-09.spec.ts:137-165`: the real built hook with `makeFakeGitRepo` + `makeFakeHome` (`helpers/hook-process.ts:164`). It writes `CLAUDE.md` and `.claude/skills/hello`, and step 4 (l.280) reads `harness_snapshots.body`. This is where to add a step for FR-8 (`gitStatus` present) and for org-synced (a fake-home `skills/synced/<org>/…`).
- `tests/scenarios/hook/s-compat-01.spec.ts:306`: a frozen 2.6.1 hook (FR-9 server acceptance of old shapes).
- `tests/scenarios/tours/screen-registry.ts:685-705` plus the meta-test `tours/tour-10-registry.spec.ts` (iterates `SESSION_TABS`): adding a tab id needs a `session.<id>` registry row.

**Open gaps**
1. **Which line is the "first user prompt".** In real transcripts the lines before the first assistant are: an `isMeta` `<local-command-caveat>`, `<command-name>/clear`, a `<command-message>` skill launch, and an `isMeta` array-content skill body of 8,769 and 20,738 chars in two samples. The literal "first `type:user` line" is the caveat. The plan needs a qualification rule, for example reusing the parser's prompt rule or `okf-task-context` `filterUserPrompts`. It also needs to decide where the injected skill body goes; unattributed, it silently inflates Harness internals.
2. **MCP join key.** `deferred_tools_delta` groups by the `mcp__<slug>__` segment, e.g. `claude_ai_Claude_Docs`. `mcp_instructions_delta.addedNames` uses display names, e.g. "claude.ai Claude Docs". Snapshot `mcpServers` carry only names from local config (claude.ai connectors are absent). No normalisation rule exists yet.
3. **Org-synced naming.** The listing uses `anthropic-skills:<name>`, but that prefix appears nowhere on disk. Disk has `~/.claude/skills/synced/<org-uuid>/<name>/SKILL.md` plus `manifest.json` (`skills[]{skillId,name,description,source: anthropic|anthropic-example|plugin,backingPluginId,updatedAt}`). Undecided:
   - the snapshot `name` (bare or prefixed);
   - how to match it to the listing;
   - masking `<org>`;
   - interaction with `HIDDEN_SKILL_PREFIX`;
   - whether the user scan's `skills/synced` must be excluded from rule 1.
   Adding these entries changes `snapshotId` for every user who has synced skills, which means one resend each.
4. **Memory (`MEMORY.md`).** FR-4 says it comes from the `instructions` attachment, but no attachment type for it was seen, and the PoC always reports 0. The source is unknown.
5. **Environment partition membership.** The PoC sizes `environment`, `model`, `language`, `date`, `auto_mode` and `remote_session_change`. A real startup block also has `command_permissions`, which is not covered.
6. **Hook test kind for `gitStatus` id rows.** `harness-snapshot.algo.test.js` has no git-init support. A new row kind (or a `git`/`gitAdd` option) is needed, copying `okf-snapshot.algo.test.js`. Making a file `tracked` also needs `git add`.
7. **Git-status cost.** It runs on every hook run, not only on resends, because the id depends on it. Budget and timeout (default 2000 ms) are undecided.
8. **Tab order.** "Rightmost" versus the conditional Raw Logs tab: the wireframe puts the new tab after Raw Logs.
9. **Pure-function home and algorithm doc.** No algorithm doc exists for the anatomy computation (total, Harness internals, first-block cut-off, split rules). The test policy allows a new `*.algo.test.ts` only together with a new doc under `docs/knowledgebase/algorithms/`. Otherwise the numbers are checked only through the GS-05 scenario literals.
10. **Golden literals.** These depend on the stand's `charsPerToken` for `claude-sonnet-4-6` (falling back to 3.5), so token estimates in `expected.json` must be derived with the same ratio. Byte and total literals are exact: total 8800, listing 83, instructions 5250.
