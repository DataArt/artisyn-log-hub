---
reviewed: no
reviewer: none
---

# OKF access extraction: which KB paths a tree node read, searched, listed or wrote

## Purpose

The OKF tabs (session and repo) answer "which knowledge-base articles did the agents actually
read, how much of them went into the context, and did they find them through the index or by
searching". Agents mostly read the KB through Bash in fragments (`sed -n`, `grep -n`, `cat`), not
through the Read tool, so a Read-only count misses most of the use. This algorithm turns one
transcript (one tree node: the root session or one sub-agent) into `session_okf_access` rows —
per repo path, per operation — with the result bytes, the call count, whether the read followed
the node's own edit, and the order of first access.

## Code

- Implementation: `server/src/logs/okf/okf-access-extractor.ts` (`extractOkfAccess`,
  `toolResultBytes`, `toAbsolute`).
- Helpers it relies on:
  - `server/src/logs/change-surface/path-normalise.ts` — `resolveRepoPath(absPath, roots)` (rule 3)
    and `truncateChangedPath` (`CHANGED_PATH_MAX_LENGTH` = 1024);
  - `packages/bash-view/src/bash-analyze.ts` — `analyzeBash` and its `readAccess` field (rule 5,
    documented in [bash-command-view](bash-command-view.md) rule 5.9);
  - `server/src/logs/okf/server-bash-parser.ts` — `getServerBashParser()`, the server's
    `tree-sitter-bash` loader (WASM from `dist/wasm/`, else `node_modules`).
- Callers: `server/src/logs/okf/okf-access-writer.ts` (`writeSessionOkfAccess`,
  `rebuildOkfAccessForNodes`) from ingest, import, the file-stats heal and
  `recompute-all-sessions`; `okf-facts.service.ts` for the facts route.
- Twins: none.
- Test: `server/src/logs/okf/okf-access-extractor.algo.spec.ts` (jest, with the real server
  parser).

## Input and output

`extractOkfAccess(entries, roots, parser, { isSubagentLog })` takes the parsed NDJSON lines of one
`claude` / `claude-subagent` log, the session's candidate repo roots, the Bash parser (`null`
skips Bash calls only) and returns `{pathKey, op, afterOwnEdit, bytes, calls, seq}[]` in the
order the rows were first created. One stored row per `(pathKey, op, afterOwnEdit)` of the node.

## Rules

1. **Lines.** In a root log (`isSubagentLog` false) lines with `isSidechain: true` are skipped
   (they belong to a sub-agent, which has its own log); in a sub-agent log every line counts. The
   current directory is the `cwd` of the latest line that has one.
2. **Bytes (DD-1).** A call's bytes = UTF-8 bytes of its `tool_result` content: the string, or
   the sum of the `text` blocks (image and other blocks count 0). The first `tool_result` of a
   `tool_use_id` wins. Not `computeToolResultBytes` (UTF-16, Read only).
3. **Path resolution (DD-5, DD-6).** A path is made absolute against, in order, the Bash
   `workDir` (Bash only) and the line `cwd` (`\` → `/`; an absolute path — `/…` or `X:/…` — is
   kept; a `~` path, or a relative one with no absolute base, is dropped). Then
   `resolveRepoPath(abs, roots)` strips the longest matching root (case-insensitive, on a `/`
   boundary, the rest keeps its case; msys `/d/…` also tried as `D:/…`). The root itself resolves
   to `''`. No match, or no usable root at all, drops the path (FR-2).
4. **Op per tool (DD-3).**

   | Tool call | op | key |
   |---|---|---|
   | Read (`file_path`; `offset` / `limit` ignored) | `read` | file |
   | Edit, MultiEdit, Write (`file_path`), NotebookEdit (`notebook_path`) | `write` | file |
   | Grep with `path` that has an extension and no trailing `/` | `grep` | file |
   | Grep with a folder `path`, or no `path` (cwd) | `grep` | folder |
   | Glob (`path` or cwd, plus the static prefix of `pattern`) | `list` | folder |
   | Bash `readAccess` kind `read` | `read` | file |
   | Bash `readAccess` kind `grep` | `grep` | file, or folder when the path ends `/` or has no extension |
   | Bash `readAccess` kind `list` | `list` | folder |
   | Bash `changes` | `write` | file |
   | any other tool | nothing | |

   The static prefix of a glob is its leading segments before the first segment with `* ? [ ] {
   }`; a pattern without any glob character names a file, so its folder is listed.
5. **Bash.** The command goes through `analyzeBash(parser, command)` (the same analysis the
   client's Bash view runs). With no parser, an empty command or a parse exception the call adds
   nothing.
6. **Keys (DD-4).** A file key is the repo-relative path; a folder key is the repo-relative folder
   plus `/`, the repo root is `/`. Only file keys ending `.md` (any case) are stored; folder keys
   are always stored. Keys longer than 1024 characters are cut to 1024 (`truncateChangedPath`).
7. **Duplicates.** A `tool_use` id seen a second time in the node is skipped whole (DD-8). Inside
   one call a repeated `(key, op)` is kept once.
8. **Even split (DD-2).** The call's bytes are split over its read-side accesses (every op except
   `write`), **before** the `.md` filter: each gets `floor(bytes / N)`, the first in order also
   gets the remainder. `write` accesses get 0. Each stored access adds its share to its row and
   `calls += 1`.
9. **Own edit (DD-7).** Calls are walked in transcript order with the set of keys this node has
   written so far. A `read` / `grep` access of a key already in the set goes to the row with
   `afterOwnEdit = true`; the call's own writes join the set only after the call. `list` and
   `write` rows are always `false`.
10. **Order (DD-27).** `seq` = the 1-based rank of the key's first stored access in the node; every
    row of the same key (any op, own edit or not) carries the same `seq`.

## Edge cases

- Read with `offset` / `limit` counts as the whole file key, with the bytes actually returned:
  OA-01, OA-18.
- Bash fragments: `sed -n` OA-02, `grep -n` on a file OA-03, `cat` OA-04, `cd <dir> && cat` (Bash
  `workDir`) OA-17.
- Multi-file `cat` splits the bytes, remainder to the first: OA-05; a non-`.md` path takes its
  share and is then dropped: OA-06.
- Folder access: `grep -rn` over a folder OA-07, `ls` OA-08, Glob OA-09, Grep tool with a folder,
  with no path (repo root `/`) and with a file OA-10.
- Edit then Read / grep of the same file: OA-11.
- Paths outside every root, and a sibling folder that only shares a prefix with the root: OA-12;
  no roots at all: OA-16.
- `\` paths and a lower-case drive letter fold onto one key: OA-13.
- **FR-6 — "identical Reads in pairs" in sub-agent data.** Investigated on the dev database
  (`docs/tasks/todo/2026-10-27-okf-usage-tab/fr6-investigation.md`): no `tool_use` id repeats in
  any transcript and no sub-agent log is uploaded twice. The pairs are **one call recorded by two
  sources** — the hook's `PostToolUse` record in the root's `artisyn` log (Windows `\` spelling,
  `agent_id` set) and the sub-agent transcript's `tool_use` (mostly `/`), under the same
  `tool_use_id` — which is why they looked like two agents. This extraction reads only
  `claude` / `claude-subagent` transcripts, never `artisyn` records, so the pair is counted once.
  The duplicate-id guard (rule 7) stays as a safety net: OA-14.
- Non-`.md` file: OA-15; upper-case `.MD`: OA-22.
- `text` blocks counted in UTF-8, images 0: OA-19.
- Sidechain lines skipped in a root log, kept in a sub-agent log: OA-20, OA-21.
- Bash write (`sed -i`) and the Write tool: OA-22. No parser: Bash adds nothing, OA-23.

## Examples

Each row is one transcript. `input.calls` are tool calls in order; for call *k* the test emits an
`assistant` line with one `tool_use` block (`id` = the call's `id`, default `t<k>`, `name`,
`input`) and then a `user` line with one `tool_result` for that id whose `content` is the call's
`result` when given, else a string of `resultBytes` ASCII characters. Every line carries
`cwd` = `input.cwd` (default `/work/acme-app`) and `isSidechain: true` when the call says
`sidechain`. `input.roots` defaults to `["/work/acme-app"]`, `input.subagent` (default false) is
`isSubagentLog`, and a row with `noParser: true` passes `parser = null` (otherwise the real server
parser). `expected.rows` is the exact result, in order.

```examples
[
  {
    "id": "OA-01",
    "input": {"calls": [{"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/db-tables.md", "offset": 10, "limit": 40}, "resultBytes": 1200}]},
    "expected": {"rows": [{"pathKey": "docs/kb/db-tables.md", "op": "read", "afterOwnEdit": false, "bytes": 1200, "calls": 1, "seq": 1}]},
    "note": "Rule 4: Read -> read of the file; offset/limit do not change the key. Rule 3: the root /work/acme-app is stripped. Rule 2: 1200 result bytes. First key -> seq 1."
  },
  {
    "id": "OA-02",
    "input": {"calls": [{"name": "Bash", "input": {"command": "sed -n 10,40p docs/kb/db-tables.md"}, "resultBytes": 900}]},
    "expected": {"rows": [{"pathKey": "docs/kb/db-tables.md", "op": "read", "afterOwnEdit": false, "bytes": 900, "calls": 1, "seq": 1}]},
    "note": "Rule 5: analyzeBash takes 10,40p as the sed script and the file as a read (kind read). Rule 3: relative path joined to cwd /work/acme-app, then made repo-relative. One read-side access gets all 900 bytes."
  },
  {
    "id": "OA-03",
    "input": {"calls": [{"name": "Bash", "input": {"command": "grep -n okf docs/kb/api-reference.md"}, "resultBytes": 300}]},
    "expected": {"rows": [{"pathKey": "docs/kb/api-reference.md", "op": "grep", "afterOwnEdit": false, "bytes": 300, "calls": 1, "seq": 1}]},
    "note": "Rule 4: grep's first positional is the pattern, the second a read of kind grep; the path has an extension -> file key, op grep, 300 bytes."
  },
  {
    "id": "OA-04",
    "input": {"calls": [{"name": "Bash", "input": {"command": "cat docs/kb/index.md"}, "resultBytes": 500}]},
    "expected": {"rows": [{"pathKey": "docs/kb/index.md", "op": "read", "afterOwnEdit": false, "bytes": 500, "calls": 1, "seq": 1}]},
    "note": "Rule 4: cat reads its positional (kind read) -> read row with all 500 bytes."
  },
  {
    "id": "OA-05",
    "input": {"calls": [{"name": "Bash", "input": {"command": "cat docs/kb/a.md docs/kb/b.md"}, "resultBytes": 1001}]},
    "expected": {"rows": [
      {"pathKey": "docs/kb/a.md", "op": "read", "afterOwnEdit": false, "bytes": 501, "calls": 1, "seq": 1},
      {"pathKey": "docs/kb/b.md", "op": "read", "afterOwnEdit": false, "bytes": 500, "calls": 1, "seq": 2}
    ]},
    "note": "Rule 8: two read-side accesses, floor(1001 / 2) = 500 each, remainder 1001 - 1000 = 1 to the first -> a.md 501, b.md 500; the sum stays 1001. Each gets calls 1. Rule 10: a.md first -> seq 1, b.md seq 2."
  },
  {
    "id": "OA-06",
    "input": {"calls": [{"name": "Bash", "input": {"command": "cat src/main.ts docs/kb/a.md"}, "resultBytes": 1000}]},
    "expected": {"rows": [{"pathKey": "docs/kb/a.md", "op": "read", "afterOwnEdit": false, "bytes": 500, "calls": 1, "seq": 1}]},
    "note": "Rule 8 splits before the .md filter: 1000 / 2 = 500 each (main.ts would get the 0 remainder too). Rule 6 drops src/main.ts (not .md), so only a.md is stored, with 500 bytes; its seq is 1 because main.ts was never stored."
  },
  {
    "id": "OA-07",
    "input": {"calls": [{"name": "Bash", "input": {"command": "grep -rn TODO docs/kb"}, "resultBytes": 700}]},
    "expected": {"rows": [{"pathKey": "docs/kb/", "op": "grep", "afterOwnEdit": false, "bytes": 700, "calls": 1, "seq": 1}]},
    "note": "Rule 4: a grep path with no extension is a folder -> folder key docs/kb/ (rule 6), op grep, all 700 bytes."
  },
  {
    "id": "OA-08",
    "input": {"calls": [{"name": "Bash", "input": {"command": "ls docs/kb"}, "resultBytes": 120}]},
    "expected": {"rows": [{"pathKey": "docs/kb/", "op": "list", "afterOwnEdit": false, "bytes": 120, "calls": 1, "seq": 1}]},
    "note": "Rule 4: ls reads its positional with kind list -> always a folder key, op list. list is read-side (rule 8), so it carries the 120 bytes."
  },
  {
    "id": "OA-09",
    "input": {"calls": [{"name": "Glob", "input": {"pattern": "docs/kb/**/*.md"}, "resultBytes": 400}]},
    "expected": {"rows": [{"pathKey": "docs/kb/", "op": "list", "afterOwnEdit": false, "bytes": 400, "calls": 1, "seq": 1}]},
    "note": "Rule 4: Glob without path -> cwd; the static prefix of docs/kb/**/*.md is docs/kb (the ** segment stops it) -> folder docs/kb/, op list, 400 bytes."
  },
  {
    "id": "OA-10",
    "input": {"calls": [
      {"name": "Grep", "input": {"pattern": "okf", "path": "/work/acme-app/docs/kb"}, "resultBytes": 250},
      {"name": "Grep", "input": {"pattern": "okf"}, "resultBytes": 90},
      {"name": "Grep", "input": {"pattern": "okf", "path": "docs/kb/index.md"}, "resultBytes": 60}
    ]},
    "expected": {"rows": [
      {"pathKey": "docs/kb/", "op": "grep", "afterOwnEdit": false, "bytes": 250, "calls": 1, "seq": 1},
      {"pathKey": "/", "op": "grep", "afterOwnEdit": false, "bytes": 90, "calls": 1, "seq": 2},
      {"pathKey": "docs/kb/index.md", "op": "grep", "afterOwnEdit": false, "bytes": 60, "calls": 1, "seq": 3}
    ]},
    "note": "Rule 4: Grep with a path without extension -> folder docs/kb/; Grep with no path -> the cwd, which is the root -> '' -> folder key '/' (rule 6); Grep with a relative file path -> joined to cwd, file key. Three keys in order -> seq 1, 2, 3."
  },
  {
    "id": "OA-11",
    "input": {"calls": [
      {"name": "Edit", "input": {"file_path": "/work/acme-app/docs/kb/x.md", "old_string": "a", "new_string": "b"}, "resultBytes": 50},
      {"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/x.md"}, "resultBytes": 800},
      {"name": "Bash", "input": {"command": "grep -n b docs/kb/x.md"}, "resultBytes": 40}
    ]},
    "expected": {"rows": [
      {"pathKey": "docs/kb/x.md", "op": "write", "afterOwnEdit": false, "bytes": 0, "calls": 1, "seq": 1},
      {"pathKey": "docs/kb/x.md", "op": "read", "afterOwnEdit": true, "bytes": 800, "calls": 1, "seq": 1},
      {"pathKey": "docs/kb/x.md", "op": "grep", "afterOwnEdit": true, "bytes": 40, "calls": 1, "seq": 1}
    ]},
    "note": "Rule 8: the Edit is a write -> 0 bytes (its 50 result bytes are not counted). Rule 9: after the Edit x.md is in the written set, so the Read and the grep go to afterOwnEdit rows. Rule 10: all rows of x.md share seq 1."
  },
  {
    "id": "OA-12",
    "input": {"calls": [
      {"name": "Read", "input": {"file_path": "/work/other/notes.md"}, "resultBytes": 500},
      {"name": "Read", "input": {"file_path": "/work/acme-app2/docs/a.md"}, "resultBytes": 500}
    ]},
    "expected": {"rows": []},
    "note": "Rule 3: /work/other is outside the root; /work/acme-app2 only shares a prefix with /work/acme-app, not on a / boundary -> both dropped, nothing stored."
  },
  {
    "id": "OA-13",
    "input": {"roots": ["D:\\work\\acme-app"], "cwd": "D:\\work\\acme-app", "calls": [
      {"name": "Read", "input": {"file_path": "D:\\work\\acme-app\\docs\\kb\\db-tables.md"}, "resultBytes": 700},
      {"name": "Read", "input": {"file_path": "d:/work/acme-app/docs/kb/db-tables.md"}, "resultBytes": 700}
    ]},
    "expected": {"rows": [{"pathKey": "docs/kb/db-tables.md", "op": "read", "afterOwnEdit": false, "bytes": 1400, "calls": 2, "seq": 1}]},
    "note": "Rule 3: \\ becomes /, and the root matches case-insensitively (d: vs D:), so both spellings resolve to docs/kb/db-tables.md: one row, 700 + 700 = 1400 bytes, calls 2."
  },
  {
    "id": "OA-14",
    "input": {"calls": [
      {"id": "dup", "name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/a.md"}, "resultBytes": 300},
      {"id": "dup", "name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/b.md"}, "resultBytes": 900}
    ]},
    "expected": {"rows": [{"pathKey": "docs/kb/a.md", "op": "read", "afterOwnEdit": false, "bytes": 300, "calls": 1, "seq": 1}]},
    "note": "Rule 7: the second tool_use with id dup is skipped whole (b.md never appears). Rule 2: the first tool_result of dup (300 bytes) wins."
  },
  {
    "id": "OA-15",
    "input": {"calls": [
      {"name": "Read", "input": {"file_path": "/work/acme-app/src/main.ts"}, "resultBytes": 500},
      {"name": "Edit", "input": {"file_path": "/work/acme-app/src/main.ts"}, "resultBytes": 10}
    ]},
    "expected": {"rows": []},
    "note": "Rule 6: file keys are stored only for .md files; main.ts gives no read and no write row."
  },
  {
    "id": "OA-16",
    "input": {"roots": [], "calls": [{"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/a.md"}, "resultBytes": 500}]},
    "expected": {"rows": []},
    "note": "Rule 3: no usable root -> nothing can be made repo-relative -> no rows (FR-2)."
  },
  {
    "id": "OA-17",
    "input": {"calls": [{"name": "Bash", "input": {"command": "cd docs/kb && cat index.md"}, "resultBytes": 400}]},
    "expected": {"rows": [{"pathKey": "docs/kb/index.md", "op": "read", "afterOwnEdit": false, "bytes": 400, "calls": 1, "seq": 1}]},
    "note": "Rule 3 / 5: analyzeBash gives workDir docs/kb and the read index.md relative to it; index.md joined to docs/kb, then to cwd /work/acme-app -> /work/acme-app/docs/kb/index.md -> docs/kb/index.md."
  },
  {
    "id": "OA-18",
    "input": {"calls": [
      {"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/b.md"}, "resultBytes": 100},
      {"name": "Grep", "input": {"pattern": "x", "path": "docs/kb/"}, "resultBytes": 30},
      {"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/a.md"}, "resultBytes": 200},
      {"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/b.md", "offset": 50}, "resultBytes": 100}
    ]},
    "expected": {"rows": [
      {"pathKey": "docs/kb/b.md", "op": "read", "afterOwnEdit": false, "bytes": 200, "calls": 2, "seq": 1},
      {"pathKey": "docs/kb/", "op": "grep", "afterOwnEdit": false, "bytes": 30, "calls": 1, "seq": 2},
      {"pathKey": "docs/kb/a.md", "op": "read", "afterOwnEdit": false, "bytes": 200, "calls": 1, "seq": 3}
    ]},
    "note": "Rule 10: first-access order b.md (1), docs/kb/ (2, a Grep path with a trailing / is a folder), a.md (3); the second Read of b.md keeps seq 1 and adds to its row: 100 + 100 = 200 bytes, calls 2."
  },
  {
    "id": "OA-19",
    "input": {"calls": [{"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/a.md"}, "result": [{"type": "text", "text": "h\u00e9llo"}, {"type": "image", "source": {"type": "base64", "data": "AAAA"}}]}]},
    "expected": {"rows": [{"pathKey": "docs/kb/a.md", "op": "read", "afterOwnEdit": false, "bytes": 6, "calls": 1, "seq": 1}]},
    "note": "Rule 2: the text block 'h\u00e9llo' is 5 characters but 6 UTF-8 bytes (\u00e9 = 2 bytes); the image block counts 0 -> 6."
  },
  {
    "id": "OA-20",
    "input": {"calls": [{"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/a.md"}, "sidechain": true, "resultBytes": 500}]},
    "expected": {"rows": []},
    "note": "Rule 1: in a root log a sidechain line belongs to a sub-agent (counted from its own log) -> skipped, nothing stored."
  },
  {
    "id": "OA-21",
    "input": {"subagent": true, "calls": [{"name": "Read", "input": {"file_path": "/work/acme-app/docs/kb/a.md"}, "sidechain": true, "resultBytes": 500}]},
    "expected": {"rows": [{"pathKey": "docs/kb/a.md", "op": "read", "afterOwnEdit": false, "bytes": 500, "calls": 1, "seq": 1}]},
    "note": "Rule 1: in a sub-agent log every line counts, sidechain or not -> the read is stored with its 500 bytes."
  },
  {
    "id": "OA-22",
    "input": {"calls": [
      {"name": "Bash", "input": {"command": "sed -i s/a/b/ docs/kb/a.md"}, "resultBytes": 0},
      {"name": "Write", "input": {"file_path": "/work/acme-app/docs/kb/NEW.MD", "content": "x"}, "resultBytes": 20}
    ]},
    "expected": {"rows": [
      {"pathKey": "docs/kb/a.md", "op": "write", "afterOwnEdit": false, "bytes": 0, "calls": 1, "seq": 1},
      {"pathKey": "docs/kb/NEW.MD", "op": "write", "afterOwnEdit": false, "bytes": 0, "calls": 1, "seq": 2}
    ]},
    "note": "Rule 4: sed -i makes a.md a Bash change -> write; the Write tool -> write. Rule 8: writes get 0 bytes. Rule 6: .MD matches .md case-insensitively, the key keeps its case."
  },
  {
    "id": "OA-23",
    "noParser": true,
    "input": {"calls": [{"name": "Bash", "input": {"command": "cat docs/kb/a.md"}, "resultBytes": 500}]},
    "expected": {"rows": []},
    "note": "Rule 5: with parser null (WASM failed to load) Bash calls add nothing; Read/Grep/Glob/Edit would still be extracted."
  }
]
```

## Mutations

- Bytes split over stored (`.md`) accesses only instead of all read-side ones -> OA-06 (1000).
- Remainder given to the last path, or dropped -> OA-05 (500 / 501, or a sum of 1000).
- `write` given a share of the bytes -> OA-11 (Edit 50 bytes), OA-22.
- Grep / `rg` path without extension stored as a file -> OA-07; `ls` path stored as a file ->
  OA-08; Glob listing the pattern's own path -> OA-09 (`docs/kb/**/*.md`).
- Grep with no `path` ignored instead of the cwd -> OA-10 (`/` row).
- `afterOwnEdit` set by the same call's write, or never -> OA-11.
- Root matched as a plain string prefix -> OA-12 (`acme-app2`); case-sensitive root match or
  `\` not converted -> OA-13.
- The second occurrence of a `tool_use` id counted -> OA-14 (`b.md`).
- Non-`.md` file rows kept -> OA-15, OA-06.
- Bash `workDir` ignored -> OA-17 (`index.md` resolved against the repo root).
- `seq` per row instead of per key, or reset per op -> OA-11, OA-18.
- UTF-16 length or image bytes counted -> OA-19 (5, or more than 6).
- Sidechain lines read from the root log -> OA-20; skipped in the sub-agent log -> OA-21.

## Where the result is visible

- Session pane → **OKF** tab: bundle cards (FILES READ, BYTES INTO CONTEXT), the tree's READ /
  WRITE columns and `own_edit` / `folder_scan` markers, the Agents panel's "how agents reached the
  KB" (via `seq`).
- Repository → **OKF** tab: every tile, the histogram, hot files, not-read list and the tree.
- API: `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage`,
  `GET /api/v1/repositories/:repoId/reports/okf-usage`, `GET /api/v2/okf-usage/facts` (`kbReads`,
  `kbSeq`).
- Storage: `session_okf_access` (see [../okf-usage.md](../okf-usage.md)).
