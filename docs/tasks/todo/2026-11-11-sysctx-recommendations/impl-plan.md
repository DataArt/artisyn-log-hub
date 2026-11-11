# Implementation plan: Startup Context Recommendations (2026-11-11-sysctx-recommendations)

## TL;DR

- New repo-local package `packages/recommendations/` (`@loghub/recommendations`). It exports
  `CATALOG_VERSION`, `CATALOG` (14 entries, ids `startup.*`), `matchRecommendations(facts)` and the
  types `StartupFacts`, `CatalogEntry` and `RecommendationRow`. It is pure TS, wired into the client
  only (Vite alias plus tsconfig `paths`); the server gets no dependency yet.
- The package also exports `VERIFIED_ON`, the Claude Code version the disable advice was checked on.
  The modal disclaimer and the scenario both use it.
- New client adapter `buildStartupFacts()` (`sysctx-anatomy/startup-facts.ts`). It turns the anatomy,
  the harness snapshot and `main` into `StartupFacts`.
- Two new optional fields on anatomy rows: `names` on `mcp-server` rows (the server's startup
  deferred names) and `pluginId` on `skills` rows. The `sysctx-anatomy` algorithm doc and its rows
  file get updated.
- New UI: a **Recommendations** button with a count badge next to "View system prompt", and
  `RecommendationsModal`. The modal is static data and makes no network request.
- FR-8 and the FR-4a tool source are **already built** (`findToolDefinitions`,
  `tool-definitions.ts:124`), so `system-prompt-view` gets no code change. The plan only rewords
  FR-4a and FR-8 in `requirements.md`.
- No DB, API, server or hook change.
- Tests:
  - a new algorithm doc and rows file `startup-recommendations`, with a table test;
  - GS-05 golden extended with `Artifact`, `PowerShell`, a claude.ai stub connector and a user-level
    MCP server, plus a new `recommendations` block that `check-arithmetic.mjs` checks;
  - a new step 8a3 in `s-sess-03`, with the numbers in steps 8 and 8a2 updated.
- GS-05 number changes also reach the GS-05 `README.md`,
  `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` and the step-8 titles. Chunk 8
  also adds a note to the `2026-11-02-session-antipatterns` requirements and writes a changelog
  entry.
- In-app help: `user-docs/session-log.md` and `user-docs/tuning-your-setup.md` get a Recommendations
  section (offline first).

## Reference

Requirements: [requirements.md](requirements.md) (evidence in [notes.md](notes.md); research archive
[research/findings-1.md](research/findings-1.md)).

## Design Decisions

1. **Tool data source.** FR-4a and FR-8 are satisfied by the code that already exists.
   - Tool rows come from the anatomy `tool-definitions` partition, which `findToolDefinitions` fills:
     the wire `api-request-shape` first, otherwise the first `prompt_snapshot` with tools.
   - A tool's size is name + description + `JSON.stringify(input_schema)`.
   - That makes tool rows equal to the modal's Tool definitions tab (FR-5 AC).
   - When `anatomy.toolSource === null`, `StartupFacts.tools` is `null` and no tool entry matches.
   - `requirements.md` FR-4a, FR-8, the FR-8 AC and the matching Common-sense line are reworded to
     this (Chunk 8).
2. **Built-in tool test.** A tool is built-in when its name does not match `^mcp__`. The snapshot's
   `server` field is ignored, because GS-05's `Bash` carries a synthetic `server: "gs05-mcp"`.
   Built-in tool entries match by exact name.
3. **Package.** `packages/recommendations/` (`@loghub/recommendations`) copies the layout of
   `packages/bash-view/`: `package.json` (private, `type: module`, `exports`/`types` →
   `./src/index.ts`), `tsconfig.json`, `README.md` and `src/`.
   - Rules: pure TS, no DOM or Node APIs, erasable syntax only, `.ts` relative imports
     (`docs/knowledgebase/repo-local-packages.md`).
   - Client wiring follows `client/vite.config.ts:17-19` (alias) and `client/tsconfig.json` (`paths`
     plus `include`).
   - There is no server `file:` dependency until `2026-11-02-session-antipatterns` needs one.
4. **One id namespace.** Entry ids are `startup.<slug>`, and antipatterns will use `session.<slug>`.
   Ids are stable and never reused.
5. **The package's input contract** (`src/types.ts`). The package never imports client types.

   ```ts
   export type Controller = 'built-in' | 'claudeai-account' | 'org' | 'user' | 'project';
   export interface StartupFacts {
     cpt: number;                 // anatomy.cpt
     denominator: number;         // anatomy.denominator
     tools: { name: string; bytes: number }[] | null;   // null = no tools source
     snapshot: boolean;           // a harness snapshot exists
     mcpServers: StartupMcpServer[];
     skills: { name: string; bytes: number; source: string | null; pluginId: string | null }[];
     memoryBytes: number;         // anatomy Memory partition bytes
     instructionFiles: { path: string; bytes: number; source: 'project' | 'user' }[]; // loaded at start only
     agentTypes: { name: string; bytes: number }[];
   }
   export interface StartupMcpServer {
     key: string;                 // mcpKey()
     label: string;
     names: string[];             // startup deferred names
     namesBytes: number;
     instrBytes: number;
     failed: boolean;             // anatomy status 'failed' or snapshot connected === false
     configSource: 'project' | 'user' | null;   // snapshot; null = not in the snapshot
   }
   export interface MatchedItem { name: string; bytes: number | null; status?: 'connected' | 'failed'; note?: string }
   export interface CatalogEntry {
     id: string; title: string; controller: Controller;
     explanation: string;
     disable: { text: string; snippet?: (items: MatchedItem[]) => string };
     verify: boolean;             // true = the disable advice is not confirmed: shown as "verify"
     match: (f: StartupFacts) => MatchedItem[] | null;   // null or [] = not matched
   }
   export interface RecommendationRow {
     id: string; title: string; controller: Controller; explanation: string;
     items: MatchedItem[];
     bytes: number | null;        // Σ item bytes; null when every item is unmeasured
     tokens: number | null;       // Math.round(bytes / cpt)
     share: number | null;        // tokens / denominator (0 when denominator is 0)
     disableText: string; snippet: string | null; verify: boolean;
   }
   ```

   The package also exports `CATALOG_VERSION = 1` and `VERIFIED_ON: string` (the Claude Code
   version the advice was checked on). FR-3's per-entry `verifiedOn` is one catalog-wide constant,
   because all entries are verified in one pass.
6. **`matchRecommendations(facts): RecommendationRow[]`** runs `CATALOG` in catalog order.
   - Each entry yields at most one row (FR-3a).
   - Rows keep catalog order, the same order as the wireframe; they are not sorted by size.
   - Item order inside a row: bytes descending, ties in first-seen order.
   - The button count is `rows.length`.
7. **Byte ownership (FR-5).** Each measured byte belongs to at most one row:
   - tool bytes go to the single tool entry that names the tool;
   - a claude.ai server's `namesBytes` go to the stubs row or the authenticated row;
   - its `instrBytes` go only to the instructions row;
   - a non-claude.ai server's `namesBytes + instrBytes` go to the user row or the project row;
   - the failed-servers row is always 0 B (status only).

   Shares therefore sum to at most `attributed / denominator`, up to rounding.
8. **The catalog** (`src/catalog.ts`, the only file to edit when adding an entry). The `verify` flags
   start as stated here and are confirmed in Chunk 2.

   | # | id | title | controller | match → items (bytes) | snippet |
   |---|---|---|---|---|---|
   | 1 | `startup.rare-builtin-tools` | Rarely needed built-in tools | built-in | tools named `Artifact`, `Workflow`, `ScheduleWakeup`, `SendFeedback`, `ShareOnboardingGuide`, `ReportFindings` | `"permissions": { "deny": [<names>] }` |
   | 2 | `startup.two-shells` | Two shell tools | built-in | both `Bash` and `PowerShell` present → both items | `"permissions": { "deny": ["PowerShell"] }` |
   | 3 | `startup.claudeai-connector-stubs` | claude.ai connectors, not signed in | claudeai-account | servers with `key` starting `claude_ai_`, `names` non-empty and every name ending `__authenticate` or `__complete_authentication` → one item per connector (`namesBytes`); the row note says "N connectors" | `ENABLE_CLAUDEAI_MCP_SERVERS=false` |
   | 4 | `startup.claudeai-connectors` | claude.ai connectors | claudeai-account | `claude_ai_` servers with at least one non-stub name (`namesBytes`) | `ENABLE_CLAUDEAI_MCP_SERVERS=false` |
   | 5 | `startup.claudeai-instructions` | claude.ai connector instructions (Claude Docs / Data) | claudeai-account | `claude_ai_` servers with `instrBytes > 0` (`instrBytes`); the explanation names the side effect (a claude.ai doc instead of a repo file) | `ENABLE_CLAUDEAI_MCP_SERVERS=false` |
   | 6 | `startup.org-synced-skills` | Organisation skills | org | skills whose `source === 'org-synced'` or whose name starts with `anthropic-skills:` | none (not removable locally) |
   | 7 | `startup.user-mcp-servers` | User-level MCP servers | user | non-`claude_ai_` servers with `configSource === 'user'`; or, when `snapshot` is true, `configSource === null` and the key does not start with `plugin_`, with note `user/local scope (~/.claude.json)`. Bytes = `namesBytes + instrBytes`, or 0 with status `failed` | `claude mcp remove <name> -s user` (`verify`) |
   | 8 | `startup.auto-memory` | Auto-memory | user | `memoryBytes > 0` → one item `MEMORY.md` (`memoryBytes`) | `"autoMemoryEnabled": false` (`verify`) |
   | 9 | `startup.project-claude-md` | Project CLAUDE.md and rules | project | `instructionFiles` with `source === 'project'` and bytes > 0 (one item per path) | none (advice text: trim, move rare parts to rules or skills) |
   | 10 | `startup.project-mcp-servers` | Project MCP servers | project | non-`claude_ai_` servers with `configSource === 'project'` (bytes as in #7) | none (remove from `.mcp.json` or deny `mcp__<server>__*`) |
   | 11 | `startup.failed-mcp-servers` | MCP servers that failed to connect | project | servers with `failed` → item bytes 0, status `failed` | none (fix or remove) |
   | 12 | `startup.plugin-skills` | Plugin skills | user | skills with `source === 'plugin'`, grouped per `pluginId` (item = plugin id, bytes = Σ its skills; `pluginId` null → `(unknown plugin)`) | `"enabledPlugins": { "<id>": false, … }` |
   | 13 | `startup.interaction-tools` | Agent and question tools | built-in | tools named `AskUserQuestion`, `Agent`, `ListAgents` | `"permissions": { "deny": [<names>] }` |
   | 14 | `startup.subagent-types` | Subagent types listing | built-in | `agentTypes` non-empty → one item per type | none (explains: built-in, plugins, `.claude/agents/`) |

   - Precedence: #6 before #12, so a skill matched by #6 is skipped by #12.
   - `user` means "user profile" in the UI.
   - A user-level server that is also declared in the project cannot be reported, because the hook
     dedupes by name (`harness-snapshot.js:287-296`). #7's "remove the user-level copy" advice
     therefore applies only when `configSource` arrives as `user` for a name `.mcp.json` also has,
     which current hooks never send. Keep the advice text and do not add a matcher branch for it.
9. **Explanation and disable texts** are short catalog strings, not user data. The wireframe
   `recommendations-modal.svg` gives the tone. Each text is at most about 200 characters, and the
   modal shows them as they are.
10. **Anatomy additions** (`sysctx-anatomy.ts`). `AnatomyRow` gets two optional fields:
    - `names?: string[]` on `mcp-server` rows: the startup `deferred_tools_delta` names of that server,
      in order;
    - `pluginId?: string | null` on `skills` rows: the resolved snapshot entry's `plugin.id`, or
      `null`.

    No size changes. Neither field reaches the tab's DOM.
11. **The adapter** (`client/.../sysctx-anatomy/startup-facts.ts`):
    `buildStartupFacts(input: { anatomy: SysctxAnatomy; snapshot: HarnessSnapshot | null; main: Record<string, unknown>[] }) → { facts: StartupFacts; claudeVersion: string | null }`.
    - The tab calls it inside a `useMemo` on the existing `anatomy` memo
      (`SessionSysctxAnatomyTab.tsx:148-159`), passing `harnessSnapshot ?? null` and
      `mainLogs ?? []`. `anatomy` is never null.
    - `instructionFiles[].source` narrows the row `source` with a guard: `'user'` stays `'user'`,
      and anything else (in practice only `'project'`) becomes `'project'`. `skills[].source` is the
      row `source` as is.
    - A server that appears only in the snapshot and has not failed is skipped, because there are no
      bytes to show. A snapshot-only server that has failed is kept, with 0 B and `names: []`.
    - `tools`: the `tool-definitions` rows (`label`, `bytes`) when `anatomy.toolSource !== null`,
      otherwise `null`.
    - `mcpServers`: the `mcp-server` rows, plus servers that appear only in the snapshot. Join by
      `mcpKey(snapshot.name)`: `configSource` from the snapshot, `failed` = row status `failed` or
      snapshot `connected === false`. A server only in the snapshot gets `names: []` and 0 bytes.
    - `skills`: the `skills` rows.
    - `memoryBytes`: the `memory` partition bytes.
    - `instructionFiles`: the `instruction-file` rows that are not `onDemand`.
    - `agentTypes`: the `agent-types` rows.
    - `claudeVersion`: the first `main` line with a string `version` (FR-6).
11a. **Old hooks and old Claude Code.** A missing data source gives an empty or `null` facts field,
    so the entry does not match. There is no banner and no error.
12. **UI contract.**
    - The button `data-testid="sysctx-reco-open"` sits beside `sysprompt-open`. It is rendered only
      when `rows.length > 0`, with a badge `data-testid="sysctx-reco-count"`.
    - The modal is mounted only while it is open. The rows are computed in a `useMemo` in the tab
      from the anatomy, so the count is known without opening it.
    - Modal test ids:
      - `sysctx-reco-modal`;
      - `sysctx-reco-summary`, the header line `N matched · ≈ X tokens (Y % of T) · [K not measured ·] Claude Code <v|unknown> · catalog v<CATALOG_VERSION>`:
        - X = Σ row tokens;
        - Y = X / `anatomy.denominator`, the same denominator as the row shares;
        - T = `fmtInt(anatomy.denominator)`, followed by " attributed" when
          `anatomy.denominator !== anatomy.total`;
        - "K not measured" appears only when K > 0. No v1 entry yields `null` bytes, so the branch
          exists only for the shared contract;
      - `sysctx-reco-disclaimer`, FR-6 text naming the session version and `VERIFIED_ON`;
      - one `sysctx-reco-row` per row, carrying `data-reco-id`;
      - in each row, `sysctx-reco-tokens` (`≈ N` + `share %` + `B`, or "not measured"),
        `sysctx-reco-controller` and, when there is a snippet, `sysctx-reco-copy`.
    - Share uses one decimal (`Math.round(share*1000)/10`), the same as the tab.
13. **The GS-05 extension** (exact sizes; cpt 3.5, total 8,800).
    - Built-in `Artifact` (700 B) and `PowerShell` (350 B) are added to `gs05-0003p.tools`. Each is
      `{name, description, schema:{name, description, input_schema}}` with ASCII filler, sized to
      name + description + `JSON.stringify(input_schema)`.
    - Two names are appended to `gs05-0006`'s `addedNames`/`addedLines`:
      - `mcp__claude_ai_Gmail__authenticate` (34 + 1 = 35 B);
      - `mcp__claude_ai_Gmail__complete_authentication` (45 + 1 = 46 B).
    - `mcp__context7__get_docs` (23 + 1 = 24 B) is appended to the same lists.
    - `artisyn.jsonl` `mcpServers` gets
      `{name:"context7", command:"npx", args:["-y","@upstash/context7-mcp"], configSource:"user", connected:true, tools:[{name:"get_docs", schemaSizeTokens:150}]}`.

    The resulting numbers:

    | Block | Before | After |
    |---|---|---|
    | anatomy `tool-definitions` | 378 B / 108 tok | 1,428 B / 408 tok |
    | anatomy `mcp-server` | 429 B / 123 tok | 534 B / 153 tok |
    | anatomy `attributed` | 3,027 | 3,357 |
    | anatomy `harnessInternals` | 5,773 (65.6 %) | 5,443 (61.9 %) |
    | `systemPromptView` tools / toolsBytes / toolsTokens | 2 / 378 / 108 | 4 / 1,428 / 408 |
    | `systemPromptView` totalBytes / totalTokens | 4,194 / 1,198 | 5,244 / 1,498 |

14. **The GS-05 `recommendations` block** (`expected.json`, root 0). The shape is
    `{charsPerToken, denominator, count, measuredTokens, ids:[…], rows:{<id>:{items:{<name>:bytes}, bytes, tokens}}}`.
    The values, in catalog order:

    | id | items (B) | bytes | tokens | share |
    |---|---|---|---|---|
    | `startup.rare-builtin-tools` | Artifact 700 | 700 | 200 | 2.3 % |
    | `startup.two-shells` | PowerShell 350, Bash 79 | 429 | 123 | 1.4 % |
    | `startup.claudeai-connector-stubs` | claude_ai_Gmail 81 | 81 | 23 | 0.3 % |
    | `startup.user-mcp-servers` | context7 24 | 24 | 7 | 0.1 % |
    | `startup.auto-memory` | MEMORY.md 700 | 700 | 200 | 2.3 % |
    | `startup.project-claude-md` | CLAUDE.md 3,500, CLAUDE.local.md 700 | 4,200 | 1,200 | 13.6 % |
    | `startup.project-mcp-servers` | postgres 398, playwright 31 | 429 | 123 | 1.4 % |
    | `startup.plugin-skills` | adlc@artisyn 83 | 83 | 24 | 0.3 % |

    That gives count 8, `measuredTokens` 1,900 and a summary share of 21.6 % (1,900 / 8,800). The
    user-level `~/.claude/CLAUDE.md` (1,050 B) is not in #9. #9's item names are the anatomy display
    paths. #8 always has the single fixed item `MEMORY.md`.

15. **Checking the disable advice (NFR).** The check never touches the developer's real Claude Code
    configuration.
    - Create a scratch folder outside the repo under the scratchpad, and set `CLAUDE_CONFIG_DIR` to a
      fresh subfolder of it. Do not use `~/.claude` or `~/.claude.json`.
    - A fresh config dir has no credentials. Ask the user to log in once inside it:
      `! CLAUDE_CONFIG_DIR=<dir> claude /login`, with claude.ai login so the connectors appear.
      Never copy credential files.
    - Seed the baseline in the scratch dir: install one plugin with `claude plugin install`, add one
      user-level MCP server with `claude mcp add -s user`, and write one auto-memory `MEMORY.md`.
    - Check `permissions.deny` on a tool that is surely present (e.g. `WebFetch`), and also on
      `Artifact` when the baseline has it.
    - When an item is missing from the baseline (e.g. there are no claude.ai connectors), its
      mechanism cannot be confirmed and its entry keeps `verify: true`.
    - Run once as a baseline: `claude -p "List the names of every tool you have, one per line" --output-format json`.
    - Then rerun the same command once per mechanism, with only that one setting added:
      - `permissions.deny: ["Artifact"]` in the scratch project's `.claude/settings.json`;
      - the env var `ENABLE_CLAUDEAI_MCP_SERVERS=false`;
      - `autoMemoryEnabled: false`;
      - `enabledPlugins: {"<id>": false}`;
      - `claude mcp add`, then `claude mcp remove <name> -s user`, inside the scratch config dir.
    - A mechanism counts as confirmed when its tool, server or memory block is gone from the second
      run's tool list or its startup transcript, and present in the baseline.
    - The runs spend a few real `claude -p` requests.
    - Any mechanism not confirmed keeps `verify: true`.
    - `VERIFIED_ON` = `claude --version` of the binary used.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `packages/recommendations/package.json`, `tsconfig.json`, `README.md` | new package | copy of the `packages/bash-view/` layout (DD 3) |
| `packages/recommendations/src/types.ts` | the input/output contract | DD 5 |
| `packages/recommendations/src/catalog.ts` | `CATALOG`, `CATALOG_VERSION`, `VERIFIED_ON` | DD 8, the only file to edit when adding an entry |
| `packages/recommendations/src/match.ts` | `matchRecommendations` | DD 6, 7 |
| `packages/recommendations/src/index.ts` | public exports | |
| `client/vite.config.ts`, `client/tsconfig.json` | alias, `paths`, `include` | DD 3 |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/sysctx-anatomy.ts` | `names`, `pluginId` on rows | DD 10 |
| `…/sysctx-anatomy/startup-facts.ts` | adapter | DD 11 |
| `…/sysctx-anatomy/sysctx-anatomy-constants.ts` | `CONTROLLER_LABELS`, `RECO_ITEMS_PREVIEW` | Visual/UX notes |
| `…/sysctx-anatomy/SessionSysctxAnatomyTab.tsx` | button, badge, modal mount | DD 12 |
| `…/sysctx-anatomy/RecommendationsModal.tsx` | modal: summary, disclaimer, table | DD 12; split rows into `RecommendationRows.tsx` if the file passes 10 KB |
| `…/sysctx-anatomy/startup-recommendations.algo.test.ts` | table test of `matchRecommendations` | new; allowed with a new algorithm doc |
| `docs/knowledgebase/algorithms/startup-recommendations.md` | algorithm doc | new |
| `docs/algorithm-examples/startup-recommendations.json` | rows | new |
| `docs/knowledgebase/algorithms/sysctx-anatomy.md`, `docs/algorithm-examples/sysctx-anatomy.json` | the new row fields plus one row | DD 10 |
| `docs/knowledgebase/algorithms/README.md`, `docs/knowledgebase/index.md` | list the new doc | |
| `docs/knowledgebase/sysctx-anatomy-tab.md` | button, modal, test ids, Files table | |
| `docs/knowledgebase/repo-local-packages.md` | package table row | |
| `tests/golden/gs-05-skills-rules-mcp-workflow/{session.jsonl, artisyn.jsonl, expected.json, README.md}` | fixture extension | DD 13, 14 |
| `tests/golden/check-arithmetic.mjs` | check the `recommendations` block | Test coverage plan |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` | GS-05 numbers (lines ~156, ~380) | |
| `tests/scenarios/view/s-sess-03.spec.ts` | steps 8 / 8a2 numbers, new step 8a3 | |
| `user-docs/session-log.md`, `user-docs/tuning-your-setup.md` | in-app help on Recommendations | offline-first: help ships with the product |
| `docs/tasks/todo/2026-11-11-sysctx-recommendations/requirements.md` | reword FR-4a, FR-8 and its AC | DD 1 |

## Test coverage plan

Under the CLAUDE.md test policy:

- **Algorithm (new doc).** `startup-recommendations.md` plus the rows file
  `docs/algorithm-examples/startup-recommendations.json`, run by the new
  `startup-recommendations.algo.test.ts` under `client/src`; vitest includes only `client/src/**`.
  - Each row's `input` is a `StartupFacts`; `expected` is a subset of
    `{ids, count, rows:{<id>:{items:{name:bytes}, bytes, tokens, sharePct}}}`.
  - Rows cover:
    - every entry matching;
    - nothing matching;
    - `tools: null`;
    - no snapshot (#7, #10, #12 unmatched);
    - stubs vs. authenticated vs. instructions bytes ownership;
    - a failed user server (0 B in #7 and in #11);
    - #6 taking precedence over #12;
    - `Bash` without `PowerShell`;
    - a GS-05 mirror row equal to DD 14.
- **Algorithm (extend).** In `sysctx-anatomy.json`, extend SA-07 (or add a row) to assert
  `mcp-server` `names` and `skills` `pluginId`. SA-GS05 embeds the GS-05 startup block inline, so it
  must mirror the DD 13 fixture: the two tools, the three deferred names and the `context7` snapshot
  server. It must also mirror the DD 13 numbers: tool-definitions 1,428 B / 408, mcp-server 534 B /
  153, attributed 3,357, internals 5,443. The doc lines quoting SA-GS05 numbers get the same update.
- **Golden arithmetic (scenario kind).** This extends the existing golden-fixture consistency check
  that the scenarios rely on, and adds no new test file. GS-05 is extended per DD 13, and `expected.json` gets the DD 14 block.
  `check-arithmetic.mjs` re-derives it independently of the client:
  - item bytes from the startup lines (tool bytes via its `firstRequestTools` helper, deferred-name
    bytes per server, memory and instruction bytes via `startupAnatomy`, skills per plugin);
  - each row's bytes = Σ items and tokens = `round(bytes / cpt)`;
  - count = `ids.length`;
  - `measuredTokens` = Σ tokens ≤ denominator.

  It runs through `scripts/__tests__/golden-arithmetic.test.js` (`npm run test:scripts`).
- **Scenario.** In `tests/scenarios/view/s-sess-03.spec.ts`, steps 8 and 8a2 follow the new
  expected numbers (the hint literal `65.6 %` → `61.9 %`, 4 tools). A new step 8a3 checks:
  - the badge count = `recommendations.count`;
  - the modal row ids in order = `ids`;
  - each row's ≈ tokens;
  - the summary, the disclaimer (`2.1.99` plus `VERIFIED_ON`) and that a copy button works;
  - no fixture marker text (`GS05-LOCAL-MARKER`, `GS05-TOOL-MARKER`) in the modal DOM;
  - that opening the modal sends no request;
  - GS-07's anatomy tab has no `sysctx-reco-open`.
- **API contract.** None, because no route changes.

## Visual/UX notes

- The header row is `flex items-start gap-4` (`SessionSysctxAnatomyTab.tsx:207`). The new button
  goes after "View system prompt", as `Button variant="outline" size="sm"` with a `Lightbulb` icon,
  the text "Recommendations" and a small count badge. The header does not stretch full width.
- The modal reuses `Dialog`/`DialogHeader`/`DialogDescription` like `SystemPromptModal.tsx:9-60`,
  with a wide dialog (`max-w-5xl`). The summary line and disclaimer go above the table.
- Table columns: GROUP (title plus an items line) / WHAT IT IS FOR / ≈ TOKENS (tokens, `share % · bytes B`) / CONTROLLED BY / HOW TO DISABLE.
  - Long item lists show the first `RECO_ITEMS_PREVIEW = 4` names and a "… N more ▾" toggle.
    The constant lives in `sysctx-anatomy-constants.ts`.
  - A failed item shows a `failed` tag.
  - A `verify` row prefixes its disable text with "Verify:".
  - The snippet is a `<pre>` with a copy button that uses `useCopyToClipboard`.
- Controller labels go in `CONTROLLER_LABELS: Record<Controller, string>` in `sysctx-anatomy-constants.ts`, next to `SOURCE_LABELS`: `built-in` → "Claude Code built-in", `claudeai-account` → "claude.ai account",
  `org` → "organisation", `user` → "user profile", `project` → "project".
- Numbers use `fmtInt` from `AnatomyCells.tsx`, plus the tab's "≈" wording.

## Wireframes

No redraw. Implementation follows the DD that supersede these parts of the wireframes:

- tool rows are measured (DD 1), not "not measured — in Harness internals";
- the "OPTIONAL (OQ)" rows are required (DD 8);
- GS-05 shows a button with 8 rows (DD 14), not "no button".

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Package skeleton and matcher | 6 | contract per DD 5–7; no client code |
| 2 | Catalog entries | 6 | needs Chunk 1 types; verifies the disable advice |
| 3 | Anatomy fields and adapter | 5 | client logic; consumes the package contract |
| 4 | Recommendations UI | 7 | needs Chunks 1–3 |
| 5 | Algorithm doc and table test | 5 | tests the package from Chunks 1–2 |
| 6 | GS-05 golden and arithmetic check | 6 | numbers per DD 13–14 |
| 7 | Scenario s-sess-03 | 5 | needs Chunks 4 and 6 |
| 8 | Docs and help | 7 | last |

### Chunk 1 — Package skeleton and matcher
- [ ] Create `packages/recommendations/` with `package.json` (`@loghub/recommendations`, private, `type: module`, `exports`/`types` → `./src/index.ts`), `tsconfig.json` and `README.md`, copied from `packages/bash-view/` per DD 3.
- [ ] Write `src/types.ts` with `Controller`, `StartupFacts`, `StartupMcpServer`, `MatchedItem`, `CatalogEntry` and `RecommendationRow`, exactly per DD 5.
- [ ] Write `src/match.ts`: `matchRecommendations(facts, catalog = CATALOG)` per DD 6, with row bytes = Σ non-null item bytes (`null` when all are null), tokens `Math.round(bytes / facts.cpt)`, share `tokens / denominator` (0 when the denominator is 0), and `snippet = entry.disable.snippet?.(items) ?? null`.
- [ ] Create `src/catalog.ts` exporting `CATALOG_VERSION = 1`, `VERIFIED_ON` (placeholder, set in Chunk 2) and an empty `CATALOG: CatalogEntry[]`. Write `src/index.ts`, re-exporting types, catalog and `matchRecommendations`.
- [ ] Wire the client: add an alias `'@loghub/recommendations'` → `../packages/recommendations/src/index.ts` in `client/vite.config.ts`, plus `paths` and `include` entries in `client/tsconfig.json`, following `@loghub/bash-view`.
- [ ] Run client `bun run typecheck` and `bun run lint` and fix any issues.

### Chunk 2 — Catalog entries
- [ ] In `packages/recommendations/src/catalog.ts`, add entries #1, #2 and #13 per DD 8 (built-in tool entries, name match per DD 2, snippets per the DD 8 table), with explanation and disable texts per DD 9.
- [ ] Add entries #3, #4 and #5 (claude.ai stubs, authenticated, instructions) per DD 8, with byte ownership per DD 7. #3's items are one per connector, labelled with the server label.
- [ ] Add entries #7, #10 and #11 (user, project and failed MCP servers) per DD 8, including the `configSource === null` fallback and the `plugin_` exclusion of #7. Failed items get `status: 'failed'` and 0 bytes.
- [ ] Add entries #6, #8, #9, #12 and #14 per DD 8, with #6 taking precedence over #12 (#12 skips skills that #6 matches) and #12 grouping by `pluginId`.
- [ ] Order `CATALOG` by DD 8 `#`. Assert unique ids in a module-level check, so a duplicate id throws at import.
- [ ] Check every disable mechanism per DD 15 (isolated `CLAUDE_CONFIG_DIR`, never the real `~/.claude`). Set `VERIFIED_ON` and set `verify: true` on any entry whose mechanism was not confirmed.

### Chunk 3 — Anatomy fields and adapter
- [ ] In `sysctx-anatomy.ts`, add `names?: string[]` and `pluginId?: string | null` to `AnatomyRow` (DD 10). Collect each MCP name into `McpAcc` inside the `deferred_tools_delta` loop (:602-617) and copy it onto `mcp-server` rows (:650-665).
- [ ] In the skills loop (:699-716), set `pluginId: entry?.plugin?.id ?? null` on each skill row, checking that `HarnessSnapshotSkill` in `client/src/viewer/api.ts` types `plugin.id`.
- [ ] Create `sysctx-anatomy/startup-facts.ts` with `buildStartupFacts({ anatomy, snapshot, main })` per DD 11, joining snapshot `mcpServers` by `mcpKey` (exported from `sysctx-anatomy.ts:198`).
- [ ] In `docs/knowledgebase/algorithms/sysctx-anatomy.md`, document the two new row fields (MCP and skills rules). Extend SA-07 or add a row in `docs/algorithm-examples/sysctx-anatomy.json` that asserts `names` and `pluginId`. Update SA-GS05's inline block (`sysctx-anatomy.json:340`) and its doc lines to the DD 13 fixture and numbers, and update the rows count line.
- [ ] Run client `bun run typecheck`, `bun run lint` and `bun run test` and fix any issues.

### Chunk 4 — Recommendations UI
- [ ] In `SessionSysctxAnatomyTab.tsx`, add a `useMemo` that computes `buildStartupFacts` and then `matchRecommendations` from `anatomy`, `harnessSnapshot` and `mainLogs`, and a `recoOpen` state.
- [ ] Render the Recommendations button (`sysctx-reco-open`, `Lightbulb` icon, badge `sysctx-reco-count`) after `sysprompt-open`, only when rows exist, per DD 12 and the Visual/UX notes.
- [ ] Create `RecommendationsModal.tsx` (props: `open`, `onOpenChange`, `rows`, `anatomy`, `claudeVersion`) with the `sysctx-reco-modal` dialog, the `sysctx-reco-summary` line and the `sysctx-reco-disclaimer` text, per DD 12, using `CATALOG_VERSION` and `VERIFIED_ON`.
- [ ] Add `CONTROLLER_LABELS: Record<Controller, string>` (labels per the Visual/UX notes) and `RECO_ITEMS_PREVIEW = 4` to `sysctx-anatomy-constants.ts`.
- [ ] Render the table: one `sysctx-reco-row` (`data-reco-id`) per row with the columns, controller labels, item collapse, `failed` tag and `Verify:` prefix per the Visual/UX notes, and test ids `sysctx-reco-tokens`, `sysctx-reco-controller` and `sysctx-reco-copy`.
- [ ] Wire the snippet copy through `useCopyToClipboard` (`client/src/viewer/hooks/useCopyToClipboard.ts`). Mount the modal only while it is open, as `SystemPromptModal` is mounted.
- [ ] Update the tab's header comment (DOM rule: the modal shows only catalog text, names, counts and sizes). If `RecommendationsModal.tsx` is over 10 KB, split the rows into `RecommendationRows.tsx`. Run client typecheck and lint.

### Chunk 5 — Algorithm doc and table test
- [ ] Write `docs/knowledgebase/algorithms/startup-recommendations.md` in the format of `algorithms/README.md`, with rules = DD 2 and DD 5–8 (input contract, catalog order, byte ownership, precedence, rounding) and a Mutations section. Note that a `mcp__`-less tool with a snapshot `server` (GS-05 `Bash`) counts as built-in here.
- [ ] Write `docs/algorithm-examples/startup-recommendations.json`, with rows for each case listed under Test coverage plan → Algorithm (new doc), including the GS-05 mirror row equal to DD 14.
- [ ] Create `client/src/viewer/pages/repository/session-log/sysctx-anatomy/startup-recommendations.algo.test.ts` from the `system-prompt-view.algo.test.ts:1-40` template, so it loads the rows, calls `matchRecommendations` and compares the `expected` subset.
- [ ] Add the doc to the Docs table in `docs/knowledgebase/algorithms/README.md` and to `docs/knowledgebase/index.md`.
- [ ] Run client `bun run test` and `npm run test:scripts` (the algo-docs check) and fix any failures.

### Chunk 6 — GS-05 golden and arithmetic check
- [ ] In `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl`, add the `Artifact` and `PowerShell` tools to `gs05-0003p.tools`, and the three deferred names to `gs05-0006`, with the exact sizes from DD 13.
- [ ] In `artisyn.jsonl`, add the user-level `context7` server from DD 13 to the snapshot `mcpServers`.
- [ ] In `expected.json`, update the `anatomy` and `systemPromptView` numbers per DD 13 and add the `recommendations` block per DD 14 (with a `$comment` naming the algorithm doc).
- [ ] In `tests/golden/check-arithmetic.mjs`, add an independent `recommendations` check per Test coverage plan → Golden arithmetic, re-implementing the DD 7/8 rules for the matched entries (built-in name test DD 2, stub-name test, configSource join). Extend the header comment.
- [ ] Run `npm run test:scripts`. Update any other GS-05 `expected.json` block the new server or tools move (e.g. `inventory`), and the GS-05 `README.md` numbers.
- [ ] Grep `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` and the `tests/scenarios` specs other than `s-sess-03.spec.ts` (Chunk 7 owns that one) for GS-05 tool, MCP-server, 3,027, 5,773, 65.6 % and 4,194 literals. Update them to the DD 13 numbers.

### Chunk 7 — Scenario s-sess-03
- [ ] In `tests/scenarios/view/s-sess-03.spec.ts`, add a `GoldenRecommendations` interface next to `GoldenAnatomy` (:69), matching the DD 14 shape.
- [ ] Update step 8 (:431): the internals hint literal goes from `65.6 %` to `61.9 %`, along with any other hardcoded GS-05 number. Update step 8a2 (:521) for 4 tools (`Read`, `Artifact`, `PowerShell`, `Bash`) and their order.
- [ ] Add step 8a3 after 8a2: open `sysctx-reco-open`, check the `sysctx-reco-count` and the row `data-reco-id` order against `recommendations`, and check each row's `sysctx-reco-tokens`, the summary and the disclaimer (`2.1.99`).
- [ ] In step 8a3, also check that opening the modal triggers no network request, that `GS05-LOCAL-MARKER` and `GS05-TOOL-MARKER` are absent from the modal DOM, that one `sysctx-reco-copy` passes its snippet to the stubbed `navigator.clipboard.writeText` (the step 8a2 pattern, :602-610), and that GS-07's anatomy tab renders `sysctx-anatomy-tab` with no `sysctx-reco-open`.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03"` and again with `--mode c` (the scenario declares both; use its actual tag) and fix any failures.

### Chunk 8 — Docs and help
- [ ] Update `docs/knowledgebase/sysctx-anatomy-tab.md`: the Files table (`startup-facts.ts`, `RecommendationsModal.tsx`, the package), the Recommendations button and modal, the DOM rule exception, and the test-id table (:193-223) with the DD 12 ids.
- [ ] Add a `@loghub/recommendations` row to the package table in `docs/knowledgebase/repo-local-packages.md`, noting it is client-only for now and planned to be shared with `2026-11-02-session-antipatterns`.
- [ ] Add a short "Recommendations" paragraph to the anatomy section of `user-docs/session-log.md`, and a pointer in `user-docs/tuning-your-setup.md`. State that the advice is curated and must be verified on a new session.
- [ ] In `requirements.md`, reword FR-4a, FR-8, the FR-8 AC and the Common-sense tool lines to the built behaviour per DD 1. Add a dated note that FR-3's per-entry `verifiedOn` became the catalog-wide `VERIFIED_ON` (DD 5).
- [ ] Add a short note in `docs/tasks/todo/2026-11-02-session-antipatterns/requirements.md` Notes that the catalog package `@loghub/recommendations` exists with the `startup.*` id namespace.
- [ ] Write the changelog entry `docs/changelog/<YYYY-MM-DD-HHmm>-sysctx-recommendations.md` (one line, per the `changelog` skill).
- [ ] Run `npm run build:help` to confirm the help pages generate, then run the fast health set (`adlc-lh:check-health` with `finalRun: false`).
