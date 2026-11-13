---
reviewed: no
reviewer: none
---

# System context anatomy

## Purpose

Before the user types anything, Claude Code already sends a large startup context in the first
request: system prompt, tool names, skills listing, instruction files, reminders. The "System
context anatomy" session tab shows how big that context was (exact, from the API usage) and which
parts filled it (estimated from the bytes the transcript logged), so the user can see what to
trim — a skill they never use, an oversized `CLAUDE.md`, an MCP server with long instructions.

## Code

- Implementation:
  `client/src/viewer/pages/repository/session-log/sysctx-anatomy/sysctx-anatomy.ts`
  (`buildSysctxAnatomy`, `computeStartupTotal`, `splitSkillListing`, `mcpKey`); constants and
  vocabularies in `sysctx-anatomy-constants.ts` (`KIND_LABELS`, `GIT_LABELS`,
  `FIRST_PROMPT_ROLE_LABELS`, `MEMORY_DISPLAY_PATH`, `OUTSIDE_PATH_PREFIX`). The tool set and
  its sizes come from `tool-definitions.ts` (`findToolDefinitions`), which the View system prompt
  modal uses too, so the modal's Tool definitions equal this partition. It reuses
  `resolveCharsPerToken` and `normaliseClientPath` (`log-parser.ts`) and `toUserDisplayPath`,
  `classifyInstructionRole` (`instruction-files.ts`).
- Twins: none. The PoC `docs/pocs/2026-10-29-1504-sysctx-anatomy/anatomy.cjs` is the reference it
  was derived from (it reads disk and git itself; the builder reads only the transcript and the
  hook's harness snapshot).
- Test: `client/src/viewer/pages/repository/session-log/sysctx-anatomy/sysctx-anatomy.algo.test.ts`.

## Input and output

- Input: `main` (the raw main transcript lines, as `/logs` returns them), `snapshot` (the hook's
  harness snapshot or `null`), `repoRoot` (absolute, may be empty), and the bytes-per-token ratio
  `cpt` — given directly, or `resolveCharsPerToken(pricing, model)` for the model of the first
  main assistant line (default 3.5).
- Output: `total`, `attributed`, `internals`, `overBy`, `denominator`, `cpt`, `model`,
  `toolSource` (`wire` / `snapshot` / `null`, rule 10a), `flags`
  (`empty`, `noSnapshot`, `noGitStatus`, `noPromptSnapshot`, `unknownTotal`, `overTotal`) and
  `partitions` in table order. Each partition has `kind`, `label`, `source`, `bytes`, `tokens`,
  `share`, `estimated`, optional `count` and its drill-down `rows` (`label`, `source`, `bytes`,
  `tokens`, `share`, plus per-kind fields: `path`, `fileBytes`, `git`, `fileKind`, `onDemand`,
  `status`, `errorCode`, `tools`, `namesBytes`, `instrBytes`, `onDemandNames`, `names`, `pluginId`,
  `role`).
- No file, section or prompt text is ever in the output — only names, paths, sizes, statuses,
  role labels and "Block n".

## Rules

### Startup block and total

1. **Anchor.** The anchor is the first line with `type === 'assistant'`, `isSidechain` not `true`
   and an object `message.usage`.
2. **Startup block.** The lines before the anchor. Without an anchor: the lines before the first
   `type === 'assistant'` line of any kind, or all lines when there is none. Lines with
   `isSidechain === true` are dropped from the block. Only `type: 'attachment'` lines (with an
   `attachment.type` string) and `type: 'user'` lines of the block are read; every other line type
   (`mode`, `system`, …) and everything after the block (compaction, `/clear`, resume) is ignored.
3. **Total.** `total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of the
   anchor's `message.usage`, a missing field counting 0. Later lines with the same `message.id`
   are not added. Without an anchor `total` is `null` (unknown). `computeStartupTotal(main)`
   returns this number alone.

### Sizes, tokens and shares

4. Every size is the UTF-8 byte length of the named string.
5. `tokens(b) = Math.round(b / cpt)`, applied to each partition's bytes and, separately, to each
   row's bytes (rows need not add up to their partition).
6. `attributed` = Σ partition tokens (harness internals excluded).
7. `internals = total − attributed` when `total` is known and that is ≥ 0; otherwise `null`, and
   there is no `harness-internals` partition. `overBy = attributed − total` when
   `attributed > total`, else `null`.
8. `denominator = total` when `total` is known and `total ≥ attributed`, otherwise `attributed`.
   `share = tokens / denominator` (0 when the denominator is 0).

### Partitions (table order)

9. **`system-prompt`** (source `harness`): the first `prompt_snapshot` attachment of the block;
   each `systemPrompt[i]` block (a string, or an object's `text`) except memory blocks is one row
   "Block i+1" (1-based index in the array, so a skipped block leaves a gap). The
   `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker and blocks that are blank after `trim()` are not
   prompt text and are skipped, as in the modal — so system prompt + the memory block = the
   modal's System prompt bytes.
10. **`memory`** (source `user`): every `systemPrompt` block whose first non-empty line, trimmed,
    is exactly `# Memory`, plus every `instructions` file whose path ends with `/MEMORY.md`. One
    row, path `~/.claude/projects/<project-slug>/memory/MEMORY.md`, git `outside-repo`; no row
    when 0 bytes.
10a. **`tool-definitions`** (source per row) — `findToolDefinitions(block, main)`:
    - **wire** (Claude Code 2.1.312+): the first line of the block with `type === 'api-request'`,
      a string `shapeHash` and `querySource` absent or `repl_main_thread`; its tools are
      `shape.tools` of the `api-request-shape` line (anywhere in `main`) with the same
      `shapeHash`, used when non-empty — the tools exactly as the first request sent them;
    - else **snapshot** (2.1.280+): `tools` of the first non-sidechain `prompt_snapshot` anywhere
      with a non-empty `tools` array (usually written after the first reply; same tool set);
    - else no tools: the partition is 0 B and `toolSource` is `null`.

    A tool whose definition has `defer_loading: true` is not in the context until searched and is
    dropped. A tool's size is `name + description + JSON.stringify(inputSchema)`, where
    `inputSchema` is `schema.input_schema` when the snapshot's `schema` is the whole wire tool
    (it always is in real data), else `input_schema` when there is no `schema`, else `schema`. The
    whole definition's JSON is not used: it counts the description's JSON escapes (~2 % more than
    the text the model reads). One row per tool, label = the name (`(unnamed tool #n)`), source
    `mcp-server` when it has a `server` or an `mcp__…__` name, else `built-in`; rows sorted by
    bytes descending; `count` = the number of tools.
11. **`environment`** (source `harness`, estimated): every other attachment of the block whose
    type is not measured by another partition (`prompt_snapshot`, `deferred_tools_delta`,
    `mcp_instructions_delta`, `agent_listing_delta`, `skill_listing`, `instructions`,
    `session_context`) and not `deferred_tools_record` or `nested_memory`. Size =
    `JSON.stringify(attachment)`; one row per attachment type (summed), in first-seen order.
12. **`deferred-tools`** (source `built-in`): for every `deferred_tools_delta` of the block, each
    `addedNames[i]` that does not start `mcp__…__` adds `addedLines[i]` + 1 (newline) bytes;
    `count` = the number of such names. No rows.
13. **`mcp-server`** (source `mcp-server`). The join key is
    `mcpKey(name) = name.replace(/[^A-Za-z0-9_-]/g, '_')`, applied to the `<slug>` of a
    `mcp__<slug>__<tool>` name (shortest match), to `mcp_instructions_delta.addedNames`, to
    `failedMcpServers[].name` (any attachment of the block) and to snapshot `mcpServers[].name`.
    Per server: `namesBytes` = Σ (`addedLines[i]` + 1) of its deferred names, `tools` = their
    count, `instrBytes` = Σ bytes of `mcp_instructions_delta.addedBlocks[i]` (the
    `mcp-instructions` part), `bytes = namesBytes + instrBytes`. `label` = the instructions name,
    else the snapshot name, else the key. `status` = `failed` with `errorCode` when listed in
    `failedMcpServers`, else `connected`. `onDemandNames` = distinct `mcp__` names of
    `deferred_tools_record.entries[].name` in the **whole** transcript that map to an existing
    server (not part of the size). `names` = the server's startup `deferred_tools_delta` names in
    block order (a server known only from `failedMcpServers` or instructions has `[]`; not part of
    the size). Rows sorted by bytes descending, ties in first-seen order.
14. **`agent-types`** (source `harness`): every `agent_listing_delta` of the block; each
    `addedTypes[i]` is a row of `addedLines[i]` + 1 bytes. A snapshot `agents[]` entry of the same
    name gives source `project`, `path`, `fileBytes` and `git`; without one the source is
    `built-in` and the file fields are `null`.
15. **`skills`** (source per row): the first `skill_listing` with `isInitial === true` of the
    block, else its first `skill_listing`. Partition bytes = the whole `content`.
    `splitSkillListing`: each distinct name's slice starts at `"- " + name + ": "` and runs to the
    next found start (in content order) or to the end; a name not found is 0 bytes. Row source,
    with a snapshot: an entry with the exact name → its `source`; else, for a name `p:x`, an entry
    with `source === 'org-synced'` and name `x` → `org-synced`; else `built-in`. Without a
    snapshot the source is `null`. A matched entry gives `path`, `fileBytes` and `git`; otherwise
    they are `null`. `pluginId` = the matched entry's `plugin.id`, else `null` (no entry, an entry
    without `plugin`, or no snapshot); not part of the size. Snapshot skills not in the listing are
    not shown. Rows sorted by bytes
    descending, ties in listing order.
16. **`instruction-file`** (source per row): rows are the union, keyed by display path with `\`
    → `/`, lowercased, of
    - the block's `instructions` files (MEMORY.md excluded) — display path `toUserDisplayPath`
      for type `User`, otherwise the repo-relative path (rule 17); same key twice adds the bytes;
    - snapshot `systemContext.files[]` — a match sets `fileBytes` (its `bytes`) and `git` (its
      `gitStatus`); an unmatched one is an **on-demand** row with 0 bytes.

    Source: type `User` or an `<outside>/…` path → `user`; otherwise `project`. `fileKind` =
    `classifyInstructionRole(path, type)`. Partition bytes = Σ startup rows. Order: startup rows
    in transcript order, then on-demand rows in snapshot order.
17. **Display path and git.** An absolute path (`/…` or `X:/…`) inside `repoRoot` (prefix match
    on a `/` boundary, case-insensitive) becomes repo-relative (`normaliseClientPath`). Outside it,
    or — with an empty `repoRoot` — when `normaliseClientPath`'s known-top-level-dir fallback
    finds nothing, it becomes `<outside>/<basename>`. A row's `git` is the snapshot `gitStatus`
    when present, else `outside-repo` for a path starting `~/`, `<outside>/` or
    `<plugin>@<ver>/` (`/^[^/]+@[^/]+\//`), else `unknown`.
18. **`system-reminder`** (source `system-reminder`): every `session_context` attachment of the
    block; each `context` key is a row of its string value's bytes (a non-string value:
    `JSON.stringify`).
19. **`first-prompt`** (source `user`): every non-sidechain `type: 'user'` line of the block is a
    row. Size: a string `content` → its bytes; an array `content` → Σ bytes of `type: 'text'`
    parts that do not start with `<system-reminder>` (`tool_result` parts never count). Role, by
    the line's text: `isMeta` and the text starts `<local-command-caveat>` → `command-caveat`;
    the text contains `<command-name>` → `slash-command`; `isMeta` with array content →
    `injected-body`; otherwise `typed-prompt`. The label is the role's label, never the text.
20. **`harness-internals`** (source `harness`): `internals` tokens (rule 7), `bytes` `null`, no
    rows. Its label is "Formatting & unlogged text" (`INTERNALS_LABEL_TOOLS_MEASURED`) when
    `toolSource` is not `null`, else "Harness internals". Its hint text is `HARNESS_INTERNALS_HINT`
    in the constants file (titled with the same label); it lists Tool
    definitions only when `toolSource` is `null` (then they are the largest part of internals).
    With the tools measured, internals is message wrapping, short texts the log does not keep and
    the estimate error — measured on local prod at 0.1–4.7 % of the total.

### Flags

21. `empty`: `main` has no lines. `noSnapshot`: no snapshot. `noGitStatus`: a snapshot whose
    skills, agents and context files carry no `gitStatus` at all. `noPromptSnapshot`: no
    `prompt_snapshot` in the block. `unknownTotal`: `total` is `null`. `overTotal`: `overBy` is
    not `null`.

## Edge cases

- A sidechain assistant before the main one, a duplicate `message.id`: SA-01. A missing usage
  field: SA-02.
- A second `prompt_snapshot` / `instructions` after the anchor is ignored: SA-03.
- First-prompt roles, a `<system-reminder>` text part and a `tool_result` part, a sidechain user
  line: SA-04.
- Skills split, a non-initial listing ignored, org-synced, built-in, a name not found: SA-05.
  No snapshot (source `null`) and no anchor at all: SA-06.
- MCP join of a display name to a slug, a failed server, on-demand names, a built-in deferred
  name, per-server startup `names`: SA-07. Skill `pluginId`: `null` in SA-05, `adlc@artisyn` in
  SA-GS05.
- Memory block (exact `# Memory` line) and a `MEMORY.md` instructions file: SA-08.
- Environment estimate, `deferred_tools_record` / `nested_memory` / `mode` ignored: SA-09.
- Attributed > total (no internals, `overBy`): SA-10.
- Files: `~/` → outside repo, project path without a snapshot entry → unknown, absolute path
  outside the repo → `<outside>/basename`, on-demand rules: SA-11. Empty `repoRoot`: SA-13.
- Subagent types and system reminders: SA-12. Snapshot without any `gitStatus`: SA-13.
- Helpers: `splitSkillListing` with UTF-8 and a repeated name SA-14, `mcpKey` SA-15, SA-16.
- Empty transcript: SA-17.
- Tool definitions from the wire shape, a deferred tool dropped, an `mcp__` tool; the boundary
  marker and a blank block skipped: SA-TD1. From the tools snapshot after the anchor (the real
  `schema` shape), an MCP tool by `server`: SA-GS05. No tools logged: every other builder row.
- The GS-05 golden session (built-in `Artifact` and `PowerShell` tools, a claude.ai sign-in stub
  connector, a user-level `context7` server): SA-GS05.

## Examples

Two kinds of rows.

- **Builder rows** have `input.main` (transcript lines), optional `input.snapshot` (a partial
  harness snapshot: the test adds `snapshotId`, `schemaVersion: 1`, `perToolDetailSupported`,
  empty `skills` / `agents` / `mcpServers`, `systemContext: null`, and per skill `kind: "skill"`,
  `description`, `body`, `contentHash`, per agent/file `contentHash`/`description`/`body` when
  missing), optional `input.repoRoot` (default `""`) and optional `input.cpt` (absent → the
  default ratio 3.5). Anywhere in `input`, an object `{"$fill": n, "start": s}` stands for the
  ASCII string `s` followed by `x` up to `n` bytes. `expected` is a subset of the projection
  `{total, attributed, internals, overBy, denominator, cpt, flags, kinds, partitions, rows}`:
  `kinds` = partition kinds in order; `partitions[kind]` = `{bytes, tokens, sharePct, count?}`;
  `rows[kind]` = the rows with `share` replaced by `sharePct`; `sharePct` =
  `Math.round(share * 1000) / 10`. Objects match on the keys listed; arrays match in length and
  order.
- **Helper rows** have `input.split` (`{content, names}` → `expected.sizes`, name → bytes) or
  `input.mcpKey` (a string → `expected.key`).

Rows (19): [`docs/algorithm-examples/sysctx-anatomy.json`](../../algorithm-examples/sysctx-anatomy.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- The sidechain assistant used as the anchor, or duplicate `message.id` lines summed -> SA-01
  (total 999 or 600).
- Lines after the anchor read (no first-block cut-off) -> SA-03 (system prompt 735 B, files 350 B).
- Only the first `type:user` line counted as the first prompt -> SA-04 (51 B); `<system-reminder>`
  parts or `tool_result` parts counted -> SA-04 (larger injected body).
- The first `skill_listing` taken instead of the `isInitial` one -> SA-05 (row `other`); the
  org-synced fallback missing -> SA-05 (`p:synced` built-in).
- MCP names joined without `mcpKey` -> SA-07 (instructions on a separate `claude.ai Claude Docs`
  row, `my.db` labelled `my_db`).
- A memory block matched by prefix (`# Memory…`) -> SA-08 (Block 3 moved to memory).
- `deferred_tools_record` / `nested_memory` sized as environment -> SA-09.
- Internals kept negative instead of `null` when attributed > total -> SA-10.
- Repo-root prefix match without the `/` boundary -> SA-11 (`2/CLAUDE.md`); every absolute path
  treated as inside the repo -> SA-13 (`home/u/proj/CLAUDE.md`).
- Skill slice sizes in UTF-16 characters instead of UTF-8 bytes -> SA-14 (b = 9).
- Shares divided by a zero denominator -> SA-17 (`NaN`).
- The boundary marker counted as prompt text -> SA-TD1 (37 B), SA-GS05 (3,150 B).
- MCP `names` taken from `deferred_tools_record` instead of the startup delta -> SA-07 (`my_db`
  gets no name, Claude Docs only `read`); `pluginId` read from the skill name prefix -> SA-GS05
  (`adlc` instead of `adlc@artisyn`).
- A tool sized as the JSON of the whole snapshot `schema` (name and description twice) ->
  SA-GS05 (Read 511 B instead of 299); `defer_loading` tools kept -> SA-TD1 (3 rows); the tools snapshot used
  although the wire shape is logged -> SA-TD1 has no snapshot, SPV-14 (tool `S`).

## Where the result is visible

Session pane → **System context anatomy** tab (the rightmost session tab): the header total, the
partition bar and the partition table with its drill-downs (Skills, Instruction files, MCP
servers, …), and the Harness internals hint. The Logs tab's one-line "Startup context · T tokens"
summary shows `computeStartupTotal`.
