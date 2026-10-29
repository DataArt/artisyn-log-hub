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
  `FIRST_PROMPT_ROLE_LABELS`, `MEMORY_DISPLAY_PATH`, `OUTSIDE_PATH_PREFIX`). It reuses
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
- Output: `total`, `attributed`, `internals`, `overBy`, `denominator`, `cpt`, `model`, `flags`
  (`empty`, `noSnapshot`, `noGitStatus`, `noPromptSnapshot`, `unknownTotal`, `overTotal`) and
  `partitions` in table order. Each partition has `kind`, `label`, `source`, `bytes`, `tokens`,
  `share`, `estimated`, optional `count` and its drill-down `rows` (`label`, `source`, `bytes`,
  `tokens`, `share`, plus per-kind fields: `path`, `fileBytes`, `git`, `fileKind`, `onDemand`,
  `status`, `errorCode`, `tools`, `namesBytes`, `instrBytes`, `onDemandNames`, `role`).
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
   "Block i+1" (1-based index in the array, so a skipped memory block leaves a gap).
10. **`memory`** (source `user`): every `systemPrompt` block whose first non-empty line, trimmed,
    is exactly `# Memory`, plus every `instructions` file whose path ends with `/MEMORY.md`. One
    row, path `~/.claude/projects/<project-slug>/memory/MEMORY.md`, git `outside-repo`; no row
    when 0 bytes.
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
    server (not part of the size). Rows sorted by bytes descending, ties in first-seen order.
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
    they are `null`. Snapshot skills not in the listing are not shown. Rows sorted by bytes
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
    rows. Its hint text is `HARNESS_INTERNALS_HINT` in the constants file.

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
  name: SA-07.
- Memory block (exact `# Memory` line) and a `MEMORY.md` instructions file: SA-08.
- Environment estimate, `deferred_tools_record` / `nested_memory` / `mode` ignored: SA-09.
- Attributed > total (no internals, `overBy`): SA-10.
- Files: `~/` → outside repo, project path without a snapshot entry → unknown, absolute path
  outside the repo → `<outside>/basename`, on-demand rules: SA-11. Empty `repoRoot`: SA-13.
- Subagent types and system reminders: SA-12. Snapshot without any `gitStatus`: SA-13.
- Helpers: `splitSkillListing` with UTF-8 and a repeated name SA-14, `mcpKey` SA-15, SA-16.
- Empty transcript: SA-17.
- The GS-05 golden session: SA-GS05.

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

```examples
[
  {
    "id": "SA-01",
    "input": {"main": [
      {"type": "assistant", "isSidechain": true, "message": {"id": "m0", "usage": {"input_tokens": 999}}},
      {"type": "user", "message": {"content": "hello world"}},
      {"type": "assistant", "message": {"id": "m1", "model": "claude-x", "usage": {"input_tokens": 10, "cache_creation_input_tokens": 200, "cache_read_input_tokens": 90}}},
      {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 10, "cache_creation_input_tokens": 200, "cache_read_input_tokens": 90}}}
    ]},
    "expected": {
      "total": 300, "attributed": 3, "internals": 297, "overBy": null, "denominator": 300, "cpt": 3.5,
      "partitions": {"first-prompt": {"bytes": 11, "tokens": 3}, "harness-internals": {"bytes": null, "tokens": 297, "sharePct": 99}}
    },
    "note": "Rule 1: the sidechain assistant (999) is skipped; the anchor is m1. Rule 3: 10 + 200 + 90 = 300; the second m1 line is not added (600 would be wrong). Rule 19: 'hello world' = 11 B -> round(11/3.5 = 3.14) = 3. Rule 7: 300 - 3 = 297, share 297/300 = 99.0 %."
  },
  {
    "id": "SA-02",
    "input": {"main": [
      {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 5, "cache_read_input_tokens": 100}}}
    ]},
    "expected": {
      "total": 105, "attributed": 0, "internals": 105,
      "flags": {"empty": false, "noSnapshot": true, "noGitStatus": false, "noPromptSnapshot": true, "unknownTotal": false, "overTotal": false},
      "kinds": ["system-prompt", "memory", "environment", "deferred-tools", "mcp-server", "agent-types", "skills", "instruction-file", "system-reminder", "first-prompt", "harness-internals"]
    },
    "note": "Rule 3: the missing cache_creation_input_tokens counts 0: 5 + 0 + 100 = 105. The block is empty, so every partition is 0 and internals = 105. All ten measured kinds are listed in table order, then harness-internals. Rule 21: no snapshot, no prompt_snapshot."
  },
  {
    "id": "SA-03",
    "input": {"main": [
      {"type": "attachment", "attachment": {"type": "prompt_snapshot", "systemPrompt": [{"$fill": 35, "start": "You are"}]}},
      {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 100}}},
      {"type": "system", "subtype": "compact_boundary"},
      {"type": "attachment", "attachment": {"type": "prompt_snapshot", "systemPrompt": [{"$fill": 700, "start": "You are"}]}},
      {"type": "attachment", "attachment": {"type": "instructions", "files": [{"path": "/r/CLAUDE.md", "type": "Project", "content": {"$fill": 350, "start": "#"}}]}}
    ]},
    "expected": {
      "total": 100, "attributed": 10, "internals": 90,
      "flags": {"noPromptSnapshot": false},
      "partitions": {"system-prompt": {"bytes": 35, "tokens": 10}, "instruction-file": {"bytes": 0, "tokens": 0}},
      "rows": {"system-prompt": [{"label": "Block 1", "bytes": 35, "tokens": 10, "source": "harness"}], "instruction-file": []}
    },
    "note": "Rule 2: only the line before the anchor is read: one 35 B block -> 35/3.5 = 10 tokens. The 700 B prompt_snapshot and the 350 B instructions after the compact boundary are outside the block (counting them would give 220 + 100 more tokens). 100 - 10 = 90."
  },
  {
    "id": "SA-04",
    "input": {"main": [
      {"type": "user", "isMeta": true, "message": {"content": "<local-command-caveat>Caveat</local-command-caveat>"}},
      {"type": "user", "message": {"content": "<command-name>/clear</command-name>"}},
      {"type": "user", "isSidechain": true, "message": {"content": "sidechain text"}},
      {"type": "user", "isMeta": true, "message": {"content": [
        {"type": "text", "text": "<system-reminder>ctx</system-reminder>"},
        {"type": "text", "text": {"$fill": 70, "start": "Base directory"}},
        {"type": "tool_result", "content": "zzz"}
      ]}},
      {"type": "user", "message": {"content": "Fix the bug"}},
      {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 1000}}}
    ]},
    "expected": {
      "total": 1000, "attributed": 48, "internals": 952,
      "partitions": {"first-prompt": {"bytes": 167, "tokens": 48}},
      "rows": {"first-prompt": [
        {"label": "command caveat", "role": "command-caveat", "bytes": 51, "tokens": 15},
        {"label": "slash command", "role": "slash-command", "bytes": 35, "tokens": 10},
        {"label": "injected skill/command body", "role": "injected-body", "bytes": 70, "tokens": 20},
        {"label": "typed prompt", "role": "typed-prompt", "bytes": 11, "tokens": 3}
      ]}
    },
    "note": "Rule 19. Caveat: 22 + 6 + 23 = 51 B, isMeta + starts <local-command-caveat> -> 15. /clear: 14 + 6 + 15 = 35 B, contains <command-name> -> 10. The sidechain line is dropped (rule 2). The isMeta array: the <system-reminder> part and the tool_result do not count, the 70 B text does -> 20. 'Fix the bug' 11 B -> 3. Partition 51+35+70+11 = 167 -> round(47.71) = 48; 1000 - 48 = 952. Only the first user line (the literal FR-6 reading) would give 51 B."
  },
  {
    "id": "SA-05",
    "input": {
      "main": [
        {"type": "attachment", "attachment": {"type": "skill_listing", "isInitial": false, "names": ["other"], "content": "- other: z\n"}},
        {"type": "attachment", "attachment": {"type": "skill_listing", "isInitial": true, "names": ["proj-skill", "p:synced", "builtin-x", "missing"], "content": "- proj-skill: Does A.\n- p:synced: Does B.\n- builtin-x: C.\n"}},
        {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 100}}}
      ],
      "snapshot": {"skills": [
        {"name": "proj-skill", "source": "project", "path": ".claude/skills/proj-skill/SKILL.md", "bytes": 400, "gitStatus": "tracked"},
        {"name": "synced", "source": "org-synced", "path": "~/.claude/skills/synced/<org>/synced/SKILL.md", "bytes": 300},
        {"name": "unused", "source": "project", "path": ".claude/skills/unused/SKILL.md", "bytes": 900, "gitStatus": "untracked"}
      ]}
    },
    "expected": {
      "total": 100, "attributed": 17, "internals": 83,
      "flags": {"noSnapshot": false, "noGitStatus": false},
      "partitions": {"skills": {"bytes": 58, "tokens": 17}},
      "rows": {"skills": [
        {"label": "proj-skill", "source": "project", "bytes": 22, "tokens": 6, "path": ".claude/skills/proj-skill/SKILL.md", "fileBytes": 400, "git": "tracked"},
        {"label": "p:synced", "source": "org-synced", "bytes": 20, "tokens": 6, "path": "~/.claude/skills/synced/<org>/synced/SKILL.md", "fileBytes": 300, "git": "outside-repo"},
        {"label": "builtin-x", "source": "built-in", "bytes": 16, "tokens": 5, "path": null, "fileBytes": null, "git": null},
        {"label": "missing", "source": "built-in", "bytes": 0, "tokens": 0, "path": null, "fileBytes": null, "git": null}
      ]}
    },
    "note": "Rule 15: the isInitial listing wins over the earlier non-initial one ('other' is not a row). Slices: '- proj-skill: Does A.\\n' = 2+10+2+7+1 = 22; '- p:synced: Does B.\\n' = 2+8+2+7+1 = 20; '- builtin-x: C.\\n' = 2+9+2+2+1 = 16; 'missing' not found = 0. Partition = whole content 58 B -> round(16.57) = 17. Rows: 22/3.5 = 6.29 -> 6, 20/3.5 = 5.71 -> 6, 16/3.5 = 4.57 -> 5. Sources: exact name -> project; 'p:synced' -> org-synced entry 'synced' (git from ~/ fallback = outside-repo, rule 17); others built-in. 'unused' is not listed, so no row. 100 - 17 = 83."
  },
  {
    "id": "SA-06",
    "input": {"main": [
      {"type": "attachment", "attachment": {"type": "skill_listing", "isInitial": true, "names": ["a"], "content": "- a: x\n"}},
      {"type": "user", "message": {"content": "abcdefg"}},
      {"type": "assistant", "message": {"id": "m1"}},
      {"type": "user", "message": {"content": "later prompt"}}
    ]},
    "expected": {
      "total": null, "attributed": 4, "internals": null, "overBy": null, "denominator": 4,
      "flags": {"noSnapshot": true, "noGitStatus": false, "unknownTotal": true, "overTotal": false},
      "kinds": ["system-prompt", "memory", "environment", "deferred-tools", "mcp-server", "agent-types", "skills", "instruction-file", "system-reminder", "first-prompt"],
      "partitions": {"skills": {"bytes": 7, "tokens": 2, "sharePct": 50}, "first-prompt": {"bytes": 7, "tokens": 2, "sharePct": 50}},
      "rows": {"skills": [{"label": "a", "source": null, "git": null}], "first-prompt": [{"bytes": 7}]}
    },
    "note": "Rules 1-3: the only assistant line has no usage, so there is no anchor; the block ends at that first assistant line ('later prompt' is outside) and total is null. Skills '- a: x\\n' 7 B -> 2; 'abcdefg' 7 B -> 2; attributed 4. Rule 7: no internals partition. Rule 8: denominator = attributed = 4, each share 2/4 = 50 %. Rule 15: no snapshot -> source null."
  },
  {
    "id": "SA-07",
    "input": {
      "main": [
        {"type": "attachment", "attachment": {"type": "deferred_tools_delta",
          "addedNames": ["Read2", "mcp__claude_ai_Claude_Docs__create", "mcp__claude_ai_Claude_Docs__read", "mcp__my_db__query"],
          "addedLines": ["Read2", "mcp__claude_ai_Claude_Docs__create", "mcp__claude_ai_Claude_Docs__read", "mcp__my_db__query"],
          "removedNames": [],
          "failedMcpServers": [{"name": "broken.server", "errorCode": "timeout"}]}},
        {"type": "attachment", "attachment": {"type": "mcp_instructions_delta", "addedNames": ["claude.ai Claude Docs"], "addedBlocks": [{"$fill": 100, "start": "Use"}], "removedNames": []}},
        {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 1000}}},
        {"type": "attachment", "attachment": {"type": "deferred_tools_record", "entries": [
          {"name": "mcp__claude_ai_Claude_Docs__read"}, {"name": "mcp__claude_ai_Claude_Docs__read"}, {"name": "mcp__other__x"}, {"name": "Bash"}
        ]}}
      ],
      "snapshot": {"mcpServers": [{"name": "my.db", "command": "npx", "args": ""}]}
    },
    "expected": {
      "total": 1000, "attributed": 55, "internals": 945,
      "partitions": {"deferred-tools": {"bytes": 6, "tokens": 2, "count": 1}, "mcp-server": {"bytes": 186, "tokens": 53}},
      "rows": {"mcp-server": [
        {"key": "claude_ai_Claude_Docs", "label": "claude.ai Claude Docs", "status": "connected", "tools": 2, "namesBytes": 68, "instrBytes": 100, "bytes": 168, "tokens": 48, "onDemandNames": ["mcp__claude_ai_Claude_Docs__read"]},
        {"key": "my_db", "label": "my.db", "status": "connected", "tools": 1, "namesBytes": 18, "instrBytes": 0, "bytes": 18, "tokens": 5, "onDemandNames": []},
        {"key": "broken_server", "label": "broken_server", "status": "failed", "errorCode": "timeout", "tools": 0, "bytes": 0, "tokens": 0}
      ]}
    },
    "note": "Rule 12: 'Read2' 5 + 1 = 6 B -> 2, count 1. Rule 13: 'mcp__claude_ai_Claude_Docs__create' = 5+21+2+6 = 34 (+1 = 35), '...__read' = 32 (+1 = 33): namesBytes 68; mcpKey('claude.ai Claude Docs') = 'claude_ai_Claude_Docs' joins the 100 B instructions -> 168 B -> 48. 'mcp__my_db__query' 17 + 1 = 18 -> 5; mcpKey('my.db') = 'my_db', so the label is the snapshot name. 'broken.server' -> 'broken_server', failed, 0 B, label = the key. Partition 68+100+18 = 186 -> round(53.14) = 53. The record after the anchor still counts for onDemandNames (deduplicated); 'mcp__other__x' has no server and 'Bash' is not MCP. 2 + 53 = 55; 1000 - 55 = 945. Rows sorted 168, 18, 0."
  },
  {
    "id": "SA-08",
    "input": {"main": [
      {"type": "attachment", "attachment": {"type": "prompt_snapshot", "systemPrompt": [
        {"$fill": 70, "start": "You are"},
        {"$fill": 35, "start": "\n# Memory\n"},
        {"$fill": 35, "start": "# Memory notes\n"}
      ]}},
      {"type": "attachment", "attachment": {"type": "instructions", "files": [
        {"path": "/home/u/.claude/projects/-repo/memory/MEMORY.md", "type": "AutoMem", "content": {"$fill": 35, "start": "-"}}
      ]}},
      {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 100}}}
    ]},
    "expected": {
      "total": 100, "attributed": 50, "internals": 50,
      "partitions": {"system-prompt": {"bytes": 105, "tokens": 30}, "memory": {"bytes": 70, "tokens": 20}, "instruction-file": {"bytes": 0, "tokens": 0}},
      "rows": {
        "system-prompt": [{"label": "Block 1", "bytes": 70, "tokens": 20}, {"label": "Block 3", "bytes": 35, "tokens": 10}],
        "memory": [{"label": "~/.claude/projects/<project-slug>/memory/MEMORY.md", "source": "user", "bytes": 70, "tokens": 20, "git": "outside-repo"}],
        "instruction-file": []
      }
    },
    "note": "Rule 10: block 2's first non-empty line is '# Memory' -> memory (35 B); block 3's is '# Memory notes', not exact -> system prompt. The MEMORY.md instructions file (35 B) also goes to memory, not to instruction files. Memory 70 B -> 20. System prompt blocks 1 and 3 (rule 9 keeps the array index): 70 + 35 = 105 -> 30. 30 + 20 = 50; 100 - 50 = 50."
  },
  {
    "id": "SA-09",
    "input": {"main": [
      {"type": "mode", "mode": "normal"},
      {"type": "attachment", "attachment": {"type": "date", "date": "2026-01-08"}},
      {"type": "attachment", "attachment": {"type": "command_permissions", "allowedTools": []}},
      {"type": "attachment", "attachment": {"type": "deferred_tools_record", "entries": [{"name": "Bash", "description": "runs commands"}]}},
      {"type": "attachment", "attachment": {"type": "nested_memory", "path": "/r/CLAUDE.md", "content": {"$fill": 500, "start": "#"}}},
      {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 100}}}
    ]},
    "expected": {
      "total": 100, "attributed": 24, "internals": 76,
      "partitions": {"environment": {"bytes": 83, "tokens": 24}},
      "rows": {"environment": [
        {"label": "date", "bytes": 35, "tokens": 10, "source": "harness"},
        {"label": "command_permissions", "bytes": 48, "tokens": 14, "source": "harness"}
      ]}
    },
    "note": "Rule 11: JSON '{\"type\":\"date\",\"date\":\"2026-01-08\"}' = 35 B -> 10; '{\"type\":\"command_permissions\",\"allowedTools\":[]}' = 48 B -> round(13.71) = 14. The mode line is not an attachment; deferred_tools_record and nested_memory are excluded. Partition 83 B -> round(23.71) = 24; 100 - 24 = 76."
  },
  {
    "id": "SA-10",
    "input": {"main": [
      {"type": "user", "message": {"content": {"$fill": 700, "start": "Please"}}},
      {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 150}}}
    ]},
    "expected": {
      "total": 150, "attributed": 200, "internals": null, "overBy": 50, "denominator": 200,
      "flags": {"overTotal": true, "unknownTotal": false},
      "kinds": ["system-prompt", "memory", "environment", "deferred-tools", "mcp-server", "agent-types", "skills", "instruction-file", "system-reminder", "first-prompt"],
      "partitions": {"first-prompt": {"bytes": 700, "tokens": 200, "sharePct": 100}}
    },
    "note": "700/3.5 = 200 tokens > total 150. Rule 7: internals 150 - 200 < 0 -> null, no harness-internals partition; overBy = 200 - 150 = 50. Rule 8: denominator = attributed = 200, so the prompt is 100 %."
  },
  {
    "id": "SA-11",
    "input": {
      "repoRoot": "/work/repo",
      "main": [
        {"type": "attachment", "attachment": {"type": "instructions", "files": [
          {"path": "/home/u/.claude/CLAUDE.md", "type": "User", "content": {"$fill": 35, "start": "#"}},
          {"path": "/work/repo/CLAUDE.md", "type": "Project", "content": {"$fill": 70, "start": "#"}},
          {"path": "/work/repo/server/CLAUDE.md", "type": "Project", "content": {"$fill": 7, "start": "#"}},
          {"path": "/work/repo2/CLAUDE.md", "type": "Project", "content": {"$fill": 14, "start": "#"}}
        ]}},
        {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 1000}}}
      ],
      "snapshot": {"systemContext": {"totalBytes": 772, "files": [
        {"path": "CLAUDE.md", "bytes": 72, "gitStatus": "tracked"},
        {"path": ".claude/rules/db.md", "bytes": 500, "gitStatus": "untracked"},
        {"path": ".claude/rules/ui.md", "bytes": 200}
      ]}}
    },
    "expected": {
      "total": 1000, "attributed": 36, "internals": 964,
      "partitions": {"instruction-file": {"bytes": 126, "tokens": 36}},
      "rows": {"instruction-file": [
        {"path": "~/.claude/CLAUDE.md", "source": "user", "fileKind": "user-md", "bytes": 35, "tokens": 10, "fileBytes": null, "git": "outside-repo", "onDemand": false},
        {"path": "CLAUDE.md", "source": "project", "fileKind": "claude-md", "bytes": 70, "tokens": 20, "fileBytes": 72, "git": "tracked", "onDemand": false},
        {"path": "server/CLAUDE.md", "source": "project", "fileKind": "claude-md", "bytes": 7, "tokens": 2, "fileBytes": null, "git": "unknown", "onDemand": false},
        {"path": "<outside>/CLAUDE.md", "source": "user", "fileKind": "claude-md", "bytes": 14, "tokens": 4, "fileBytes": null, "git": "outside-repo", "onDemand": false},
        {"path": ".claude/rules/db.md", "source": "project", "fileKind": "rule", "bytes": 0, "tokens": 0, "fileBytes": 500, "git": "untracked", "onDemand": true},
        {"path": ".claude/rules/ui.md", "source": "project", "fileKind": "rule", "bytes": 0, "tokens": 0, "fileBytes": 200, "git": "unknown", "onDemand": true}
      ]}
    },
    "note": "Rule 16-17. User file -> '~/.claude/CLAUDE.md' (toUserDisplayPath), source user, no snapshot entry, git '~/' -> outside-repo. '/work/repo/CLAUDE.md' -> 'CLAUDE.md', joins the snapshot entry (72 B on disk, tracked). 'server/CLAUDE.md' has no entry -> git unknown. '/work/repo2/...' shares the text prefix '/work/repo' but not the '/' boundary -> '<outside>/CLAUDE.md', source user, outside-repo (a bare prefix match would give '2/CLAUDE.md'). The two rules are snapshot-only -> on demand, 0 B; ui.md has no gitStatus and a project path -> unknown. Bytes 35+70+7+14 = 126 -> 36; rows 10, 20, 2, 4. 1000 - 36 = 964."
  },
  {
    "id": "SA-12",
    "input": {
      "main": [
        {"type": "attachment", "attachment": {"type": "agent_listing_delta", "isInitial": true, "addedTypes": ["Explore", "reviewer"], "addedLines": ["- Explore: Finds code.", "- reviewer: Reviews."], "removedTypes": []}},
        {"type": "attachment", "attachment": {"type": "session_context", "context": {"userEmail": "dev@x.test", "gitStatus": {"$fill": 60, "start": "Current branch"}}}},
        {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 100}}}
      ],
      "snapshot": {"agents": [{"name": "reviewer", "path": ".claude/agents/reviewer.md", "bytes": 300, "source": "project", "gitStatus": "ignored"}]}
    },
    "expected": {
      "total": 100, "attributed": 33, "internals": 67,
      "flags": {"noGitStatus": false},
      "partitions": {"agent-types": {"bytes": 44, "tokens": 13}, "system-reminder": {"bytes": 70, "tokens": 20}},
      "rows": {
        "agent-types": [
          {"label": "Explore", "source": "built-in", "bytes": 23, "tokens": 7, "path": null, "fileBytes": null, "git": null},
          {"label": "reviewer", "source": "project", "bytes": 21, "tokens": 6, "path": ".claude/agents/reviewer.md", "fileBytes": 300, "git": "ignored"}
        ],
        "system-reminder": [
          {"label": "userEmail", "bytes": 10, "tokens": 3},
          {"label": "gitStatus", "bytes": 60, "tokens": 17}
        ]
      }
    },
    "note": "Rule 14: '- Explore: Finds code.' = 2+7+2+11 = 22 (+1 = 23) -> round(6.57) = 7, no snapshot agent -> built-in; '- reviewer: Reviews.' = 2+8+2+8 = 20 (+1 = 21) -> 6, joins the snapshot agent (300 B, ignored). Partition 44 -> round(12.57) = 13. Rule 18: 'dev@x.test' 10 B -> round(2.86) = 3, gitStatus 60 B -> round(17.14) = 17, partition 70 -> 20. 13 + 20 = 33; 100 - 33 = 67."
  },
  {
    "id": "SA-13",
    "input": {
      "main": [
        {"type": "attachment", "attachment": {"type": "instructions", "files": [
          {"path": "/home/u/proj/CLAUDE.md", "type": "Project", "content": {"$fill": 35, "start": "#"}},
          {"path": "/home/u/proj/client/CLAUDE.md", "type": "Project", "content": {"$fill": 35, "start": "#"}}
        ]}},
        {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 100}}}
      ],
      "snapshot": {"skills": [{"name": "s", "source": "project", "path": ".claude/skills/s/SKILL.md", "bytes": 10}]}
    },
    "expected": {
      "flags": {"noSnapshot": false, "noGitStatus": true},
      "rows": {"instruction-file": [
        {"path": "<outside>/CLAUDE.md", "source": "user", "git": "outside-repo", "bytes": 35},
        {"path": "client/CLAUDE.md", "source": "project", "git": "unknown", "bytes": 35}
      ]}
    },
    "note": "Rule 17 with an empty repoRoot: '/home/u/proj/CLAUDE.md' has no known top-level dir, so normaliseClientPath only strips the leading '/' -> still the absolute path -> '<outside>/CLAUDE.md' (source user, outside-repo); '/home/u/proj/client/CLAUDE.md' is cut at '/client/' -> 'client/CLAUDE.md', unknown. Rule 21: the snapshot's only entry has no gitStatus -> noGitStatus."
  },
  {
    "id": "SA-14",
    "input": {"split": {"content": "- b: twé\n- a: one\n- a: dup\n", "names": ["a", "b", "c", "a"]}},
    "expected": {"sizes": {"a": 18, "b": 10, "c": 0}},
    "note": "splitSkillListing: 'a' starts at its first '- a: ' (char 9), 'b' at 0; sorted by position b, a. b = '- b: twé\\n' = 9 chars, 10 UTF-8 bytes ('é' is 2). a runs to the end: '- a: one\\n- a: dup\\n' = 18. 'c' is not found -> 0; the repeated 'a' in names is counted once."
  },
  {
    "id": "SA-15",
    "input": {"mcpKey": "claude.ai Claude Docs"},
    "expected": {"key": "claude_ai_Claude_Docs"},
    "note": "Rule 13: '.' and ' ' are outside [A-Za-z0-9_-] and become '_'."
  },
  {
    "id": "SA-16",
    "input": {"mcpKey": "my-db_1"},
    "expected": {"key": "my-db_1"},
    "note": "Rule 13: '-', '_' and digits are kept, so the name is unchanged."
  },
  {
    "id": "SA-17",
    "input": {"main": []},
    "expected": {
      "total": null, "attributed": 0, "internals": null, "denominator": 0,
      "flags": {"empty": true, "noSnapshot": true, "noPromptSnapshot": true, "unknownTotal": true, "overTotal": false},
      "partitions": {"system-prompt": {"bytes": 0, "tokens": 0, "sharePct": 0}}
    },
    "note": "No lines: no anchor (total null), every partition 0, denominator = attributed = 0, so every share is 0 (rule 8) instead of NaN."
  },
  {
    "id": "SA-GS05",
    "input": {
      "repoRoot": "/work/repo-gold",
      "main": [
        {"type": "mode", "mode": "normal"},
        {"type": "attachment", "attachment": {"type": "prompt_snapshot", "systemPrompt": [{"$fill": 2800, "start": "You are"}, {"$fill": 700, "start": "# Memory\n"}]}},
        {"type": "attachment", "attachment": {"type": "date", "date": "2026-01-08"}},
        {"type": "attachment", "attachment": {"type": "skill_listing", "isInitial": true, "skillCount": 2, "names": ["adlc:review-deep", "adlc:review"], "content": "- adlc:review-deep: Deep review of a change\n- adlc:review: Quick review of a change"}},
        {"type": "attachment", "attachment": {"type": "deferred_tools_delta", "addedNames": ["mcp__postgres__query", "mcp__postgres__list_tables", "mcp__playwright__browser_click"], "addedLines": ["mcp__postgres__query", "mcp__postgres__list_tables", "mcp__playwright__browser_click"], "removedNames": []}},
        {"type": "attachment", "attachment": {"type": "mcp_instructions_delta", "addedNames": ["postgres"], "addedBlocks": [{"$fill": 350, "start": "Use"}], "removedNames": []}},
        {"type": "attachment", "attachment": {"type": "instructions", "files": [
          {"path": "/home/golden/.claude/CLAUDE.md", "type": "User", "content": {"$fill": 1050, "start": "# User instructions"}},
          {"path": "/work/repo-gold/CLAUDE.md", "type": "Project", "content": {"$fill": 3500, "start": "# Project"}},
          {"path": "/work/repo-gold/CLAUDE.local.md", "type": "Local", "content": {"$fill": 700, "start": "# Local"}}
        ]}},
        {"type": "attachment", "attachment": {"type": "session_context", "context": {"userEmail": "dev@arrakis.test", "gitStatus": {"$fill": 334, "start": "Current branch: feature/billing"}}}},
        {"type": "user", "message": {"content": {"$fill": 130, "start": "<command-name>/clear</command-name>"}}},
        {"type": "user", "message": {"content": {"$fill": 122, "start": "<command-message>adlc:review</command-message>\n<command-name>/adlc:review</command-name>"}}},
        {"type": "assistant", "message": {"id": "msg_gs05_001", "model": "claude-sonnet-4-6", "usage": {"input_tokens": 800, "cache_creation_input_tokens": 8000, "cache_read_input_tokens": 0}}}
      ],
      "snapshot": {
        "skills": [
          {"name": "adlc:review-deep", "source": "plugin", "path": "adlc@1.0.0/skills/review-deep/SKILL.md", "bytes": 1750, "gitStatus": "outside-repo"},
          {"name": "adlc:review", "source": "plugin", "path": "adlc@1.0.0/skills/review/SKILL.md", "bytes": 1200, "gitStatus": "outside-repo"},
          {"name": "unused-skill", "source": "project", "path": ".claude/skills/unused-skill/SKILL.md", "bytes": 600, "gitStatus": "untracked"},
          {"name": "gold-sync", "source": "org-synced", "path": "~/.claude/skills/synced/<org>/gold-sync/SKILL.md", "bytes": 300, "gitStatus": "outside-repo"}
        ],
        "mcpServers": [{"name": "postgres", "command": "npx", "args": ""}, {"name": "playwright", "command": "npx", "args": ""}],
        "systemContext": {"totalBytes": 6300, "files": [
          {"path": "CLAUDE.md", "bytes": 3500, "gitStatus": "tracked"},
          {"path": ".claude/rules/db.md", "bytes": 700, "gitStatus": "tracked"},
          {"path": ".claude/rules/ui.md", "bytes": 1400, "gitStatus": "untracked"},
          {"path": "CLAUDE.local.md", "bytes": 700, "gitStatus": "ignored"}
        ]}
      }
    },
    "expected": {
      "total": 8800, "attributed": 2829, "internals": 5971, "overBy": null, "denominator": 8800, "cpt": 3.5,
      "flags": {"empty": false, "noSnapshot": false, "noGitStatus": false, "noPromptSnapshot": false, "unknownTotal": false, "overTotal": false},
      "kinds": ["system-prompt", "memory", "environment", "deferred-tools", "mcp-server", "agent-types", "skills", "instruction-file", "system-reminder", "first-prompt", "harness-internals"],
      "partitions": {
        "system-prompt": {"bytes": 2800, "tokens": 800},
        "memory": {"bytes": 700, "tokens": 200},
        "environment": {"bytes": 35, "tokens": 10},
        "deferred-tools": {"bytes": 0, "tokens": 0, "count": 0},
        "mcp-server": {"bytes": 429, "tokens": 123},
        "agent-types": {"bytes": 0, "tokens": 0},
        "skills": {"bytes": 83, "tokens": 24},
        "instruction-file": {"bytes": 5250, "tokens": 1500, "sharePct": 17},
        "system-reminder": {"bytes": 350, "tokens": 100},
        "first-prompt": {"bytes": 252, "tokens": 72},
        "harness-internals": {"bytes": null, "tokens": 5971, "sharePct": 67.9}
      },
      "rows": {
        "mcp-server": [
          {"label": "postgres", "tools": 2, "namesBytes": 48, "instrBytes": 350, "bytes": 398, "tokens": 114},
          {"label": "playwright", "tools": 1, "namesBytes": 31, "instrBytes": 0, "bytes": 31, "tokens": 9}
        ],
        "skills": [
          {"label": "adlc:review-deep", "source": "plugin", "bytes": 44, "tokens": 13, "git": "outside-repo"},
          {"label": "adlc:review", "source": "plugin", "bytes": 39, "tokens": 11, "git": "outside-repo"}
        ],
        "instruction-file": [
          {"path": "~/.claude/CLAUDE.md", "source": "user", "bytes": 1050, "tokens": 300, "git": "outside-repo"},
          {"path": "CLAUDE.md", "source": "project", "bytes": 3500, "tokens": 1000, "fileBytes": 3500, "git": "tracked"},
          {"path": "CLAUDE.local.md", "source": "project", "fileKind": "local-md", "bytes": 700, "tokens": 200, "fileBytes": 700, "git": "ignored"},
          {"path": ".claude/rules/db.md", "onDemand": true, "bytes": 0, "git": "tracked"},
          {"path": ".claude/rules/ui.md", "onDemand": true, "bytes": 0, "git": "untracked"}
        ],
        "first-prompt": [
          {"role": "slash-command", "bytes": 130, "tokens": 37},
          {"role": "slash-command", "bytes": 122, "tokens": 35}
        ]
      }
    },
    "note": "Impl-plan DD 21-22 (cpt 3.5). System prompt block 1 2800 B -> 800; block 2 starts '# Memory' -> memory 700 B -> 200. Environment: the date JSON 35 B -> 10 (the mode line is ignored). MCP: postgres names 20+1 + 26+1 = 48 plus 350 B instructions = 398 -> round(113.71) = 114; playwright 30+1 = 31 -> 9; partition 429 -> round(122.57) = 123. Skills 44 + 39 = 83 -> round(23.71) = 24; rows 44/3.5 = 12.57 -> 13, 39/3.5 = 11.14 -> 11; plugin sources from the snapshot; gold-sync is not listed, so no row. Files 1050 + 3500 + 700 = 5250 -> 1500 (17.0 %); the rules are on demand. Reminders 16 + 334 = 350 -> 100. User lines 130 + 122 = 252 -> 72 (both contain <command-name>). Attributed 800+200+10+0+123+0+24+1500+100+72 = 2829. Total 800 + 8000 + 0 = 8800; internals 8800 - 2829 = 5971 = 67.85 % -> 67.9."
  }
]
```

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

## Where the result is visible

Session pane → **System context anatomy** tab (the rightmost session tab): the header total, the
partition bar and the partition table with its drill-downs (Skills, Instruction files, MCP
servers, …), and the Harness internals hint. The Logs tab's one-line "Startup context · T tokens"
summary shows `computeStartupTotal`.
