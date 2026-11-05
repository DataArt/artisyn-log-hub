# Implementation plan — 2026-11-03 OKF View: tell what to change in the KB and where

## TL;DR

- **New pure server modules:**
  - `server/src/logs/okf/okf-pointers.ts`: `extractPointers`, `isNewPointer`, `isPartialResult`.
  - `server/src/logs/okf/okf-value-signals.ts`: `computeArticleSignals` → area, FR-1 yield, FR-2, FR-3, FR-13, FR-15.
  - `server/src/logs/okf/okf-thresholds.ts`: `DEFAULT_OKF_THRESHOLDS`, `resolveOkfThresholds`, `validateOkfThresholds`.
- **Extractor:** `extractOkfDetail` returns access rows plus code events, pointers and the ordered sequence. `extractOkfAccess` becomes a thin wrapper around it.
- **`@loghub/bash-view`:** `BashReadAccess` gets two optional fields, `range` and `pattern`, and `git grep` becomes a `grep` read.
- **DB, migration `0091_okf_value_signals.sql`, additive only:**
  - New tables `session_okf_event` and `session_okf_pointer`.
  - `session_okf_access`: new columns `ranged_calls`, `ranged_bytes` and `search_hits`.
  - `sessions`: new columns `okf_extract_version` and `okf_events_truncated`.
  - `RepoConfigJson.okf` lives in jsonb and needs no migration.
- **API:**
  - New route `GET /api/v1/repositories/:repoId/reports/okf-usage/article?path=`.
  - Additive optional fields on the session and repo `okf-usage` responses, including `canRecompute` from the new `okfCanRecompute` helper.
  - The facts route (`GET /api/v2/okf-usage/facts`) gains per-agent `accessSeq`, and the settings response gains `okfDefaults`.
  - Saving settings skips the derived-stats recompute when only `okf` changed.
- **Server constants:** a new `server/src/logs/okf/okf-constants.ts`. `normaliseSnapshot` moves to `okf-snapshot.ts` so the writer can use it.
- **Config resolution:** `okf` is resolved per section (personal row's `okf` → team row's `okf` → defaults). `resolveEffectiveConfig()` stays as it is for every other field.
- **Client:**
  - A new article drill-down (`OkfArticleDrillDown`, URL param `okfArticle`, API call `getOkfArticle`) and an `okf-action-text.ts` dictionary.
  - An "OKF thresholds" Settings block.
  - New columns, markers and panels on both OKF tabs.
- **Lifecycle and validation:**
  - `purgeSessionChildData` deletes the new rows and resets the marker.
  - `validateConfig` returns 400 for an invalid `okf`.
- **Tests:** a new algorithm doc `okf-value-signals.md` with its rows file and `okf-value-signals.algo.spec.ts`.
- **Hooks:** no change. Existing sessions get the new data only through `recompute-all-sessions`.

## Reference

- Requirements: [requirements.md](requirements.md) (GH-88)
- Probe evidence: [notes.md](notes.md); research archive: [research/findings-1.md](research/findings-1.md)

## Design Decisions

**Extraction (stored raw, no thresholds)**

- **DD-0 Constants.** `server/src/logs/okf/okf-constants.ts` exports these; the extractor, writer, read side and value-signals module import them from there.

  | Constant | Value |
  |---|---|
  | `OKF_EXTRACT_VERSION` | 2 |
  | `OKF_EVENT_SKIP_SEGMENTS` | the list in DD-5 |
  | `OKF_PATTERN_MAX_CHARS` | 200 |
  | `OKF_EVENT_CAP_PER_NODE` | 3000 |
  | `OKF_POINTER_CAP_PER_NODE` | 5000 |
  | `OKF_TOP_PATTERNS` | 5 |
  | `OKF_POINTER_MAX_CHARS` | 512 (DD-8 span length; also the column width) |
  | `OKF_CODE_ROOTS_MAX` | 50 |
  | `OKF_PATH_MAX_CHARS` | 1024; an event path or article path longer than this is dropped, not truncated |

  - **`okfFixedLimits`:** the settings response carries `{ readTopN, hotFilesTopN, taskHeadMaxChars, patternMaxChars, eventCapPerNode }`, built from the existing `READ_TOP_N`, `HOT_FILES_TOP_N`, `TASK_HEAD_MAX_CHARS` and the constants above, for the "Not settings" footer.
  - **Pointer table:** the drill-down shows 17 rows before "Show all". This is a client UI constant, `OKF_POINTER_ROWS = 17`, in `OkfPointerTable.tsx`.
- **DD-1a Extractor row types,** exported from `okf-access-extractor.ts`:
  - `OkfEventRow { ord: number; op: 'read' | 'search' | 'write'; path: string; rangeFrom: number | null; rangeTo: number | null; pattern: string | null }`
  - `OkfPointerRow { articlePath: string; articleHash: string | null; readOrd: number; pointer: string; isNew: boolean; followed: boolean; partial: boolean }`
  - `OkfSeqItem { ord: number; op: 'kb_read' | 'kb_search' | 'kb_write' | 'read' | 'search' | 'write'; path: string; offset?: number; limit?: number; pattern?: string; newPointers?: string[] }`

- **DD-1 Extraction output.** `extractOkfDetail(entries, roots, parser, { isSubagentLog, snapshotFiles })` returns `{ access: OkfAccessRow[]; events: OkfEventRow[]; pointers: OkfPointerRow[]; seq: OkfSeqItem[]; truncated: boolean }`.
  - `snapshotFiles` is an optional `ReadonlyMap<repoRelPath, { size: number | null; hash: string | null }>` built from the root's bound snapshot.
  - `extractOkfAccess(...)` stays exported and returns `.access`, so its callers and the algorithm harness are unchanged.
- **DD-2 Call ordinal.** `ord` is the 1-based index of a tool call among the node's tool calls, after the duplicate `tool_use` id rule (DD-8). `session_okf_event.ord`, `session_okf_pointer.read_ord` and `OkfSeqItem.ord` share this counter, so the read side can order pointers before or after events.
- **DD-3 `OkfAccessRow` additions.**
  - `rangedCalls` / `rangedBytes`: read calls that carry a range (DD-4) and their bytes. They are also included in `calls` / `bytes`.
  - `searchHits`: grep / list calls on the row whose result is a hit (DD-6).
- **DD-4 Ranges.**
  - `Read` with `offset` or `limit` → `{ from: offset ?? 1, to: limit ? (offset ?? 1) + limit - 1 : null }`.
  - Bash `sed -n 'a,bp'` → `{ from: a, to: b }`.
  - `head -n N` / `head -N` → `{ from: 1, to: N }`.
  - `tail -n N` → `{ from: -N, to: null }`.
  - Bash ranges come from the new `BashReadAccess.range`. A range makes the read "ranged" (FR-4).
- **DD-5 Code events.**
  - **Which accesses:** every resolved access of a call except `.md` files present in `snapshotFiles`; with no snapshot, every access is kept.
  - **Op mapping:** read → `read`; grep / list → `search`; write → `write`.
  - **Path form:** repo-relative, with folders ending in `/` and the repo root as `/`.
  - **Dropped paths:** any path with a segment in `OKF_EVENT_SKIP_SEGMENTS` = `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.next`, `target`, `tmp`.
  - **Granularity:** one event per path argument.
  - **Pattern:** Grep `pattern`, or Bash `BashReadAccess.pattern`, cut to `OKF_PATTERN_MAX_CHARS = 200`; Glob keeps no pattern.
  - **Cap:** at most `OKF_EVENT_CAP_PER_NODE = 3000` events per node; beyond it `truncated = true`.
- **DD-6 Search hit (FR-8).** A grep / list call is a hit when its result is not an error and, after trimming, is not empty and not one of `No files found` / `No matches found`.
  - The read side marks `entry: search` only when all three hold:
    - the node's first bundle access is a grep / list folder row with `searchHits > 0`;
    - that row's key is a folder, not a file;
    - the same node later has a `read` row in that bundle.
  - Bash `ls <path-with-extension>` (a list of a named file) produces no folder row and no access row.
- **DD-7 Byte split (FR-9).**
  - **Weights:** a call's result bytes are split over its read-side accesses in proportion to the `snapshotFiles` size of each key. The split is `Math.floor` per path, with the remainder going to the first.
  - **Fallback:** an even split (today's DD-2) when `snapshotFiles` is absent or any read-side target has no size. Folder targets count as "no size".
  - **Late binding:** a snapshot that binds after extraction leaves the even split until recompute. Binding does not trigger a re-extract.
- **DD-8 Pointers.** `extractPointers(text)` collects the back-ticked spans of `text` (`` `([^`\n]{1,512})` ``) and normalises each one:
  - Trim. Drop the span if it starts with `http`, `-`, `$`, `<` or `@`, or contains a space.
  - Strip a trailing `:\d+(-\d+)?` and a `#…` anchor, then a leading `./`.
  - Reduce a glob to its static prefix (the extractor's `globStaticPrefix`) and drop a trailing `/`.
  - Keep it only if it contains `/` or has an extension.
  - An absolute path is resolved through `resolveRepoPath`. If it does not resolve, it is dropped.
  - The result is de-duplicated within one read.
- **DD-9 New, partial, followed.**
  - **New:** a pointer is new when the pointer string is not a substring of the node's earlier text. That text is every earlier user text, including the sub-agent prompt and `system-reminder` text, plus every earlier assistant text block and every earlier `tool_result` text, accumulated in transcript order.
  - **Partial:** the result is `is_error: true`, is empty after trimming, or starts with `<persisted-output>` (`isPartialResult`).
  - **Followed:** some later call of the same node (any op, KB or code) has a path equal to the pointer or under `pointer + '/'`.
  - **Multi-file reads:** a KB read call that reads more than one `.md` article stores no pointer rows. Every article it read is counted as one partial read for the drill-down note.
  - **Cap:** pointer rows are capped at `OKF_POINTER_CAP_PER_NODE = 5000`; beyond it `truncated = true`.
- **DD-10 KB read for pointers.** A `read` access of a stored `.md` key (the same keys as `session_okf_access`) gets pointer rows. `article_hash` = `snapshotFiles.get(path)?.hash ?? null`.
- **DD-11 Extraction marker (FR-11).**
  - Constant `OKF_EXTRACT_VERSION = 2`. The writer sets `sessions.okf_extract_version` on every node it rebuilds, even with zero rows, and sets `okf_events_truncated` from `truncated`.
  - "No OKF analysis yet" = a root session in the period whose `okf_extract_version` is `NULL` or `< OKF_EXTRACT_VERSION`.
  - `initializeDatabase()` re-queues nothing.

**Read-time signals**

- **DD-12 Article area.** It is built over all-time pointer rows of the scope: the repo scope and the team / user / branch filters, without the period. For each (article, hash):
  - take the non-partial `is_new` pointers that are files (have an extension and no trailing `/`) under a `codeRoots` folder;
  - drop the pointers that are new pointers of more than `pointerMaxArticles` distinct articles.
  - **Hash used:** the current hash; if it has no reads, the hash of the most recent session that has reads, flagged `areaFromOlderVersion`.
  - Articles with no reads have no area.
- **DD-13 In-area search.**
  - A `search` event is in an article's area when its path (with any trailing `/` dropped) equals an area file or starts with `areaFile + '/'`. This is the probe's definition, which the defaults were calibrated on.
  - The `read` and `write` events on area files are FR-1 hits, never FR-2.
- **DD-14 Value signal rules.**
  - All per-node signals ignore upkeep pairs (DD-15) and are computed over period sessions.
  - **FR-1 yield:** `n` = non-partial reads with at least one new pointer; `k` = those reads with at least one `followed` new pointer.
  - **FR-2:** for each (node, article) pair where the node read the article, count the node's in-area `search` events with `ord` greater than the node's first read `ord`. A pair is listed when the count is at least `exploredMinSearches`.
  - **FR-3:** a node with at least `routingMinSearches` in-area searches that has no read row of the article. Y counts nodes with at least 1 in-area search. The article becomes a finding when X ≥ `routingMinAgents`. FR-3 is skipped for catalog articles.
  - **FR-13:** a (article, pointer) pair is dead when it is new in non-partial reads of at least `deadPointerMinShown` distinct nodes and is never `followed`.
    - `notFound` = no event or access in the all-time scope touched the path or anything under it, **and** the path is not a file of the latest snapshot.
    - This is a proxy: Log Hub has no repo file list, so the UI label is "path not found in any session".
  - **FR-14 patterns:** top `OKF_TOP_PATTERNS = 5` by count, ties broken by pattern ascending. Patterns are never masked.
  - **FR-15:** an article whose area has more than `areaMaxFiles` files gets an `info` finding `catalog` with params `{ files }`.
- **DD-15 Upkeep (FR-5).** A (node, article) pair is upkeep when the node has a `write` row for the article. The existing DD-7 "own edit" marker stays; an upkeep pair carries both markers (`own edit` and `upkeep ×N`), and its read leaves Read top 5 for the Upkeep line.
  - Its `read` / `grep` rows are excluded from read totals, shares, hot files, the verdict and FR-1, FR-2 and FR-3, and are summed into an `upkeep` block instead.
  - A root tree whose only KB rows are upkeep is not a KB session; it is counted in `tiles.upkeepOnlySessions`.
  - Computed at read time from the existing rows, so it needs no recompute.
- **DD-16 Section reads (FR-4).**
  - `coarse_article` uses whole-file reads only: `calls - rangedCalls` and `bytes - rangedBytes`.
  - The tree row gets a `section` marker and `rangedCalls` when `rangedCalls > 0`.
- **DD-17 Verdict changes.**
  - **FR-6:** the share histogram skips bundles with fewer than `shareMinBundleFiles` files.
  - **FR-7:** `kb_flood` changes the verdict level only when `flooded ≥ floodMinSessions`. Otherwise it is kept as an `info` finding with params `{ flooded, kbSessions }`.
  - **FR-10 stale:**
    - **Base:** each finding on a file is computed over the sessions whose bound hash of that file equals the latest snapshot's hash.
    - **Stale chip:** if those sessions are below the rule's minimum but all sessions are above it, the finding is computed over all sessions and marked `stale: { sessions, total, oldSize }`.
    - **Removed files:** a file missing from the latest snapshot gets `removed: true` and is dropped from the level.
  - The `info` severity never changes the level.
- **DD-18 Finding and marker vocabulary (additive).**
  - `OkfFindingRule` gains `routing_miss`, `searched_after`, `dead_pointers` and `catalog`.
  - `OkfFindingSeverity` gains `info`.
  - `OkfFinding` gains optional `stale?: { sessions: number; total: number; oldSize: number | null }` and `removed?: boolean`.
  - `OkfTreeMarker` gains `routing_miss`, `catalog`, `dead`, `upkeep`, `stale`, `section` and `not_read`.
  - "Not read" stays the existing `notRead` list plus the new `not_read` marker on a file that is in the snapshot and has 0 non-upkeep reads in the period. It is not a finding and has no action.
  - "Stale" is the `stale` field on any finding, not a rule. When it is set, `okfActionText` appends the stale action (DD-26).
  - The client already renders an unknown rule id raw, so older consumers keep working.
- **DD-18a Per-session file hashes (FR-10).** `getRepoOkfUsage` already loads each root's bound snapshot body (`okf-usage.service.ts` ~:960-970, the `bodies` map). Build `Map<rootSessionRowId, Map<path, { hash, size }>>` from it and pass it to `computeRepoVerdict`, together with the latest snapshot's map (DD-17).

**Thresholds (FR-17)**

- **DD-19 Threshold shape and defaults.**
  - `RepoConfigJson.okf?: OkfThresholds`, where every field is optional and defaults to the table below.

    | Field | Default |
    |---|---|
    | `shareMinBundleFiles` | 10 |
    | `sessionShareFix` | 0.25 |
    | `sessionShareMess` | 0.5 |
    | `repoMinKbSessions` | 5 |
    | `alwaysReadShare` | 0.8 |
    | `floodShare` | 0.25 |
    | `floodMessSessionShare` | 0.2 |
    | `floodMinSessions` | 3 |
    | `coarseMinSizeBytes` | 51200 |
    | `coarseMinSessions` | 5 |
    | `coarseMaxReadRatio` | 0.1 |
    | `exploredMinSearches` | 2 |
    | `routingMinSearches` | 3 |
    | `routingMinAgents` | 3 |
    | `pointerMaxArticles` | 3 |
    | `areaMaxFiles` | 30 |
    | `deadPointerMinShown` | 4 |
    | `codeRoots` | `['server/', 'client/', 'hook/', 'scripts/', 'packages/', 'tests/']` |

  - "What it affects" labels for the Settings block:
    - `shareMinBundleFiles`: "bundles smaller than this are skipped by share rules and the histogram"
    - `sessionShareFix` / `sessionShareMess`: "session verdict levels"
    - `repoMinKbSessions`: "minimum KB sessions for repo rules"
    - `alwaysReadShare`: "always_read"
    - `floodShare` / `floodMessSessionShare`: "kb_flood"
    - `floodMinSessions`: "flooded sessions needed before kb_flood changes the verdict"
    - `coarse*`: "coarse_article"
    - `exploredMinSearches`: "searched after reading"
    - `routingMin*`: "routing miss"
    - `pointerMaxArticles`: "article area (shared pointers dropped)"
    - `areaMaxFiles`: "catalog"
    - `deadPointerMinShown`: "dead pointers"
    - `codeRoots`: "article area — set to this repo's code folders"
  - **Verdict group:** `shareMinBundleFiles` through `coarseMaxReadRatio`. **Value-signal group:** the rest.
  - **"Not settings" footer:** the read top list (5), the hot files list size, the task head length, the 200-character pattern cut and the per-node event cap.
  - **Validation:**
    - Share fields (`sessionShareFix`, `sessionShareMess`, `alwaysReadShare`, `floodShare`, `floodMessSessionShare`, `coarseMaxReadRatio`) must be numbers in (0, 1].
    - Every other numeric field is an integer ≥ 1.
    - `codeRoots` is a non-empty array of at most 50 strings, each relative, not containing `..`, not starting with `/`, and normalised to end in `/`.
  - `validateOkfThresholds` throws `BadRequestException('okf.<field> …')`. `resolveOkfThresholds(raw)` merges field by field and replaces an invalid stored field with its default.
- **DD-20 Per-section resolution.** `RepositoriesService.resolveOkfThresholds(userId, repoUrl, teamId?)` returns `{ values, custom: string[] }`, where `custom` lists the fields that differ from the defaults.
  - **Team view:** the team row's `okf` → defaults.
  - **Personal view:** the personal row's `okf` if it is present → the `okf` of the lowest-id team linking the URL → defaults.
  - Other config fields keep the whole-object `resolveEffectiveConfig()`.
- **DD-21 Save without recompute.** All three settings routes (GET, `PUT …/team`, `PUT …/user`) return `getRepoSettings(...)`, so all of them carry `okfDefaults` and `okfFixedLimits`.
  - `saveTeamConfig` / `saveUserConfig` compare the stored row with the new config, ignoring `okf`. When they are deep-equal, the save skips `recomputeTeamScope` / `recomputeForRepo`.
  - `RepoSettingsResponse` gains `okfDefaults: OkfThresholds`, filled from `DEFAULT_OKF_THRESHOLDS`, so the client keeps no twin of the defaults.
- **DD-22 Client save.** The client saves only the fields that differ from `okfDefaults`, and drops the section when none differ. It saves through the existing read-modify-write helper in `RepositorySettings.tsx`.
  - **Reset to defaults:** saves without `okf`.
  - **Copy from team settings:** shown in the personal view when `teamConfig?.okf` exists; it fills the form from that section.
  - The wireframe's live "On this repo" hint column is not built, because no FR asks for it and it would need a preview endpoint.

**API and UI scope**

- **DD-23 Drill-down route.** The per-article drill-down is a separate route, so the repo response stays light. Its shape is under API changes.
  - **Same rules as `okf-usage`:** scope, 403 and the team filter, through `resolveUsageScope`.
  - **Bad input:** a `path` that is not a stored KB article in scope → 200 with `found: false`.
- **DD-24 Team filter for the new rows.** Same as `session_okf_access`, fail closed (DD-30 of the OKF feature):
  - pointer and event rows of a tree with no snapshot are dropped in the team view;
  - pointer rows whose article is ignored are dropped;
  - event rows are not filtered by `ignored`.
- **DD-25 Dropped wireframe items.** These wireframe items are not built:
  - the per-article git version history (real-3); FR-10 shows only the current size and the old size;
  - the "most searched files" list (real-2), since FR-2 and FR-3 show patterns;
  - the live "On this repo" hint column (real-5).
- **DD-26 Action text (FR-16).** `client/src/viewer/lib/okf/okf-action-text.ts` exports `okfActionText(finding)`, which returns a string or `null`. Value-signal rows are passed as findings with the same rule ids.
  - Params are `file` (the article or file path), `bundle`, `patterns` (comma-joined top patterns), `area` (the common folder of the area files), `files` (count) and `path` (the dead pointers, comma-joined, at most 3 then "…").
    - The verdict already emits `file` / `bundle` for the existing rules.
    - Chunk 8 emits `file`, `patterns`, `area`, `files` and `path` for the value-signal rules.
  - Texts:

    | Rule | Action text |
    |---|---|
    | `coarse_article` | "split {file} at its headings or add section pointers to index.md" |
    | `always_read` | "move the facts of {file} into index.md / CLAUDE.md" |
    | `kb_flood` | "the index lines of {bundle} do not route — agents read a quarter of the bundle; sharpen the one-line descriptions" |
    | `searched_after` | "after reading {file}, agents searched for {patterns} — add these facts to the article or a section pointer to them" |
    | `routing_miss` | "agents searched {area} for {patterns} without opening {file} — mention these in its index.md line (or in CLAUDE.md routing)" |
    | `dead_pointers` | "remove {path} from {file}, or write it as a full repo-relative path next to the fact it serves" |
    | `catalog` | "{file} lists {files} code paths — check it against C3: paths that grep finds in seconds need not be listed; keep the non-obvious ones" |
    | `session_share` | no action (`null`) |

  - A finding with `stale` set gets the line " · re-check after sessions on the current version" appended.
  - Unknown rule ids return `null`; `formatOkfFinding` still shows them raw.
- **DD-27 Workflow sub-agents.** Workflow sub-agents are ordinary tree nodes through `parent_session_id`, so FR-3 runs per node and needs no special case.
- **DD-28 All-time scope queries.** All-time scope queries (the DD-12 area and the FR-13 `notFound`) first select the in-scope node ids: the scope's root trees with no period filter. They then join the new tables by `session_id`, using the leading `session_id` of the unique keys. They never scan by path. Each is a single SQL aggregate (`GROUP BY article_path, article_hash, pointer` / `DISTINCT path`), and no extra path index is added.
- **DD-29 Value signals strip.** The drill-down strip shows yield "k / n reads", searched-after "agents · searches", routing miss "X of Y agents", dead pointers "N dead of M shown" and catalog "N area files". A signal with no data shows "—".

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0091_okf_value_signals.sql` | new tables and columns | per Database changes; + `meta/_journal.json`, migrations lock |
| `server/src/database/schema/index.ts` | `sessionOkfEvent`, `sessionOkfPointer`, new columns, `OkfThresholds`, `RepoConfigJson.okf` | comment style like `sessionOkfAccess` (~:1836) |
| `packages/bash-view/src/bash-analyze.ts` | `BashReadAccess.range?`, `.pattern?`, `git grep` | `GREP_CMDS` :78, `sed` branch :272, `readAccess` build :491 |
| `server/src/logs/okf/okf-constants.ts` | new: shared constants | DD-0 |
| `server/src/logs/okf/okf-snapshot.ts` | receives `normaliseSnapshot` (moved from `okf-usage.service.ts:133`) | used by writer + read side |
| `server/src/logs/okf/okf-pointers.ts` | new: `extractPointers`, `isPartialResult`, `isNewPointer` | DD-8, DD-9 |
| `server/src/logs/okf/okf-access-extractor.ts` | `extractOkfDetail`, ranges, events, pointers, FR-8, FR-9, search hits | Read case :180, Bash :206-231, split :319-328 |
| `server/src/logs/okf/okf-access-writer.ts` | write events/pointers/marker, load snapshot files | writer :25-79, `rebuildSessionOkfAccess` :70, `rebuildOkfAccessForNodes` |
| `server/src/logs/okf/okf-thresholds.ts` | new: defaults, resolve, validate | DD-19 |
| `server/src/logs/okf/okf-value-signals.ts` | new: pure read-time signals | DD-12..DD-14 |
| `server/src/logs/okf/okf-verdict.ts` | constants → `OkfThresholds`; FR-4/5/7/10, info, stale | constants :22-51, `computeRepoVerdict` :371, flood :412, coarse :445 |
| `server/src/logs/okf/okf-usage-tree.ts` | new markers, ranged counters, upkeep, team filter for new rows | `applyOkfTeamFilter`, `buildOkfTree` |
| `server/src/logs/okf/okf-usage.service.ts` | load new rows, thresholds, signals, FR-6, FR-11, article route | session :352, repo :482, histogram :614-623, hot files :640-675, entry :461 |
| `server/src/logs/okf/okf-usage.types.ts` | additive response fields + `RepoOkfArticleResponse` | per API changes |
| `server/src/logs/okf/okf-facts.service.ts` | per-agent `accessSeq` | next to `otherReadsTop` :325; extractor call :280 |
| `server/src/logs/reports/reports.controller.ts` | new article route; pass `repoId`/user to service for thresholds | next to `getOkfUsageReport` :350 |
| `server/src/logs/repositories.controller.ts` | session route passes thresholds context | `getSessionOkfUsage` :1513 |
| `server/src/logs/repositories.service.ts` | `resolveOkfThresholds`, `validateConfig` okf, skip-recompute, `okfDefaults` | :637, :714, :970, :1032, `RepoSettingsResponse` :89 |
| `server/src/sessions/sessions.service.ts` | purge new tables, reset marker | step c2 :232-236, step g :273 |
| `client/src/models/repositories.ts` | mirror of all type additions | :859+ |
| `client/src/viewer/lib/okf/okf-action-text.ts` | new: FR-16 dictionary | DD-26 |
| `client/src/viewer/lib/okf/okf-verdict-text.ts` | texts for new rules, `info` severity | `formatOkfFinding` :82 |
| `client/src/viewer/pages/repository/okf/okf-url-state.ts` | `okfArticle` URL param | |
| `client/src/viewer/pages/repository/okf/RepoOkfTab.tsx` | drill-down switch, FR-11 banner, Upkeep panel | stays < 10 KB |
| `client/src/viewer/pages/repository/okf/OkfKpiTiles.tsx` | yield + routing-miss tiles, upkeep-only count | |
| `client/src/viewer/pages/repository/okf/OkfHotFiles.tsx` | Yield column | |
| `client/src/viewer/pages/repository/okf/OkfShareHistogram.tsx` | "bundles of ≥ N files" caption | |
| `client/src/viewer/pages/repository/MaintenanceSection.tsx` | reference only — its `recomputeAllSessions(repoId, teamId)` call is reused by the banner | unchanged |
| `client/src/viewer/pages/repository/okf/OkfUpkeepPanel.tsx` | new: Upkeep panel | |
| `client/src/viewer/pages/repository/okf/OkfAnalysisCoverageBanner.tsx` | new: FR-11 banner + recompute link | reuses `recomputeAllSessions` |
| `client/src/viewer/pages/repository/okf/article/OkfArticleDrillDown.tsx` | new: drill-down page | real-2/real-3 |
| `client/src/viewer/pages/repository/okf/article/OkfPointerTable.tsx` | new: pointer list, Show all | |
| `client/src/viewer/pages/repository/okf/article/OkfSignalBlocks.tsx` | new: routing-miss / searched-after / dead / catalog blocks + action lines | |
| `client/src/viewer/pages/repository/session-log/okf/OkfTree.tsx`, `okf-tree-rows.tsx`, `okf-tree.ts` | new columns, markers, expandable pointer rows, routing-miss rows | shared by session and repo tabs |
| `client/src/viewer/pages/repository/session-log/okf/OkfVerdictCard.tsx` | action lines, `info`, `stale`, thresholds chip, measures-what subtitle | |
| `client/src/viewer/pages/repository/session-log/okf/OkfAgentsPanel.tsx` | yield / misses / upkeep / searches per agent | |
| `client/src/viewer/pages/repository/session-log/okf/SessionOkfTab.tsx` | value-signals tile, upkeep line, § chips | |
| `client/src/viewer/pages/repository/OkfThresholdsSection.tsx` | new: Settings block | real-5 |
| `client/src/viewer/pages/repository/RepositorySettings.tsx` | mount block, carry `okf` in saves | :129-180, :308-346 |
| `client/src/viewer/api.ts` | `getOkfArticle` | next to the repo OKF usage call (~:870) |
| `docs/knowledgebase/algorithms/okf-value-signals.md` + `docs/algorithm-examples/okf-value-signals.json` | new algorithm doc + rows | per `algorithms/README.md` |
| `server/src/logs/okf/okf-value-signals.algo.spec.ts` | new table test | template `okf-verdict.algo.spec.ts` |
| `docs/knowledgebase/algorithms/okf-access-extraction.md`, `okf-verdict.md`, `bash-command-view.md` | rule changes | rule 4, rule 8; DD-23 constants; rule 5.9 |
| `docs/algorithm-examples/okf-access-extraction.json`, `okf-verdict.json`, `bash-command-view.json` | new/changed rows | |
| `server/src/logs/okf/okf-access-extractor.algo.spec.ts` | compare optional `expected.events` / `expected.pointers` | harness only |
| `server/src/logs/okf/okf-verdict.algo.spec.ts` | pass optional row `thresholds` and hash maps into the verdict | harness only |
| `server/src/logs/logs.service.ts`, `server/src/logs/session-file-stats-writer.ts` | check writer call sites (:526, :1179; :270) | no signature change expected |
| `docs/knowledgebase/okf-usage.md`, `db-tables.md`, `server-endpoint-map.md`, `client-component-map.md`, `algorithms/README.md` (table ~:68-71), `index.md` (~:106-109) | KB updates | |
| `docs/knowledgebase/db_state.sql` | regenerated | `db-state-update` skill |
| `user-docs/okf-tab.md` (new, modelled on `otel-tab.md`), `user-docs/nav.json`, `tests/scenarios/tours/screen-registry.ts` | user help for the OKF tabs: new columns, drill-down, thresholds | `session-log.md` has no OKF section; then `npm run build:help` |
| `server/test/contract/registry/f21-reports.ts`, `f19-change-surface.ts`, `f16-post-turn.ts`, `f14-repositories.ts` | contract rows | |
| `server/test/contract/fixtures/world-v1.sql.ts` | a few event/pointer rows for the OKF fixture session | |
| `tests/scenarios/helpers/okf.ts` | richer `OkfAction` | :62, `agentTranscriptLines` :199 |
| `tests/scenarios/repos/s-repo-16.spec.ts`, `s-repo-09.spec.ts` | new steps | |

## API changes

All additions are optional fields, so older clients and skills ignore them.

**`GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage`** (`SessionOkfUsageResponse`):

- `thresholds?: { custom: string[] }`.
- `upkeep?: { path: string; bundle: string | null; readBytes: number; readCalls: number }[]`.
- `signals?: OkfSignalSummary`, defined as `{ readsWithNewPointers: number; readsFollowed: number; routingMissArticles: number; searchedAfterPairs: number; deadPointers: number }`.
- `eventsTruncated?: boolean`.
- `OkfTreeNode` gains:
  - `rangedCalls?`, `upkeepReadCalls?`, `yield?: { k: number; n: number } | null`;
  - `searchedAfter?: { agents: number; searches: number }`, `routingMiss?: { agents: number; areaAgents: number }`;
  - `deadPointers?: number`, `catalogFiles?: number`;
  - `stale?: { size: number | null; oldSize: number | null }`, `removed?: boolean`.
- `OkfAgent` gains:
  - `pointers?: { article: string; pointer: string; followed: boolean }[]` (new pointers only) and `promptNamedPaths?: number`;
  - `routingMisses?: { article: string; searches: number; patterns: string[] }[]`;
  - `upkeepArticles?: string[]`, `searches?: number`, `yield?: { k: number; n: number } | null`.

**`GET /api/v1/repositories/:repoId/reports/okf-usage`** (`RepoOkfUsageResponse`):

- `thresholds?: { custom: string[] }`.
- `tiles` gains:
  - `upkeepOnlySessions?`, `pointerYield?: { k: number; n: number } | null`;
  - `routingMissArticles?`, `routingMissPairs?`;
  - `sessionsWithoutAnalysis?`, `sessionsInPeriod?`.
- `hotFiles[]` gains `yield?: { k: number; n: number } | null`.
- `upkeep?: { path: string; bundle: string | null; sessions: number; readBytes: number }[]`.
- `canRecompute?: boolean`, computed with the same authority as `recompute-all-sessions`.
- The tree nodes carry the same additions as the session route.
- `shareBins` apply FR-6.

**New `GET /api/v1/repositories/:repoId/reports/okf-usage/article`.** Query: `path` (required), plus the same `teamId`, `startDate`, `endDate`, `branches`, `users`, `attr` as `okf-usage`. A missing `path` → 400. Response `RepoOkfArticleResponse`:

```ts
{
  found: boolean;
  path: string; bundle: string | null;
  size: number | null; oldSize: number | null; hashStatus: 'current' | 'stale' | 'removed' | 'unknown';
  areaFromOlderVersion: boolean;
  reads: { whole: number; section: number; upkeep: number; partial: number };
  yield: { k: number; n: number } | null;
  pointers: { pointer: string; shown: number; followed: number; dead: boolean; notFound: boolean }[]; // dead first, then shown desc
  area: string[];
  catalog: { files: number } | null;
  routingMiss: { agents: number; areaAgents: number; patterns: { pattern: string; count: number }[];
    missing: { sessionId: string; agentId: string; taskHead: string; searches: number }[] } | null; // taskHead masked like okf-usage
  searchedAfter: { agents: number; searches: number; patterns: { pattern: string; count: number }[] } | null;
  findings: OkfFinding[];          // this article's findings, incl. value-signal rules
  sameFindingElsewhere: { path: string; rule: OkfFindingRule; value: number }[]; // top 5
}
```

**`GET /api/v2/okf-usage/facts`** (`OkfFactsResponse.agents[]`): gains `accessSeq?: { ord: number; op: 'kb_read' | 'kb_search' | 'kb_write' | 'read' | 'search' | 'write'; path: string; offset?: number; limit?: number; pattern?: string; newPointers?: string[] }[]`. It is built on demand from `extractOkfDetail(...).seq`.

**Settings routes** (`GET/PUT :repoId/settings`, `PUT …/team`, `PUT …/user`):

- The `config` body accepts `okf`; it is validated by DD-19 and an invalid value → 400.
- The response gains `okfDefaults`.
- An `okf`-only change skips the recompute (DD-21).

## Database changes

Migration `server/drizzle/migrations/0091_okf_value_signals.sql`, additive only and with no data deletion. It carries `COMMENT ON` statements for every new table and column, as in `0084_schema_comments.sql`.

- **`session_okf_event`:**
  - Columns: `id serial PK`, `session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`, `ord integer NOT NULL`, `op varchar(8) NOT NULL CHECK (op IN ('read','search','write'))`, `path varchar(1024) NOT NULL`, `range_from integer NULL`, `range_to integer NULL`, `pattern varchar(200) NULL`.
  - `UNIQUE (session_id, ord, op, path)`; its leading `session_id` serves the delete and the read.
- **`session_okf_pointer`:**
  - Columns: `id serial PK`, `session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`, `article_path varchar(1024) NOT NULL`, `article_hash varchar(128) NULL`, `read_ord integer NOT NULL`, `pointer varchar(512) NOT NULL`, `is_new boolean NOT NULL`, `followed boolean NOT NULL`, `partial boolean NOT NULL DEFAULT false`.
  - `UNIQUE (session_id, read_ord, article_path, pointer)`.
  - A partial read with no pointers stores one row with `pointer = ''`, so the drill-down can count it.
- **`session_okf_access`:** `ADD COLUMN ranged_calls integer NOT NULL DEFAULT 0`, `ADD COLUMN ranged_bytes bigint NOT NULL DEFAULT 0`, `ADD COLUMN search_hits integer NOT NULL DEFAULT 0`.
- **`sessions`:** `ADD COLUMN okf_extract_version smallint NULL`, `ADD COLUMN okf_events_truncated boolean NOT NULL DEFAULT false`.
- **Steps:**
  1. Add the SQL file and the `meta/_journal.json` entry.
  2. Run `npm run migrations:lock` (server).
  3. Update the Drizzle schema.
  4. Apply to the dev DB (`npm run migrate`).
  5. Regenerate `docs/knowledgebase/db_state.sql` with the `db-state-update` skill.
  6. Follow the `migrations-data-integrity` skill.
- Writers delete and then insert per node with `ON CONFLICT DO UPDATE`, like the `okf-access-writer.ts` contract.
- `purgeSessionChildData` deletes from both new tables explicitly (a soft delete does not cascade) and resets `okf_extract_version` to NULL next to the `okfSnapshotId` clear.

## Test coverage plan

Under the CLAUDE.md test policy: algorithm rows, contract rows and scenario steps only.

- **Algorithm — extend `okf-access-extraction`** (`docs/algorithm-examples/okf-access-extraction.json`, picked up by `okf-access-extractor.algo.spec.ts`):
  - Ranged Read and `sed -n` / `head -n` / `tail -n` counters.
  - `ls <file>` produces no row; search hit / miss.
  - The size-proportional split and the even fallback.
  - Code events with patterns and skipped segments; the event cap.
  - Pointer normalisation; new versus prompt-named pointers.
  - Partial reads (`<persisted-output>`, empty, error); followed; a multi-file KB read stores no pointers.
  - Existing rows gain the new zero counters.
- **Algorithm — extend `okf-verdict`** (`docs/algorithm-examples/okf-verdict.json`):
  - FR-4 whole-only ratio, FR-5 upkeep exclusion and upkeep-only sessions, FR-6 histogram guard.
  - FR-7: RV-09 changes to one flood → `info`; three floods → `fix`.
  - FR-10 stale and removed; `info` does not change the level.
  - Threshold overrides.
- **Algorithm — extend `bash-command-view`** (`docs/algorithm-examples/bash-command-view.json`): `range` for `sed -n` / `head` / `tail`, `pattern` for grep / rg, and `git grep`. Existing grep rows gain `pattern`.
- **Algorithm — new `okf-value-signals`** (doc + rows + `okf-value-signals.algo.spec.ts`):
  - The area: shared-pointer drop, folder and non-`codeRoots` drop, older-hash fallback.
  - FR-1 hit and denominator.
  - FR-2 and its upkeep exclusion.
  - FR-3: 3 vs 2 searches; a sub-agent read does not clear the main agent.
  - FR-13 dead and not-found; FR-15 catalog suppresses FR-3; FR-14 top patterns; partial reads excluded.
  - A new algorithm file goes in together with its new doc, as the policy allows.
- **Thresholds:**
  - **Per-field merge and invalid-stored fallback:** `okf-verdict` rows whose raw `okf` goes through `resolveOkfThresholds`, since the thresholds table is part of `okf-verdict.md`.
  - **Save validation:** the f14 contract 400 row.
  - **Personal and team resolution:** scenario step 16.
- **API contract:**
  - `f21-reports.ts`: repo `okf-usage` with the new fields, plus the new `F21-okf-article`, `-article-outsider` (403) and `-article-missing-path` (400) rows.
  - `f19-change-surface.ts`: session `okf-usage` with the new fields.
  - `f16-post-turn.ts`: facts `accessSeq`.
  - `f14-repositories.ts`: settings round-trip of `okf`, an invalid `okf` → 400, `okfDefaults`.
  - Fixture rows in `world-v1.sql.ts`.
  - The router meta-test requires the new route's row.
- **Scenario — extend `tests/scenarios/repos/s-repo-16.spec.ts` after step 11:**
  - routing miss: 3 sub-agents grep the area, 2 searches do not count;
  - yield hit versus a prompt-named path;
  - a dead pointer;
  - upkeep exclusion;
  - patterns visible in the team view to a `team-no-prompts` member (s-repo-16 step 15 switches the team to `restricted` and back);
  - `routingMinSearches` changed in Settings changes the list without recompute, with the chip;
  - the FR-11 banner and the recompute link.
- **Scenario — extend `s-repo-09.spec.ts`:** one step checks that import re-creates event / pointer rows and delete removes them.
- **Performance:** `npm run perf` (server; required after server changes by `.claude/rules/server.md`; a measurement, not a test kind) after the server chunks; stop and ask if any metric degrades by more than 20 %.

## Visual/UX notes

Follow the `ui-components` skill and the existing OKF tab styles (chips, tree columns, cards).

**Repo tab** (real-1):

- **Verdict card:**
  - The subtitle says what is measured: "access, layout and value proxies".
  - A "custom thresholds" chip with a hover list of the custom fields, or a muted "default thresholds ⚙" chip that links to Settings → OKF thresholds.
  - Findings are listed worst first; each has a second muted line "→ action" (DD-26), and `info` findings are grey.
- **Tiles:** KB files, not read, KB sessions (+ upkeep-only), median share, pointer yield "k of n reads", and articles with routing misses (+ pairs).
- **Tree:** new right-aligned columns YIELD "k / n" (or "—"), EXPL. AFTER "agents · searches" and ROUTE MISS "X / Y". Marker chips: `routing miss`, `§ section reads ×N`, `catalog N`, `N dead` (only when N ≥ 3), `upkeep ×N`, `stale · now X KB`, `not read`. A column legend sits under the tree.
- **Below the tree:** the histogram caption "bundles of ≥ N files", hot files with a Yield column, and the Upkeep panel (article · sessions · bytes).
- **FR-11 banner:** an info banner above the tiles when `sessionsWithoutAnalysis > 0`; the "Recompute all sessions" link only when `canRecompute`.
- **Drill-down:**
  - A tree row's file name opens it (URL `okfArticle=<path>`), with "← back to the tree" at the top.
  - **Header:** size, a hash status chip and the read summary "whole N · § section N · upkeep N excluded · N reads cut to a preview / empty, not counted".
  - **Value signals strip.**
  - **Pointer table:** "✓ followed ×k" or "· shown ×n, never followed"; dead pointers are listed first with a "path not found in any session" tag; the first 17 rows, then "… N more · Show all".
  - **Signal blocks:** routing-miss and searched-after blocks with the top 5 patterns in monospace, plus the action; a table of the missing agents (masked task head); a catalog block; a "same finding on other articles" list.
- **Empty states:** an article with no reads with new pointers shows "—" and no finding; a stale area shows a muted "area from an older version" note.

**Session tab** (real-4):

- The verdict subtitle says "upkeep excluded".
- Read top 5 gets `§ section ×N` chips, plus a muted "Upkeep" line.
- A whole-tree value-signals tile.
- **Tree:** new columns POINTERS USED "k / n" and EXPL. AFTER. An expandable sub-row per agent lists its new pointers with ✓ for followed, plus "N paths already named in its prompt". Unread articles with a miss get a "routing miss · N searches" row with the action line.
- **Agents panel:** new columns yield, routing misses, upkeep and searches.
- A "events truncated" muted note when `eventsTruncated`.

**Settings** (real-5):

- An "OKF thresholds" card in the analysis tab: a table SETTING / DEFAULT / VALUE / WHAT IT AFFECTS in two groups, verdict and value signals.
- `codeRoots` is a tag-list input.
- A "Not settings" footer lists the fixed limits.
- Buttons "Save for this repo", "Reset to defaults" and "Copy from team settings"; the note "Saving writes only the fields that differ from the default".
- The card is read-only when `readOnly` (team view, not the team owner).
- Inline validation mirrors DD-19 and the server 400 message is shown.

Every new component stays under the component-size limit (10 KB); split it rather than grow `RepoOkfTab.tsx` (7.8 KB) / `SessionOkfTab.tsx` (8.25 KB) / `okf-tree-rows.tsx` (6.4 KB). `RepositorySettings.tsx` is already 15.2 KB: add nothing to it beyond the mount and the `okf` carry-through. Thresholds controls are read-only when `readOnly` (team view, not the team owner) or — if the `2026-11-05-readonly-demo-user` task has landed — the current user is read-only.

## Wireframes

No wireframe changes. The `real-*` wireframes are authoritative, except for the items DD-25 drops: version history, most-searched files and the live hint column. `repo-okf-tab.svg` / `session-okf-tab.svg` are superseded concept drafts.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema & migration | 6 | first; everything writes or reads these |
| 2 | bash-view range / pattern | 4 | extractor depends on it |
| 3 | Extractor: access rows | 7 | after 1–2 |
| 4 | Extractor: events & pointers | 6 | after 3; uses `okf-pointers.ts` |
| 5 | Writer, marker, lifecycle | 6 | after 4 |
| 6 | Thresholds & settings service | 6 | independent of 3–5; before 7 |
| 7 | Verdict changes | 6 | needs 6 thresholds |
| 8 | Value-signals module | 5 | needs 6 |
| 9 | Read side: session & repo routes | 8 | needs 5, 7, 8 |
| 10 | Article route & facts route | 5 | needs 9 |
| 11 | Client models & libs | 5 | needs 9–10 shapes |
| 12 | Client repo tab | 7 | needs 11 |
| 13 | Client article drill-down | 4 | needs 11–12 |
| 14 | Client session tab | 6 | needs 11 |
| 15 | Client Settings block | 5 | needs 6, 11 |
| 16 | Docs & KB | 7 | after code |
| 17 | Tests: algorithm rows | 7 | after 2–8; ends with perf check |
| 18 | Tests: contract rows | 6 | after 9–10 |
| 19 | Tests: scenario steps | 7 | last |

### Chunk 1 — Schema & migration
- [ ] Create `server/drizzle/migrations/0091_okf_value_signals.sql` with the tables, columns, constraints and `COMMENT ON` statements listed under Database changes.
- [ ] Add the `0091_okf_value_signals` entry to `server/drizzle/migrations/meta/_journal.json` and run `npm run migrations:lock` from `server/`.
- [ ] In `server/src/database/schema/index.ts` add `sessionOkfEvent` and `sessionOkfPointer` tables next to `sessionOkfAccess` (~:1836), per Database changes, with comment blocks in the same style.
- [ ] In `server/src/database/schema/index.ts` add `rangedCalls`, `rangedBytes`, `searchHits` to `sessionOkfAccess` and `okfExtractVersion`, `okfEventsTruncated` to `sessions` after `toolUsageVersion` (table ~:136-185). Use `// Migration 0091:` in the schema comments (`0085` is now `0085_agent_meta_labels`).
- [ ] In `server/src/database/schema/index.ts` add an exported `OkfThresholds` interface (all fields optional, per DD-19) and `okf?: OkfThresholds` to `RepoConfigJson` (:1524) with a doc comment describing DD-20 resolution.
- [ ] Check the migration against the `migrations-data-integrity` skill, apply it to the dev DB (`npm run migrate` in `server/`), then run the `db-state-update` skill to regenerate `docs/knowledgebase/db_state.sql`.

### Chunk 2 — bash-view range / pattern
- [ ] In `packages/bash-view/src/bash-analyze.ts` extend `BashReadAccess` (:85) with optional `range?: { from: number; to: number | null }` and `pattern?: string`, set only when known.
- [ ] Fill `range` for `sed -n 'a,bp'`, `head -n N` / `head -N` and `tail -n N` per DD-4, in the `sed` branch (:272) and the head/tail handling.
- [ ] Fill `pattern` for `GREP_CMDS` (:78) commands with the first non-option argument (or the `-e` value), and treat `git grep <pattern> [paths]` as a `grep` read access with that pattern.
- [ ] Make sure `packages/bash-view/src/index.ts` exports the extended `BashReadAccess`, and that the server and client typechecks pass with the optional fields.

### Chunk 3 — Extractor: access rows
- [ ] Create `server/src/logs/okf/okf-constants.ts` with the DD-0 constants table.
- [ ] In `server/src/logs/okf/okf-access-extractor.ts` add `rangedCalls`, `rangedBytes`, `searchHits` to `OkfAccessRow` (DD-3) and a `range` field to `CallAccess`. Read sets it from `offset` / `limit`, Bash from `BashReadAccess.range` (DD-4).
- [ ] Extend pass 1 (:272-285) to keep the result text and `is_error` per `tool_use` id, alongside the bytes.
- [ ] Mark a grep / list call as a search hit per DD-6 and add it to the row's `searchHits`.
- [ ] Skip Bash `list` accesses whose path has an extension (FR-8, DD-6) in the Bash case (:217-226).
- [ ] Replace the even split (:319-328) with the size-proportional split from `options.snapshotFiles` and the even fallback, per DD-7.
- [ ] Add `snapshotFiles?: ReadonlyMap<string, { size: number | null; hash: string | null }>` to `ExtractOkfAccessOptions` (:45). Update the header rule list to cover the changed DD-2 split and the new rules.

### Chunk 4 — Extractor: events & pointers
- [ ] Create `server/src/logs/okf/okf-pointers.ts` exporting `extractPointers(text, roots)`, `isPartialResult(text, isError)` and `isNewPointer(pointer, priorText)` per DD-8 and DD-9, reusing `globStaticPrefix` (export it from the extractor) and `resolveRepoPath`.
- [ ] In the extractor export the DD-1a types and add `extractOkfDetail` returning `{ access, events, pointers, seq, truncated }` (DD-1). `extractOkfAccess` becomes `extractOkfDetail(...).access`.
- [ ] Number calls with `ord` (DD-2) and accumulate the node's prior text (user text, assistant text, tool_result text) in transcript order for the new-pointer test.
- [ ] Emit `OkfEventRow { ord, op, path, rangeFrom, rangeTo, pattern }` per DD-5, with skip segments, the 200-char pattern cut and the `OKF_EVENT_CAP_PER_NODE = 3000` cap that sets `truncated`.
- [ ] Emit `OkfPointerRow { articlePath, articleHash, readOrd, pointer, isNew, followed, partial }` for single-article KB reads per DD-9/DD-10. Set `followed` after the walk; on a partial read with no pointers, write one row with `pointer: ''`; cap at `OKF_POINTER_CAP_PER_NODE = 5000`.
- [ ] Emit `seq: OkfSeqItem[]` (`ord`, op incl. `kb_*`, path, offset, limit, pattern, newPointers) for the facts route, uncapped in memory.

### Chunk 5 — Writer, marker, lifecycle
- [ ] In `server/src/logs/okf/okf-access-writer.ts` add `loadSnapshotFilesForNode(db, sessionDbId)`. It resolves the root through `topAncestorIdsSql`, reads the bound `okf_snapshots.body` and maps file path → `{ size, hash }`. Move `normaliseSnapshot` from `okf-usage.service.ts:133` into `okf-snapshot.ts` and import it in both places.
- [ ] Extend `writeSessionOkfAccess` to write `rangedCalls`, `rangedBytes`, `searchHits` (also in the `onConflictDoUpdate` set).
- [ ] Add `writeSessionOkfEvents` and `writeSessionOkfPointers`: delete-then-insert per node in chunks with `ON CONFLICT DO UPDATE` on their unique keys. Set `sessions.okf_extract_version = OKF_EXTRACT_VERSION` (2) and `okf_events_truncated` (DD-11).
- [ ] Make `rebuildSessionOkfAccess` and `rebuildOkfAccessForNodes` call `extractOkfDetail` with `snapshotFiles` and run the three writers; keep their exported signatures unchanged.
- [ ] Check each writer call site — `logs.service.ts:526` (ingest), `:1179` (import, inside a tx), `repositories.service.ts:1515` (recompute) and `session-file-stats-writer.ts:270` (heal). Each must pass its own db / tx handle through to `loadSnapshotFilesForNode`.
- [ ] In `server/src/sessions/sessions.service.ts` `purgeSessionChildData` add the `session_okf_event` and `session_okf_pointer` deletes right after step c2 (:232-236), before c3 `session_tool_usage`, and add `okfExtractVersion: null` to the step g `.set({ harnessSnapshotId: null, okfSnapshotId: null })` (:273).

### Chunk 6 — Thresholds & settings service
- [ ] Create `server/src/logs/okf/okf-thresholds.ts` exporting `DEFAULT_OKF_THRESHOLDS`, `resolveOkfThresholds(raw)` (per-field merge, invalid → default) and `validateOkfThresholds(raw)`, which throws `BadRequestException`. Rules per DD-19.
- [ ] In `server/src/logs/repositories.service.ts` `validateConfig` (:714) call `validateOkfThresholds(config.okf)` when `config.okf !== undefined`, next to the `turnEndCostAdvisor` checks (:793).
- [ ] Add `RepositoriesService.resolveOkfThresholds(userId, repoUrl, teamId?)` returning `{ values, custom }` per DD-20, using `findPersonalRepoConfig`, `resolveUserTeamForUrl` and `findTeamRepoConfig`.
- [ ] In `saveTeamConfig` (:970) and `saveUserConfig` (:1032) load the stored row first and skip the recompute call when the stored and new configs are deep-equal ignoring `okf` (DD-21).
- [ ] Add `okfDefaults: OkfThresholds` and `okfFixedLimits` (DD-0) to `RepoSettingsResponse` (:89) and fill them in `getRepoSettings`.
- [ ] Add a helper `okfCanRecompute(user, repoId, teamId?)` in `RepositoriesService`, reusing the authority check of `recompute-all-sessions` (`repositories.controller.ts:2116-2144`): team owner for the team view, repo owner for the personal view. Note: if the `2026-11-05-readonly-demo-user` task lands first, `okfCanRecompute` must return false for a read-only user, and the `okf` PUTs fall under its write guard; the new GET routes must perform no writes.

### Chunk 7 — Verdict changes
- [ ] In `server/src/logs/okf/okf-verdict.ts` replace the constants (:22-51) with an `OkfThresholds`-typed parameter on `computeSessionVerdict` (:300) and `computeRepoVerdict` (:371), defaulting to `DEFAULT_OKF_THRESHOLDS`.
- [ ] Apply FR-5 upkeep (DD-15) in both verdicts: exclude upkeep read and grep rows, and skip upkeep-only trees as KB sessions while returning `upkeepOnlySessions`.
- [ ] Make `coarse_article` (:445+) use whole-file calls and bytes only (DD-16), with `coarseMinSizeBytes`, `coarseMinSessions` and `coarseMaxReadRatio`.
- [ ] Make `kb_flood` (:412) gate the level on `floodMinSessions` and otherwise emit an `info` finding (DD-17). Make `info` findings never affect the level.
- [ ] Add FR-10 stale and removed handling per DD-17, with the repo verdict input extended by the DD-18a hash maps.
- [ ] In `server/src/logs/okf/okf-usage.types.ts` add the DD-18 rule, severity, finding and marker additions. Add every optional field listed under API changes for `SessionOkfUsageResponse`, `RepoOkfUsageResponse`, `OkfTreeNode` and `OkfAgent`, plus `OkfSignalSummary`.

### Chunk 8 — Value-signals module
- [ ] Create `server/src/logs/okf/okf-value-signals.ts` with input types: period pointer rows, all-time pointer rows, period events, all-time touched paths, per-node read and upkeep sets, latest snapshot files, and thresholds.
- [ ] Implement `computeArticleArea` per DD-12: codeRoots files, shared-pointer drop with `pointerMaxArticles`, current hash or older-hash fallback with the `areaFromOlderVersion` flag.
- [ ] Implement FR-1 yield, FR-2 searched-after and FR-3 routing miss per DD-13/DD-14, excluding upkeep pairs and partial reads, returning per-article and per-node results with top-5 patterns (`OKF_TOP_PATTERNS = 5`).
- [ ] Implement FR-13 dead pointers (with `notFound` per DD-14) and the FR-15 catalog `info` finding, which suppresses FR-3.
- [ ] Export `computeArticleSignals` that returns findings with rules `routing_miss`, `searched_after`, `dead_pointers` and `catalog`, whose params are the DD-26 set: `file`, `patterns`, `area`, `files` and `path`.

### Chunk 9 — Read side: session & repo routes
- [ ] In `server/src/logs/okf/okf-usage.service.ts` add loaders for `session_okf_event` and `session_okf_pointer` rows of the scoped trees, plus an all-time (period-free, same scope) pointer and touched-path query for the area (DD-12). Aggregate in SQL where possible.
- [ ] Apply the DD-24 team filter to the new rows in `okf-usage-tree.ts` `applyOkfTeamFilter`.
- [ ] In `okf-usage-tree.ts` `buildOkfTree` add the DD-18 markers (incl. `not_read`) and the `OkfTreeNode` fields under API changes (`rangedCalls`, `upkeepReadCalls`, `yield`, `searchedAfter`, `routingMiss`, `deadPointers`, `catalogFiles`, `stale`, `removed`).
- [ ] Apply FR-6 (`shareMinBundleFiles`) to the repo share histogram (:614-623), and exclude upkeep from hot files (:640-675) while adding `yield`.
- [ ] Apply DD-6 entry rules in `agentEntry` (used at :461): `search` only with `searchHits > 0` on a folder row followed by a bundle read.
- [ ] Extend `getSessionOkfUsage` (:352) to accept `thresholds`, compute signals with `okf-value-signals.ts`, and fill `upkeep`, `signals`, `thresholds.custom`, `eventsTruncated` and the `OkfAgent` additions (patterns unmasked).
- [ ] Extend `getRepoOkfUsage` (:482) the same way, plus the tiles additions and FR-11 counts (DD-11) over period roots, `upkeep` and `canRecompute`.
- [ ] In `reports.controller.ts` (:350) and `repositories.controller.ts` (:1513) resolve `RepositoriesService.resolveOkfThresholds(user.id, repoUrl, teamId)` and `okfCanRecompute`, and pass them to the service.

### Chunk 10 — Article route & facts route
- [ ] Add `RepoOkfArticleResponse` (shape under API changes) to `server/src/logs/okf/okf-usage.types.ts`.
- [ ] Add `OkfUsageService.getRepoOkfArticle(repoIds, scope, path, thresholds)` building the response from the chunk 9 loaders and `computeArticleSignals`. Task heads are masked with `maskFirstPrompt`; patterns are not. An unknown path returns `found: false`.
- [ ] Add `@Get(':repoId/reports/okf-usage/article')` to `reports.controller.ts` beside `getOkfUsageReport`. It uses the same `resolveUsageScope` params, 400s when `path` is missing or empty, and passes `resolveOkfThresholds(user.id, repoUrl, teamId)` to the service.
- [ ] In `server/src/logs/okf/okf-facts.service.ts` call `extractOkfDetail` (:280) and add per-agent `accessSeq` from `.seq` next to `otherReadsTop` (:325).
- [ ] Add `accessSeq?` to `OkfFactsResponse` in `okf-usage.types.ts` (:158) per API changes.

### Chunk 11 — Client models & libs
- [ ] Mirror every type addition from `okf-usage.types.ts` (DD-18, API changes, `RepoOkfArticleResponse`) in `client/src/models/repositories.ts` (OKF block :863+). Do NOT mirror `accessSeq`: the facts route is not called by the client (see the note at :865-867). Add `OkfThresholds` and `okf?` to `RepoConfig` (`models/repositories.ts:11`), and `okfDefaults` / `okfFixedLimits` to `RepoSettingsResponse` in `client/src/viewer/api.ts` (:1332).
- [ ] Create `client/src/viewer/lib/okf/okf-action-text.ts` exporting `okfActionText(finding)` with the DD-26 text table, the stale suffix and `null` for `session_share` and unknown rules.
- [ ] Extend `formatOkfFinding` in `client/src/viewer/lib/okf/okf-verdict-text.ts` (:82) with titles for the new rules and the `info` severity, keeping the raw fallback for unknown ids.
- [ ] Add `getOkfArticle(repoId, path, filters)` next to the existing repo OKF usage API call (grep `reports/okf-usage` in `client/src`).
- [ ] Add the `okfArticle` URL param (read, write, clear) to `client/src/viewer/pages/repository/okf/okf-url-state.ts`. Keep it OUT of `OKF_PARAM_KEYS`, so a filter change keeps the drill-down open; leaving the tab still clears it via `setMainTab` (`useRepositoryViewState.ts:164-170`).

### Chunk 12 — Client repo tab
- [ ] In `OkfVerdictCard.tsx` add the "→ action" second line per finding (`okfActionText`), grey `info` rows, the `stale` / `removed` chips, the custom / default thresholds chip that links to Settings, and the "measures access, layout and value proxies" subtitle.
- [ ] In `OkfKpiTiles.tsx` add the pointer-yield and routing-miss-articles tiles and the upkeep-only count, per Visual/UX notes.
- [ ] In the shared tree (`OkfTree.tsx`, `okf-tree-rows.tsx`, `okf-tree.ts`) add the YIELD, EXPL. AFTER and ROUTE MISS columns, the new marker chips and a column legend. File names become drill-down links in the repo tab.
- [ ] In `OkfHotFiles.tsx` add a Yield column; in `OkfShareHistogram.tsx` add the caption "bundles of ≥ N files".
- [ ] Create `client/src/viewer/pages/repository/okf/OkfUpkeepPanel.tsx` (article · sessions · bytes) and mount it in `RepoOkfTab.tsx`.
- [ ] Create `OkfAnalysisCoverageBanner.tsx` for FR-11: "X of Y sessions in this period have no OKF analysis yet". The recompute link shows only when `canRecompute` and calls `recomputeAllSessions(repoId, teamId)` as `MaintenanceSection.tsx` does; on success it invalidates the `['repo-okf-usage', …]` query (MaintenanceSection invalidates nothing).
- [ ] In `RepoOkfTab.tsx` render `OkfArticleDrillDown` instead of the overview when `okfArticle` is set; keep the file under 10 KB (it is 7.8 KB now — move the overview into its own component if needed).

### Chunk 13 — Client article drill-down
- [ ] Create `client/src/viewer/pages/repository/okf/article/OkfArticleDrillDown.tsx`: fetch `getOkfArticle` with the tab filters; render the back link, header (size, hash status, read summary incl. partial count) and the DD-29 value signals strip, plus the `found: false` and loading states.
- [ ] Create `article/OkfPointerTable.tsx`: the dead-first list with ✓ / · marks and the "path not found in any session" tag; 17 rows, then "… N more · Show all".
- [ ] Create `article/OkfSignalBlocks.tsx`: the routing-miss block (X of Y, top patterns, missing-agents table), searched-after, dead-pointer and catalog blocks, each with its `okfActionText` line.
- [ ] Add the "same finding on other articles" list (clickable, switching `okfArticle`) and the "area from an older version" note.

### Chunk 14 — Client session tab
- [ ] In `SessionOkfTab.tsx` (8.25 KB) add the whole-tree value-signals tile from `signals`, the "Upkeep" line under Read top 5, and the "events truncated" note — in new files (e.g. `OkfValueSignalsTile.tsx`, `OkfReadTop.tsx`), so the tab stays under 10 KB.
- [ ] Add `§ section ×N` chips to Read top 5 entries and tree rows that have `rangedCalls`.
- [ ] In the session tree rows add POINTERS USED "k / n" and EXPL. AFTER, and an expandable sub-row per agent listing its new pointers (✓ followed) plus "N paths already named in its prompt".
- [ ] Render unread-article rows from `OkfAgent.routingMisses` as "routing miss · N searches" with the action line.
- [ ] In `OkfAgentsPanel.tsx` add the yield, routing misses, upkeep and searches columns.
- [ ] Check every touched component stays under the 10 KB limit; split a row renderer into its own file where needed.

### Chunk 15 — Client Settings block
- [ ] Create `client/src/viewer/pages/repository/OkfThresholdsSection.tsx` (root `id="okf-thresholds"`): a two-group table SETTING / DEFAULT (from `okfDefaults`) / VALUE / WHAT IT AFFECTS, using the DD-19 labels, with a `codeRoots` tag list and a "Not settings" footer built from `okfFixedLimits`.
- [ ] Add inline validation mirroring DD-19 and show the server 400 message on save failure.
- [ ] Implement diff-only save, "Reset to defaults" and "Copy from team settings" per DD-22 inside `OkfThresholdsSection` (props: `data`, `isTeamView`, `readOnly`, a `save(config)` callback built on the existing read-modify-write helper `withSavedAnalysisSettings`, `RepositorySettings.tsx:129-180`). `RepositorySettings.tsx` is already 15.2 KB — keep the logic out of it.
- [ ] Mount the section in the analysis tab of `RepositorySettings.tsx` (:308-346), honouring `readOnly` (:127). Add `okf` to `withSavedAnalysisSettings` (:147-156) so the categories save carries it through; `saveThreshold` and `saveTurnEndCostAdvisor` already spread `base` — verify they keep `okf`.
- [ ] Link the verdict card's thresholds chip to Settings via search params `mtab=settings&stab=analysis&sfocus=okf-thresholds` — NOT a URL hash: the app uses `createHashRouter` (`client/src/main.tsx:257`), so the hash holds the route. Pass an `onOpenThresholds` callback into `OkfVerdictCard` from `RepoOkfTab` and `SessionOkfTab`, built on the `setMainTab` logic (`useRepositoryViewState.ts:145-170`, `useRepositorySettingsTabState.ts`). On mount with `sfocus=okf-thresholds`, the section calls `scrollIntoView` and drops the param with `replace`. `id="okf-thresholds"` stays only as a DOM anchor.

### Chunk 16 — Docs & KB
- [ ] Create `docs/knowledgebase/algorithms/okf-value-signals.md` per `algorithms/README.md` (the rules of DD-12..DD-14), with a pointer to the rows file `docs/algorithm-examples/okf-value-signals.json`. Add it to the table in `docs/knowledgebase/algorithms/README.md` and to `docs/knowledgebase/index.md`.
- [ ] Update `docs/knowledgebase/algorithms/okf-access-extraction.md`: rule 4 (ranges), rule 8 (proportional split), plus new rules for search hits, `ls <file>`, events, pointers, partial reads and the caps.
- [ ] Update `docs/knowledgebase/algorithms/okf-verdict.md`: the thresholds table (DD-19) replaces the DD-23 constants, plus the upkeep, whole-only coarse ratio, FR-6, FR-7 `info` and FR-10 stale rules. Note that the defaults were calibrated on the Log Hub repo, with a pointer to this task's `notes.md`.
- [ ] Update `docs/knowledgebase/algorithms/bash-command-view.md` rule 5.9 (`range`, `pattern`, `git grep`) and add the `okf/article/` folder to `docs/knowledgebase/client-component-map.md` next to the OKF lines (~:84, :121, :164).
- [ ] Update `docs/knowledgebase/okf-usage.md`: the new tables, the marker, the writers, the team filter for the new rows, the article route, settings resolution (DD-20) and the backward-compatibility table.
- [ ] Update `docs/knowledgebase/db-tables.md` with the new tables and columns (in the same diagram style as the recently added `otel_session_totals` / `otel_agent_totals`, :44-52), and `server-endpoint-map.md` with the article route (scope and 403 like `okf-usage`, the `found: false` rule).
- [ ] `user-docs/session-log.md` has no OKF section (only tab-table rows :14, :39). Create `user-docs/okf-tab.md` (session and repo OKF tabs: columns, drill-down, actions, upkeep, thresholds) modelled on `otel-tab.md`, add it to `user-docs/nav.json`, link it from the `session-log.md` tab tables, add its `docRef` / help row in `tests/scenarios/tours/screen-registry.ts` (`tour-10-registry` fails otherwise), then run `npm run build:help`.

### Chunk 17 — Tests: algorithm rows
- [ ] In `server/src/logs/okf/okf-access-extractor.algo.spec.ts` compare optional `expected.events` and `expected.pointers` (against `extractOkfDetail`) when a row has them, and allow a row-level `snapshotFiles`.
- [ ] Add the new zero counters to the existing rows of `docs/algorithm-examples/okf-access-extraction.json`, then add the rows listed under Test coverage plan (ranges, FR-8, FR-9, search hits, events, patterns, caps, pointers, partial, multi-file).
- [ ] Add `bash-command-view.json` rows for `range` (`sed -n`, `head`, `tail`), `pattern` (grep, rg, `-e`) and `git grep`; update existing grep rows with `pattern`.
- [ ] Update RV-09 in `docs/algorithm-examples/okf-verdict.json` to FR-7 (`info`), then add the FR-4, FR-5, FR-6, FR-7 (3 floods), FR-10 stale / removed and threshold-override rows. In the spec, pass a row's raw `okf` through `resolveOkfThresholds`, and add a row with an invalid stored field that falls back to its default.
- [ ] Create `docs/algorithm-examples/okf-value-signals.json` with the rows listed under Test coverage plan, and `server/src/logs/okf/okf-value-signals.algo.spec.ts` modelled on `okf-verdict.algo.spec.ts`.
- [ ] Run the fast set (`adlc-lh:check-health`, `finalRun: false`) and fix failures.
- [ ] Run `npm run perf` from `server/` and compare with the baseline; stop and ask the user if any metric degrades by more than 20 %.

### Chunk 18 — Tests: contract rows
- [ ] Add a few `session_okf_event` / `session_okf_pointer` rows and a marker for the existing OKF fixture session in `server/test/contract/fixtures/world-v1.sql.ts`: extend the now 9-column `sessions` insert (:1248, ends with `agent_description, workflow_phase`) with `okf_extract_version`, and add the event/pointer inserts after the `session_okf_access` block (~:1974).
- [ ] Extend `F21-okf-usage` in `server/test/contract/registry/f21-reports.ts` (`F21-okf-usage` :376, `-hot-files` :422, `-outsider` :477) for the new optional fields, then add `F21-okf-article`, `F21-okf-article-outsider` (403) and `F21-okf-article-missing-path` (400).
- [ ] Extend the session `okf-usage` row in `f19-change-surface.ts` (:65) with the new fields.
- [ ] Extend the facts rows in `f16-post-turn.ts` (:394-444) with `accessSeq` (server-only field; the client does not mirror it).
- [ ] Add rows to `f14-repositories.ts` (:178-357): an `okf` round-trip on the user and team PUT, an invalid `okf.routingMinSearches` → 400, and `okfDefaults` in the GET and PUT responses.
- [ ] Run `npm run test:contract` from `server/` (in the background, never alongside a build or e2e run) and fix failures.

### Chunk 19 — Tests: scenario steps
- [ ] Extend `tests/scenarios/helpers/okf.ts` `OkfAction` (:62): `read` with `result` text and `offset` / `limit`, `grep` with `pattern`, a `bash` command action, and a sub-agent `task` that may name paths (feeding `agentTranscriptLines` :199).
- [ ] In `tests/scenarios/repos/s-repo-16.spec.ts` add step 12: routing miss — 3 sub-agents grep 3× in an article's area without reading it, another greps 2×. The drill-down shows "3 of 4" with patterns; a sub-agent read does not clear the main agent.
- [ ] Add step 13: yield and dead pointers — a read whose pointer is then opened counts as a hit; the same path named in the sub-agent task does not; a pointer shown in 4 reads and never followed is listed dead.
- [ ] Add step 14: upkeep — the reads of an agent that edits the article appear in the Upkeep panel, not in hot files or the yield.
- [ ] Add step 15: switch the s-repo-16 team (now `transparent`, :72) to `restricted` via the owner PATCH of `accessMode`, and use a member whose role gives `team-no-prompts` visibility (`team-scope.ts:60-69`). In the drill-down the search patterns are unmasked and `missing[].taskHead` is masked. Restore `transparent` at the end of the step, because later steps assume it.
- [ ] Add step 16: set `routingMinSearches` to 2 in Settings → OKF thresholds; the routing-miss list grows without recompute, the "custom thresholds" chip shows, and the FR-11 banner and recompute link follow authority.
- [ ] Update `tests/scenarios/view/s-sess-09.spec.ts` for DD-15: in step 8 (:282) `a01.md` (read after own edit) moves from Read top 5 to the Upkeep line; in step 9 (:290) the tree row keeps `own edit` and also shows `upkeep ×1`. Add a step 11 for the Chunk 14 UI (POINTERS USED, EXPL. AFTER, agents panel yield / routing misses / upkeep / searches columns, `§` chips).
- [ ] Regression check: run `tests/scenarios/view/s-rept-01.spec.ts` step 9 (:252, exact `toEqual` on repo findings) — its 5-file bundle should gain no FR-6 / FR-7 findings; if it does, record it in `docs/BLOCKED.md` instead of loosening the assertion.
- [ ] In `tests/scenarios/repos/s-repo-09.spec.ts` extend steps 5a / 9: after import the tree has `session_okf_event` / `session_okf_pointer` rows; after delete they are gone. Run each touched scenario with `--grep`.
