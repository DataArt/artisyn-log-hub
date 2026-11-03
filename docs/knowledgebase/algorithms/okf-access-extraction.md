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
  (`docs/tasks/done/2026-10-27-okf-usage-tab/fr6-investigation.md`): no `tool_use` id repeats in
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

Rows (23): [`docs/algorithm-examples/okf-access-extraction.json`](../../algorithm-examples/okf-access-extraction.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
