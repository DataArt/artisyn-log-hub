# Research findings 1 — 2026-11-11

## Requirements summary
A **Recommendations** button is added to the System context anatomy tab. It shows a count, uses test id `sysctx-reco-open` (per the wireframe) and is hidden when nothing matches. It opens a modal (no network request) with one row per matched entry of a static, versioned catalog. Each row shows: group plus matched items, what it is for, ≈ tokens and share of the total, who controls it (`built-in` / `claudeai-account` / `org` / `user` / `project`), and how to disable it, with a snippet that can be copied. A disclaimer names the session's Claude Code version (transcript `version`) and the catalog's `verifiedOn`. The catalog must live in a **new repo-local package under `packages/`** (FR-3b), with entry ids in one namespace shared with the planned session-antipatterns feature (`2026-11-02-session-antipatterns`). FR-4 covers 13 groups:
- rare built-in tools
- Bash + PowerShell
- claude.ai stubs and authenticated connectors
- Docs/Data instructions
- org-synced skills
- user-level MCP
- auto-memory
- project CLAUDE.md
- project MCP
- failed MCP
- plugin skills
- AskUserQuestion/Agent/ListAgents
- the subagent types listing

There is no server, DB or API change. Every byte goes to at most one row (FR-5), and no prompt or file text appears in the DOM (FR-7). FR-8 is a fix to the tool size rule. Tests: extend GS-05 and `check-arithmetic.mjs`, and add a step to `s-sess-03`.

## Already built vs. remaining
- **FR-8 (tool byte rule)** — built, but not as the requirements text says.
  - `client/src/viewer/pages/repository/session-log/sysctx-anatomy/tool-definitions.ts:49-74`: size = `name + description + JSON.stringify(schema.input_schema)`, with fallbacks to `input_schema` and then `schema`.
  - The modal shows `inputSchema` only (`system-prompt-view.ts:351`).
  - FR-8's formula `JSON.stringify(schema)` was rejected on purpose: it counts the description's escapes (about 2 % more) and put 10 of 18 sessions over the exact total (`notes.md`, `consistency-fix-plan.md` §4).
  - Rows already exist: SPV-15 (real wire shape) and SPV-09/SPV-04 (bare schema) in `docs/algorithm-examples/system-prompt-view.json`, and SA-TD1 and SA-GS05 in `sysctx-anatomy.json`.
  - `attachment-types.md:443-458` already describes `schema` as the whole wire tool.
  - The GS-05 tools snapshot `gs05-0003p` is already in wire shape: `Read` 299 B + `Bash` 79 B = 378 B.
  - Remaining: only the rewording of FR-8 and its acceptance criterion. The "Artifact ≈ 38 KB" figure in that criterion comes from the rejected formula; under the built rule it is somewhat lower.
- **FR-4a (tool source)** — partly built, and contradicts the requirements text.
  - `toolsSnapshot()` does not exist. The source is `findToolDefinitions` (`tool-definitions.ts:124`): the `api-request-shape` line of the first main request (2.1.312+), otherwise the first snapshot with tools. `defer_loading` tools are dropped.
  - The anatomy already exposes one row per tool in partition `tool-definitions` (`sysctx-anatomy.ts:477-490`): label = name, `source` `built-in` or `mcp-server`, plus bytes and tokens.
  - `anatomy.toolSource` is `wire`, `snapshot` or `null`.
  - The matcher should consume these rows, which satisfies the FR-5 acceptance criterion (tool rows equal the modal's Tool definitions tab).
- **FR-5 (token ratio)** — the ratio exists as `anatomy.cpt` with `Math.round(bytes/cpt)`, and the share denominator is `anatomy.denominator` (`sysctx-anatomy.ts:836-847`). The byte-ownership rule across rows is not built.
- **Not built** — FR-1, FR-2, FR-3, FR-3a, FR-3b, FR-6, FR-7 (the modal), the FR-4 matchers, and the GS-05 `recommendations` block. Nothing named `CATALOG_VERSION`, `ENABLE_CLAUDEAI`, `recommendation*` or `sysctx-reco` exists in code.
- **Data each matcher can use today:**
  - **claude.ai connectors (built-in data).** `mcp-server` rows have `key` = `mcpKey(slug)` (e.g. `claude_ai_Gmail`), plus `namesBytes`, `instrBytes`, `tools`, `status` and `errorCode` (`sysctx-anatomy.ts:650-665`). The rows do **not** keep each server's startup deferred names, so the stub test (every name ends in `__authenticate` or `__complete_authentication`) cannot be done from the anatomy output. Either add a names list to `McpAcc` / `AnatomyRow`, or re-read `deferred_tools_delta`.
  - **Memory.** Partition `memory` (the `# Memory` block plus the `MEMORY.md` files).
  - **Instruction files.** Rows carry `source` (`user` or `project`) and `fileKind`.
  - **Skills.** Rows carry `source` (`plugin`, `org-synced`, `built-in`, `project` or `user`). The plugin id is in `HarnessSnapshotSkill.plugin.id` (e.g. `adlc@artisyn`) but is not copied onto the anatomy row.
  - **Subagent types.** Partition `agent-types`.
  - **MCP config source.** `HarnessSnapshotMcpServer.configSource` and `connected` (`client/src/viewer/api.ts:1643-1652`) are not joined onto the anatomy rows.
  - **Claude Code version.** The anatomy does not expose the transcript `version`. Read it from `main`, or use `selectedSession.claudeVersion` (used by `SessionSummaryTab.tsx:196`).

## Wireframes
- `wireframes/anatomy-tab-recommendations-button.svg`
  - The button sits beside "View system prompt" in the header (`flex items-start gap-4`, `SessionSysctxAnatomyTab.tsx:207-220`), with test id `sysctx-reco-open` and a count badge for the matched rows.
  - Its variant text "GS-05 golden / a session matching no catalog entry → no button" is **out of date**. Under the FR-4 extra groups, GS-05 as it is today already matches 4 entries (Open gaps 7).
- `wireframes/recommendations-modal.svg`
  - Header: `N matched · measured rows ≈ X tokens (Y % of T) · K rows not measured · Claude Code <v> · catalog v1`, plus a disclaimer.
  - Columns: GROUP / WHAT IT IS FOR / ≈ TOKENS (share, B) / CONTROLLED BY / HOW TO DISABLE (copy button). Long item lists collapse behind "… ▾".
  - Rows have `data-testid="sysctx-reco-row"` and `data-reco-id`.
  - Out-of-date details:
    - Tool rows are shown as "not measured — in Harness internals", but tools are measured now (the `tool-definitions` partition).
    - Plugin skills, failed MCP and webstorm appear as "OPTIONAL (OQ)" rows, but they are required by FR-4 now.
    - The auto-memory switch is marked "verify — OQ"; the NFR says to verify it during implementation.

## Knowledgebase
- `docs/knowledgebase/sysctx-anatomy-tab.md` — Files table; data sources (no new request); partitions; the "no text in the DOM" rule and its modal exception; test-id table at :193-223. The new test ids and the modal get added here.
- `docs/knowledgebase/algorithms/sysctx-anatomy.md` — rules 9-20, especially 10a (tools), 13 (MCP join key `mcpKey`, status) and 15 (skill source, org-synced fallback). Examples projection format at :203-220.
- `docs/knowledgebase/algorithms/system-prompt-view.md` — rule 3 (sizes) and the rows-file conventions (`$fill`).
- `docs/knowledgebase/algorithms/README.md` — the doc format and the Docs table (add a row). `scripts/__tests__/algo-docs.test.js` requires a rows file and forbids inline examples tables.
- `docs/knowledgebase/repo-local-packages.md`
  - Layout to copy: `packages/tool-monitor/` (`package.json` private, `type: module`, `exports` → `./src/index.ts`).
  - Client wiring: alias in `client/vite.config.ts:17-19`, plus `client/tsconfig.json` `paths` and `include` (:21-27).
  - Server wiring, only if the server consumes it now: a `file:` dependency in `server/package.json:30-32` plus `npm install`.
  - Rules: pure TS, no DOM/Node APIs, erasable syntax only, `.ts` relative imports. Add a row to its package table.
- `docs/knowledgebase/log-schema/attachment-types.md` — `prompt_snapshot` at :422-458; the wire `api-request-shape` follows at :458.
- `docs/knowledgebase/index.md` — lines 23, 40 and 104-105. Add the new algorithm doc line.
- `docs/knowledgebase/client-component-map.md` — read before UI work (per `client.md`). Invoke the `ui-components` skill.

## Existing patterns
- `sysctx-anatomy/SessionSysctxAnatomyTab.tsx:161-230` — a header button plus a modal that is mounted only while open. Copy it for the Recommendations button and modal (`useState`; pass `anatomy`, `harnessSnapshot` and `mainLogs`).
- `sysctx-anatomy/SystemPromptModal.tsx:9-60` — `Dialog`, `DialogHeader`, `DialogDescription`, `useCopyToClipboard` (`client/src/viewer/hooks/useCopyToClipboard.ts:3`), `fmtInt` from `AnatomyCells.tsx`, and the header line with ≈ tokens.
- `sysctx-anatomy/sysctx-anatomy.ts:422-915` — `buildSysctxAnatomy`, the only source of partition and row numbers. Matchers should read its output, plus the harness snapshot for `configSource`, `connected` and `plugin.id`.
- `sysctx-anatomy/tool-definitions.ts:134` — `mcpServerOfTool`.
- `sysctx-anatomy.ts:198` — `mcpKey`, the join key between the snapshot's `mcpServers[].name` and the anatomy rows.
- `sysctx-anatomy-constants.ts:61-75,101-110` — the `KIND_LABELS` and `SOURCE_LABELS` vocabularies. A controller vocabulary would follow the same style.
- `client/src/viewer/pages/repository/session-log/summary/detectors/registry.ts:34-58` — an existing static client catalog: `DETECTORS[]`, each `{id, run(ctx) → Finding|null}`, in a stable order. This is the closest precedent for a "catalog of matchers". Its `claude-version.ts` parses versions with `lib/semver`.
- `client/src/viewer/lib/bash-view/bash-view.algo.test.ts` — a package (`@loghub/bash-view`) tested by client vitest, the model for testing a new package. Vitest includes only `client/src/**`, so the test file has to sit under `client/src`.
- `sysctx-anatomy/system-prompt-view.algo.test.ts:1-40` — the table-test template (loader via `createRequire`, `expandFills`).
- `tests/golden/check-arithmetic.mjs:245-393` — the independent re-derivation helpers `startupAnatomy`, `firstRequestTools` and `systemPromptView`. `check()` compares the `expected.json` blocks at :541-562, and already reads `artisyn` (the harness snapshot) at :444.

## Tests to extend
- **Algorithm.** A new `docs/knowledgebase/algorithms/<catalog-name>.md`, a rows file `docs/algorithm-examples/<catalog-name>.json`, and a new `*.algo.test.ts` under `client/src` (allowed only together with the new doc). If anatomy rows gain fields (each server's deferred names, `plugin`), update the rows in `docs/algorithm-examples/sysctx-anatomy.json`: SA-07 (the MCP join / `claude_ai_` row) and SA-GS05.
- **Golden.**
  - `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl`: add `Artifact` and `PowerShell` to the `gs05-0003p` tools, and `mcp__claude_ai_<X>__authenticate` / `__complete_authentication` to `deferred_tools_delta`.
  - `artisyn.jsonl`: one `configSource: "user"` server in `mcpServers`, with its deferred names in the transcript.
  - `expected.json`: the `anatomy` blocks (tool-definitions, mcp-server, attributed, harnessInternals) and `systemPromptView` change, and a new `recommendations` block is added.
  - Also update: GS-05 `README.md`, the `SA-GS05` row, `docs/qaa-overview/scenarios/03-session-view-reports-golden.md:156,380`, and `check-arithmetic.mjs` (new re-derivation). All of this runs through `scripts/__tests__/golden-arithmetic.test.js`.
- **Scenario.** `tests/scenarios/view/s-sess-03.spec.ts`:
  - Step 8 (:431): the anatomy numbers and the `65.6 %` hint literal will change.
  - New step after 8a2 (:521): open `sysctx-reco-open` and check the count and the `sysctx-reco-row[data-reco-id]` rows against `expected.json` `recommendations`.
  - A `GoldenRecommendations` type next to `GoldenAnatomy` (:69).
  - Negative case (FR-1): GS-07 has no startup attachments, so it matches nothing. Step 8d's inline session would match (10,000 B project CLAUDE.md), and so would GS-01 (a `Workflow` tool in its snapshot → rare built-ins).
- **API contract:** none, because no route changes.

## Open gaps
1. **The requirements text is out of date against the code.** FR-4a ("first `prompt_snapshot`, `api-request-shape` not used", `toolsSnapshot()`) and FR-8 (`JSON.stringify(schema)`, Artifact ≈ 38 KB) contradict `findToolDefinitions`. The plan should drop or reword FR-8 and its acceptance criterion, and take tool rows from the anatomy's `tool-definitions` partition.
2. **The package boundary is not decided.** FR-3b puts the catalog in `packages/`, which cannot import client types (`HarnessSnapshot`, `SysctxAnatomy`). The package therefore needs its own structural input type ("startup facts": tool rows, MCP rows with names, config and status, skills with source and plugin id, memory, instruction and agent bytes, cpt, denominator), and the client needs an adapter. Also undecided: whether the server gets a `file:` dependency now (antipatterns is not built yet), and where the algorithm test lives (client vitest under `client/src`).
3. **Each server's deferred names are missing.** The anatomy keeps only `tools` and `namesBytes` per MCP server, so the stub test needs a new field or a re-read of the raw `deferred_tools_delta`.
4. **The data source for user-level MCP.** The hook reads only `.mcp.json`, `~/.claude/mcp.json` and `~/.claude/settings.json` (`hook/.claude/telemetry_tool/harness-snapshot.js:301-322`). It does not read `~/.claude.json`, which is where `claude mcp add -s user` writes. The acceptance criterion "user-level `playwright`" on session 2f225416 may therefore not be detectable; check it on local prod before the plan. claude.ai connectors never appear in the snapshot either.
5. **"Project CLAUDE.md" is ambiguous.** FR-4 says "startup `instructions` that are not MEMORY.md", which also includes the user-level `~/.claude/CLAUDE.md`. On GS-05, all instruction files are 5,250 B → 1,500 tok (17.0 %); counting only `source: project` gives 3,500 + 700 = 4,200 B → 1,200 tok (13.6 %).
6. **Overlapping matches.** A failed user-level or project server matches two entries. At 0 B nothing is counted twice, but there are still two rows, so the plan should set which one wins. Bash in GS-05 has `server: "gs05-mcp"`, so decide whether the Bash + PowerShell row requires built-in tools only; if it does, GS-05 also needs a built-in `Bash`.
7. **GS-05 already matches 4 entries before any extension** (cpt 3.5, denominator 8,800):

   | Entry | Bytes | Tokens | Share |
   |---|---|---|---|
   | Auto-memory | 700 B | 200 tok | 2.3 % |
   | Instruction files (all; 1,200 tok if only `source: project`, see gap 5) | 5,250 B | 1,500 tok | 17.0 % |
   | Project MCP: postgres 48 + 350 = 398 B → 114 tok, playwright 31 B → 9 tok | 429 B | 123 tok | 1.4 % |
   | Plugin skills `adlc@artisyn` (44 + 39) | 83 B | 24 tok | 0.3 % |

   GS-05 has no Docs/Data instructions, no org-synced name in the listing (`gold-sync` is in the snapshot but not in the listing) and no agent types. Extending GS-05 changes the anatomy, `systemPromptView`, the README, SA-GS05 and the step 8 hint literal, so the plan has to recompute those numbers.
8. **Row identity and copy.** The plan has to fix how a row's tokens are computed (round of the row's summed bytes, as in the anatomy) and the share denominator (`anatomy.denominator`; shares stay ≤ 100 % because the rows are disjoint subsets of `attributed`). Test ids beyond the wireframe's `sysctx-reco-open`, `sysctx-reco-row` and `data-reco-id` are not defined yet: the count badge, the copy button and the disclaimer.
9. **Facts only a live session can confirm.** The disable mechanisms are unverified: a bare `permissions.deny` entry hiding a tool, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, and the auto-memory off switch (the NFR asks to verify these during implementation; the wireframe still marks memory as an OQ). The `enabledPlugins` key format `<plugin>@<marketplace>` matches `plugin.id` in the snapshot.
10. **Where the version comes from.** FR-6 asks for the transcript `version` (GS-05 lines carry `"version":"2.1.99"`), but the anatomy does not expose it. The choice is between reading the first `main` line that has a string `version` and using `selectedSession.claudeVersion`.
