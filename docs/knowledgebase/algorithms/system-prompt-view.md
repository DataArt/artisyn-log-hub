---
reviewed: no
reviewer: none
---

# System prompt view

## Purpose

The System context anatomy tab says how many bytes the system prompt and the tool definitions
take, but not what they say. The "View system prompt" modal shows the text Claude Code captured
in its `prompt_snapshot` attachments — the prompt parts (shared vs. per-session), the tool
definitions and the flags — with local paths masked, so the user can read what the harness sent
and copy or download it as Markdown.

## Code

- Implementation:
  `client/src/viewer/pages/repository/session-log/sysctx-anatomy/system-prompt-view.ts`
  (`hasPromptSnapshot`, `buildSystemPromptView`, `maskLocalPaths`, `partTitle`,
  `systemPromptViewToMarkdown`, `exportFileName`, `DYNAMIC_BOUNDARY_MARKER`). It reuses
  `utf8`, `isObj`, `blockText` and `startupBlockLines` from `sysctx-anatomy.ts` and
  `OUTSIDE_PATH_PREFIX` / `PROJECT_SLUG_PLACEHOLDER` from `sysctx-anatomy-constants.ts`.
- Twins: none. `tests/golden/check-arithmetic.mjs` re-derives the GS-05 sizes independently
  (golden data, not a copy of the code).
- Test: `client/src/viewer/pages/repository/session-log/sysctx-anatomy/system-prompt-view.algo.test.ts`.

## Input and output

- Input: `main` (the raw main transcript lines), `repoRoot` (absolute, may be empty) and `cpt`
  (bytes per token; the tab passes the anatomy's `cpt`).
- Output (`SystemPromptView`): `prompt` (`status` `ok` / `unrecognised` / `missing`, `parts`,
  `grouped`, `bytes`, `tokens`), `tools` (`status` `ok` / `none`, `source` `wire` / `snapshot` / `null`, `items`, `bytes`, `tokens`),
  `flags` (`key`, `value`, `isObject`), `totals` (`parts`, `tools`, `bytes`, `tokens`) and
  `error`. A part is `{index, title, text, bytes, tokens, group}`; a tool is
  `{index, name, server, description, schemaJson, bytes, tokens, share}`. Every display string
  (`title`, `text`, `name`, `server`, `description`, `schemaJson`, `value`) is already masked.

## Rules

1. **Snapshot selection.** A *snapshot line* is a line with `isSidechain` not `true`,
   `type === 'attachment'`, an object `attachment` and `attachment.type === 'prompt_snapshot'`.
   `hasPromptSnapshot(main)` is true when any snapshot line exists. The **startup snapshot** is
   the first snapshot line of the startup block (the anatomy's block: the lines before the first
   main assistant line with `message.usage`, sidechains dropped — `sysctx-anatomy.md` rules 1–2);
   when the block has none, it is the first snapshot line anywhere. Every other snapshot is
   ignored for the prompt and the flags.
1a. **Tools.** The tools are the anatomy's Tool definitions — `findToolDefinitions`
   (`tool-definitions.ts`, rule 10a of [sysctx-anatomy.md](sysctx-anatomy.md)): the
   `api-request-shape` of the first main `api-request` of the startup block when logged
   (`tools.source = 'wire'`), else the first snapshot line anywhere with a non-empty `tools`
   array (`'snapshot'`), else none (`null`). Tools with `defer_loading: true` are dropped; a
   tool's `index` stays its position in the source array.
2. **Shared helpers.** Part text is `blockText(part)`: a string as-is, an object's string `text`,
   anything else `JSON.stringify`. Sizes are `utf8` byte lengths.
3. **Sizes and tokens.** Every size is taken from the **raw** (unmasked) text, so a part's bytes
   equal its anatomy "Block n" row.
   - part bytes = `utf8(blockText(part))`;
   - tool bytes = `utf8(name ?? '') + utf8(description ?? '') + utf8(JSON.stringify(inputSchema))`,
     the schema term 0 without one; `inputSchema` is `schema.input_schema` when `schema` is the
     whole wire tool `{name, description, input_schema, …}` (always so in real snapshots), else
     `input_schema` when there is no `schema`, else `schema`. The Schema pane shows that same
     `inputSchema`. The `server` string and the `(unnamed tool #n)` placeholder are not counted;
   - item tokens = `Math.round(bytes / cpt)`; section tokens = `Math.round(sectionBytes / cpt)`
     (a round of the sum, not a sum of rounded items); every token count is 0 when `cpt` is not
     a positive finite number;
   - `totals.parts` = number of parts, `totals.tools` = number of tools,
     `totals.bytes = prompt.bytes + tools.bytes`, `totals.tokens = Math.round(totals.bytes / cpt)`;
   - tool `share = bytes / toolsBytes × 100` (0 when the tools are 0 B), shown with one decimal;
   - a part's `index` is its 1-based position in the raw `systemPrompt` array, counting markers
     and skipped parts; a tool's `index` is its 1-based position in `tools`.
   - The boundary marker and the flags are excluded from every size.
4. **Boundary split.** A part whose trimmed text equals `DYNAMIC_BOUNDARY_MARKER`
   (`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`, 34 B) is a marker, never a part. With at least one
   marker, parts before the first marker are group `shared` and parts after it group `session`;
   further markers are dropped. With none, every part has group `null` and `grouped` is false. A
   part whose text is empty after `trim()` is skipped. A group with no parts is not rendered.
5. **Part title** (`partTitle(maskedText)`). A blank text is `(empty part)`. Otherwise, the first
   heading line (`/^#{1,6}\s+\S/`, lines inside ``` fences ignored), trimmed, `#`s kept. Without a
   heading, the first 8 whitespace-separated words of the first non-empty line joined by one
   space, plus `…` when the line has more. A title longer than 80 chars is cut to 79 + `…`.
   An unnamed tool is `(unnamed tool #n)`, n its 1-based position.
6. **Path masking** (`maskLocalPaths(text, repoRoot)`), applied to every display string: part
   text, tool name, server and description, every string value inside a schema or an object flag
   (keys untouched, masked **before** pretty-printing). A path never starts right after a word
   char, `.`, `~`, `/` or `\` (so URLs, `~/` and relative paths stay). A path ends at whitespace
   or one of `` ' " ` ) ] } > ``; trailing `.,;:!?` stay in the text, outside the path.
   - **Pass 1, repoRoot** (only when non-empty, trailing separators trimmed): the root matches
     case-insensitively with `/` or `\` for each separator and spaces literally, and must be
     followed by a separator or the end of the path. It becomes the remainder with the leading
     separator removed and `\` → `/`, or `.` for the root itself.
   - **Pass 2, other absolute paths** (`X:\`, `X:/`, `/Users/`, `/home/`, `/tmp/`, `/var/`,
     `/opt/`, `/mnt/`), after `\` → `/`: a path containing `/.claude/` becomes `~/.claude/` + the
     rest after it, with `projects/<segment>` → `projects/<project-slug>`; any other path becomes
     `<outside>/` + its basename (trailing `/` stripped first; `<outside>` alone for a bare drive
     root).
   - Known limitation: a space ends the path, so `C:\Program Files\x` masks only `C:\Program`.
7. **Flags.** Every own key of the startup snapshot, in object order, except `systemPrompt`,
   `tools`, `rendered` and `type`. A string is masked; a number, boolean or null is `String(v)`;
   an object or array is deep-masked and shown as `JSON.stringify(v, null, 2)` with
   `isObject: true`. "Object order" is the order of the parsed line as served: the stored
   transcript is Postgres `jsonb`, which reorders keys, so in the app it is not the order the CLI
   wrote. The view does not sort; the scenario compares flag keys as a set.
8. **Malformed input.** No startup snapshot → prompt `missing`; a non-array `systemPrompt` →
   prompt `unrecognised` (flags still read). No tools (rule 1a) → tools `none`. A tool's schema is
   `inputSchema` (rule 3); a non-object tool entry is `{}`; a non-string `server` is `null`.
   Any throw → the empty view with `error: 'Could not read the system prompt snapshot'`.
9. **Export file name** (`exportFileName(main)`): `system-prompt-<sessionId>.md` from the first
   line with a non-empty string `sessionId` (characters outside `[A-Za-z0-9._-]` → `_`), else
   `system-prompt.md`.
10. **Markdown export** (`systemPromptViewToMarkdown`). Blocks joined by a blank line, ending in
    one newline: `# System prompt`; when grouped, `## Shared` / `## Session-specific` before their
    parts (an empty group has no heading); each part `### Part <index> · <bytes> B` then its text
    verbatim; `# Tool definitions`, then per tool `## <name>` (plus ` · server <server>`), the
    description (an empty string stays an empty block) or `_no description_` when it is absent or
    not a string, and the schema as a fenced `json` block; `# Flags`, then
    per flag `` - `key`: value ``, an object flag as `` - `key`: `` followed by its fenced `json`
    block indented two spaces. A fence is one backtick longer than the longest backtick run in
    its content, at least 3. Empty or failure states write the modal's message lines
    (`No system prompt parts`, `System prompt not in a recognised format`,
    `No tool definitions in this session`, `No flags`). On a build error the export is only
    `# System prompt` followed by the error text — no Tool definitions or Flags sections.

## Edge cases

- Boundary split, marker index kept: SPV-01. No marker: SPV-02. Several markers, a whitespace
  marker, a blank part, an empty shared group: SPV-03; the empty group in the export: SPV-MD1.
- Part payload shapes (string, `.text`, other object): SPV-04.
- Non-array `systemPrompt`: SPV-05. No snapshot: SPV-06. A throw: SPV-13.
- Startup snapshot inside the block, tools snapshot after the anchor, sidechain snapshot skipped,
  later snapshots ignored: SPV-07. Fallback when the block has none, an empty `tools` array: SPV-08.
- Tools from the wire shape (another shape and the tools snapshot ignored, a `defer_loading`
  tool dropped): SPV-14. The real snapshot shape (`schema` = the whole wire tool): SPV-15.
- Tools: unnamed, non-object entry, `input_schema`, `schema` winning, no schema, empty description,
  `server` present / non-string and not counted: SPV-09.
- UTF-8 sizes, round of the sum, shares, a memory block shown as a part: SPV-10, SPV-02.
- Flags (exclusions incl. `type`, scalars, object JSON, masked values): SPV-11.
- Masked display with raw sizes, schema strings masked while keys stay: SPV-12.
- Titles: SPV-T1 … SPV-T8.
- Masking: repoRoot with backslashes, mixed case and spaces SPV-M1; root itself → `.` and `)`
  ending a path SPV-M2; pass-1 lookbehind and a root prefix without a separator SPV-M3;
  `.claude/projects/<slug>` SPV-M4; `<outside>/basename`, trailing punctuation, drive root
  SPV-M5; URLs, `~/` and relative paths untouched SPV-M6.
- `hasPromptSnapshot`: SPV-H1 … SPV-H3.

## Examples

Five kinds of rows, picked by the input key:

- `input.view` = `{main, repoRoot, cpt}` → `buildSystemPromptView`. `expected` lists only the
  top-level keys it checks (`prompt`, `tools`, `flags`, `totals`, `error`); each listed key is
  compared in full, except that a part's `text` and a tool's `description` / `schemaJson` are
  compared only when the expected item gives them. A tool's `share` is projected as
  `sharePct = Math.round(share × 10) / 10`.
- `input.mask` = `{text, repoRoot}` → the masked string.
- `input.title` = a text → the `partTitle` string.
- `input.has` = `main` → the `hasPromptSnapshot` boolean.
- `input.markdown` = a view input → the exact export string.

Anywhere in `input`, an object `{"$fill": n, "start": s}` stands for the ASCII string `s` followed
by `x` up to `n` bytes.

Rows (33): [`docs/algorithm-examples/system-prompt-view.json`](../../algorithm-examples/system-prompt-view.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Section tokens as a sum of rounded items -> SPV-02 (6 instead of 5).
- Sizes taken from the masked text -> SPV-12 (part 28 B instead of 39).
- The whole snapshot `schema` JSON added to name + description (the pre-fix formula, which
  counted every description twice: 57.7 K instead of 33.7 K tokens on a real session) -> SPV-15
  (86 B instead of 10).
- The tools snapshot used although the wire shape is logged, or a `defer_loading` tool kept ->
  SPV-14.
- `server` counted in a tool's bytes -> SPV-09 (Q 12 B); the `(unnamed tool #n)` placeholder
  counted -> SPV-09 (tool 1 17 B).
- Part index renumbered after the marker or a skipped part -> SPV-01 (`# Environment` index 2),
  SPV-03.
- The first snapshot anywhere used for the tools, or a sidechain snapshot used -> SPV-07.
- `type` listed as a flag -> SPV-11, SPV-05.
- Pass 1 without the lookbehind -> SPV-M3 (`/home/x` + `file.ts`); without the separator
  boundary -> SPV-M3 (`2/a.ts`).
- A `#` line inside a fence taken as the title -> SPV-T3.

## Where the result is visible

Session pane → **System context anatomy** tab → **View system prompt** button (shown only when
the session has a snapshot) → the modal: header totals, the System prompt / Tool definitions /
Flags tabs, and the Copy as Markdown / Download .md output.
