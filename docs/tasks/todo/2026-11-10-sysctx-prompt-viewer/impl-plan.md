# Implementation plan — System Prompt Viewer on the System Context Anatomy tab

## TL;DR

- Client-only change. No server, hook, route, DB or new npm package. `react-markdown` and `remark-gfm` are already in the entry bundle.
- New pure module `client/src/viewer/pages/repository/session-log/sysctx-anatomy/system-prompt-view.ts`. It exports `DYNAMIC_BOUNDARY_MARKER`, `hasPromptSnapshot`, `buildSystemPromptView` (never throws), `maskLocalPaths`, `partTitle`, `systemPromptViewToMarkdown` and `exportFileName`. It reuses `utf8`, `isObj`, `basename`, `blockText` and a new `startupBlockLines`, all newly exported from `sysctx-anatomy.ts`, plus a new constant `PROJECT_SLUG_PLACEHOLDER` in `sysctx-anatomy-constants.ts`.
- New modal components `SystemPromptModal.tsx`, `SystemPromptSections.tsx` and `SystemPromptItems.tsx`, next to the anatomy tab. They are imported statically by `SessionSysctxAnatomyTab.tsx`, so they ride the existing lazy session-tabs chunk and add no new `import()` target.
- New client helper `client/src/viewer/lib/download-text-file.ts`. It is the first browser-built Blob download.
- Privacy: absolute local paths are masked on the parsed model (DD 6). The anatomy tab itself still renders no prompt text.
- Tests:
  - New algorithm doc `system-prompt-view.md`, rows file and `system-prompt-view.algo.test.ts`.
  - GS-05 fixture extended: startup snapshot gets a boundary marker, a session part and flags; a late `tools` snapshot is added. The anatomy numbers move: system-prompt 3150 B / 900 tok, attributed 2929, internals 5871, hint 66.7 % — in `expected.json`, the GS-05 README and row `SA-GS05` of `docs/algorithm-examples/sysctx-anatomy.json`.
  - `tests/golden/check-arithmetic.mjs` re-derives a new `expected.json` block `systemPromptView`.
  - New `s-sess-03` step 8a2 (with a `GoldenSystemPromptView` type), plus a negative assertion in step 8d. The scenario design doc `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` follows.
- Docs: `sysctx-anatomy-tab.md` (modal exception to "no text in the DOM", test ids), `log-schema/attachment-types.md` (`prompt_snapshot` notes), `user-docs/session-log.md`, algorithms README and KB index.

## Reference

Requirements: [requirements.md](requirements.md) (GH-123). Research trail: `research/findings-1.md`.

Dev DB check (2026-11-11), `logs.log_type = 'claude'`:
- 275 of 1126 transcripts have `prompt_snapshot`, written by Claude Code 2.1.280–2.1.314, with at most 3 snapshots per session.
- In all 275, the first snapshot has no `tools`; 274 have a later snapshot with tools, and 274 have the boundary marker.
- No snapshot is in a sidechain. Every `systemPrompt` is an array of strings.
- Snapshot keys match the `attachment-types.md` list plus `type`. Tool keys are `name`, `description`, `schema` and `server`.
- Tool sets range from 11 to 132 tools, up to 337 K chars of JSON in one session.
- Absolute paths appear in 270 tool descriptions and in about 2 parts per snapshot.

## Design Decisions

1. **Snapshot selection.** All selection skips lines with `isSidechain === true`.
   - A *snapshot line* is a `main` line with `type === 'attachment'`, an object `attachment` and `attachment.type === 'prompt_snapshot'`.
   - `hasPromptSnapshot(main)` is true when any snapshot line exists.
   - The **startup snapshot** is the first snapshot line inside the startup block (the anatomy's rule 2/9 block, via the extracted `startupBlockLines`). If the block has none, it is the first snapshot line anywhere in `main`, so the button never opens an empty view.
   - The **tools snapshot** is the first snapshot line anywhere in `main` whose `tools` is a non-empty array.
   - Every other snapshot is ignored.
2. **Shared helpers, no twins.** `sysctx-anatomy.ts` exports its private `utf8`, `isObj`, `basename` and `blockText`, and a new `startupBlockLines(main)`. `startupBlockLines` is extracted from `buildSysctxAnatomy` lines 392–398 (anchor cut + sidechain filter); `buildSysctxAnatomy` then calls it, with no behaviour change. The new module imports these.
3. **Sizes and tokens.**
   - All sizes are taken from the **raw** (unmasked) text, so a part's bytes equal its anatomy "Block n" row.
   - A part's bytes are `utf8(blockText(part))`.
   - A tool's bytes are `utf8(name ?? '') + utf8(description ?? '') + utf8(JSON.stringify(schema))`, with the schema term 0 when there is no schema.
   - Item tokens are `Math.round(bytes / cpt)`.
   - Section and header token totals are `Math.round(sumBytes / cpt)`, not a sum of rounded values.
   - `totals.parts = prompt.parts.length`, `totals.tools = tools.items.length`, `totals.bytes = prompt.bytes + tools.bytes` and `totals.tokens = Math.round(totals.bytes / cpt)`.
   - `PromptPartItem.index` is the part's 1-based position in the raw `systemPrompt` array, counting the marker and skipped parts, so it equals the anatomy "Block n" number. GS-05: `# Environment` is index 4. `ToolItem.index` is the 1-based position in `tools`.
   - `cpt` is passed in by the tab as `anatomy.cpt`.
   - Tool share is `bytes / toolsBytes × 100`, shown with `toFixed(1)` plus ` %`.
   - The boundary marker and the flags are excluded from every size.
4. **Boundary split.**
   - The marker is a part whose trimmed text equals `DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'` (34 B).
   - Parts before the first marker are in group `shared` and parts after it in group `session`. Further markers are dropped.
   - With no marker, every part has `group: null` and `grouped: false`.
   - A part whose `blockText` is empty after `trim()` is skipped. A group with no parts is not rendered.
5. **Part title** (`partTitle(maskedText)`).
   - If the text has a heading line (`/^#{1,6}\s+\S/`, ignoring lines inside ``` fences), the title is the first such line, trimmed, with `#`s kept (e.g. `# Environment`).
   - Otherwise the title is the first 8 whitespace-separated words of the first non-empty line, plus `…` when that line has more words.
   - The title is capped at 80 chars (cut and add `…`). An empty text gets `(empty part)`.
   - Unnamed tools are titled `(unnamed tool #n)`, with n 1-based in snapshot order.
6. **Path masking.** `maskLocalPaths(text, repoRoot)` is applied once to every display string: part text, tool name and description, every string value inside the schema (walked deeply, keys untouched, **before** `JSON.stringify(masked, null, 2)`), and flag values (scalars and strings inside objects).
   - Constants: import `OUTSIDE_PATH_PREFIX` (`'<outside>/'`, `sysctx-anatomy-constants.ts:122`); add `export const PROJECT_SLUG_PLACEHOLDER = '<project-slug>'` to the same file.
   - `displayPathOf` (`sysctx-anatomy.ts:282`) is not reused: it maps one whole known path, while masking must find paths inside free text and apply the `.claude` rewrite.

   It runs in two passes:
   - **Pass 1, repoRoot.** Only when `repoRoot` is non-empty. Build a regex from `repoRoot` with regex specials escaped and each `\` or `/` replaced by `[\\/]`, flag `i`, trailing separators trimmed, prefixed by the pass-2 lookbehind `(?<![\w.~\/\\])` (so `/home/x/work/repo` does not match root `/work/repo`). The root must be followed by a separator or a terminator, and the rest of the path is consumed as `[^\s'"`)\]}>]*`. Replace with the remainder: leading separator removed, `\` turned into `/`, or `.` when the remainder is empty. Spaces inside `repoRoot` match literally.
   - **Pass 2, other absolute paths.** Regex `/(?<![\w.~\/\\])(?:[A-Za-z]:[\\\/]|\/(?:Users|home|tmp|var|opt|mnt)\/)[^\s'"`)\]}>]*/g`. Strip trailing `.,;:!?` from each match (they stay in the text). Then, after `\` → `/`:
     - if the path contains `/.claude/`, it becomes `~/.claude/` + the rest after the first `/.claude/`, with `projects/<segment>` replaced by `projects/` + `PROJECT_SLUG_PLACEHOLDER`;
     - otherwise it becomes `OUTSIDE_PATH_PREFIX + basename` (trailing `/` stripped first; `<outside>` alone when the basename is empty).
   - There is no `KNOWN_TOP_LEVEL_DIRS` fallback, because the NFR does not list it and `<outside>` is the safe default.
   - Known limitation: the match stops at a space, so `C:\Program Files\x` masks only `C:\Program`.
7. **Flags.**
   - The flags are every own key of the startup snapshot, in object order, except `systemPrompt`, `tools`, `rendered` and `type`. `type` is the attachment discriminator (`prompt_snapshot`), not a Claude Code flag.
   - Strings are shown masked as-is. Numbers, booleans and null are shown with `String(v)`.
   - Objects and arrays are deep-masked, then shown as `JSON.stringify(v, null, 2)` with `isObject: true`.
8. **Malformed input.**
   - `buildSystemPromptView` wraps everything in try/catch. On a throw it returns an empty view with `error: 'Could not read the system prompt snapshot'`.
   - A non-array `systemPrompt` gives `prompt.status: 'unrecognised'`; no startup snapshot gives `'missing'`.
   - No tools snapshot gives `tools.status: 'none'`.
   - A tool's schema is `schema ?? input_schema`; non-object tool entries are treated as `{}`.
   - A tool's optional string `server` (the MCP server name; seen on 98 tool rows in the dev DB, e.g. `postgres`, `playwright`, `idea`) is kept as `ToolItem.server` (masked, `null` when absent or not a string). It is shown as a badge, not counted in the tool's bytes (DD 3), and written as `## <name> · server <server>` in the export.
9. **Module contract.** Exported from `system-prompt-view.ts`; later chunks build against it:
   ```ts
   export const DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
   export type PromptGroup = 'shared' | 'session';
   export interface PromptPartItem { index: number; title: string; text: string; bytes: number; tokens: number; group: PromptGroup | null }
   export interface ToolItem { index: number; name: string; server: string | null; description: string | null; schemaJson: string | null; bytes: number; tokens: number; share: number }
   export interface FlagItem { key: string; value: string; isObject: boolean }
   export interface SystemPromptView {
     prompt: { status: 'ok' | 'unrecognised' | 'missing'; parts: PromptPartItem[]; grouped: boolean; bytes: number; tokens: number };
     tools: { status: 'ok' | 'none'; items: ToolItem[]; bytes: number; tokens: number };
     flags: FlagItem[];
     totals: { parts: number; tools: number; bytes: number; tokens: number };
     error: string | null;
   }
   export function hasPromptSnapshot(main: Record<string, unknown>[]): boolean;
   export function buildSystemPromptView(input: { main: Record<string, unknown>[]; repoRoot: string; cpt: number }): SystemPromptView;
   export function maskLocalPaths(text: string, repoRoot: string): string;
   export function partTitle(text: string): string;
   export function systemPromptViewToMarkdown(view: SystemPromptView): string;
   export function exportFileName(main: Record<string, unknown>[]): string; // `system-prompt-<first string sessionId>.md`, else `system-prompt.md`
   ```
   `text`, `description`, `schemaJson`, `value` and `title` are already masked. `share` is a number from 0 to 100, unrounded.
10. **Markdown export** (`systemPromptViewToMarkdown`). Sections are separated by blank lines.
    - `# System prompt`.
    - When grouped, `## Shared` and `## Session-specific` headings come before their parts.
    - Each part is `### Part <index> · <bytes> B` followed by its text verbatim.
    - `# Tool definitions`, then per tool `## <name>`, the description (or `_no description_`) and, when there is a schema, a fenced `json` block. The fence is one backtick longer than the longest backtick run in the content, at least 3.
    - `# Flags`, then per flag `- \`key\`: value`; object values are a fenced `json` block under the bullet.
    - Empty or failure states write the same message lines as the modal (DD 12).
11. **Modal tab state is local** (`useState`, default `prompt`), as in `WorkflowAgentModal.tsx:53-101`. The client.md URL rule covers page and panel tabs, not a transient modal.
12. **UI strings and test ids** (shared by chunks 2, 3 and 5):

    | Element | Text | `data-testid` |
    |---|---|---|
    | Button on the tab | `View system prompt` (lucide `FileText`) | `sysprompt-open` |
    | Dialog content | title `System prompt`; sub-line `Captured by Claude Code (prompt_snapshot). Internal, undocumented format — may change in any release.` | `sysprompt-modal` |
    | Header totals | `${parts} parts · ${tools} tools · ${B} B · ≈ ${tok} tokens` | `sysprompt-totals` |
    | Copy button | `Copy as Markdown` / `Copied` | `sysprompt-copy` |
    | Download button | `Download .md` | `sysprompt-download` |
    | Tab triggers | `System prompt` / `Tool definitions` / `Flags` | `sysprompt-tab-prompt` / `-tools` / `-flags` |
    | Tab panels | — | `sysprompt-panel-prompt` / `-tools` / `-flags` |
    | Tab toolbar line | prompt: `${n} parts · ${B} B · ≈ ${tok} tok`; flags: `${n} keys` | `sysprompt-toolbar` |
    | Tools summary line | `${n} tools · ${B} B · ≈ ${tok} tokens — counted in Harness internals on the anatomy tab` | `sysprompt-tools-summary` |
    | Expand / collapse all | `Expand all` / `Collapse all` | `sysprompt-expand-all` / `sysprompt-collapse-all` |
    | Group header | `Shared · ${n} parts` / `Session-specific · ${n} parts` (uppercase via CSS) | `sysprompt-group` + `data-group` |
    | Item row | prompt right side `${B} B · ≈ ${tok} tok`; tool right side `${B} B · ${share} %`; a tool with `server` shows a `Badge` `MCP · ${server}` after its name | `sysprompt-item` + `data-section` (`shared`/`session`/`ungrouped`/`tool`/`flag`) + `data-expanded` |
    | Item body | Markdown, or a JSON block with a `json` tag | `sysprompt-item-body` |
    | Empty / format / error lines | `No tool definitions in this session` · `System prompt not in a recognised format` · `No system prompt parts` · `No flags` · `no description` · error text from DD 8 | `sysprompt-empty` / `sysprompt-error` |

    Numbers use `fmtInt` from `AnatomyCells.tsx`.
13. **Expand state.** One `Set<string>` of expanded item keys per tab, held in the modal. Keys are `part-<index>`, `tool-<index>` and `flag-<key>`. An item's body element mounts **only** while expanded, so about 150 K chars are never rendered at once. Expand all and Collapse all replace the tab's Set. On the Flags tab every flag is one `sysprompt-item` row with `data-section="flag"`: a scalar flag shows its value inline and is not expandable (no chevron, no `data-expanded`); an object flag shows a one-line `{…}` preview and expands into a `JsonBlock`. Flags Expand all / Collapse all affect object flags only.
14. **Markdown rendering.** Use `<ReactMarkdown remarkPlugins={[remarkGfm]}>` inside `prose prose-sm max-w-none` (as `HelpModal.tsx:164,178`). Never add `rehype-raw`: react-markdown 10 renders raw HTML as text by default (`client/node_modules/react-markdown/lib/index.js:360`).
15. **Lazy loading and parse timing.** The tab computes only `useMemo(() => hasPromptSnapshot(mainLogs ?? []))`. The modal is rendered only while open, and calls `buildSystemPromptView` in its own `useMemo`. `SessionSysctxAnatomyTab` is already in the `session-tabs-lazy-group.ts` chunk, so the static import keeps the `import()` count at 9.
16. **No button caption.** The wireframe's "4 snapshots · 14 parts · 18 tools" caption is dropped, because it would need a parse in the tab (DD 15) and no FR asks for it.
17. **GS-05 fixture contract** (chunk 4 writes it, chunk 5 asserts it).
    - The startup snapshot (`gs05-0000p`, line 2) gets two new `systemPrompt` parts after the existing two:
      - `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"`;
      - the exact 316-byte part `"# Environment\nWorking directory: /work/repo-gold/src\nUser memory: /home/dev/.claude/projects/-work-repo-gold/memory/MEMORY.md\nScratchpad: /tmp/gs05-scratch/notes.txt\nGS05-SESSION-MARKER "` followed by 130 `x`.
    - The startup snapshot also gets the flags `cliPrefix: "gs05"`, `reminderFold: true`, `contextRendering: "announced"` (real flags are scalars — see `attachment-types.md` § Shape details) and an invented object flag `gs05Extra: {"mode":"compact","cwd":"/work/repo-gold"}`, which tests the FR-9 "unknown keys / objects" path.
    - A new non-sidechain attachment line `gs05-0003p` (`prompt_snapshot`) is inserted right after line 11 (`gs05-0003`, the first assistant line with usage). Its envelope is copied from line 2 (`parentUuid: null`, same `sessionId`, `userType`, `entrypoint`, `cwd`, `gitBranch`, `version`, `isSidechain: false`) with `timestamp` equal to line 11's; no other line's `parentUuid` changes. It holds:
      - `systemPrompt: ["GS05-LATE-PART"]` and `cliPrefix: "gs05-late"`;
      - tool `Read`: description `"Reads a file.\n\n| Param | Meaning |\n|---|---|\n| file_path | absolute, e.g. /home/dev/notes.md |\n\nGS05-TOOL-MARKER <system-reminder>stays text</system-reminder>"`, `schema` `{"type":"object","properties":{"file_path":{"type":"string","description":"Example: C:\\Users\\dev\\file.txt"}},"required":["file_path"]}`;
      - tool `Bash`: description `"Runs a command."`, `input_schema` `{"type":"object","properties":{"command":{"type":"string"}}}`, `server: "gs05-mcp"`.
    - The anatomy system-prompt drill-down gains rows `Block 3` (34 B, 10 tok) and `Block 4` (316 B, 90 tok).
    - Anatomy moves (computed): system-prompt 2800 + 34 + 316 = **3150 B → 900 tok**, attributed 2829 − 800 + 900 = **2929**, harnessInternals 8800 − 2929 = **5871**, internals share 5871 / 8800 = **66.7 %** (step 8 hint literal, was 67.9 %).
    - The modal shows 3 parts (shared 2: `You are a coding assistant working in the…` and `# Memory`; session 1: `# Environment`), parts bytes 2800 + 700 + 316 = **3816**, and 2 tools.
    - Masked expectations:
      - `/work/repo-gold/src` → `src`;
      - `/home/dev/.claude/projects/-work-repo-gold/memory/MEMORY.md` → `~/.claude/projects/<project-slug>/memory/MEMORY.md`;
      - `/tmp/gs05-scratch/notes.txt` → `<outside>/notes.txt`;
      - `/home/dev/notes.md` → `<outside>/notes.md`;
      - `C:\Users\dev\file.txt` → `<outside>/file.txt`;
      - `gs05Extra.cwd` → `.`.
    - Tool bytes and the totals are computed at implementation time and recorded in the new `expected.json` block `roots[0].systemPromptView`:
      ```json
      {"$comment": "…", "charsPerToken": 3.5, "parts": 3, "shared": 2, "session": 1, "partsBytes": 3816, "partsTokens": 1090, "tools": 2, "toolsBytes": <n>, "toolsTokens": <n>, "totalBytes": <n>, "totalTokens": <n>}
      ```
      `partsTokens` = round(3816 / 3.5) = 1090. `check-arithmetic.mjs` re-derives the block.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/sysctx-anatomy.ts` | export helpers | DD 2; no behaviour change |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/system-prompt-view.ts` | **new** pure module | DD 1–10 |
| `client/src/viewer/lib/download-text-file.ts` | **new** `downloadTextFile(name, text)` | Blob `text/markdown;charset=utf-8` → object URL → `<a download>` click → `setTimeout(() => URL.revokeObjectURL(url), 0)` |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/SystemPromptItems.tsx` | **new** `PromptItemRow`, `MarkdownBody`, `JsonBlock` | DD 12–14 |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/SystemPromptSections.tsx` | **new** `PromptSection`, `ToolsSection`, `FlagsSection`, `SectionToolbar` | DD 4, 7, 12, 13 |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/SystemPromptModal.tsx` | **new** Dialog, header, totals, copy/download, Tabs | DD 11, 12, 15 |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/SessionSysctxAnatomyTab.tsx` | button + modal mount | DD 15; header comment updated |
| `docs/knowledgebase/algorithms/system-prompt-view.md` | **new** algorithm doc | README sections, `reviewed: no` |
| `docs/algorithm-examples/system-prompt-view.json` | **new** rows file | rows per Test coverage plan |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/system-prompt-view.algo.test.ts` | **new** vitest table test | template `sysctx-anatomy.algo.test.ts:1-60` |
| `docs/knowledgebase/algorithms/README.md` | Docs table row | after line 61 |
| `docs/knowledgebase/index.md` | KB index line | "Tests and algorithm docs" section, near line 104 |
| `docs/knowledgebase/sysctx-anatomy-tab.md` | Files, test ids, modal exception to "no text in the DOM" | — |
| `docs/knowledgebase/log-schema/attachment-types.md` | `prompt_snapshot` notes | boundary marker, late `tools` snapshot, viewer link |
| `user-docs/session-log.md` | § System context anatomy (line 271) | "View system prompt" paragraph |
| `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl` | fixture extension | DD 17 |
| `tests/golden/gs-05-skills-rules-mcp-workflow/expected.json` | anatomy numbers + `systemPromptView` block | DD 17 |
| `client/src/viewer/pages/repository/session-log/sysctx-anatomy/sysctx-anatomy-constants.ts` | add `PROJECT_SLUG_PLACEHOLDER` | DD 6 |
| `tests/golden/gs-05-skills-rules-mcp-workflow/README.md` | numbers + new lines | DD 17 |
| `tests/golden/check-arithmetic.mjs` | re-derive `systemPromptView` | next to `startupAnatomy` (:243) |
| `docs/algorithm-examples/sysctx-anatomy.json` | row `SA-GS05` (:311) mirrors the fixture | DD 17 numbers |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` | scenario design doc | anatomy numbers near line 380 (900, 5,871), step 8a2 entry, 8d negative (lines 369–382) |
| `tests/scenarios/view/s-sess-03.spec.ts` | step 8 hint literal, new step 8a2, step 8d negative, header comment | — |

## Test coverage plan

- **Algorithm** (new algorithm doc + rows file + table test; allowed because the doc is new). Rows in `docs/algorithm-examples/system-prompt-view.json`, ids `SPV-xx`. The test dispatches on the input key:
  - `input.view` = `{main, repoRoot, cpt}` → a projection of `SystemPromptView`. Each row's `expected` lists only the top-level keys it checks (`prompt`, `tools`, `flags`, `totals`, `error`), and the test compares each listed key in full. For `prompt.parts`, `text` is checked only when the row gives it (masking rows), so `$fill` parts need not echo their text;
  - `input.mask` = `{text, repoRoot}` → string;
  - `input.title` = text → string;
  - `input.has` = main → boolean;
  - `input.markdown` = view input → exact markdown string.

  Rows cover:
  - boundary split; no marker; several markers; empty part and empty group;
  - part payload shapes (string, `.text`, object → JSON);
  - title rules (heading, `#` kept, heading inside a fence ignored, first 8 words + `…`, 80-char cap);
  - non-array `systemPrompt`;
  - startup snapshot inside the block, and the fallback when the block has none;
  - tools snapshot after the first assistant line; sidechain snapshot skipped; later snapshots ignored;
  - tool edge cases (unnamed, `input_schema`, no schema, no description, `server` present / non-string, `server` not in bytes);
  - sizes, item and total tokens (round of sum), share;
  - flags (exclusions incl. `type`, object JSON, masked values);
  - masking (repoRoot with backslashes, mixed case and spaces; root itself → `.`; `.claude/projects/<slug>`; `<outside>/basename`; trailing punctuation; URL not matched; schema strings masked while keys stay);
  - `hasPromptSnapshot` true/false/sidechain-only;
  - one markdown-export row.

  Large texts use the `$fill` convention.
- **Algorithm, existing:** row `SA-GS05` in `docs/algorithm-examples/sysctx-anatomy.json` is updated to the extended startup snapshot (DD 17 numbers). The golden arithmetic build-script check (`tests/golden/check-arithmetic.mjs` via `scripts/__tests__/golden-arithmetic.test.js`) re-derives the GS-05 `systemPromptView` block.
- **Scenario** (extends `tests/scenarios/view/s-sess-03.spec.ts`; no new file):
  - step 8 gets the moved anatomy numbers (from `expected.json`) and the hint literal `66.7 %`;
  - new step `8a2` covers AC-1 to AC-9 on GS-05;
  - step 8d (inline session without a snapshot) asserts `sysprompt-open` has count 0 (AC-1 negative).
- **API contract:** none — no route changes.

## Visual/UX notes

- Light theme only. Use existing `ui/dialog`, `ui/tabs` and `ui/button` (outline, size `sm`). Invoke the `ui-components` skill before writing the UI.
- **Button:** outline `sm`, to the right of the anatomy `Header`. Wrap both in `flex items-start gap-4` so the button is not pushed 1000 px away (client.md § spacing).
- **Dialog:** `w-[90vw] max-w-[1100px] h-[85vh] flex flex-col`. The header holds the title, a muted sub-line, totals (`tabular-nums`) and the Copy / Download buttons. Tabs come below, and each panel is `flex-1 min-h-0 overflow-auto`.
- **Item row:** a full-width button with a `ChevronRight` that rotates 90° when expanded, a truncated title on the left, and a muted `tabular-nums` size on the right. An expanded row has an `border-indigo-300` border and an `bg-indigo-50` header. The body has `p-3`.
- **JSON block:** `pre` with `text-xs font-mono bg-muted rounded p-3 overflow-auto` and a small `json` tag badge. The tool body has `DESCRIPTION` and `INPUT SCHEMA` sub-labels (`text-[10px] uppercase tracking-wide text-muted-foreground`).
- **Group header:** `text-[11px] font-semibold uppercase tracking-wide text-muted-foreground`.
- **Flags:** a two-column key/value list, with the key in `font-mono`.

## Wireframes

No wireframe edits needed. The implementation deviates from the SVGs as follows:

- `anatomy-tab-button.svg`: the no-snapshot variant is "no button", per FR-1/FR-7; there is no caption (DD 16).
- `sysprompt-modal-tools-flags.svg`: tool sizes are in B with a one-decimal % (DD 3), not KB and whole %; Flags expand/collapse applies to object values only (DD 13).
- The SVG numbers are illustrative (cpt 3.7 and 2.7).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Pure view module | 6 | client sysctx-anatomy dir; no UI |
| 2 | Modal components + tab mount | 7 | builds on chunk 1 contract (DD 9) |
| 3 | Algorithm doc, rows, table test + KB/user docs | 8 | tests chunk 1; docs describe chunk 2 UI (chunks run in order) |
| 4 | GS-05 fixture + golden arithmetic | 6 | data for chunk 5 |
| 5 | Scenario steps | 7 | asserts chunks 2–4 on the stand |

### Chunk 1 — Pure view module
- [ ] In `sysctx-anatomy.ts`, export `utf8`, `isObj`, `basename` and `blockText`. Extract lines 392–398 into exported `startupBlockLines(main)`, returning the sidechain-filtered startup-block lines, and call it from `buildSysctxAnatomy` (DD 2).
- [ ] Add `PROJECT_SLUG_PLACEHOLDER` to `sysctx-anatomy-constants.ts` (DD 6). Create `system-prompt-view.ts` with the types and constants of DD 9, plus `hasPromptSnapshot` and snapshot selection per DD 1. In the module header comment, describe the observed shape: the startup snapshot has no tools, a later one does, there is a boundary marker, and `tools[].server` exists. Link to `log-schema/attachment-types.md` § Shape details. Add a JSDoc on `ToolItem.server`.
- [ ] Implement `maskLocalPaths(text, repoRoot)` per DD 6, and a private deep-mask for schema and flag values (string values only, keys untouched).
- [ ] Implement `partTitle` per DD 5, and the boundary split, skip and group rules per DD 4.
- [ ] Implement `buildSystemPromptView` per DD 3, 7, 8 and 9: sizes from raw text, masked display fields, tools, flags, totals, and the try/catch error view.
- [ ] Implement `systemPromptViewToMarkdown` per DD 10, and `exportFileName` per DD 9.

### Chunk 2 — Modal components + tab mount
- [ ] Create `client/src/viewer/lib/download-text-file.ts` exporting `downloadTextFile(fileName: string, text: string): void`: Blob type `text/markdown;charset=utf-8`, object URL, temporary `<a download>`, click, then revoke in `setTimeout(…, 0)`.
- [ ] Create `SystemPromptItems.tsx` with `PromptItemRow`, `MarkdownBody` (DD 14) and `JsonBlock`. `PromptItemRow` takes `title`, `meta`, `section`, `expandable`, `expanded`, `onToggle` and `children`, and mounts children only when expanded. Styles and test ids per Visual/UX notes and DD 12.
- [ ] Create `SystemPromptSections.tsx`:
  - `SectionToolbar` (summary text, Expand all, Collapse all);
  - `PromptSection` (groups or ungrouped list, status messages);
  - `ToolsSection` (summary line, DESCRIPTION Markdown, INPUT SCHEMA `JsonBlock`, `no description`);
  - `FlagsSection` (DD 7, 13).

  Each takes its view slice plus `expanded: Set<string>` and `setExpanded`.
- [ ] Create `SystemPromptModal.tsx` (props `open`, `onOpenChange`, `main`, `repoRoot`, `cpt`):
  - memoised `buildSystemPromptView` and `systemPromptViewToMarkdown`;
  - header and totals per DD 12;
  - Copy via `useCopyToClipboard(markdown)`, Download via `downloadTextFile(exportFileName(main), markdown)`;
  - local tab state (DD 11);
  - one expanded Set per tab;
  - error line when `view.error` is set.
- [ ] In `SessionSysctxAnatomyTab.tsx`, add `useMemo(() => hasPromptSnapshot(mainLogs ?? []), [mainLogs])` and `useState(false)` for `promptOpen`. Render the `sysprompt-open` button beside `Header` only when true. Mount `SystemPromptModal` only while open, with `main={mainLogs ?? []}`, `repoRoot` and `cpt={anatomy.cpt}` (DD 15).
- [ ] Update the `SessionSysctxAnatomyTab.tsx` header comment: the tab DOM still holds no prompt text, and prompt text appears only inside the on-demand modal.
- [ ] Keep each new `.tsx` under 10 KB. If `SystemPromptSections.tsx` exceeds it, move `FlagsSection` into `SystemPromptFlags.tsx`.

### Chunk 3 — Algorithm doc, rows, table test + KB/user docs
- [ ] Create `docs/knowledgebase/algorithms/system-prompt-view.md` with front matter `reviewed: no`, `reviewer: none`. Sections: Purpose, Code, Rules (DD 1–10 as numbered rules), Edge cases, Examples (the input-key formats from Test coverage plan), Mutations and Where visible.
- [ ] Create `docs/algorithm-examples/system-prompt-view.json` with `SPV-xx` rows `{id, input, expected, note}` covering every bullet of Test coverage plan → Algorithm, including a pass-1 lookbehind row. Use `$fill` for large texts.
- [ ] Create `system-prompt-view.algo.test.ts` from the template at `sysctx-anatomy.algo.test.ts:1-60` (loader path, `expandFills`). Dispatch on `input.view`, `mask`, `title`, `has` and `markdown`, and compare a projection of the view to `expected`.
- [ ] Add a `system-prompt-view` row to the Docs table in `docs/knowledgebase/algorithms/README.md`, after line 61. Add a line next to the System Context Anatomy entry in `docs/knowledgebase/index.md` (line 104): "Read before touching `system-prompt-view.ts` (prompt viewer modal: snapshot selection, boundary split, path masking)".
- [ ] Update `docs/knowledgebase/sysctx-anatomy-tab.md`:
  - § Files: add the new modules;
  - "no text in the DOM" rule: add the modal exception and the masking (DD 6);
  - test-id table: add every DD 12 id;
  - coverage: mention step 8a2.
- [ ] Update `docs/knowledgebase/log-schema/attachment-types.md` § `prompt_snapshot`:
  - the boundary marker part;
  - the first snapshot without `tools` and the later snapshot carrying them;
  - `input_schema` as an alias;
  - a pointer to `algorithms/system-prompt-view.md`.
- [ ] Add a "View system prompt" paragraph to `user-docs/session-log.md` § "System context anatomy" (line 271). Cover the three tabs, masked paths, Copy and Download, no button without a snapshot, and that the format is undocumented.
- [ ] Run client `bun run test` and root `npm run test:scripts` (`algo-docs.test.js` requires the rows file), and fix any failures.

### Chunk 4 — GS-05 fixture + golden arithmetic
- [ ] Edit `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl`: extend the startup snapshot (line 2) and insert the line `gs05-0003p` after `gs05-0003`, envelope and payload exactly per DD 17. Write the edit as a Node `.mjs` script in the scratchpad.
- [ ] Compute with Node the `Read` and `Bash` tool bytes per DD 3, their tokens and the totals. Add the `roots[0].systemPromptView` block (DD 17 shape) to `expected.json`.
- [ ] Update the `expected.json` anatomy: `system-prompt` 3150 B / 900 tok, `attributed` 2929, `harnessInternals` 5871.
- [ ] Add `systemPromptView(lines)` to `tests/golden/check-arithmetic.mjs`, next to `startupAnatomy` (:243). It re-derives parts, groups, parts and tools bytes, and tokens independently per DD 1, 3 and 4. The check compares them with `systemPromptView` when present.
- [ ] Update `tests/golden/gs-05-skills-rules-mcp-workflow/README.md`: the snapshot description at line 11 and the anatomy numbers at line 29. Update row `SA-GS05` in `docs/algorithm-examples/sysctx-anatomy.json` (:311) to the DD 17 numbers.
- [ ] Grep `tests/` and `docs/` for GS-05 values that move: `2829`/`2,829`, `5971`/`5,971`, `67.9`, `system prompt 800`, `Block 3`/`Block 4` rows, Logs entry/attachment/line counts. Update the hits (including `docs/qaa-overview/scenarios/03-session-view-reports-golden.md`), then run root `npm run test:scripts` and client `bun run test`.

### Chunk 5 — Scenario steps
- [ ] In `tests/scenarios/view/s-sess-03.spec.ts` step 8, change the hint literal `67.9 %` to `66.7 %` and the step title's `5,971` to `5,871`. Add a `GoldenSystemPromptView` type next to `GoldenAnatomy` (:64), matching the DD 17 block.
- [ ] Add step `8a2` after 8a:
  - open GS-05 with `{ tab: 'sysctx' }` and click `sysprompt-open`;
  - assert `sysprompt-totals` against the `expected.json` `systemPromptView` block;
  - on the System prompt tab, assert the group headers Shared · 2 and Session-specific · 1, three `sysprompt-item`s, and the DD 17 titles;
  - assert Expand all and Collapse all through `data-expanded`.
- [ ] In step 8a2, open the Tools tab and assert:
  - the summary line;
  - two tool items, `Read` and `Bash`, with the `MCP · gs05-mcp` badge on `Bash`;
  - inside the expanded `Read`: a `table`, the literal text `<system-reminder>`, and a JSON block containing `<outside>/file.txt`.
- [ ] In step 8a2, open the Flags tab and assert:
  - `cliPrefix` shows `gs05`, not `gs05-late`;
  - the expanded `gs05Extra` JSON has `"cwd": "."`;
  - there is no `type` key;
  - `GS05-LATE-PART` does not appear anywhere in the modal.
- [ ] In step 8a2, stub `navigator.clipboard.writeText` with `page.evaluate` (capture into `window.__copied`), click Copy, and read the captured text. Then download with `page.waitForEvent('download')` and assert:
  - the filename matches `/^system-prompt-.*\.md$/`;
  - the file text equals the copied text;
  - it contains the DD 17 masked paths;
  - it has no `/home/dev`, `/tmp/gs05`, `C:\Users` or `/work/repo-gold`.
- [ ] In step 8a2, close the modal and assert the anatomy tab contains no `GS05-SESSION-MARKER`.
- [ ] In step 8d, assert `sysprompt-open` has count 0. Update the spec header comment (lines 1–47) with step 8a2. Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03"` and fix any failures.
