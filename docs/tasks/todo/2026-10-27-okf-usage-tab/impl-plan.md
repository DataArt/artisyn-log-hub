# Implementation plan — 2026-10-27 OKF Usage Tab

## TL;DR

- **DB (migration `0075_okf_usage`):** new tables `session_okf_access` (per tree node, per path/op/own-edit, with a `seq` first-access rank) and `okf_snapshots` (content-addressed, per user); new columns `sessions.okf_snapshot_id` (indexed) and `upload_queue.okf_snapshot_id`. No backfill in SQL — history comes from `recompute-all-sessions`.
- **New repo-local package `packages/bash-view` (`@loghub/bash-view`):** the pure `analyzeBash` / `buildBashView` / formatting logic moves out of `client/src/viewer/lib/bash-view/`; the tree-sitter loader stays per side. `BashAnalysis` gains an additive `readAccess` field (read / grep / list per path).
- **Server gets `web-tree-sitter` + `tree-sitter-bash` as runtime dependencies** (same versions as the client); the two `.wasm` files are copied to `dist/wasm/` by the build, the scenario stand and the Dockerfile.
- **New server module `server/src/logs/okf/`:** `server-bash-parser` (WASM loader), `okf-access-extractor` (FR-1/2/6), `okf-access-writer` (FR-3), `okf-snapshot` (FR-10 store/bind/sweep, clone of `harness-snapshot.ts`), `okf-usage.types`, `okf-verdict` (pure rules, FR-14a/17a), `okf-task-context` (FR-20 prompt filter), `okf-usage.service` (session + repo aggregation, team fail-closed filter), `okf-facts.service` + `okf-facts.controller`.
- **New endpoints:** `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage`, `GET /api/v1/repositories/:repoId/reports/okf-usage`, `GET /api/v2/okf-usage/facts` (API key, owner only). Upload `POST /api/v2/logs` gains optional `okfSnapshotId` / `okfSnapshotFull` query params and `unknownOkfSnapshotId` response field (additive, backward compatible both ways).
- **Hook (version bump 2.25.0 → 2.26.0):** new `okf-snapshot.js` (bundle detection, `git check-ignore --stdin`, content id) and `okf-state.js`, both added to the installer file list in `scripts/build-hooks-installer.js`; new config key `okf` (`{ exclude: string[] }`); OKF lines ride only on the root session's `artisyn` upload from `send-logs-hook.js`.
- **Client:** new session tab `okf` and new repo main tab `okf` with their own components under `session-log/okf/` and `okf/`; verdict text is rendered client-side from rule ids + params.
- **Build and export format:** new `scripts/copy-wasm.js` (WASM into `dist/wasm/`), client alias for `@loghub/bash-view`; repository export zips gain `okfSnapshotId` and OKF lines (older zips still import, DD-42); the hook may add an mtime-tree cache to `okf-state.json` if detection is slow (Chunk 7).
- **Release line:** root `package.json` version 1.0.0 → 1.1.0, so the next release is tagged `v1.1.0` (DD-46).
- **No LLM anything** (FR-19): no setting, worker branch, table or UI for analysis.

## Reference

Requirements: [requirements.md](requirements.md) · evidence and decision history: [notes.md](notes.md) ·
research archive: [research/findings-1.md](research/findings-1.md) · wireframes:
[session-okf-tab.svg](wireframes/session-okf-tab.svg), [repo-okf-tab.svg](wireframes/repo-okf-tab.svg).

## Design Decisions

### Extraction (Phase 1)

- **DD-1 Byte unit.** "Bytes" are UTF-8 bytes (`bytesOfUtf8`, `server/src/logs/claude-extractor.ts:612`) of the concatenated text blocks of the call's `tool_result` (image blocks count 0); `computeToolResultBytes` (`claude-extractor.ts:1391`, UTF-16, Read-only) is not reused. Snapshot `size` is also UTF-8 bytes on disk, so the coarse-article ratio compares like with like.
- **DD-2 Even split.** A Bash call touching N resolved paths gives each `floor(bytes / N)`, and the remainder goes to the first path in `analyzeBash` order, so the sum equals the call's bytes; every path gets `calls += 1`. A write-only path (Bash `changes`) gets bytes 0 for op `write`; the read bytes are split across the read/grep/list paths only.
- **DD-3 Op mapping.**

  | Source | op | path_key |
  |---|---|---|
  | Read tool (`file_path`, offset/limit ignored) | `read` | file |
  | Edit / MultiEdit / Write / NotebookEdit tool | `write` (bytes 0) | file |
  | Grep tool, `path` is a file | `grep` | file |
  | Grep tool, `path` is a folder or absent (cwd) | `grep` | folder (DD-4) |
  | Glob tool (`path` or cwd; static prefix of `pattern` appended) | `list` | folder |
  | Bash `readAccess` kind `read` (`cat`, `sed -n`, `head`, …) | `read` | file |
  | Bash `readAccess` kind `grep` (`grep`, `rg`, `ag`, `egrep`, `fgrep`) | `grep` | file or folder |
  | Bash `readAccess` kind `list` (`ls`, `find`, `tree`, `dir`) | `list` | folder |
  | Bash `changes` | `write` | file |

  Only paths ending `.md` (case-insensitive) are stored for file rows; folder rows are stored for any folder under a root (the bundle filter at read time drops the rest).
- **DD-4 Folder keys.** A folder `path_key` is the repo-relative folder with a trailing `/` (repo root = `/`), so files and folders never collide; a path is a folder when the tool input is a known folder form (Grep/Glob `path`, `ls`/`find` operand, trailing `/`) or has no extension.
- **DD-5 Bash path resolution.** Each `analyzeBash` path is resolved as `join(entry.cwd, analysis.workDir ?? '', p)` (absolute `p` kept as is, `\` → `/`) and then passed to `resolveRepoPath` (DD-6).
- **DD-6 `resolveRepoPath(absPath, roots): string | null`** lives in `server/src/logs/change-surface/path-normalise.ts`, built on `usableRepoRoots()` (`:117`) and `stripRepoRootPreservingCase()` (`:135`); `null` when no root matches or the session has no roots — nothing is stored then (FR-2).
- **DD-7 `after_own_edit`.** Per node, walk tool calls in transcript order keeping a set of path keys this node wrote (DD-3 `write` rows); a `read`/`grep` on a path already in the set is `after_own_edit = true`. `list` and `write` rows are always `false`.
- **DD-8 Dedupe (FR-6).** Within one node, a `tool_use` id seen twice counts once (first occurrence wins); the FR-6 investigation (Chunk 3) records its finding in `algorithms/okf-access-extraction.md` → Edge cases. If the pairs turn out to be two separate uploads of the same sub-agent log under two `sessions` rows, the fix is reported as a separate bug, not handled in this task.
- **DD-9 Writer contract.** `writeSessionOkfAccess(tx, sessionDbId, rows)` deletes the node's rows and inserts the new set (per-node delete-then-insert); it is called from every place `writeSessionFileStats` is called: ingest (`logs.service.ts:452`), import (`:1041`), heal (`session-file-stats-writer.ts:211` `rewriteSessionTreeFileStats` — it already reparses tree bodies, so the OKF rows are rebuilt from the same parsed bodies with the now-known roots), recompute: NOT in `writeFileStatsForTree` (`repositories.service.ts:1647` runs once per file-category scope), but once per tree in the scope-independent `recomputeAllSessionStats` (`repositories.service.ts:1280`) via a new private `recomputeOkfAccess(treeSessionIds)` that reparses the tree's `claude`/`claude-subagent` bodies with their artisyn roots (same roots lookup as `writeFileStatsForTree`).
- **DD-10 Bash parser on the server.** `server/src/logs/okf/server-bash-parser.ts` loads `web-tree-sitter` (its CJS export) once per process with `locateFile` → `resolveWasm('web-tree-sitter.wasm')` and `Language.load(resolveWasm('tree-sitter-bash.wasm'))`; `resolveWasm` tries `path.join(__dirname, 'wasm', name)` (ncc bundle in `dist/`) then `require.resolve` of the package file (dev / jest). If loading fails, Bash calls are skipped (Read/Grep/Glob/Edit still extracted) and one warning is logged per process.

### Shared package (FR-20)

- **DD-11 `@loghub/bash-view`.** `packages/bash-view/src/` takes `bash-analyze.ts`, `bash-format.ts`, `bash-view.ts`, `bash-highlight.ts`, `display-paths.ts` and a new `syntax.ts` that declares structural types `BashSyntaxNode` (`type`, `text`, `startIndex`, `endIndex`, `isNamed`, `hasError`, `parent`, `nextSibling`, `children`, `namedChildren`, `childForFieldName`, `childrenForFieldName`, `descendantsOfType`), `BashSyntaxTree` (`rootNode`, `delete()`), `BashCapture`, `BashParser` and `withTree`; no `web-tree-sitter` import, so the package keeps the "no dependencies" rule. `client/src/viewer/lib/bash-view/` keeps only `bash-parser.ts` (the dynamic-import loader) and `browser-parser.ts`, re-typed against the package's `BashParser`.
- **DD-12 `readAccess`.** `BashAnalysis` gains `readAccess: { path: string; kind: 'read' | 'grep' | 'list' }[]` — one entry per path in `reads` (same order), kind from the command base name per DD-3; the client view ignores it, so the view output is unchanged.

### OKF snapshot (Phase 2)

- **DD-13 Snapshot body (wire and `okf_snapshots.body`).**

  ```json
  { "type": "okf-snapshot", "okfSnapshotId": "<64 hex>", "schemaVersion": 1,
    "bundles": [ { "root": "docs/knowledgebase", "index": "docs/knowledgebase/index.md",
                   "ignored": false,
                   "files": [ { "path": "docs/knowledgebase/db-tables.md", "ignored": false,
                                "size": 12345, "hash": "<sha256 hex of content>" } ] } ] }
  ```

  Ref line: `{ "type": "okf-snapshot-ref", "okfSnapshotId": "<64 hex>" }`. Neither line has `timestamp`. Paths are repo-relative with `/`. A bundle's `ignored` is its `index.md`'s flag.
- **DD-14 Snapshot id.** `sha256` over `JSON.stringify` of the bundles sorted by `root`, each bundle's files sorted by `path`, projected to `{root, index, ignored, files:[{path, ignored, size, hash}]}` — never mtime (mirrors `algorithms/harness-snapshot.md`).
- **DD-15 Detection.** Walk from the git root (`getGitRoot`), skipping `.git`, `node_modules`, symlinked directories and every `okf.exclude` match (default `["tmp/**"]` always applied in addition to the configured list); every `index.md` whose front matter (first 512 bytes, between `---` lines) has an `okf_version:` key roots a bundle; every `.md` under a bundle root belongs to the deepest bundle root containing it. Index links are never followed. Glob matching uses a small local `globToRegExp` (`**`, `*`, `?`), no new dependency.
- **DD-16 Ignored flags.** One `git check-ignore --stdin -z` call over all found file paths through a new `gitWithInput(args, cwd, input, timeoutMs)` in `git-context.js` (`execFileSync` with `input`, `windowsHide: true`; returns `{ status: number | null, stdout: string }`, never throws); exit code 1 means "none ignored", any other failure marks every file `ignored: true` (fail closed).
- **DD-17 Config key.** Top-level `okf` of type `'object'` (new `CONFIG_TYPES` kind: a non-null, non-array object) with `exclude: string[]`; `log-hub.local.json`'s `okf` replaces `log-hub.json`'s whole (`shallowMergeConfigs` semantics, documented). An old hook ignores the unknown key.
- **DD-18 Caps, constants and validation.** The server accepts an id only if `^[0-9a-f]{64}$`; otherwise silently ignored, never 400. Named constants:

  | Constant | Where | Value |
  |---|---|---|
  | `OKF_SNAPSHOT_MAX_BYTES` | `server/src/logs/okf/okf-snapshot.ts` | `10 * 1024 * 1024` (over-cap body → line ignored, id treated as unknown) |
  | `OKF_SNAPSHOT_MAX_FILES` | `hook/.../okf-snapshot.js` | 20000 (over → no snapshot sent, logged) |
  | `OKF_FRONT_MATTER_READ_BYTES` | `okf-snapshot.js` | 512 |
  | `OKF_CHECK_IGNORE_TIMEOUT_MS` | `okf-snapshot.js` | 5000 (passed to `gitWithInput`) |
  | `OKF_DETECTION_BUDGET_MS` | `okf-snapshot.js` | 300 (measurement threshold for the Chunk 7 cache decision; logged when exceeded) |
  | `OKF_KNOWN_SNAPSHOTS_MAX` | `okf-state.js` | 20 |
  | `OKF_STATE_VERSION` | `okf-state.js` | 1 |
  | `OKF_PATH_KEY_MAX` | `okf-access-extractor.ts` | 1024 (longer path → row skipped, matches `varchar(1024)`) |
  | `OKF_FACTS_OTHER_READS_TOP` | `okf-facts.service.ts` | 20 |
  | `OKF_FACTS_MAX_PROMPT_CHARS` | `okf-facts.service.ts` | 4000 per prompt (cut, suffix `…`) |
- **DD-19 Hook state.** New `okf-state.js` (file `okf-state.json`, version `OKF_STATE_VERSION`, cap `OKF_KNOWN_SNAPSHOTS_MAX`, fail-open, temp-file + rename) cloned from `harness-state.js` with `readKnownOkfSnapshots` / `rememberOkfSnapshot` / `forgetOkfSnapshot`; no per-session map (OKF lines never ride on `prompt-upload-hook.js`).
- **DD-20 Hook delivery.** In `send-logs-hook.js`, beside `getHarnessPrefix` (`:1204`), a `getOkfPrefix()` under the same `artisyn && isCurrentSession` gate (`:1448`, `:1460`): always the ref line, plus the full line when the id is not in `okf-state`; query `okfSnapshotId` (+ `okfSnapshotFull=1` with the full line); on success remember the id; on `unknownOkfSnapshotId === id` in the response, forget it so the next upload resends the full body. Detection runs only here (at upload), never at `SessionStart`.
- **DD-21 Server binding.** Root session binds with `UPDATE sessions SET okf_snapshot_id = $id WHERE id = $root AND okf_snapshot_id IS NULL` on the first `artisyn` upload carrying a ref or full line; never rebound. Sub-agent nodes resolve the root via `topAncestorIdsSql` (`server/src/logs/session-tree.sql.ts:68`).
- **DD-22 Known check / unknown response.** Mirrors `isHarnessSnapshotKnown` (`harness-snapshot.ts:273`): stored row for `(user, id)` or a pending/processing/partially_uploaded `upload_queue` row with `okf_snapshot_id = id`; `unknownOkfSnapshotId` returned on single and chunk-complete responses only (`logs-v2.controller.ts:128-134`, `:239-249`).

### Verdict and aggregation (Phases 3–4)

- **DD-23 Constants** (`server/src/logs/okf/okf-verdict.ts`, pinned by `algorithms/okf-verdict.md`):

  | Constant | Value |
  |---|---|
  | `SHARE_MIN_BUNDLE_FILES` | 10 |
  | `SESSION_SHARE_FIX` / `SESSION_SHARE_MESS` | 0.25 / 0.50 (strictly greater than) |
  | `REPO_MIN_KB_SESSIONS` | 5 |
  | `ALWAYS_READ_SHARE` | 0.80 (≥) |
  | `FLOOD_SHARE` | 0.25 (>) |
  | `FLOOD_MESS_SESSION_SHARE` | 0.20 (≥) |
  | `COARSE_MIN_SIZE_BYTES` | 51200 |
  | `COARSE_MIN_SESSIONS` | 5 |
  | `COARSE_MAX_READ_RATIO` | 0.10 (<) |
  | `READ_TOP_N` / `HOT_FILES_TOP_N` | 5 / 10 |
  | `SHARE_BINS` | `[0, 0.10, 0.25, 0.50]` → bins `0-10`, `10-25`, `25-50`, `50+` (lower bound inclusive) |
  | `TASK_HEAD_MAX_CHARS` | 200 |

- **DD-24 Session verdict.** Per agent (tree node) and per bundle with ≥ 10 files: share = distinct files of the bundle with a `read`/`grep` row of this node ÷ bundle files, where files this node wrote are removed from both numerator and denominator; worst finding wins. Rule id `session_share`, params `{ agentId, bundle, read, total, share }`. Levels: no bundle and no access → `verdict: null`; no access → `kb_not_used`; no snapshot → share rule skipped and qualifier `partial_data`.
- **DD-25 Repo verdict.** Unit = root session tree with ≥ 1 OKF row in a visible bundle (or, snapshot-less, any OKF row in the view); rules `always_read` `{bundle, path, sessions, kbSessions, share}`, `kb_flood` `{bundle, sessions, bundleSessions, share}`, `coarse_article` `{bundle, path, size, sessions, avgReadBytes, ratio}` per FR-17a; `kb_flood` counts only snapshot-bound trees; qualifier `partial_data` with params `{ withoutSnapshot, total }` carried in `verdict.partialData`. Levels `kb_not_used` (0 sessions), `not_enough_data` (1–4; findings listed with severity kept but level replaced).
- **DD-26 Agents `entry`.** For an agent's first access to any bundle: `index` if it targets that bundle's `index.md`; `search` if a `grep`/`list` row on the bundle precedes its first non-index `read`; otherwise `given`. Needs first-access order, so extraction also emits per node an ordered list `firstAccess: path_key[]` — stored as `seq int` = rank of the row's first access within the node (new column, DD-27).
- **DD-27 `seq` column.** `session_okf_access.seq int not null` = 1-based order of the first access of `(path_key)` within the node (all rows of the same path share it); used for "started from index" (FR-12: tree-wide first access = earliest node `start_time`, then `seq`) and `entry`.
- **DD-28 Task head.** `taskHead` = `cleanTaskText(logs.first_prompt)` of the node's `claude`/`claude-subagent` log (no new storage), cut to `TASK_HEAD_MAX_CHARS`; `cleanTaskText` is the `okf-task-context` filter.
- **DD-29 Repo folding.** Latest snapshot = the bound snapshot of the newest root session (by `start_time`) in the filtered set (filtered by branch when `branches` given); its bundles define `bundles`/`tree`; accessed paths absent from it go to a synthetic group `{ bundle: null, label: 'gone' }` ("No longer in KB"). Sessions' accesses fold by `path_key`.
- **DD-30 Team filter (FR-17).** With `teamId`: a path is kept only when the accessing root's own snapshot lists it `ignored: false` and no contributing snapshot lists it `ignored: true`; snapshot-less trees and paths missing from the session's snapshot contribute nothing; bundles of the latest snapshot with `ignored: true` are dropped; the verdict is computed after the filter.
- **DD-31 Drawer and "Show all".** The repo tree node drawer from the wireframe is out of scope (no FR); "Show all" lists expand inline from the full lists the response already carries (`hotFiles` top 10 only → no "Show all" for hot files; `notRead` full list).
- **DD-32 Personal vs team.** Route-based like every other repo tab (`/repos/:id` vs `/teams/:t/repos/:id` → `teamId` param), not a toggle; the wireframe toggle is replaced.
- **DD-33 Facts route ownership.** `OkfFactsService` loads the root `sessions` row by its `session_id` string and returns 404 unless one of that session's `logs` rows has `logs.user_id = req.userId` (the API key's user); a missing session and a foreign one both get the same 404.
- **DD-34 Facts content (FR-20).** Built by reparsing the stored `claude` / `claude-subagent` bodies of the tree (`getDescendantSessionIds`), never from `session_okf_access`:
  - `startedAt` = root `logs.start_time` (ISO).
  - `prompts` = the root (main) agent's user prompts through `filterUserPrompts` (DD-28 filter), each cut to `OKF_FACTS_MAX_PROMPT_CHARS`.
  - `agents[]` = one entry per tree node: `id` = `sessions.session_id` string, `parentId` = its `parent_session_id`, `prompt` = main: the joined `prompts`; sub-agent: its first user message through `cleanTaskText`.
  - `kbReads` = this node's `read`/`grep` rows (from `extractOkfAccess`) whose path is in a bundle of the root snapshot (all `.md` rows when there is no snapshot), with `ownEditBytes` = bytes of the `after_own_edit` rows and `size` from the snapshot (`null` without).
  - `kbSeq` = those paths ordered by `seq` (first-access order).
  - `otherReadsTop` = non-KB file reads (Read tool + `analyzeBash` `reads`, any extension, repo-relative via `resolveRepoPath`), summed bytes, top `OKF_FACTS_OTHER_READS_TOP`.
  - `changes` = this node's written repo-relative paths (Edit/Write/MultiEdit/NotebookEdit + `analyzeBash` `changes`), sorted, unique.
  - `tree` = union over nodes of `changes`, of all read paths, and `runs` = `analyzeBash` `runs` labels, unique, in first-seen order.
  - No tool result text anywhere.
- **DD-35 Identifiers in responses.** `agents[].id` (both routes) is the `sessions.session_id` string; `snapshot.takenAt` (repo route) = `okf_snapshots.created_at` of the latest snapshot; share values (`share`, `medianShare`, `maxShare`) are fractions 0–1, `startedFromIndex` tile is a count of KB sessions; `OkfFinding.node.bundle` is `string | null` (null = the "No longer in KB" group).
- **DD-38 Repo rules, exactly.** Let *KB sessions* = filtered root trees with ≥ 1 `read`/`grep` row on a path of a bundle visible in the view; for a bundle B, *B sessions* = KB sessions with such a row in B. Index files = each bundle's `index.md`. Every finding names its bundle.
  - `always_read` (severity `fix`): a non-index file f of B with (KB sessions that have a `read`/`grep` row on f) ÷ (KB sessions) ≥ `ALWAYS_READ_SHARE`. Snapshot-less trees count in both numerator and denominator.
  - `kb_flood`: only for B with ≥ `SHARE_MIN_BUNDLE_FILES` files and only over snapshot-bound trees; per tree, share(B) = distinct B files with a `read`/`grep` row ÷ B files; *flooded* = share > `FLOOD_SHARE`. Any flooded tree → `fix`; flooded ÷ snapshot-bound B sessions ≥ `FLOOD_MESS_SESSION_SHARE` → `mess`. One finding per bundle.
  - `coarse_article` (severity `fix`): a non-index file f of B with snapshot size ≥ `COARSE_MIN_SIZE_BYTES`, read (`read` op) in ≥ `COARSE_MIN_SESSIONS` KB sessions, and (Σ `read`-op bytes ÷ Σ `read`-op calls over those sessions) ÷ size < `COARSE_MAX_READ_RATIO`; `grep` rows ignored. Snapshot-less trees count.
  - Level: 0 KB sessions → `kb_not_used`; 1 … `REPO_MIN_KB_SESSIONS − 1` → `not_enough_data` (findings still listed); otherwise the worst finding severity, `ok` when none.
- **DD-39 Repo response fields.** Over KB sessions after the DD-30 filter and the `bundle` filter:
  - `OkfBundleSummary` on the repo route: `files` = the bundle's file count in the latest snapshot; `filesRead` = distinct bundle files with a `read`/`grep` row in any KB session; `share` = `filesRead ÷ files` (null when `files` is null); `readBytes` = KB read bytes summed over KB sessions.
  - per-session share = share of the selected bundle; with all bundles, the session's highest share among visible bundles that have a snapshot file list. `shareBins`, `medianShare`, `maxShare` use it, snapshot-bound trees only.
  - `kbFiles` = files of the latest snapshot in the selected (or all visible) bundles; `notRead` = those with no `read`/`grep` row in any KB session; `startedFromIndex` tile = KB sessions whose first access to the selected (any, for all) bundle was its `index.md`; `kbSessions` / `totalSessions` = KB sessions / all filtered root trees.
  - `hotFiles` = top `HOT_FILES_TOP_N` files by KB read bytes (`read` + `grep` bytes, own-edit rows included; `list`/`write` excluded — the same definition as `readTop` and `OkfBundleSummary.readBytes`), ties by path; `sessions` = KB sessions that read it.
  - `snapshot.branch` = `logs.git_branch` of the root `artisyn` log of the session whose snapshot was picked (DD-29).
- **DD-40 Tree markers.**

  | Marker | Session route | Repo route |
  |---|---|---|
  | `folder_scan` | folder node with ≥ 1 `grep` or `list` row on its folder key | same, summed over sessions |
  | `entry_point` | the bundle `index.md` when the tree's first access to the bundle (DD-27) is it | not set |
  | `own_edit` | file with `ownEditReadBytes > 0` | same |
  | `coarse` | not set | file named by a `coarse_article` finding |
  | `hot` | not set | file in `hotFiles` (marker label carries its rank) |

- **DD-41 Prompt filter (`okf-task-context`).** `filterUserPrompts` keeps string-content `user` entries that are not tool results and not `isMeta`; drops a prompt starting with `<task-notification>`, `<local-command-stdout>`, `<local-command-caveat>`, `<bash-stdout>` or `<system-reminder>`; strips embedded `<system-reminder>…</system-reminder>` blocks; a `<command-message>`-first prompt becomes `/<command-name> <command-args>` (trimmed); a `<command-name>`-first prompt (CLI utility such as `/clear`) is dropped; whitespace is collapsed and empty results dropped. `cleanTaskText` applies the same to one string and returns `null` when dropped.
- **DD-42 Export backward compatibility.** Import treats a missing `okfSnapshotId` in the zip session shape and missing OKF lines as "no snapshot" (column stays null); older Log Hub versions ignore the new field and lines (unknown NDJSON types are skipped).
- **DD-43 Hook default exclusion.** `OKF_DEFAULT_EXCLUDE = ['tmp/**']` lives in `okf-snapshot.js` and is concatenated with `config.okf.exclude` inside `buildOkfSnapshot`; `CONFIG_DEFAULTS.okf = { exclude: [] }` stays empty so a user list never removes it.
- **DD-44 Repo tab URL state.** The `okf*` params live only in `RepoOkfTab` (read/written with `useSearchParams`); `setMainTab` (`useRepositoryViewState.ts:104-113`) adds `'okf'` to the `mtab` branch and deletes every `okf*` param when leaving the tab.
- **DD-45 Update-hook link.** The FR-14 banner links to `ROUTES.apiKeys` (`client/src/app-routes.ts:17`, the page with the Install tab).

- **DD-47 Verdict strings** (client, `okf-verdict-text.ts`; `{x}` = finding params, `%` rounded to an integer, bytes via the existing byte formatter):

  | Key | Text |
  |---|---|
  | level `ok` / `fix` / `mess` / `kb_not_used` / `not_enough_data` | "OK" / "Something to fix" / "Mess" / "KB not used" / "Not enough data" |
  | qualifier `partial_data` (session) | "partial data — no KB snapshot" |
  | qualifier `partial_data` (repo) | "partial data — {withoutSnapshot} of {total} sessions without a snapshot" |
  | `session_share` | "agent {first 4 chars of agentId} read {share}% of {bundle} files ({read} of {total})" |
  | `always_read` | "`{path}` is read in {sessions} of {kbSessions} KB sessions ({share}%) — its key facts probably belong in `index.md`/`CLAUDE.md`, or it should be split" |
  | `kb_flood` | "`{bundle}`: in {sessions} sessions an agent read more than 25% of its files ({share}% of the sessions that used it)" |
  | `coarse_article` | "`{path}` ({size}) is read in {sessions} sessions, ~{avgReadBytes} per read ({ratio}%) — split it or add section pointers" |
  | entry `index` / `search` / `given` | "✓ index" / "grep" / "given" |

  Unknown rule ids render as the rule id plus raw params (forward compatibility).
- **DD-48 `okf-verdict.md` example cases** (one row each; inputs are per-node/per-session row aggregates plus bundle file lists):
  - session: agent reads 6 of 10 files of a 10-file bundle → `mess` (`session_share` 0.6); 3 of 10 → `fix`; 2 of 10 → `ok`; 9-file bundle, 9 of 9 → `ok` (bundle skipped); agent wrote 4 of 10 and read 3 of the other 6 → share 0.5 → `fix`; 12 agents each read the same 1 article of 82 → `ok`; agent greps then reads 2 articles without `index.md` → `ok`, entry `search`; no rows → `kb_not_used`; no bundle and no rows → `null`; rows but no snapshot → `ok` + `partial_data`, share rule skipped.
  - repo: 0 KB sessions → `kb_not_used`; 3 KB sessions with an always-read file → `not_enough_data` with the finding listed; file read in 44 of 49 → `always_read` `fix`; 39 of 49 → none; 161 KB (164 864 B) file read in 14 sessions, 56 read calls, 229 376 read bytes (4 096 B/call, ratio 0.0248) → `coarse_article`; same file at 49 KB → none; 1 of 20 bundle sessions flooded → `kb_flood` `fix`; 4 of 20 → `mess`; flooded sessions without a snapshot → not counted; team view with an ignored file read in every session → no finding names it.

### Release

- **DD-46 Version.** Root `package.json` `version` becomes `1.1.0`; its X.Y names the release line read by `scripts/ci/release-version.js` (`docs/knowledgebase/algorithms/release-version.md`), so the next release is `v1.1.0`. `server/package.json`, `client/package.json` and `artisyn-hooks-installer/package.json` keep their versions; the hook version is DD-20's `2.26.0`.

### Tests

- **DD-36 Scenario data.** Scenarios build their OKF sessions inline with `postLogs` + `ndjson` (`tests/scenarios/helpers/ingest.ts:24`) through a shared builder `tests/scenarios/helpers/okf.ts` (`okfSessionTree({ reads, subAgentReads, edits, snapshot })` → `artisyn` with `okf-snapshot` line + `claude` + `claude-subagent` bodies); no new golden fixture, so the `gs-01…gs-09` session counts other scenarios assert stay unchanged.
- **DD-37 Server `readAccess` coverage.** The server extraction table (`okf-access-extraction.md`) runs `analyzeBash` from the package with the real server parser, so its Bash rows (`sed -n`, `grep -n`, `grep -rn`, `cat a b`, `ls`) cover `readAccess` on the server; the client `bash-view.algo.test.ts` covers the same rows through the browser-shaped loader.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0075_okf_usage.sql` (+ `meta/` journal, lock) | DB changes | per Database changes; `npm run migrations:lock` |
| `server/src/database/schema/index.ts` | Drizzle schema | new tables/columns |
| `packages/bash-view/{package.json,tsconfig.json,README.md,src/*}` | shared bash analysis | DD-11, DD-12 |
| `client/src/viewer/lib/bash-view/*` | keep loader only | remove moved modules, re-point imports |
| every client importer of `lib/bash-view` (`useBashView.ts`, `BashCallList.tsx`, `ContextGrowthSubStepRow.tsx`, `StepDetailsModal.tsx`, `prompt-turn-helpers.tsx`, `BashCommandView.tsx`, `BashFileSummary.tsx`, `HighlightedScript.tsx`, `tool-bodies.tsx`, `ToolOutputBlock.tsx`; re-check with `grep -rl "lib/bash-view" client/src`) | importers | moved modules imported from `@loghub/bash-view`; loader imports stay |
| `client/vite.config.ts`, `client/tsconfig.json` | alias | like `@loghub/pricing` (`vite.config.ts:17,32`, `tsconfig.json:21,24`) |
| `server/package.json`, `server/package-lock.json` | deps | `@loghub/bash-view` `file:`, `web-tree-sitter` 0.27.1, `tree-sitter-bash` 0.25.1 |
| `scripts/build-assets.js`, `scripts/copy-wasm.js` (new), `scripts/scenarios/build-stand.mjs`, `Dockerfile` | ship WASM | `dist/wasm/*.wasm` |
| `server/src/logs/change-surface/path-normalise.ts` | `resolveRepoPath` | DD-6 |
| `server/src/logs/okf/server-bash-parser.ts` | server parser loader | DD-10 |
| `server/src/logs/okf/okf-access-extractor.ts` | FR-1/2/6 extraction | DD-1..8, DD-27 |
| `server/src/logs/okf/okf-access-writer.ts` | FR-3 writer | DD-9 |
| `server/src/logs/logs.service.ts`, `session-file-stats-writer.ts`, `repositories.service.ts` | writer call sites | DD-9 |
| `server/src/logs/okf/okf-snapshot.ts` | store/bind/load/known/sweep | clone of `harness-snapshot.ts` |
| `server/src/logs/artisyn-extractor.ts` | non-activity lines | add `okf-snapshot`, `okf-snapshot-ref` (`:87-98`) |
| `server/src/logs/logs-v2.controller.ts`, `upload-queue.service.ts` | upload params | DD-22 |
| `server/src/sessions/sessions.service.ts`, `server/src/teams/teams.service.ts` | orphan sweep | beside harness sweep |
| `server/src/logs/repository-export-import.service.ts` | export/import | OKF lines + rebind |
| `server/src/logs/export-import-zip.ts` | export zip session shape | add `okfSnapshotId` beside the session fields (`:81` area) |
| `server/src/logs/reports/harness-usage.service.ts` | reference only | its scope SQL is reused (extract a shared helper if it is private) |
| `server/src/logs/okf/okf-verdict.ts` | pure rules | DD-23..25 |
| `server/src/logs/okf/okf-task-context.ts` | prompt filter | FR-20, DD-28 |
| `server/src/logs/okf/okf-usage.service.ts` | session + repo responses | DD-26..32 |
| `server/src/logs/okf/okf-usage.types.ts` | response types | per API changes |
| `server/src/logs/okf/okf-facts.service.ts`, `okf-facts.controller.ts` | facts route | FR-20, DD-33 |
| `server/src/logs/repositories.controller.ts`, `server/src/logs/reports/reports.controller.ts`, `server/src/logs/logs.module.ts` | routes + providers | |
| `server/src/logs/okf/*.algo.spec.ts` (4 files) | algorithm tables | per Test coverage plan |
| `hook/.claude/telemetry_tool/okf-snapshot.js`, `okf-state.js` | hook detection/state | DD-13..19 |
| `scripts/build-hooks-installer.js` | installer file list | add both new hook modules next to `harness-snapshot.js` / `harness-state.js` (`:127-128`) |
| `hook/.claude/telemetry_tool/git-context.js`, `env-context.js`, `send-logs-hook.js`, `upload-logs.js`, `version.json` | hook wiring | DD-16, 17, 20 |
| `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js` | hook algo table | |
| `hook/INSTALL_HOOK.md`, `hook/HOW_HOOK_WORKS.md` | hook docs | `okf` key, OKF lines |
| `client/src/models/repositories.ts`, `client/src/viewer/api.ts` | types + fetchers | mirror server types |
| `client/src/viewer/tab-ids.ts`, `SessionTabBar.tsx`, `SessionDetailPane.tsx`, `RepositoryView.tsx`, `useRepositoryViewState.ts` | tab registration | |
| `client/src/viewer/pages/repository/session-log/okf/*` | session tab | Visual/UX notes |
| `client/src/viewer/pages/repository/okf/*` | repo tab | Visual/UX notes |
| `client/src/viewer/lib/okf/okf-verdict-text.ts` | rule id → text | shared by both tabs |
| `docs/knowledgebase/algorithms/okf-*.md` (4), `algorithms/README.md`, `algorithms/bash-command-view.md` | algorithm docs | |
| `docs/knowledgebase/okf-usage.md` (new), `index.md`, `db-tables.md`, `data-retention.md`, `hook-api-versioning.md`, `server-endpoint-map.md`, `api-reference.md`, `session-export-import.md`, `repo-local-packages.md`, `client-component-map.md`, `hook-installation.md` | KB | |
| `server/test/contract/registry/f16-post-turn.ts`, `f19-change-surface.ts`, `f21-reports.ts`, `f15-ingest.ts` | contract rows | |
| `tests/scenarios/helpers/okf.ts` (new helper) | OKF session builder | DD-36 |
| `tests/scenarios/**` (extend) | scenario steps | per Test coverage plan |
| `package.json` (root) | release line | `version` 1.0.0 → 1.1.0 (DD-46) |
| `docs/tasks/todo/2026-10-27-okf-usage-tab/fr6-investigation.md` (new) | FR-6 finding | input to `okf-access-extraction.md` |
| `docs/tasks/todo/2026-10-27-okf-usage-tab/wireframes/repo-okf-tab.svg` | wireframe fix | DD-31, DD-32 |

## API changes

All three are `GET`, read-only. Shared types live in `server/src/logs/okf/okf-usage.types.ts` and are mirrored in `client/src/models/repositories.ts`. Named exports: `OkfOp`, `OkfVerdictLevel`, `OkfFinding`, `OkfVerdict`, `OkfBundleSummary`, `OkfTreeNode`, `OkfAgent`, `SessionOkfUsageResponse`, `RepoOkfUsageResponse`, `OkfFactsResponse` (the last three are the response shapes in the table below; `OkfAgent` is the session route's `agents[]` element). Units per DD-35.

```ts
type OkfOp = 'read' | 'grep' | 'list' | 'write';
type OkfVerdictLevel = 'ok' | 'fix' | 'mess' | 'kb_not_used' | 'not_enough_data';
interface OkfFinding {
  rule: 'session_share' | 'always_read' | 'kb_flood' | 'coarse_article';
  severity: 'fix' | 'mess';
  params: Record<string, string | number>;        // DD-24 / DD-25
  node: { bundle: string | null; path?: string };  // null = "No longer in KB" group
}
interface OkfVerdict {
  level: OkfVerdictLevel;
  qualifiers: 'partial_data'[];
  partialData?: { withoutSnapshot: number; total: number }; // repo only
  findings: OkfFinding[];                         // worst first
}
interface OkfBundleSummary {
  root: string; index: string; ignored: boolean;
  files: number | null;              // null without snapshot
  filesRead: number; share: number | null;
  readBytes: number;                 // KB read bytes (read + grep, own-edit included)
  startedFromIndex: boolean | null;  // session route: FR-12 marker; repo route: null
  sessionsStartedFromIndex: number | null; // repo route: KB sessions whose first access to this bundle was its index.md; session route: null
}
interface OkfTreeNode {
  bundle: string | null;             // null = "no longer in KB" / unknown bundle (no snapshot)
  path: string;                      // file path or folder path ending '/'
  kind: 'bundle' | 'folder' | 'file';
  inSnapshot: boolean;               // false = "not in the KB at session start" / gone
  size: number | null;
  readBytes: number; readCalls: number; ownEditReadBytes: number;
  grepCalls: number; listCalls: number; writeCalls: number;
  agents: number;                    // distinct nodes (session) / distinct sessions (repo: `sessions`)
  markers: ('folder_scan' | 'entry_point' | 'own_edit' | 'coarse' | 'hot')[];
  children?: OkfTreeNode[];
}
```

| Endpoint | Method | Params | Response |
|---|---|---|---|
| `/api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` | GET | `teamId?` (team view) | `{ verdict: OkfVerdict \| null, hasSnapshot: boolean, readTop: {bundle, path, readBytes, ownEdit: boolean}[], bundles: OkfBundleSummary[], tree: OkfTreeNode[], agents: { id: string; taskHead: string; entry: 'index'\|'search'\|'given'\|null; kbReads: number; kbReadBytes: number; files: string[] }[] }` (`kbReads` = this agent's `read`+`grep` calls on bundle files, `kbReadBytes` their bytes, `files` = those bundle file paths sorted by read bytes desc, then path) — auth/visibility like `change-surface` (`repositories.controller.ts:1443`, `:1511-1549`); with `teamId`, DD-30 filter applies. |
| `/api/v1/repositories/:repoId/reports/okf-usage` | GET | `startDate`, `endDate`, `branches`, `users`, `teamId`, `attr`, `bundle?` | `{ verdict: OkfVerdict, snapshot: { okfSnapshotId, takenAt, branch } \| null, tiles: { kbFiles, notRead, kbSessions, totalSessions, startedFromIndex, medianShare, maxShare }, shareBins: { bin: '0-10'\|'10-25'\|'25-50'\|'50+'; sessions: number }[], hotFiles: {bundle, path, readBytes, sessions}[], notRead: {bundle, path, size}[], bundles: OkfBundleSummary[], tree: OkfTreeNode[] }` — scope via `resolveUsageScope` (`reports.controller.ts:698-750`), 403 rules of `resolveReportScope` (`:681`). Unknown `bundle` → treated as all. |
| `/api/v2/okf-usage/facts` | GET | `sessionId` (string, required) | `{ sessionId, startedAt, prompts: string[], agents: { id, parentId: string\|null, prompt: string, kbReads: {path, bytes, calls, ownEditBytes, size: number\|null}[], kbSeq: string[], otherReadsTop: {path, bytes}[], changes: string[] }[], tree: { changes: string[], reads: string[], runs: string[] } }` — `ApiKeyAuthGuard`, 404 for missing/foreign session (DD-33), 400 when `sessionId` missing. |
| `/api/v2/logs` (existing upload) | POST | + `okfSnapshotId?`, `okfSnapshotFull?=1` | + `unknownOkfSnapshotId?: string` (DD-22) |

## Database changes

Migration `server/drizzle/migrations/0075_okf_usage.sql` (template: `0073_harness_snapshots.sql`), then `npm run migrations:lock`:

1. `CREATE TABLE okf_snapshots (id serial PK, user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE, snapshot_id varchar(64) NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, snapshot_id))`.
2. `ALTER TABLE sessions ADD COLUMN okf_snapshot_id varchar(64)` (no FK, like `harness_snapshot_id`) + `CREATE INDEX sessions_okf_snapshot_id_idx ON sessions(okf_snapshot_id)`.
3. `ALTER TABLE upload_queue ADD COLUMN okf_snapshot_id varchar(64)` (nullable).
4. `CREATE TABLE session_okf_access (id serial PK, session_id int NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, path_key varchar(1024) NOT NULL, op varchar(8) NOT NULL CHECK (op IN ('read','grep','list','write')), after_own_edit boolean NOT NULL DEFAULT false, bytes bigint NOT NULL DEFAULT 0, calls int NOT NULL DEFAULT 0, seq int NOT NULL, UNIQUE (session_id, path_key, op, after_own_edit))` — the unique index's leading `session_id` serves the per-node delete and the tree read.

No data migration; history is filled by `POST :repoId/recompute-all-sessions` (FR-5). Apply the `migrations-data-integrity` skill when writing the migration.

## Dependencies

- `server`: `web-tree-sitter@0.27.1`, `tree-sitter-bash@0.25.1` (same versions as `client/package.json:38-39`) — the server must run the same bash analysis as the client (FR-20); `@loghub/bash-view` as `file:../packages/bash-view`.
- No new client or hook dependencies.

## Test coverage plan

Only the three kinds allowed by CLAUDE.md.

**Algorithm** (new docs → new table tests, allowed together):

- `docs/knowledgebase/algorithms/okf-access-extraction.md` → `server/src/logs/okf/okf-access-extractor.algo.spec.ts`: rows for Read with offset/limit, `sed -n 10,40p`, `grep -n`, `cat`, multi-file `cat a b` (DD-2 split), `grep -rn` over a folder (DD-4), Glob, Edit then Read (own edit), path outside roots (dropped), `\` paths, duplicate `tool_use` id (DD-8), a non-`.md` file (dropped).
- `docs/knowledgebase/algorithms/okf-snapshot.md` → `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js`: two bundles, nested index without/with `okf_version`, `tmp/` default exclusion, `okf.exclude`, link to `../private_kb` not followed, id stable under reordering and mtime change, id changes on content change.
- `docs/knowledgebase/algorithms/okf-task-context.md` → `server/src/logs/okf/okf-task-context.algo.spec.ts`: adlc slash command kept as `/adlc-lh:implement-deep <task>`, `/clear` dropped, `<task-notification>` dropped, system reminder dropped, one-line question kept.
- `docs/knowledgebase/algorithms/okf-verdict.md` → `server/src/logs/okf/okf-verdict.algo.spec.ts`: the cases of DD-48.
- Existing `docs/knowledgebase/algorithms/bash-command-view.md` gets rows for `readAccess` kinds (DD-12); its client table test stays at `client/src/viewer/lib/bash-view/bash-view.algo.test.ts` (client vitest runs it), imports the package and picks them up.

**API contract** (`server/test/contract/registry/`):

- session `okf-usage` rows in `f19-change-surface.ts` (same scope family: personal, and team view with an ignored path absent); report `okf-usage` row in `f21-reports.ts`; facts route rows in `f16-post-turn.ts` (owner 200, foreign key 404, missing `sessionId` 400); upload rows in `f15-ingest.ts` for `okfSnapshotId` known/unknown and invalid id ignored.

**Scenario** (extend existing):

- `@S-SESS-09` (`tests/scenarios/view/s-sess-09.spec.ts`): open the OKF tab of a session tree seeded by `helpers/okf.ts` (DD-36) that reads KB articles — verdict card, tree heat, bytes/calls toggle, own-edit and folder-scan markers, clicking a Why line scrolls to the node; sub-agent read appears (FR-4).
- `@TOUR-05` (`tours/tour-05-session-detail.spec.ts` + `tours/screen-registry.ts`): register the new session tab; `@TOUR-04` (`tours/tour-04-analytics-reports.spec.ts`): register the repo OKF tab.
- `@S-HOOK-09` (`hook/s-hook-09.spec.ts`): the real plugin uploads an `okf-snapshot` on the first upload and only `okf-snapshot-ref` on the second (FR-10), `okf.exclude` drops a bundle (FR-9).
- `@S-HOOK-01` (`hook/s-hook-01.spec.ts`): a fake Log Hub that ignores OKF params (old server) still gets a successful upload (new hook → old server).
- `@S-COMPAT-01` (`hook/s-compat-01.spec.ts`): frozen old hook upload → `okf_snapshot_id` null, session OKF tab shows the "update the hook" hint (FR-14).
- `@S-REPO-16` (`repos/s-repo-16.spec.ts`): team view of a repo with an ignored bundle has no ignored path — on the repo tab and on a session's OKF tab; personal view shows it; recompute-all-sessions fills `session_okf_access` for pre-existing sessions (FR-5, FR-17); repo OKF tab filters (bundle filter switches tree/tiles/histogram).
- `@S-REPO-09` (`repos/s-repo-09.spec.ts`): export/import keeps the OKF bundles, and a zip without `okfSnapshotId` still imports (DD-42); `@S-REPO-11` rebind step asserts `okf_snapshot_id` rebinding; delete-last-session sweeps the `okf_snapshots` row (in `@S-REPO-09` or the session-delete step already there).
- `@S-REPT-01` (`tests/scenarios/view/s-rept-01.spec.ts`): repo OKF tab verdict card with ≥ 5 KB sessions seeded by `helpers/okf.ts` (always read / coarse lines), plus a 3-session filter that shows Not enough data.

## Visual/UX notes

- **Session tab** (`session-okf-tab.svg`): tab label "OKF" between "Harness usage" and "Raw Logs". Top: verdict card (badge colours via existing `ui/badge.tsx` variants: green OK, amber Something to fix, red Mess, grey KB not used / Not enough data; "partial data" as a grey outline chip), Why lines (clickable, worst first), Read top 5 with ↻ own-edit icon, "How agents reached the KB" chips (`✓ index` / `grep` / `given`). Then bundle cards (tracked/gitignored chip, "✓ started from index.md", FILES READ `n / N · p %`, BYTES INTO CONTEXT), then a two-column area: tree (left, columns READ bar + value, WRITE bar, MARKERS; "not read" rows neutral grey, sorted last) and Agents panel (right, 280 px; click toggles the tree filter; selected agent highlighted). Header toggle Bytes/Calls (segmented control). Info box "Deeper analysis: run the local KB-completeness skill" (static text, no link to an LLM action). Without a snapshot: amber banner "No KB snapshot — update the Log Hub hook" with link to the install instructions.
- **Repo tab** (`repo-okf-tab.svg`): tab "OKF" between Reports and Settings, visible where `canSeeTeamWideTabs` allows Analytics. Filter strip reusing `DateRangePicker`, branch/user popovers (pattern of `ReportParameterStrip.tsx:134,141`, but an own `OkfFilterStrip` since that strip is tied to `mtab=reports`), `AttributeFilterPopover`, bundle select, Bytes/Calls toggle; filters apply immediately and are mirrored to URL params (`okfFrom`, `okfTo`, `okfBranches`, `okfUsers`, `okfAttr`, `okfBundle`, `okfHeat`). Verdict card + anomaly list, five KPI tiles (`KpiTiles.tsx:80` style), histogram (four CSS bars, no chart library), hot files list, not-read list (neutral, inline "Show all"), tree (columns READ, SESSIONS, WRITE, AGENTS; markers 🔥 hot #n, coarse; "No longer in KB" group last).
- Loading: skeleton rows like `SessionChangeSurfaceTab`; errors: inline error card; empty: "KB not used in this period".
- Light-only colour scheme (`ui-principles.md`); heat bars reuse `ChurnBar` styling from `change-surface-tree-rows.tsx:36`.
- Verdict text: `client/src/viewer/lib/okf/okf-verdict-text.ts`, per DD-47.

## Wireframes

- `repo-okf-tab.svg`: remove the Personal/Team toggle (DD-32 — the view follows the route) and the node side drawer (DD-31); remove "Show all →" from hot files (top 10 only).
- `session-okf-tab.svg`: no change.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema & migration | 4 | first; everything server-side depends on it |
| 2 | Shared bash-view package | 7 | before server extraction; client keeps working |
| 3 | Server bash parser & access extraction | 7 | needs 1, 2 |
| 4 | Access writer wiring | 5 | needs 3 |
| 5 | Server OKF snapshot ingest | 7 | needs 1 |
| 6 | Snapshot lifecycle: sweep, export/import | 4 | needs 5 |
| 7 | Hook snapshot builder | 6 | wire format from 5 |
| 8 | Hook delivery & release | 6 | needs 7 |
| 9 | Server verdict & task context | 5 | needs 3 |
| 10 | Server usage services | 6 | needs 4, 5, 9 |
| 11 | Server routes | 5 | needs 10 |
| 12 | Client types, API, tab registration | 8 | needs 11 |
| 13 | Client session OKF tab | 7 | needs 12 |
| 14 | Client repo OKF tab | 7 | needs 12 |
| 15 | Docs & KB | 8 | after code |
| 16 | Tests — algorithm | 5 | after 3, 7, 9 and 15 (examples blocks) |
| 17 | Tests — contract & session/hook scenarios | 5 | needs all code chunks |
| 18 | Tests — repo scenarios, version & final run | 5 | last |

### Chunk 1 — Schema & migration
- [ ] Load the `migrations-data-integrity` skill, then create `server/drizzle/migrations/0075_okf_usage.sql` with the four statements in Database changes and its drizzle `meta/` journal entry.
- [ ] Add `okfSnapshots` table, `sessions.okfSnapshotId` (+ index `sessions_okf_snapshot_id_idx`), `uploadQueue.okfSnapshotId`, and `sessionOkfAccess` table (columns per Database changes) to `server/src/database/schema/index.ts`, with comments mirroring the `harnessSnapshotId` ones.
- [ ] Run `npm run migrations:lock` in `server/` to update the migrations lock file.
- [ ] Run `npm run typecheck` in `server/` and fix schema type errors.

### Chunk 2 — Shared bash-view package
- [ ] Create `packages/bash-view/` (`package.json` named `@loghub/bash-view`, `tsconfig.json`, `README.md`) copying the shape of `packages/pricing/`.
- [ ] Add `packages/bash-view/src/syntax.ts` with the structural types and `withTree` per DD-11; export everything from `src/index.ts`.
- [ ] Move `bash-analyze.ts`, `bash-format.ts`, `bash-view.ts`, `bash-highlight.ts`, `display-paths.ts` from `client/src/viewer/lib/bash-view/` to `packages/bash-view/src/`, replacing `web-tree-sitter` type imports with `syntax.ts` types and using `.ts` relative imports.
- [ ] Add `readAccess` to `BashAnalysis` and fill it in `analyzeBash` per DD-12 / DD-3 (kind from the command base name).
- [ ] Reduce `client/src/viewer/lib/bash-view/` to `bash-parser.ts` and `browser-parser.ts` typed against the package's `BashParser`; re-point every importer listed in Files to create/modify and `bash-view.algo.test.ts` to `@loghub/bash-view`.
- [ ] Add the `@loghub/bash-view` alias to `client/vite.config.ts` and `client/tsconfig.json` (paths + include) like `@loghub/pricing`.
- [ ] Run client `bun run typecheck`, `bun run lint`, `bun run test` and fix failures.

### Chunk 3 — Server bash parser & access extraction
- [ ] Add `@loghub/bash-view` (`file:../packages/bash-view`), `web-tree-sitter@0.27.1`, `tree-sitter-bash@0.25.1` to `server/package.json`; install to update `server/package-lock.json`.
- [ ] Create `server/src/logs/okf/server-bash-parser.ts` per DD-10 (`getServerBashParser(): Promise<BashParser | null>`, cached, warning on failure).
- [ ] Ship WASM: new `scripts/copy-wasm.js` (`copyWasm(targetDir)` copies both `.wasm` files from `server/node_modules` to `<target>/wasm/`), call it from `scripts/build-assets.js` and `scripts/scenarios/build-stand.mjs` next to `copyNative`, and add the same copy to the `Dockerfile` server-build stage.
- [ ] Add `resolveRepoPath(absPath, roots): string | null` to `server/src/logs/change-surface/path-normalise.ts` per DD-6.
- [ ] Create `server/src/logs/okf/okf-access-extractor.ts`: `extractOkfAccess(entries, roots, parser): OkfAccessRow[]` implementing DD-1 to DD-8 and the `seq` of DD-27; rows `{pathKey, op, afterOwnEdit, bytes, calls, seq}`.
- [ ] FR-6 investigation: on local data (`mcp__postgres__query`, read-only) find a sub-agent with paired identical Reads, determine whether they are one log uploaded twice, two `tool_use` ids or two sessions; record the finding in `docs/tasks/todo/2026-10-27-okf-usage-tab/fr6-investigation.md`.
- [ ] Run server `npm run typecheck` and `npm run lint`; fix failures.

### Chunk 4 — Access writer wiring
- [ ] Create `server/src/logs/okf/okf-access-writer.ts`: `writeSessionOkfAccess(tx, sessionDbId, rows)` per-node delete-then-insert (DD-9).
- [ ] Call extraction + writer in ingest Step 3b (`server/src/logs/logs.service.ts:452`) and in import (`:1041`) for `claude` / `claude-subagent` logs, using the same roots `writeSessionFileStats` receives.
- [ ] Rebuild OKF rows inside `rewriteSessionTreeFileStats` (`server/src/logs/session-file-stats-writer.ts:211`) from the already reparsed bodies, so the claude-before-artisyn heal also fixes OKF rows.
- [ ] Add private `recomputeOkfAccess(treeSessionIds)` to `server/src/logs/repositories.service.ts` and call it once from `recomputeAllSessionStats` (`:1280`) over the gathered tree ids, per DD-9 (FR-5 backfill).
- [ ] Run server `npm run typecheck`, `npm run lint`, `npm run test`; fix failures.

### Chunk 5 — Server OKF snapshot ingest
- [ ] Create `server/src/logs/okf/okf-snapshot.ts` cloned from `server/src/logs/harness-snapshot.ts`: `OKF_SNAPSHOT_MAX_BYTES`, `extractOkfSnapshot`, `extractOkfSnapshotRef`, `storeOkfSnapshot`, `bindSessionOkfSnapshot` (DD-21), `loadOkfSnapshot`, `isOkfSnapshotKnown` (DD-22), `deleteOrphanOkfSnapshots`, `resolveRootOkfSnapshotId(sessionDbId)` via `topAncestorIdsSql`.
- [ ] Add `okf-snapshot` and `okf-snapshot-ref` to `NON_ACTIVITY_LINE_TYPES` in `server/src/logs/artisyn-extractor.ts:87-98`.
- [ ] In `server/src/logs/logs-v2.controller.ts` accept `okfSnapshotId` / `okfSnapshotFull` beside `snapshotId` (`:53-54`, `:86-93`, silent validation), pass them to `saveRawUpload` / `saveChunk` (`:121`, `:228`), and add `unknownOkfSnapshotId` to responses (`:128-134`, `:239-249`) via a `resolveUnknownOkfSnapshotId` like `:270`.
- [ ] Persist `okfSnapshotId` in `server/src/logs/upload-queue.service.ts` queue metadata and the `okf_snapshot_id` insert (`:18,32,113,183`), only when the full flag is set (mirror harness).
- [ ] In `server/src/logs/logs.service.ts` add the OKF store-then-bind step after Step 5d (`:579-614`) for root `artisyn` uploads, and the same in import (`:1068-1081`).
- [ ] Add `okfSnapshotId: string | null` to the session shape in `server/src/logs/export-import-zip.ts` (`:81` area) and fill it wherever that shape is built.
- [ ] Run server `npm run typecheck`, `npm run lint`, `npm run test`; fix failures.

### Chunk 6 — Snapshot lifecycle: sweep, export/import
- [ ] In `purgeSessionChildData()` (`server/src/sessions/sessions.service.ts:171-230`) add step c2 deleting `session_okf_access` rows for `ids` (soft delete keeps the `sessions` row), null `sessions.okf_snapshot_id` in step g and call `deleteOrphanOkfSnapshots(tx)` after the harness sweep in step h.
- [ ] Add the same OKF sweep next to the harness sweep in `server/src/teams/teams.service.ts:641`.
- [ ] In `server/src/logs/repository-export-import.service.ts` add `okfSnapshotId` to the session row (`:76`), emit `okf-snapshot` + `okf-snapshot-ref` lines like `buildExportHarnessSnapshotLines` (`:937-985`), and make import rebind via the Chunk 5 import step (`:649` → `importSession`), tolerating old zips per DD-42.
- [ ] Run server `npm run typecheck`, `npm run lint`; fix failures.

### Chunk 7 — Hook snapshot builder
- [ ] Add `gitWithInput(args, cwd, input, timeoutMs)` to `hook/.claude/telemetry_tool/git-context.js` per DD-16 (returns `{ status, stdout }`, `windowsHide: true`).
- [ ] Add the `'object'` kind to `matchesType`, `okf: { exclude: [] }` to `CONFIG_DEFAULTS` and `okf: 'object'` to `CONFIG_TYPES` in `hook/.claude/telemetry_tool/env-context.js` (DD-17); drop a non-array `exclude` with a log line.
- [ ] Create `hook/.claude/telemetry_tool/okf-snapshot.js`: `detectOkfBundles(projectRoot, exclude)`, `globToRegExp`, `computeOkfSnapshotId`, `buildOkfSnapshot({projectRoot, config, log})` per DD-13 to DD-16, DD-18 and DD-43.
- [ ] Create `hook/.claude/telemetry_tool/okf-state.js` per DD-19 (clone of `harness-state.js`, file `okf-state.json`).
- [ ] Measure `buildOkfSnapshot` on this repo and on a generated tree of 5 000 `.md` files (scratchpad); if over 300 ms, add an mtime-tree cache in `okf-state.json` keyed by the sorted `(path, mtimeMs, size)` list; record timings for Chunk 15.
- [ ] Run hook `npm test`; fix failures.

### Chunk 8 — Hook delivery & release
- [ ] In `hook/.claude/telemetry_tool/send-logs-hook.js` add `getOkfPrefix()` beside `getHarnessPrefix` (`:1204-1268`) under the same gate (`:1448`, `:1460`) per DD-20; prepend its lines to the root `artisyn` body after the harness lines.
- [ ] In `hook/.claude/telemetry_tool/upload-logs.js` send `okfSnapshotId` / `okfSnapshotFull=1` query params (`:448-453`) and parse `unknownOkfSnapshotId` (`:504-520`, `:876`); on success `rememberOkfSnapshot`, on unknown echo `forgetOkfSnapshot` (DD-20).
- [ ] Make every OKF failure (detection, git, state) log and continue without OKF lines — the upload must never fail because of OKF.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.26.0`; add `okf-snapshot.js` and `okf-state.js` to the shipped file list in `scripts/build-hooks-installer.js` (`:127-128`).
- [ ] Document the `okf` config key in `hook/INSTALL_HOOK.md` (`:406-437`) and the OKF lines/state in `hook/HOW_HOOK_WORKS.md` (`:195-216`, `:326-338`); run the `update-install-instructions` skill.
- [ ] Run `npm run build:hooks-installer` and refresh the dogfooded install under `.artisyn/marketplace/plugins/log-hub-hooks/` per `.claude/rules/hook.md`; run hook `npm test`.

### Chunk 9 — Server verdict & task context
- [ ] Create `server/src/logs/okf/okf-usage.types.ts` with the named exports listed in API changes.
- [ ] Create `server/src/logs/okf/okf-verdict.ts` with the DD-23 constants and pure `computeSessionVerdict(input)` (DD-24) and `computeRepoVerdict(input)` (DD-25, DD-38), inputs as plain per-node / per-session row aggregates plus snapshot bundles.
- [ ] Add pure helpers in the same file: `fileShare`, `shareBin` (DD-23 `SHARE_BINS`), `median`, `agentEntry` (DD-26), `startedFromIndex` (FR-12 per DD-27).
- [ ] Create `server/src/logs/okf/okf-task-context.ts`: `cleanTaskText(raw): string | null` and `filterUserPrompts(entries): string[]` per DD-41 (slash-command shape rule from `docs/knowledgebase/harness-usage-tab.md`; PoC reference `docs/pocs/2026-10-27-1950-okf-analysis-cost/facts.ts:41-52`).
- [ ] Run server `npm run typecheck`, `npm run lint`; fix failures.

### Chunk 10 — Server usage services
- [ ] Create `server/src/logs/okf/okf-usage.service.ts` `getSessionOkfUsage(sessionDbId, { teamFilter })`: load tree rows via `getDescendantSessionIds`, root snapshot via `resolveRootOkfSnapshotId`, build `bundles`, `tree`, `readTop`, `agents` (DD-26, DD-28 from `logs.first_prompt`), verdict via `computeSessionVerdict`.
- [ ] Add tree building to the service: bundle → folder → file nodes from the snapshot plus accessed paths, folder rows aggregated onto folder nodes, markers per DD-40, `inSnapshot` flags.
- [ ] Add `getRepoOkfUsage(scope: AnalyticsScope, bundle?)`: select root sessions with the scope's dates/branches/users/attributes (reuse the scope SQL used by `server/src/logs/reports/harness-usage.service.ts`), latest snapshot per DD-29, fold rows by path, tiles, share bins, hot files and not-read list per DD-39, verdict via `computeRepoVerdict`.
- [ ] Implement the team fail-closed filter per DD-30 as one function applied before verdict and tree in both service methods.
- [ ] Create `server/src/logs/okf/okf-facts.service.ts` `getFacts(sessionIdString, userId)` building the facts per DD-34 with ownership per DD-33.
- [ ] Run server `npm run typecheck`, `npm run lint`; fix failures.

### Chunk 11 — Server routes
- [ ] Add `GET :repoId/sessions/:sessionId/okf-usage` to `server/src/logs/repositories.controller.ts` next to `change-surface` (`:1443`), scoped by `resolveChangeSurfaceSessionScope` (`:1511-1549`), passing the team filter when `teamId` is set.
- [ ] Add `GET :repoId/reports/okf-usage` to `server/src/logs/reports/reports.controller.ts` next to `reports/harness-usage` (`:294-339`), scope via `resolveUsageScope` (`:698-750`), optional `bundle` query param.
- [ ] Create `server/src/logs/okf/okf-facts.controller.ts` `@Controller('api/v2/okf-usage')` `GET facts` with `ApiKeyAuthGuard` like `server/src/logs/post-turn-analysis/post-turn-analysis.controller.ts:57-119`; 400 when `sessionId` missing.
- [ ] Register the new services and controller in the logs Nest module.
- [ ] Run server `npm run typecheck`, `npm run lint`, `npm run test`; fix failures.

### Chunk 12 — Client types, API, tab registration
- [ ] Mirror the API changes types in `client/src/models/repositories.ts` (next to `:656`).
- [ ] Add `fetchSessionOkfUsage(repoId, sessionId, teamId?)` and `fetchRepoOkfUsage(repoId, params)` to `client/src/viewer/api.ts` (pattern `:702,717,770-787`), sending `attr` and `bundle`.
- [ ] Add `'okf'` to `SESSION_TABS` after `'harness-usage'` and to `REPO_MAIN_TABS` after `'reports'` in `client/src/viewer/tab-ids.ts`; add `'okf'` to the `mtab` branch of `setMainTab` in `useRepositoryViewState.ts:104-113` and clear `okf*` params there per DD-44.
- [ ] Create minimal `SessionOkfTab.tsx` (in `client/src/viewer/pages/repository/session-log/okf/`) and `RepoOkfTab.tsx` (in `client/src/viewer/pages/repository/okf/`) shells that render a heading, so the tab wiring compiles; Chunks 13/14 fill them.
- [ ] Add the "OKF" tab to `SessionTabBar.tsx` (after Harness usage, `:68`) and a lazy import + branch in `SessionDetailPane.tsx` (`:45-58`, `:301-380`).
- [ ] Add the "OKF" tab label and content to `RepositoryView.tsx` (`:47-52`, `:350-460`), gated like Analytics (`canSeeTeamWideTabs`, `:98`).
- [ ] Create `client/src/viewer/lib/okf/okf-verdict-text.ts` `formatOkfFinding`, `levelLabel`, `qualifierLabel`, `entryLabel` per DD-47.
- [ ] Run client `bun run typecheck` and `bun run lint`; fix failures.

### Chunk 13 — Client session OKF tab
- [ ] Fill `session-log/okf/SessionOkfTab.tsx` (under `client/src/viewer/pages/repository/`): `useQuery` like `SessionChangeSurfaceTab.tsx:62-75`, loading/error/empty states, Bytes/Calls toggle state.
- [ ] Create `OkfVerdictCard.tsx` (badge, Why lines, Read top 5, entry chips) in the same folder; reused by the repo tab via a `variant` prop.
- [ ] Create `OkfBundleCards.tsx` (per-bundle summary per Visual/UX notes).
- [ ] Create `okf-tree.ts` (flatten/expand/filter-by-agent helpers) and `OkfTree.tsx` + `okf-tree-rows.tsx` reusing `ROW_HEIGHT` / `ChurnBar` patterns from `change-surface-tree-rows.tsx:19,36,60`; `scrollToNode(bundle, path)` expands and scrolls.
- [ ] Create `OkfAgentsPanel.tsx` (list, click toggles the tree agent filter).
- [ ] Add the no-snapshot banner (link per DD-45) and the static "Deeper analysis" info box to `SessionOkfTab.tsx`.
- [ ] Load the `ui-components` skill, keep each component under the client size threshold, run client `bun run typecheck`, `bun run lint`; fix failures.

### Chunk 14 — Client repo OKF tab
- [ ] Fill `client/src/viewer/pages/repository/okf/RepoOkfTab.tsx` with `useQuery` keyed by the filter state and `okf*` URL params per DD-44.
- [ ] Create `OkfFilterStrip.tsx` (date range via `DateRangePicker`, branch/user toggles, `AttributeFilterPopover`, bundle select, Bytes/Calls); filters apply immediately.
- [ ] Create `OkfKpiTiles.tsx` (five tiles) and `OkfShareHistogram.tsx` (four CSS bars with counts).
- [ ] Create `OkfHotFiles.tsx` and `OkfNotReadList.tsx` (neutral styling, inline "Show all").
- [ ] Reuse `OkfVerdictCard` (repo variant: session count, anomaly lines) and `OkfTree` (columns READ, SESSIONS, WRITE, AGENTS; hot/coarse markers; "No longer in KB" group); anomaly click scrolls to node.
- [ ] Update `wireframes/repo-okf-tab.svg` per the Wireframes section.
- [ ] Run client `bun run typecheck`, `bun run lint`, `bun run test`; visually check both tabs with the `use-playwright` skill.

### Chunk 15 — Docs & KB
- [ ] Write `docs/knowledgebase/algorithms/okf-access-extraction.md` (DD-1..8, DD-27, FR-6 finding from `fr6-investigation.md`) and `okf-task-context.md`, each with Purpose/Code/Rules/Edge cases/Examples/Mutations/Where visible and one `examples` block of rows listed in Test coverage plan.
- [ ] Write `docs/knowledgebase/algorithms/okf-snapshot.md` (DD-13..18, detection timings) and `okf-verdict.md` (DD-23..26, DD-30, DD-38, examples per DD-48) with their examples blocks; add four rows to `docs/knowledgebase/algorithms/README.md`.
- [ ] Update `docs/knowledgebase/algorithms/bash-command-view.md`: package location, `readAccess` rule, new example rows.
- [ ] Write `docs/knowledgebase/okf-usage.md` (feature overview: tables, routes, services, tabs, team filter) and add it to `docs/knowledgebase/index.md`.
- [ ] Update `db-tables.md`, `data-retention.md` (`session_okf_access` delete in step c2, OKF sweep in steps g/h), `session-export-import.md`, `hook-api-versioning.md` (new 2.26.0 section and matrix rows for OKF params), `hook-installation.md` (`okf` key).
- [ ] Add the three routes to `server-endpoint-map.md` (pattern lines 278, 290-291) and `api-reference.md`.
- [ ] Update `repo-local-packages.md` (add `@loghub/bash-view` row; structural-types rule for parser-backed packages) and `client-component-map.md` (new okf folders, bash-view move).
- [ ] Run the `post-impl-check-kb-actual` skill over the touched KB files.

### Chunk 16 — Tests — algorithm
- [ ] Create `server/src/logs/okf/okf-access-extractor.algo.spec.ts` loading `okf-access-extraction.md` examples via `loadExamples` (pattern `server/src/logs/tool-stats.algo.spec.ts:7-17`), with the real server bash parser.
- [ ] Create `server/src/logs/okf/okf-task-context.algo.spec.ts` and `server/src/logs/okf/okf-verdict.algo.spec.ts` the same way.
- [ ] Create `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js` (template `__tests__/harness-snapshot.algo.test.js:155`, temp repos via `__tests__/test-helpers.js`).
- [ ] Confirm `client/src/viewer/lib/bash-view/bash-view.algo.test.ts` (not moved, imports re-pointed) picks up the new `readAccess` rows.
- [ ] Run server `npm run test`, client `bun run test`, hook `npm test`, root `npm run test:scripts`; fix failures.

### Chunk 17 — Tests — contract & session/hook scenarios
- [ ] Create `tests/scenarios/helpers/okf.ts` with `okfSessionTree(...)` per DD-36.
- [ ] Add contract rows: session `okf-usage` in `server/test/contract/registry/f19-change-surface.ts`, report `okf-usage` in `f21-reports.ts`, facts (owner 200, foreign 404, missing 400) in `f16-post-turn.ts`, OKF upload params (known/unknown/invalid) in `f15-ingest.ts`.
- [ ] Extend `@S-SESS-09` (`tests/scenarios/view/s-sess-09.spec.ts`) with the session OKF tab steps per Test coverage plan; register the tab in `@TOUR-05` and `tours/screen-registry.ts`.
- [ ] Extend `@S-HOOK-09` with first-full/second-ref and `okf.exclude` steps; extend `@S-HOOK-01` with the old-server fake Log Hub step.
- [ ] Extend `@S-COMPAT-01` with the null `okf_snapshot_id` and "update the hook" hint step.

### Chunk 18 — Tests — repo scenarios, version & final run
- [ ] Extend `@S-REPO-16` with team/personal ignored-bundle steps on the repo OKF tab and on one session's OKF tab (team URL), recompute backfill and bundle-filter steps.
- [ ] Extend `@S-REPO-09` / `@S-REPO-11` with OKF export/import, rebind, old-zip (no `okfSnapshotId`) import, and delete-session steps (`session_okf_access` rows gone, orphan `okf_snapshots` row swept); extend `@S-REPT-01` with the repo verdict card and Not-enough-data steps per Test coverage plan; register the repo tab in `@TOUR-04`.
- [ ] Run each touched scenario alone (`npm run test:scenarios -- --mode <a|b|c> --only scenarios,contract --grep "<@S-TAG>"`) and fix failures.
- [ ] Set root `package.json` `version` to `1.1.0` per DD-46 and run root `npm run test:scripts`.
- [ ] Run `adlc-lh:check-health` with `finalRun: true`.
