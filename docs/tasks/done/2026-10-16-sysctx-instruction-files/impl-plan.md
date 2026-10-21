# Implementation Plan — 2026-10-16-sysctx-instruction-files

## TL;DR

- Client-only change: System Context Files/Rules now come from the Claude log (`instructions` +
  `nested_memory` attachments), merged with the harness snapshot's `systemContext` (log wins, key =
  normalized path). No server, hook, DB, API or npm-dependency changes.
- New pure module `session-log/instruction-files.ts`: `toUserDisplayPath`, `classifyInstructionRole`,
  `extractInstructionFiles`, `rulesToInstructionFiles`, `mergeInstructionFiles`.
- New component `SystemContextFilesTab.tsx` (Files + Rules tables) split out of
  `SessionContextPanel.tsx` (already 22 KB, over the 20 KB component-size limit).
- `ClaudeMdFile` loses `content`, gains `role: 'user-md'`, `typeLabel`, `onDemand`; no file/rule
  text is shown anywhere in the panel or its modals (Rule modal "Body" tab removed).
- Side effect: Call Tree and Context Usage chart stop double-counting on-demand rules (they are
  already counted per turn via `rulesInjected`); user/local CLAUDE.md now count into System Files.
- Test: golden fixture GS-05 gains an `instructions` attachment; new step in
  `tests/scenarios/view/s-sess-03.spec.ts`.

## Reference

Requirements: [requirements.md](requirements.md)

## Design Decisions

- DD-1. `ClaudeMdFile.role` keeps the kind (`rule` vs file) and gains `'user-md'`; the displayed
  type comes from a new `typeLabel` (attachment `type` lowercased), falling back to the role for
  snapshot-only files (`local-md` → `local`, `user-md` → `user`, else `project`).
- DD-2. User-type paths are rewritten to `~/.claude/<rest after the first "/.claude/">` at extraction
  time, so they are never absolute and drop out of repo-root auto-detection by construction; the
  normalisation loop additionally skips paths starting with `~/`.
- DD-3. Merge runs after the path-normalisation block (`log-parser.ts:2774-2843`); key = path with
  `\` → `/`, lowercased. Order: snapshot entries first, then log entries overwrite (last
  `instructions` size wins); `totalBytes` = sum of merged `bytes`.
- DD-4. On-demand entries (`onDemand: true`) are derived from the already-built
  `turns[].rulesInjected` (no second `nested_memory` parser); `extractRulesInjected` is extended to
  keep the raw path and the attachment `content.type`.
- DD-5. Both modals are kept, metadata only (path, type, size, tokens, on-demand, modified) — they
  still show the full repo-relative path that the table shortens.
- DD-6. Files tab shows user paths as-is and applies `shortenClaudeMdPath` only over the non-user
  paths, so project paths stay repo-relative when a user-level file is present.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `client/src/viewer/pages/repository/session-log/types.ts` | `ClaudeMdFile` (`:362`), `RuleInjection` | add `'user-md'`, `typeLabel?`, `onDemand?`; remove `content`; `RuleInjection.type?: string` |
| `client/src/viewer/pages/repository/session-log/instruction-files.ts` | **new** pure helpers | extraction, user-path display, role, merge |
| `client/src/viewer/pages/repository/session-log/log-parser.ts` | parser wiring | `extractRulesInjected` (`:948`), summary block (`:2404-2427`), normalisation (`:2774-2843`); `classifyClaudeMdRole` (`:1733`) moves to the new module |
| `client/src/viewer/pages/repository/session-log/SystemContextFilesTab.tsx` | **new** Files + Rules tables | split out of the panel |
| `client/src/viewer/pages/repository/session-log/SessionContextPanel.tsx` | panel | use new component; drop inline tables (`:243-306`, `:485-527`) |
| `client/src/viewer/pages/repository/session-log/context-panel-helpers.ts` | helpers | add `instructionTypeMeta(file)` (label + color class) |
| `client/src/viewer/pages/repository/session-log/FileDetailModal.tsx` | file modal | type via `instructionTypeMeta`, add "Loaded: on demand" row |
| `client/src/viewer/pages/repository/session-log/RuleDetailModal.tsx` | rule modal | remove Body tab + "content is not captured" note, add type/on-demand rows |
| `client/src/viewer/pages/repository/session-log/call-tree/useCallTreeNodes.ts` | Call Tree system node (`:317`) | skip `onDemand` files |
| `client/src/viewer/pages/repository/session-log/charts/context-usage/context-data.ts` | Context Usage system slice (`:220-234`) | `user-md` into System Files; exclude `onDemand` files |
| `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl` | golden fixture | add one `instructions` attachment line |
| `tests/golden/gs-05-skills-rules-mcp-workflow/README.md` | fixture doc | describe the new attachment |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` | golden design (`:155`, `:429`) | add the three instruction files |
| `tests/scenarios/view/s-sess-03.spec.ts` | scenario | new step after step 8 |
| `docs/knowledgebase/session-log-view.md` | KB (`:26`, `:345` section) | System Context file sources + merge rule |
| `docs/knowledgebase/algorithms/harness-snapshot.md` | KB (`:10`, `:291`) | Files/Rules no longer snapshot-only |
| `docs/knowledgebase/client-component-map.md` | KB (`:277-283`, `:324`) | new component, modal descriptions, helper |
| `docs/knowledgebase/log-schema/claude-log-message-types.md` | KB (attachment samples, `:211`) | add `instructions` attachment sample |

## Test coverage plan

- **Scenario** (kind 3) — extends `tests/scenarios/view/s-sess-03.spec.ts` with step
  `8a. GS-05 System Context Files/Rules` on the extended GS-05 fixture: Files tab has 3 rows with
  types/sizes, no duplicate `CLAUDE.md`, user path is `~/.claude/CLAUDE.md`; Rules tab rows carry
  the on-demand mark; fixture texts are absent from the panel and the modals. Old-snapshot
  behaviour stays covered by step 8/9 (GS-01 has no snapshot, GS-05 still has one).
- No algorithm test: the touched parser code has no doc in `docs/knowledgebase/algorithms/`.
- No API contract change.

## Visual/UX notes

- Files tab columns unchanged (Path / Type / Size / Tokens); Type colors: `user` violet, `project`
  emerald, `local` orange, unknown muted. Files loaded on demand get a small muted `on demand`
  badge after the path.
- Rules tab: same badge after the name; rules from the initial context have none.
- Visual check via `use-playwright` on GS-05 (scenario stand) or a real session such as
  `ffff6666-6666-4666-8666-666666666666` (identify as its owner).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Parser: extract + merge instruction files | 7 | — |
| 2 | UI: panel, tabs, modals, consumers | 6 | depends on 1 |
| 3 | Fixture, scenario, docs | 5 | depends on 2 |

### Chunk 1 — Parser: extract + merge instruction files

- [x] In `session-log/types.ts` `ClaudeMdFile` (`:362`): set `role?: 'claude-md' | 'local-md' | 'user-md' | 'rule'`, add `typeLabel?: string` (lowercased attachment type) and `onDemand?: boolean`, delete `content`. In `RuleInjection` add `type?: string`. Fix every compile error this causes (e.g. `log-parser.ts:2424` content mapping — just drop it).
- [x] Create `session-log/instruction-files.ts` with `toUserDisplayPath(p)` (`\`→`/`; return `'~/.claude/' + text after the first '/.claude/'`, else `'~/' + basename`) and `classifyInstructionRole(path, type?)`: `rule` if path contains `.claude/rules/`, else `user-md` for type `user`, `local-md` for `local` or `CLAUDE.local.md` filename, else `claude-md` (case-insensitive). Move `classifyClaudeMdRole` (`log-parser.ts:1733`) callers onto it.
- [x] In `instruction-files.ts` add `extractInstructionFiles(events)`: for every attachment event with `attachment.type==='instructions'`, map each `files[]` entry `{path,type,content}` to `ClaudeMdFile {path (User → toUserDisplayPath), bytes: UTF-8 length of content, role: classifyInstructionRole, typeLabel: type lowercased}`; never keep content.
- [x] In `instruction-files.ts` add `rulesToInstructionFiles(rulesInjected: RuleInjection[])` → `ClaudeMdFile[]` with `path: r.path`, `bytes: r.bytes ?? 0`, `role: classifyInstructionRole(r.path, r.type)`, `typeLabel: r.type?.toLowerCase()`, `onDemand: true`; skip entries without `path`.
- [x] In `log-parser.ts` `extractRulesInjected` (`:948`): read `attachment.content.type`; set `type` on the result; when it is `User`, store `path` as `toUserDisplayPath(attachment.path)`. In the normalisation block (`:2828-2841`) skip any path starting with `~/` for both `turn.rulesInjected` and `claudeMd.files`.
- [x] In `instruction-files.ts` add `mergeInstructionFiles(lists: ClaudeMdFile[][])`: key `path.replace(/\\/g,'/').toLowerCase()`, later lists overwrite earlier entries, first-seen order kept.
- [x] In `log-parser.ts` summary block (`:2404-2427`) build three lists — snapshot files (no content), `extractInstructionFiles(events)`, `rulesToInstructionFiles(turns.flatMap(t=>t.rulesInjected))` — and normalise them in the existing block; after it set `claudeMd` from `mergeInstructionFiles` in that order (`totalBytes`=sum, `estTokens`=`Math.round(totalBytes/charsPerToken)`, undefined when empty). Update the DD-13 comment at `:2405`.

### Chunk 2 — UI: panel, tabs, modals, consumers

- [x] In `context-panel-helpers.ts` add `instructionTypeMeta(file: ClaudeMdFile): {label, cls}`: label = `file.typeLabel` ?? (`local-md`→`local`, `user-md`→`user`, else `project`); cls: user `text-violet-600 dark:text-violet-400`, project `text-emerald-600 dark:text-emerald-400`, local `text-orange-600 dark:text-orange-400`, other `text-muted-foreground`.
- [x] Create `session-log/SystemContextFilesTab.tsx` exporting `InstructionFilesTable({files, charsPerToken, onSelect})` and `RulesTable({files, charsPerToken, onSelect})`, moved from `SessionContextPanel.tsx:246-304` and `:488-525`. Rows: `data-testid="sysctx-file-row"`/`"sysctx-rule-row"`, `data-file-type={meta.label}`, `data-on-demand` when `onDemand`; show a muted `on demand` badge (`data-testid="sysctx-on-demand"`) after path/name. Type via `instructionTypeMeta`.
- [x] In `InstructionFilesTable` display path: if it starts with `~/` show as-is, else `shortenClaudeMdPath(path, nonUserPaths)` where `nonUserPaths` excludes `~/` paths. In `SessionContextPanel.tsx` replace the two inline tables with the new components; keep chips/`hasFiles`/`hasRules` logic (count = `claudeMdFiles.length` of the merged set).
- [x] `FileDetailModal.tsx`: replace the inline `roleMeta` (`:22-31`) with `instructionTypeMeta(file)`; add a "Loaded" row reading `on demand` when `file.onDemand`, else `initial context`. `RuleDetailModal.tsx`: delete the Tabs/Body branch and the "Rule file content is not captured" note (`:59-85`), render only the overview plus Type and Loaded rows; remove the unused Tabs import.
- [x] `call-tree/useCallTreeNodes.ts:317`: iterate only `files.filter((f) => !f.onDemand)` (on-demand ones are already per-turn rule rows). `charts/context-usage/context-data.ts:222-231`: System Files = roles `claude-md`/`local-md`/`user-md` and Rules = role `rule`, both excluding `onDemand` files.
- [x] Run the fast set (`adlc-lh:check-health`, `finalRun: false`); confirm `SessionContextPanel.tsx` is now under 20 KB (`wc -c`).

### Chunk 3 — Fixture, scenario, docs

- [x] In GS-05 `session.jsonl` insert after line 1 an attachment line (uuid `gs05-0000i`, `parentUuid` null, other fields as line 1): `{type:"instructions", files:[User "/home/golden/.claude/CLAUDE.md" 1050 B, Project "/work/repo-gold/CLAUDE.md" 3500 B, Local "/work/repo-gold/CLAUDE.local.md" 700 B containing "GS05-LOCAL-MARKER"]}`, ASCII content of exact length generated by a scratchpad Node script.
- [x] In `tests/scenarios/view/s-sess-03.spec.ts` add step `8a` after step 8 (GS-05 still open): Files tab → `sysctx-file-row` count 3, rows with `data-file-type` user/project/local whose text contains `~/.claude/CLAUDE.md` / `CLAUDE.md` / `CLAUDE.local.md` and the `formatBytes` sizes (read `log-parser.ts` `formatBytes` to hardcode strings); no row contains `/home/` or `/work/`.
- [x] Same step: Rules tab → 2 `sysctx-rule-row` (`db`, `ui`), each with `data-on-demand`/`sysctx-on-demand`; open the `db` row → dialog has no `Body` tab and does not contain `Use parameterised queries only`; Escape. Assert the panel does not contain `GS05-LOCAL-MARKER` nor `Use parameterised queries only`. Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03"`.
- [x] Update `tests/golden/gs-05-skills-rules-mcp-workflow/README.md` (new `instructions` attachment: user 1050 B, CLAUDE.md 3500 B duplicating the snapshot, local 700 B) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` GS-05 Context row (`:155`) and context-panel expectation (`:429`): three files, rules marked on demand.
- [x] Update KB: `session-log-view.md` (System Context section `:345` — sources, merge rule, no text shown), `algorithms/harness-snapshot.md` (`:10`, `:291` — Files/Rules also from the Claude log), `client-component-map.md` (`:277-283`, `:324` — new component, metadata-only modals, `instructionTypeMeta`), `log-schema/claude-log-message-types.md` (add an `instructions` attachment sample next to Sample 5).
