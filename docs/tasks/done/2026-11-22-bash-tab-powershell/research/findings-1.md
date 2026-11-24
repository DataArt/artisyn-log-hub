---
type: "Research"
title: "Plan research findings 1 — Shell tab with PowerShell"
description: "Verbatim research-subagent report for the plan of 2026-11-22-bash-tab-powershell (audit archive; the plan does not depend on it)."
---

## Context for the plan: Shell tab with PowerShell next to Bash

### Requirements summary
Rename the session tab to **Shell** (hint "Bash / PowerShell"). The tab id stays `bash` and the URL param stays `bashCall`; `powershell` becomes a search synonym. The tab lists Bash and PowerShell calls in one list, ordered by start time, with the same dedupe and numbering as today. Each row gets a `bash`/`pwsh` badge, and there is an All / Bash / PowerShell filter with counts. Both appear only when the session has calls of both shells. The filter lives in the URL param `shell`, with the rules in FR-4.

PowerShell calls get the full Bash-level view, driven by the `tree-sitter-powershell` 0.26.6 syntax tree:
- formatted script
- `Set-Location`/`cd`/`Push-Location` lifted into WORKING DIR
- here-string folding
- highlighting through its own capture map
- FILES summary from a closed cmdlet/alias table
- "changes N" chip and first-statement preview
- removal of the hook's `__lhWrap` prefix

This view applies everywhere `ToolCallView` is used. The Logs one-line summary, the Context Growth step label and the pill colour treat PowerShell like Bash.

On the server, the commit/PR counters and the OKF access extraction must count PowerShell too (FR-12, FR-13). No `'Bash'`-only check may be left without a stated reason (FR-14). Stored sessions get a backfill (FR-15). There are no route, hook or API changes. The WASM is lazy-loaded per grammar and ships in `dist/` for offline use.

Tests:
- **Algorithm:** a new doc `powershell-command-view.md`, its rows file and a table test.
- **PoC:** run over real commands.
- **Scenario:** extend `@S-SESS-14`, plus steps in the existing counter and OKF scenarios.

### Wireframes
- `wireframes/shell-tab-mixed-session.svg`
  - Tab bar shows `Shell 44` with the tooltip "Bash / PowerShell".
  - Filter chips read All 44 / Bash 27 / PowerShell 17.
  - Rows read `#n · time · ⏱ · [changes N] · [✗] · [agent badge]`, then a `bash`/`pwsh` badge before the preview.
  - Details pane: header `#4 PowerShell ✓ ok ≈212 tok ⏱ 1.7s`, then the description, WORKING DIR `server`, FILES (Changes `out/b.json`, `tmp/x (deleted)`; Reads `a.json`; Runs `npm run build`), then COMMAND with Formatted.
- `wireframes/shell-tab-filter-and-states.svg`
  - A: PowerShell filter on. Rows keep their numbers #2/#4/#6/#7/#9 and the tab count stays 44. The URL is `?tab=bash&shell=powershell&bashCall=…`.
  - B: Bash-only session. No filter and no badges; only the label changes.
  - C: empty state "No shell commands in this session".
  - Callouts in both SVGs still say "open question" about the param name and the badge. FR-3/FR-4 have since settled both.

### Knowledgebase
- `docs/knowledgebase/algorithms/bash-command-view.md` is the template for the new doc. Follow its sections: Code / Input and output / Rules (1 Parse: `hasError` → `ok=false` raw fallback; 2 Layout, whitespace-only with the token invariant 2.7; 3 `liftCd`; 4 heredoc fold, `HEREDOC_INLINE_MAX`=8; 5 `analyzeBash`; 6 `toRepoRelative`; 7 highlight capture→kind) / Edge cases / Examples (view rows and highlight rows, keys checked only when listed) / Mutations / Where visible. Rows live in `docs/algorithm-examples/bash-command-view.json` (110 rows) and use anonymised paths `/work/acme-app` and `C:\work\acme-app`.
- `docs/knowledgebase/algorithms/okf-access-extraction.md` maps Bash `readAccess` kinds `read`/`grep`/`list` and `changes` to ops (rules 3–4). Path resolution order is Bash `workDir`, then line `cwd`. PowerShell rows go into `docs/algorithm-examples/okf-access-extraction.json` (40 rows; the test uses the real server parser).
- `docs/knowledgebase/algorithms/cli-command-recognition.md` with `docs/algorithm-examples/cli-command-recognition.json`: PowerShell is recognised by a tokenizer, not a parser (see Open gaps).
- **No algorithm doc covers `countCommits` / `countPullRequests`.** Their only coverage is the golden `E.commits` / `E.pullRequests` check in S-SESS-01. So FR-12 cannot get algorithm rows without a new doc.
- `docs/knowledgebase/repo-local-packages.md` (§Docker, §rules lines 83–110):
  - A package never imports the parser runtime and uses structural types.
  - The runtime WASM is shipped by the consuming side (`scripts/copy-wasm.js`, Dockerfile, scenario stand).
  - Client consumes the package through an alias, the server through a `file:` dependency.
- `docs/knowledgebase/session-log-view.md`: §"Bash tab" (line 782) and §"Shared tool view" (around line 489, which describes the `forceFallback` branch). Both must be rewritten.
- `docs/knowledgebase/okf-usage.md`, line 83: `okf_extract_version` is written but read by nothing. Line 101: recompute runs only via `POST /api/v1/repositories/:repoId/recompute-all-sessions`.
- `docs/knowledgebase/tool-monitoring.md`, lines 118–140: the PowerShell wrapper (DD-14). It runs only in `bypassPermissions` since hook 2.32.2 and works through `updatedInput`.
- `docs/knowledgebase/twins-and-cross-cutting-rules.md` covers the server/client commit-counter twins. Read it before editing them.
- PoC convention: `docs/pocs/2026-10-22-2035-bash-pretty-format/` (`corpus.json`, `verify.mjs`, `bash-view.mjs`; 880/880 parse and token checks).

### Existing patterns
**Shared package `packages/bash-view/src/`**
- `syntax.ts:9-67` holds `BashSyntaxNode`/`Tree`/`Capture`, the `BashParser {parse, highlight}` interface and `withTree`. It is grammar-agnostic, so a PowerShell parser can implement the same interface.
- `bash-view.ts:44-92`: `buildBashView` composes format → `liftCd` → `foldHeredocs` → `analyzeBash` → `rel()`. Mirror it as `buildPowerShellView` returning the same `BashView` shape, so the list and the view stay unchanged.
- `bash-format.ts`: `WIDTH`=80 (line 18), `IND` (line 19), `formatBash` (262), `liftCd` (270), `foldHeredocs` (297).
- `bash-analyze.ts`:
  - `BashReadAccess` (91), `BashAnalysis {workDir, changes, reads, readAccess, runs, inline, unresolved}` (205), `analyzeBash` (295)
  - tables `W_CMDS` (25), `R_CMDS` (34), `SCRIPT_CMDS` (52, already contains `pwsh|powershell`), `SUBCOMMAND_TOOLS` (72), `RUN_SCRIPT_TOOLS` (74), `GREP_CMDS`/`LIST_CMDS` (78/80)
  - `displayGroups` (681)
- `bash-highlight.ts`: `bashHighlightQuery` (29, grammar scm plus a capture of ours), `CAPTURE_KIND` (34, Bash-specific), `HIGHLIGHT_CLASS` (48), `highlightBash` (62). `highlightBash` hard-wires `CAPTURE_KIND`, so it needs a map parameter or a PowerShell twin.
- `display-paths.ts:24`: `toRepoRelative` already handles `\`, drive letters and the msys form.
- `index.ts` re-exports every module. `README.md` and the KB list the modules.

**Client loader**
- `client/src/viewer/lib/bash-view/bash-parser.ts:26-81`: `createBashParser` / `loadBashParser`, a cached promise with retry. The error text is bash-specific.
- `client/src/viewer/lib/bash-view/browser-parser.ts:9-19`: Vite `?raw` scm, `?url` grammar and runtime WASM. Copy it for PowerShell. The cache is module-level, so a second module (or an assets-keyed cache) is needed for the "never download the other grammar" rule. `web-tree-sitter` runtime init (`Parser.init`) should be shared.
- `client/vite.config.ts:25-27`: `optimizeDeps.exclude: ['web-tree-sitter']`.
- `client/src/viewer/lib/bash-view/bash-view.algo.test.ts:78-88,115`: vitest that resolves the WASM and scm with `createRequire` and loads rows via `loadExamples`. A new `powershell-view.algo.test.ts` goes next to it.
- `client/package.json:41-42`: `tree-sitter-bash` 0.25.1 and `web-tree-sitter` 0.27.1, both pinned exactly. `server/package.json:60-61` is the same. There is no `trustedDependencies` or ignore-scripts config. `tree-sitter-bash` has the same `install: node-gyp-build` script.

**Client UI**
- `session-log/tool-call-view/useBashView.ts`: one parser per page (`loadParser` 23-34); `useLoadedParser(enabled)` (37); `useBashView(command, forceFallback)` (76); `useBashViews(rows)` (111). Needs per-shell selection: load the PowerShell parser only when a PowerShell row or call exists.
- `session-log/tool-call-view/ToolCallView.tsx:29-38`: the `PowerShell` → `forceFallback` branch, to be removed. The header already shows `⏱` for PowerShell (`isShell`, line 77). The tool badge is `getOtherToolStyle` plus `formatOtherToolName`.
- `session-log/tool-call-view/BashCommandView.tsx:65-83`: "Copy original" copies `commandOf(call.input)`, the raw stored text. FR-6a wants the prefix-stripped text there.
- `session-log/bash-tab/collect-bash-calls.ts:52`: `calls.filter((c) => c.name === 'Bash')`. `BashCallRow` (20) needs a `shell` field. Sort and numbering are at 104.
- `session-log/bash-tab/SessionBashTab.tsx:38-47`: empty state text. Selection fallback is at 49.
- `session-log/bash-tab/BashCallList.tsx`: `previewOf` (158), chip `view.files.changes.length` (206), `aria-label="Bash commands"` (198), and the row layout where the badge and filter go.
- `session-log/bash-tab/useBashCallParam.ts:4-27`: `bashCall` with `replace: true`. Use the same pattern for `shell`.
- `client/src/viewer/tab-ids.ts:269-275`: `id:'bash', label:'Bash'`, description, synonyms. The description is the tab tooltip (`SessionTabBar.tsx:28`).
- `SessionDetailPane.tsx:157-158`: `bashCount = collectBashCalls(...).length`. It feeds `SessionTabBar`, `nav-tree.ts:279` and `summary-cards.ts:134-139` (FR-11 follows automatically once the collector is fixed).
- `session-log/log-parser.ts:160`: `case 'Bash'` one-line summary (50-char cut).
- `session-log/charts/context-usage/step-label.ts:17`: `case 'Bash'` in `fullToolDetail`.
- `session-log/prompt-turn-helpers.tsx:67`: `getOtherToolStyle`, amber for `Bash` only.
- `session-log/usage/session-usage-derive.ts:120-131,481`: client twin of `countCommits`/`countPullRequests`, gated on `name === 'Bash'`.
- Already shell-aware, no change: `session-map/session-map.constants.ts:62-63`, `packages/recommendations/src/catalog.ts:103`.

**Server**
- `server/src/logs/okf/server-bash-parser.ts:24-95`:
  - `WASM_PACKAGE_PATHS`, `resolveWasm` (bundled `__dirname/wasm` first, then `require.resolve`)
  - grammar passed as bytes (jest CJS)
  - a cached `null` on failure, logged once
  - Mirror this as `server-powershell-parser.ts` and share the runtime init.
- Callers of `getServerBashParser` (from `ce`):
  - `okf-facts.service.ts:295` (`getFacts`)
  - `okf-access-writer.ts:148` (`rebuildSessionOkfAccess`)
  - `tool-monitoring/tool-usage-writer.ts:141` (`rewriteTreeToolUsage`)
- `server/src/logs/okf/okf-access-extractor.ts:279,364-401`: `accessesOfCall(name, input, cwd, roots, parser)` has a `case 'Bash'` that maps `analyzeBash` `readAccess`/`changes`/`workDir`. It needs a `case 'PowerShell'` with an analysis of the same shape and a second parser argument, or a parsers object.
- `server/src/logs/okf/okf-facts.service.ts:83-90,167-200`: `collectNodeFileFacts` has the same `case 'Bash'`, using reads, changes and runs.
- `server/src/logs/okf/okf-access-extractor.algo.spec.ts:4,20`: table test with the real server parser.
- `server/src/logs/claude-extractor.ts:1038-1044`: `name === 'Bash'` → `countCommits`/`countPullRequests`. `countCommits` and `countPullRequests` live in `tool-stats.ts:557-583`. The regex anchor `INVOCATION_START` is `(?:^|[\n;&|])\s*`.
  - **Gap for FR-12:** a PowerShell `& git commit` or `git.exe commit` would not match, and since the server and client copies are twins, the same applies to the client.
  - Stored in `session_stats.commit_count` / `pr_count` (`schema/index.ts:1190-1191`, `session-stats-writer.ts:83,118`).
- `server/src/logs/tool-monitoring/cli-command-recognition.ts:13-15,89`: the PowerShell tokenizer. `tool-usage-builder.ts:97-99` has `SHELL_TOOL_NAMES {Bash, PowerShell}`.
- `server/src/logs/builtin-tools.ts:15` lists `'Bash'` but not `'PowerShell'`. It mirrors the client `lib/tools/registry.ts` and has a drift test. Decide under FR-14.

**Backfill mechanisms**
- `server/src/database/database-init.ts:157-166`: at startup, `UPDATE sessions SET tool_usage_version = NULL WHERE tool_usage_version < TOOL_USAGE_EXTRACTOR_VERSION`. The rebuild queue is `tool-usage-rebuild.service.ts:160`. Automatic and version-gated.
- `database-init.ts:186-190` plus `backfill-session-list-flags.ts`: startup backfill pattern.
- `okf-constants.ts:14`: `OKF_EXTRACT_VERSION = 4`, written to `sessions.okf_extract_version` but read by nothing.
- `repositories.service.ts:1356`: `recomputeAllSessionStats` (session_stats plus `recomputeOkfAccess`), manual and per repo only. There is no automatic re-extraction for `session_stats` or OKF.

**Build and ship**
- `scripts/copy-wasm.js:14-17`: the `WASM_FILES` list. Add the PowerShell WASM here. Called from `scripts/build-assets.js:16,80` and `scripts/scenarios/build-stand.mjs:182-184`.
- `Dockerfile:40-44`: a hard-coded `cp …/tree-sitter-bash.wasm /app/dist/wasm/`. Add the PowerShell file. The client-build stage gets it through Vite `?url`.
- CSP `'wasm-unsafe-eval'` is already in place (see the executive-summary-report KB).

**Hook wrapper prefix (FR-6a)**
- `hook/.claude/telemetry_tool/tool-wrap-powershell.js:102-178`. The prefix is `WRAP_FUNCTION` (`function __lhWrap { param([string]$__t, …) …; $global:LASTEXITCODE = $__code }`) joined by `'; '`. Each tool adds `if (Get-Command -Name '<t>' -CommandType Application -ErrorAction SilentlyContinue) { Set-Item -LiteralPath 'function:<t>' -Value {…}; Set-Item -LiteralPath 'function:<t>.exe' -Value {…} }`. The whole prefix ends in `'; '` and is one line.
- Only one older shape exists: commit `4384029` (hook 2.28.0, fixture `tests/fixtures/legacy-hooks/2.28.0/`). It differs only inside the function body (`$__l.ToString()` instead of `ERR_TEXT`), so the structure is identical. The `2.32.3` fixture equals the current one.
- Nothing in the server or client strips `__lhWrap` today.

**Data (computed, read-only queries)**
Tool calls live in `logs.body` (a jsonb array of transcript lines) for `log_type IN ('claude','claude-subagent')`, as `message.content[] {type:'tool_use', name:'PowerShell', input:{command, description, timeout, run_in_background}}`. A PoC can pull every PowerShell command with:
```sql
FROM logs l CROSS JOIN LATERAL jsonb_array_elements(l.body) e
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'message'->'content')='array' THEN e->'message'->'content' ELSE '[]' END) b
WHERE l.log_type IN ('claude','claude-subagent') AND b->>'type'='tool_use' AND b->>'name'='PowerShell'
```
- The local dev DB has only 4 sessions and no PowerShell calls.
- A real-data Log Hub install has:

| Measure | Value |
|---|---|
| PowerShell calls | 1301 (344 sessions) |
| Bash calls | 31 810 (1922 sessions) |
| PowerShell stored commands starting with `function __lhWrap` | 0 |
| PowerShell stored commands containing `__lhWrap` anywhere | 0 |
| PowerShell commands with `&&` | 29 |
| PowerShell commands with `\|\|` | 14 |
| PowerShell commands with a here-string | 8 |
| PowerShell commands matching `git commit` | 14 |
| PowerShell commands matching `gh pr create` | 0 |
| PowerShell commands with a `description` | 1195 / 1301 |

**Scenarios**
- `tests/scenarios/view/s-sess-14.spec.ts`:
  - The fixture already has a main-session PowerShell call `{command:'Get-ChildItem'}` with id `${sid}-ps` (line 120).
  - The step at line 230 asserts it renders as raw fallback with no toggle (lines 248-255).
  - The Bash tab steps at 313-353 assert exactly 5 rows and ids `bashIds`, `session-bash-count` = 5, and the text "No Bash commands in this session".
  - All of these change: 6 rows and a mixed session.
  - The WASM request check is at 180-209 (regex `tree-sitter-bash[^/]*\.wasm`).
- `tests/scenarios/view/s-sess-01.spec.ts:158-159`: Commits / Pull requests counters from golden `tests/golden/gs-01-simple/expected.json`.
- `tests/scenarios/helpers/okf.ts:86-93,297-314`: `OkfAction` has a `bash` action (Bash only). It needs a `powershell` action for an FR-13 step. Candidate hosts: `s-sess-09` steps 7–11 or `s-repo-09`/`-11`/`-16`. No existing OKF scenario step reads a KB file through Bash.

### Open gaps
1. **FR-6a may be moot for transcripts.** 0 of 1301 real stored PowerShell commands carry the prefix. The transcript keeps the agent's original `tool_use.input`, and `updatedInput` is not written back. The PoC should confirm on a bypass-mode session with a wrapped tool. Even so, the requirement asks for recognition of both shapes, and they are structurally the same: one line, `function __lhWrap {…}; ` then `if (Get-Command -Name '<t>' …) { Set-Item … }; ` per tool.
2. **Commit/PR counters have no algorithm doc.** Decide whether to add one (`docs/knowledgebase/algorithms/commit-pr-counting.md` plus rows) or cover FR-12 with a scenario step only. The PowerShell spellings (`& git commit`, `git.exe commit`, `-and`/`-or`, `; if ($?) {…}`) are not matched by the current twin regexes.
3. **Backfill (FR-15) has no automatic mechanism** for `session_stats` or `session_okf_access`. Options:
   - bump `OKF_EXTRACT_VERSION` and add a startup requeue modelled on `TOOL_USAGE_EXTRACTOR_VERSION` / `database-init.ts:157` (nothing reads `okf_extract_version` yet)
   - a new stats version column
   - rely on the manual `recompute-all-sessions`

   If a migration is chosen, the `migrations-data-integrity` and `db-state-update` skills apply.
4. **Parser API shape.** `BashParser`/`BashSyntaxNode` are named for Bash but structurally generic. Decide whether to rename to `ShellParser` or add aliases (the server and the CLI recognizer import these names). Also decide how `accessesOfCall`, `collectNodeFileFacts` and `rewriteTreeToolUsage` receive two parsers. `highlightBash` hard-wires `CAPTURE_KIND`.
5. **Client lazy loading per grammar.** `useBashView.ts` has a single module-level `loading`. Design a per-shell loader that shares the runtime `Parser.init`, so a Bash-only session never fetches the PowerShell WASM. The scenario must assert the URL pattern `tree-sitter-powershell-<hash>.wasm`.
6. **`tree-sitter-powershell` is not installed** in client or server `node_modules`. Its WASM and scm file names, node types (`pipeline`, `command`, `command_name`, `command_parameter`, `generic_token` per notes.md), field names and capture names need checking in the PoC. So does the error-node rate for 5.1 vs 7 syntax (`&&`, `||`, ternary, `??`).
7. **CLI recognition** (`cli-command-recognition.ts`) still uses a tokenizer for PowerShell. Under FR-14 or the governing principle, decide whether it moves to the new parser (its rows file would change) or keeps a stated reason.
8. **`BUILTIN_TOOL_NAMES`** (server `builtin-tools.ts:15` and its client `registry.ts` mirror) has no `PowerShell`. Decide under FR-14.
9. **Licence scan** is GitHub `dependency-review` deny-licenses (`.github/workflows/security-scans.yml:367`, rows in `scripts/ci/scan-rows.js:202`). MIT passes, and no local config change was found to be needed.
