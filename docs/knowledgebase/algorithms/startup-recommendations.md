---
reviewed: no
reviewer: none
---

# Startup context recommendations

## Purpose

The System context anatomy tab says how many tokens each startup block takes, but not which of
them the user can switch off. The Recommendations modal matches a fixed catalog of known
"usually unneeded" startup groups (rare built-in tools, claude.ai connectors, user-level MCP
servers, auto-memory, plugin skills, ...) against the session's startup facts, and for each match
shows what it costs, who controls it and how to turn it off.

## Code

- Implementation: the repo-local package `@loghub/recommendations` (`packages/recommendations/src/`):
  - `match.ts` (`matchRecommendations`) — runs the catalog, sorts items, sums bytes, rounds tokens;
  - `catalog.ts` (`CATALOG`, `CATALOG_VERSION`, the `DOC` links; helpers `isBuiltIn`,
    `builtInTools`, `isStubConnector`, `serverItem`, `isOrgSkill`) — the entries and their
    `match` functions;
  - `types.ts` (`StartupFacts`, `StartupMcpServer`, `MatchedItem`, `CatalogEntry`,
    `RecommendationRow`, `Controller`).
- Input adapter (not part of the rows): `client/.../session-log/sysctx-anatomy/startup-facts.ts`
  (`buildStartupFacts`) builds `StartupFacts` from the [sysctx-anatomy](sysctx-anatomy.md) result
  and the harness snapshot.
- Twins: none. `tests/golden/check-arithmetic.mjs` re-derives the GS-05 `recommendations` block
  independently (golden data, not a copy of the code).
- Test: `client/src/viewer/pages/repository/session-log/sysctx-anatomy/startup-recommendations.algo.test.ts`
  (vitest; imports the package through the `@loghub/recommendations` alias).

## Input and output

Input `StartupFacts`:

| Field | Meaning |
|---|---|
| `cpt` | characters per token (anatomy `cpt`) |
| `denominator` | share denominator (anatomy `denominator`) |
| `tools` | `{name, bytes}[]` tool definitions, or `null` when there is no tools source |
| `snapshot` | a harness snapshot exists |
| `mcpServers` | `{key, label, names, namesBytes, instrBytes, failed, configSource}[]`; `key` = `mcpKey(name)`, `names` = the startup deferred names, `configSource` `'project' \| 'user' \| null` (`null` = not in the snapshot) |
| `skills` | `{name, bytes, source, pluginId}[]` |
| `memoryBytes` | anatomy Memory partition bytes |
| `instructionFiles` | `{path, bytes, source: 'project' \| 'user'}[]`, files loaded at start only |
| `agentTypes` | `{name, bytes}[]` |

Output: `RecommendationRow[]`, each `{id, title, controller, explanation, items, bytes, tokens,
share, disableText, snippet, docs, note}`, where `docs` are the entry's links to the
Claude Code documentation (`{label, url}`, catalog constants); an item is `{name, bytes, status?, note?}`. The button
count is the number of rows.

## Rules

1. **Built-in tool.** A tool is built-in when its name does not match `^mcp__`. Nothing else is
   looked at: a tool the harness snapshot attributes to a `server` but whose name has no `mcp__`
   prefix (GS-05's `Bash`, `server: "gs05-mcp"`) is built-in here. Built-in entries match by
   exact name. When `tools` is `null`, no tool entry matches.
2. **Catalog order.** `matchRecommendations` runs `CATALOG` in order. Each entry's `match`
   returns items or `null` / `[]` (= not matched); each entry yields at most one row, and rows keep
   catalog order (not sorted by size).
3. **Item order.** Inside a row, items are sorted by bytes descending (an unmeasured item last);
   ties keep the order they were matched in (the facts' order).
4. **Byte ownership.** Every measured byte belongs to at most one row:
   - a tool's bytes go to the single tool entry that names it (#1, #2 or #13);
   - a claude.ai server (`key` starts `claude_ai_`): its `namesBytes` go to #3 when it has names
     and every name ends `__authenticate` or `__complete_authentication`, else to #4 when it has at
     least one other name; its `instrBytes` go only to #5 (when > 0);
   - a non-claude.ai server's `namesBytes + instrBytes` go to #7 or #10 — or 0 B with
     status `failed` when `failed` is true;
   - #11 (failed servers) is always 0 B per item, status `failed`.
5. **Precedence.** #6 runs before #12: a skill whose `source` is `org-synced` or whose name starts
   `anthropic-skills:` is an organisation skill and is never counted in #12, even when its source
   is `plugin`.
6. **Catalog** (`id` = `startup.<slug>`, stable, never reused):

   | # | id | controller | items (bytes) |
   |---|---|---|---|
   | 1 | `rare-builtin-tools` | built-in | built-in tools named `Artifact`, `Workflow`, `ScheduleWakeup`, `SendFeedback`, `ShareOnboardingGuide`, `ReportFindings` |
   | 2 | `two-shells` | built-in | built-in `Bash` and `PowerShell`, only when both are present |
   | 3 | `claudeai-connector-stubs` | claudeai-account | stub-only claude.ai servers, item = label (`namesBytes`); row note `N connectors` (`1 connector` for one) |
   | 4 | `claudeai-connectors` | claudeai-account | claude.ai servers with a non-stub name (`namesBytes`) |
   | 5 | `claudeai-instructions` | claudeai-account | claude.ai servers with `instrBytes > 0` (`instrBytes`) |
   | 6 | `org-synced-skills` | org | organisation skills (rule 5), item = skill name |
   | 7 | `user-mcp-servers` | user | non-claude.ai servers with `configSource === 'user'`; or, when `snapshot` is true, `configSource === null` and the key does not start `plugin_`, with note `user/local scope (~/.claude.json)` |
   | 8 | `auto-memory` | user | `memoryBytes > 0` → one item `MEMORY.md` |
   | 9 | `project-claude-md` | project | instruction files with `source === 'project'` and bytes > 0, item = path |
   | 10 | `project-mcp-servers` | project | non-claude.ai servers with `configSource === 'project'` |
   | 11 | `failed-mcp-servers` | project | servers with `failed`, 0 B, status `failed` |
   | 12 | `plugin-skills` | user | skills with `source === 'plugin'` (not org, rule 5) grouped by `pluginId` (`null` → `(unknown plugin)`), bytes = Σ the group |
   | 13 | `interaction-tools` | built-in | built-in tools named `AskUserQuestion`, `Agent`, `ListAgents` |
   | 14 | `subagent-types` | built-in | every agent type, item = name |

7. **Row numbers.**
   - `bytes` = Σ measured item bytes, `null` when every item is unmeasured;
   - `tokens` = `Math.round(bytes / cpt)` (`null` with null bytes) — rounded once per row, never a
     sum of rounded items;
   - `share` = `tokens / denominator`, and 0 when `denominator` is 0;
   - the UI shows share with one decimal: `Math.round(share × 1000) / 10`.
8. **Snippets.** #1 and #13: `"permissions": { "deny": [<item names in row order, JSON-quoted>] }`;
   #2: the fixed deny of `PowerShell`; #3–#5: `ENABLE_CLAUDEAI_MCP_SERVERS=false`; #7: one
   `claude mcp remove <name> -s user` line per item; #8: `"autoMemoryEnabled": false`; #12:
   `"enabledPlugins": { "<id>": false, … }` without `(unknown plugin)` (a placeholder id when none is
   left). The other entries have no snippet.

## Edge cases

- Nothing matches → no rows, no button: SR-02, SR-09.
- `tools: null` → no tool entry: SR-03.
- No snapshot → #7's fallback, #10 and #12 do not match (configSource and skill source are null): SR-04.
- `configSource: null` with a snapshot → #7 with the user/local note; a `plugin_` server is skipped: SR-05.
- claude.ai stubs vs. signed-in names vs. instructions, a claude.ai server with no names: SR-06.
- A failed user server → 0 B in #7 and in #11, status `failed`: SR-07; a failed project server in #10: SR-01.
- Organisation skill with source `plugin` stays in #6; `pluginId: null` → `(unknown plugin)`: SR-08.
- `Bash` without `PowerShell` → no #2: SR-09.
- Equal bytes keep facts order; an `mcp__` tool never matches a built-in name: SR-10.
- Denominator 0 → share 0: SR-11.
- GS-05 golden mirror, including the `Bash` tool with a snapshot server: SR-GS05.

## Examples

Each row's `input` is a `StartupFacts` as above. `expected` lists only what it checks:
`ids` (row ids in order), `count` (= `ids.length`), `measuredTokens` (Σ row tokens) and `rows`,
a map from row id to a projection of that row; only the keys the expected row lists are compared:
`items` (`{name: bytes}`), `itemOrder` (item names in order), `statuses` / `notes`
(`{name: value}` for items that carry one), `note` (the row-level note, `null` when none), `bytes`, `tokens`, `sharePct`
(`Math.round(share × 1000) / 10`), `snippet`, `controller`, `docs` (the link URLs in order).

Rows (12): [`docs/algorithm-examples/startup-recommendations.json`](../../algorithm-examples/startup-recommendations.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Rows sorted by size instead of catalog order -> SR-01 (`ids` order), SR-GS05.
- Tokens summed from rounded items instead of rounded once per row -> SR-08 (#12: 24 + 6 = 30
  instead of 29), SR-10 (143 + 86 + 86 = 315 instead of 314).
- A claude.ai server's `instrBytes` also counted in #3/#4, or its `namesBytes` in #5 -> SR-06.
- A failed server keeps its `namesBytes` in #7 / #10 -> SR-07 (24 instead of 0).
- #12 does not skip organisation skills -> SR-08 (`anthropic-skills@claude` row item).
- `server` (snapshot) used as the built-in test -> SR-GS05 (`Bash` dropped, #2 unmatched).
- Item ties sorted by name -> SR-10 (`Artifact` before `Workflow`).
- Share divided by zero -> SR-11 (NaN instead of 0).

## Where the result is visible

Session pane → **System context anatomy** tab → **Recommendations** button with the row count
(`sysctx-reco-open`, badge `sysctx-reco-count`; shown only when there is at least one row) → the
modal: one row per match with ≈ tokens and share, "Controlled by", the explanation, the items and
the disable advice with a copy button.
