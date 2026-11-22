---
type: "Architecture Guide"
title: "OKF Usage (knowledge-base use tabs)"
description: "How Log Hub measures agents' use of a repository's OKF knowledge bases: the hook's okf-snapshot, the session_okf_access and okf_snapshots tables, the extraction, the one response shape of the session and repo OKF tabs (summary line, Versions, Wrong format, Hot files, Explorer), the reference snapshot, the KB cost estimate, the API-key facts route, the team fail-closed filter, lifecycle (recompute, delete, export) and backward compatibility."
tags:
  - okf
  - knowledge-base
  - session-view
  - reports
  - hook
generated: { by: "ai:claude", at: "2026-11-21T22:36:45+04:00" }
---

# OKF Usage

An **OKF bundle** is a folder whose `index.md` front matter carries `okf_version:` (this repo's
`docs/knowledgebase/` is one). The OKF feature answers four plain questions: which format version
each bundle declares, which articles have a malformed front matter, which KB files the agents read
most, and which files were opened at all. A summary line above them says in how many sessions (or
by how many agents) the KB was read, how many tokens of context that was and what it roughly cost.
It has two sides — per session (Session pane → **OKF** tab) and per repository over a period
(Repository → **OKF** main tab) — plus an API-key route that hands the plain facts of one session
to a local analysis skill. There is no LLM anywhere in it.

Tasks of origin: `2026-10-27-okf-usage-tab` (snapshot, extraction, routes),
`2026-11-19-okf-v03-support` (front-matter metadata) and `2026-11-21-okf-tab-minimal`, which cut
both tabs down to the summary line and four views and removed the verdict, the value signals, the
agent trail, the article drill-down and the OKF thresholds settings (see "Removed features").
"DD-n" below refers to the impl-plan of the last one.

## Data flow

1. **Hook** (`send-logs-hook.js`, hook ≥ 2.26.0): on the root session's `artisyn` upload it
   builds the KB snapshot (`okf-snapshot.js` → `okf-snapshot` line) and always prepends an
   `okf-snapshot-ref` line; the full line only when `okf-state.json` does not list the id yet.
   Query params `okfSnapshotId` (+ `okfSnapshotFull=1` with the full line). Detection, ids and
   ignored flags: [algorithms/okf-snapshot.md](algorithms/okf-snapshot.md). Hook `3.1.0`+ also
   sends the OKF v0.3 front-matter metadata (bundle `okfVersion` / `title` / `description`, file
   `meta`) — see "OKF v0.3 metadata and article rules" below.
2. **Ingest** (`logs.service.ts` Step 5d2, `okf/okf-snapshot.ts` `storeAndBindOkfSnapshot`): a
   full line is stored in `okf_snapshots` (per owner, `ON CONFLICT DO NOTHING`); the root
   `sessions` row is bound with `okf_snapshot_id = $id WHERE okf_snapshot_id IS NULL` — first
   upload wins, never rebound. Both lines are non-activity lines for `artisyn-extractor.ts`.
3. **Extraction** (`okf/okf-access-extractor.ts` `extractOkfDetail` via
   `okf/okf-access-writer.ts`): every `claude` / `claude-subagent` body is turned into
   `session_okf_access` rows for its own tree node, delete-then-insert per node, and the node's
   extraction marker is set — rules in
   [algorithms/okf-access-extraction.md](algorithms/okf-access-extraction.md). Bash commands go
   through `analyzeBash` from `@loghub/bash-view` with the server's tree-sitter parser
   (`okf/server-bash-parser.ts`). The root's bound snapshot (`loadSnapshotForNode`) gives the
   file sizes for the byte split and the bundle roots. The rows are stored raw.
4. **Read side** (`okf/okf-usage.service.ts`): loads the access rows of the tree / the scoped
   trees, the stored snapshot bodies and the per-node cost figures (`session_stats`,
   `session_costs`), picks the reference snapshot, applies the team filter
   (`okf/okf-team-filter.ts`) in a team view, and hands everything to the pure
   `buildOkfUsageView` (`okf/okf-usage-counting.ts`). No counting rule lives in the service —
   all of them are in [algorithms/okf-usage-counting.md](algorithms/okf-usage-counting.md).

Server modules in `server/src/logs/okf/`:

| Module | Role |
|---|---|
| `okf-snapshot.ts` | store / bind / normalise the snapshot |
| `okf-access-extractor.ts`, `okf-pointers.ts`, `server-bash-parser.ts` | transcript → access rows and the facts route's sequence |
| `okf-access-writer.ts` | the only writer of `session_okf_access` and the marker |
| `okf-paths.ts` | pure path helpers (`bundleOfPath`, `bundleArticles`, `isReservedOkfName`, `isDotPathUnderRoot`, folder keys) and the row type `OkfUsageRow` |
| `okf-team-filter.ts` | `applyOkfTeamFilter` |
| `okf-metadata.ts` | version hint, `stale_after`, deprecated, format hints |
| `okf-usage-counting.ts` | `buildOkfUsageView`, `pickReferenceRoot` — every counting rule |
| `okf-usage.service.ts` | loaders and the two route methods |
| `okf-usage.types.ts` | `OkfUsageResponse` and the facts types |
| `okf-facts.controller.ts`, `okf-facts.service.ts`, `okf-task-context.ts` | the API-key facts route |
| `okf-constants.ts` | fixed limits, `OKF_DEFAULT_BRANCH_NAMES`, `OKF_BYTES_PER_TOKEN` |

## Tables

| Table / column | Content |
|---|---|
| `okf_snapshots` | `(user_id, snapshot_id)` unique; `body jsonb` = the snapshot without its `type` (`okfSnapshotId`, `schemaVersion`, `bundles[]`); `created_at` = `snapshot.takenAt` of both routes. |
| `sessions.okf_snapshot_id` | Bound snapshot of a **root** session (indexed, no FK — an orphan sweep may remove the row under it). Sub-agents resolve their root via `topAncestorIdsSql`. |
| `upload_queue.okf_snapshot_id` | Id of a queued full-body upload, so the known check sees snapshots still in flight. |
| `session_okf_access` | One row per tree node × `(path_key, op, after_own_edit)`: `bytes`, `calls`, `seq` (first-access rank in the node). `op` ∈ `read`, `grep`, `list`, `write`; a folder key ends in `/` (repo root `/`). Also `ranged_calls` / `ranged_bytes` and `search_hits` (written, not read by the tabs). Cascades with its `sessions` row. The tabs read `path_key`, `op`, `bytes`, `calls` only. |
| `sessions.okf_extract_version`, `sessions.okf_events_truncated` | The **marker**: the writer sets `OKF_EXTRACT_VERSION` (4) on every node it rebuilds, even with zero rows, and `okf_events_truncated` when the extractor hit a cap. Nothing reads the marker any more (the "no OKF analysis yet" banner is gone); it stays as the record of which extractor version built the rows. |
| `session_okf_event`, `session_okf_pointer` | **No longer written since 2026-11-21** (DD-15). Rows written before stay until a follow-up task drops the tables; the session delete still removes them. Nothing reads them. |

Migrations `server/drizzle/migrations/0075_okf_usage.sql` and `0091_okf_value_signals.sql`; the
2026-11-21 cut has no migration. Details: [db-tables.md](db-tables.md).

## Where the rows are written

`rebuildSessionOkfAccess` / `rebuildOkfAccessForNodes` (`okf/okf-access-writer.ts`) are the only
writers of `session_okf_access` and the marker (`writeSessionOkfAccess`, `writeOkfExtractMarker`;
per node `DELETE`, then insert with `ON CONFLICT … DO UPDATE` on the unique key, because the heal
and the backfill may race a concurrent writer). They are called wherever the file stats are
written, with the same repo roots:

- ingest — `logs.service.ts` `upsert()` Step 3b';
- import — `logs.service.ts` import path (same writer, roots of the archive);
- heal — `session-file-stats-writer.ts` `rewriteSessionTreeFileStats` (a log that brings the
  roots later rebuilds the tree's rows);
- recompute — `repositories.service.ts` `recomputeOkfAccess`, once per tree from
  `POST /api/v1/repositories/:repoId/recompute-all-sessions` (the only way to fill rows for
  sessions ingested before the feature).

A tree node with no usable repo root gets no rows.

## Routes

| Route | Auth / scope | Service |
|---|---|---|
| `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` (`teamId?`) | `SessionAuthGuard`; same scope and 403 rules as the change-surface session routes; a session not visible in the scope answers the empty response, not 404 | `OkfUsageService.getSessionOkfUsage` (`repositories.controller.ts`) |
| `GET /api/v1/repositories/:repoId/reports/okf-usage` (`startDate`, `endDate` required; `branches`, `users`, `teamId`, `attr`, `bundle?`) | `SessionAuthGuard`; scope via `resolveUsageScope` (same as `harness-usage`); unknown `bundle` = all | `OkfUsageService.getRepoOkfUsage` (`reports/reports.controller.ts`) |
| `GET /api/v2/okf-usage/facts?sessionId=` | API key; 400 without `sessionId`; 404 for a missing session and for one whose logs the key's user does not own | `OkfFactsService.getFacts` (`okf/okf-facts.controller.ts`) |
| `POST /api/v2/logs` + `okfSnapshotId?`, `okfSnapshotFull?=1` → `unknownOkfSnapshotId?` | existing upload | `logs-v2.controller.ts` |

- An invalid `okfSnapshotId` (not `^[0-9a-f]{64}$`) is ignored silently, never a 400; an
  over-cap body (`OKF_SNAPSHOT_MAX_BYTES` = 10 MB) is ignored and the id stays unknown.
- `unknownOkfSnapshotId` comes back on a ref-only upload whose id is neither stored for the user
  nor in a pending / processing / partially uploaded queue row (`isOkfSnapshotKnown`); the hook
  then forgets the id and resends the full body next time.
- The facts route reparses the stored transcripts (never `session_okf_access`): `prompts` (main
  agent, `filterUserPrompts`, each cut to 4000 characters), per agent `kbReads`, `kbSeq`,
  `otherReadsTop` (top 20 non-KB reads), `changes`, `accessSeq` (the ordered accesses with range,
  pattern, the new pointers of a KB read and `hit` on search items, from
  `extractOkfDetail(...).seq`); and tree-wide `changes`, `reads`, `runs`. No tool result text.
  Prompt filter: [algorithms/okf-task-context.md](algorithms/okf-task-context.md). The 2026-11-21
  cut did not change this route.

### `OkfUsageResponse` (both tab routes)

One shape for both routes — `server/src/logs/okf/okf-usage.types.ts`, mirrored in
`client/src/models/repositories.ts`:

| Field | Meaning |
|---|---|
| `unit` | `sessions` (repo route: the unit is a root session) or `agents` (session route: the unit is a tree node) |
| `snapshot` | `{ branch, takenAt, hasMeta }` of the reference snapshot; `null` = no KB snapshot, then every array is empty and every number zero |
| `bundleRoots` | every visible bundle root, also under a `bundle` filter (feeds the KB folder select) |
| `currentFormat` | `OKF_CURRENT_FORMAT_VERSION` (`0.3`) |
| `summary` | `unitsRead` (N), `unitsTotal` (M), `reads`, `tokens`, `cost`, `readsWithoutCost`, `spend` (T) |
| `versions[]` | per bundle: `root`, `files`, `okfVersion` (`null` = not declared), `older`, `ignored`; `[]` when `snapshot.hasMeta` is false |
| `format` | `articles`, `indexFiles`, `withProblems`, `groups[]` (`problem`, `files[]` with optional `supersededBy`); `null` when `snapshot.hasMeta` is false |
| `files[]` | every snapshot file plus every read file not in the snapshot: `bundle`, `path`, `inSnapshot`, `index`, `units`, `reads`, `tokens`, `cost` |
| `folders[]` | per bundle root and folder: `bundle`, `path` (ends in `/`), `units`, `search` (folder-level searches on exactly this folder, or `null`) |
| `notInSnapshotUnits` | distinct units that read a file not in the snapshot |

Invariants: Σ `files[].tokens` + Σ `folders[].search.tokens` = `summary.tokens` (the same for
`reads` and, within float rounding, `cost`); Σ `versions[].files` = number of `files` with
`inSnapshot`; `format.articles + format.indexFiles` = that same number.

What the numbers mean, in short (the full rules are the algorithm doc):

- **A read** is a `read` or `grep` access row whose path lies in a bundle of the reference
  snapshot. `list` / `write` rows, paths outside every bundle, dot-paths and stored glob paths
  count nowhere. `reads` = Σ `calls`; `tokens` = Σ `bytes` / 4.
- **M** is the number of root sessions of the scope (repo) or the opened node plus its
  descendants with an agent log (session); **N** is how many of them have at least one read.
- **Spend (T)** is Σ `session_costs.cost` over every node of the same trees — not the
  Sessions-list / Spend-tab total, which adds utility calls and max(transcript, OTEL).
- **KB cost** is an estimate: per node, the KB share of what the node put into its context
  (`kbTokens / (input_tokens + cache_write_tokens)`, capped at 1) × the context-side cost (input
  + cache write + cache read; output is not included). File, folder-search and summary costs
  are sums of row costs, so they add up.

## Reference snapshot

The file lists (`files`, `folders`, `versions`, `format`, "never opened") are measured against one
snapshot (DD-7):

- **Repo route:** among the scoped roots that have a stored snapshot, the newest (`startTime`)
  whose branch is `main` or `master` (`OKF_DEFAULT_BRANCH_NAMES`); when there is none, the newest
  of all (`pickReferenceRoot`). No "default branch" is stored anywhere in the product — the name
  list is the rule. This keeps a snapshot taken on a feature branch from deciding which files are
  "never opened".
- **Session route:** the snapshot bound to the tree's root.

`snapshot.branch` is that root's `logs.git_branch` (may be `null`), `snapshot.takenAt` is
`okf_snapshots.created_at`. A file that was read but is not in the reference snapshot (deleted,
renamed, on another branch) is listed with `inSnapshot: false` and shown under "Not in this
snapshot".

## OKF v0.3 metadata and article rules

Algorithm doc of the derivation: [algorithms/okf-metadata.md](algorithms/okf-metadata.md)
(`okf/okf-metadata.ts`, pure, no DB).

**Snapshot fields (hook `3.1.0`+, additive, `schemaVersion` stays 1).** The hook reads the first
8192 bytes of every bundle file and parses its front matter:

- per bundle, from the bundle-root `index.md`: `okfVersion`, `title`, `description` — each only
  when the value is present (quotes stripped, inline `#` comments cut, `''` / `null` / `~` / block
  scalars absent, capped at 200 characters);
- per file (`index.md` included): `meta` = `{frontMatter, hasGenerated, hasTimestamp}` always, plus
  `type`, `status`, `superseded_by`, `stale_after` when present.

The body is stored verbatim; `normaliseSnapshot` (`okf/okf-snapshot.ts`) copies the strings
(truncated to 200), maps `superseded_by` / `stale_after` to `supersededBy` / `staleAfter`, ignores
wrong types and never drops a bundle or file for bad metadata. Hook side (snapshot id, cache
entry, size guard): [hook-api-versioning.md](hook-api-versioning.md) "OKF snapshot metadata".

**What the tabs derive from it.** `snapshot.hasMeta` = some bundle of the snapshot has a file with
`meta` (`hasHookMeta`). Without it `versions` is `[]` and `format` is `null`, and the client shows
one line "Update the hook to see versions and format problems." in their place. With it:

| Response field | Rule |
|---|---|
| `versions[].okfVersion`, `.older` | the bundle's declared `okf_version`; `older` = `okfVersionHint` — absent / not `major.minor[.patch]` / below `0.3` |
| `format.groups[]` | over the bundle's articles, `articleMetaFlags`: `no_front_matter`, `no_type`, `v01_timestamp`, `deprecated` (with the resolved `supersededBy`), `past_stale_after` — in this fixed order, empty groups left out, an article may sit in several |
| `format.withProblems` | distinct articles with at least one problem |

The reference time of `past_stale_after` is now on the repo route and the opened session's start
on the session route. The bundle `title` / `description` are stored but not shown.

**Article rules (every hook version).** `bundleArticles` (`okf/okf-paths.ts`) excludes the
bundle's own `index.md`, **any** `index.md` / `log.md` at any depth (`isReservedOkfName`) and
dot-paths. Reserved files still count as KB reads (they are in `files[]` with `index: true`, in the
summary and in the explorer), but they are not hot files and not checked by Wrong format. A file
whose path below its bundle root has a segment starting with `.` (e.g. `kb/.drafts/a.md`) is
dropped by `normaliseSnapshot` and `bundleOfPath` returns `null` for it: it is not KB at all and
the extractor treats it as code. A file belongs to the deepest bundle above it, so a nested
bundle's files never count in the outer one.

## Client: one view, two tabs

`client/src/viewer/pages/repository/okf/view/` holds the shared view; both tabs only fetch and
pass `data` (`OkfUsageView.tsx`). The unit label comes from `data.unit` ("Sessions" / "Agents").

| File | What it renders |
|---|---|
| `OkfUsageView.tsx` | layout: summary line; Versions + Wrong format; Hot files + Explorer. The pairs stack below `56rem` of the view's own width (container query `@[56rem]:`) |
| `OkfSummaryLine.tsx` | "KB read in **N of M** sessions" / "KB read by **N of M** agents" · "≈ X tokens of context" · "≈ $Y (≈ P % of $T spend)" · "snapshot from `branch`, date" |
| `OkfVersionsBlock.tsx` | one collapsed line ("K KB folders, all on format 0.3"), expanded when a bundle is behind; per bundle: path, files, version or "not declared", "older than the current format", the "not in git" chip for a gitignored bundle; also `OkfOldHookLine` |
| `OkfWrongFormatBlock.tsx` | one line when clean ("All N articles are well-formed · K index files are not checked"), else "Wrong format — P of N articles" with collapsible groups (10 files, then "show all") |
| `OkfHotFilesTable.tsx` | read articles (`units > 0`, `index` false): File, Sessions / Agents, Reads, ≈ Tokens, ≈ $; sortable (default ≈ Tokens descending, ties by path), 10 rows then "Show all N files"; one line sums the index files |
| `OkfExplorer.tsx`, `OkfExplorerRow.tsx`, `okf-explorer-tree.ts` | the tree built on the client from `files[]` and `folders[]` (it only sums server values): bundle roots, folders, files, a "searches across this folder" row, the last root "Not in this snapshot"; chips All / Opened (X) / Never opened (Y − X); everything collapsed at first |
| `OkfNoSnapshotLine.tsx` | "No KB snapshot — update the hook." + "How to update" → `#/api-keys` |
| `OkfLoadError.tsx` | "No access" (403) / "Error — KB usage could not be loaded." |
| `OkfTip.tsx`, `okf-view-text.ts` | the "ⓘ" tooltips and every fixed text and constant (`OKF_HOT_FILES_TOP`, `OKF_FORMAT_FILES_TOP`) |

Display formats (`formatApproxTokens`, `formatApproxCost`, `formatSpend`, `formatKbShare`) are in
`client/src/viewer/lib/okf/okf-format.ts`; their rules are part of the algorithm doc. The server
already divides bytes by 4 — the client converts nothing.

- **Session OKF tab** — `session-log/okf/SessionOkfTab.tsx` (tab id `okf`, between "Harness
  usage" and "Raw Logs"; `SessionOkfStates.tsx` keeps only `LoadingSkeleton`). The tree is the
  opened session and its sub-agents.
- **Repository OKF tab** — `okf/RepoOkfTab.tsx` (main tab `okf`, between Tools/MCP and OTEL,
  shown where `canSeeTeamWideTabs` allows). Filter strip (`OkfFilterStrip.tsx`): dates, branches,
  users, attributes, KB folder (fed from `data.bundleRoots`); applied at once and mirrored to the
  URL params `okfFrom`, `okfTo`, `okfBranches`, `okfUsers`, `okfAttr`, `okfBundle`
  (`okf-url-state.ts`; `setMainTab` drops them when leaving the tab). The hot-files sort and the
  explorer's filter and open folders are local state, not URL params.
- **Bundle filter** (`bundle`): a known root narrows `versions`, `format`, `files`, `folders` and
  every read number to that bundle; `unitsTotal`, `spend` and `bundleRoots` stay those of the
  whole scope.

Personal vs team view follows the route (`/repos/:id` vs `/teams/:t/repos/:id` → `teamId`), not a
toggle. Test ids and exact texts: DD-20 of the impl-plan; the scenario that walks the tab is
`@S-REPO-16`.

## Team filter (fail closed)

With `teamId` both routes run `applyOkfTeamFilter` (`okf/okf-team-filter.ts`) **before** counting:
a row survives only when the accessing tree's own snapshot lists the path `ignored: false` and no
contributing snapshot (any tree's own, or the reference one) lists it ignored; a folder row only
when a visible file lies under it; a tree without its own snapshot contributes no rows (it still
counts in M); bundles whose `index.md` is ignored are dropped and ignored files leave the file
lists. Ignored flags come from `git check-ignore` on the author's machine, and a failed check
marks everything ignored, so a private KB (`docs/kb-local/`, a gitignored article) never shows in
a team view — not in a count, not in a path, not in `bundleRoots`. For the same reason a
deprecated article's `supersededBy` is listed in a team view only when its target is a visible
file of the filtered snapshot (`teamView` of `buildOkfUsageView`).

In the personal view nothing is filtered: a gitignored bundle is shown with the "not in git" chip
(`versions[].ignored`), and a tree without its own snapshot is counted against the reference
snapshot like any other.

## Lifecycle

- **Delete** (`sessions.service.ts` `purgeSessionChildData`): step c2 deletes
  `session_okf_access`, `session_okf_event` and `session_okf_pointer` (a soft delete keeps the
  `sessions` row, so the cascade does not run); step g clears `okf_snapshot_id` with
  `harness_snapshot_id` and resets `okf_extract_version` to `NULL` and `okf_events_truncated` to
  `false`; step h sweeps orphan `okf_snapshots` (`deleteOrphanOkfSnapshots`). The team-repo
  removal (`teams.service.ts`) runs the same sweep. See [data-retention.md](data-retention.md).
- **Export / import**: the export zip's session shape carries `okfSnapshotId`; the root's
  `artisyn.jsonl` gets the full `okf-snapshot` line plus a ref line; import stores and rebinds
  like ingest. Older zips (no field, no lines) import with no snapshot. See
  [session-export-import.md](session-export-import.md).
- **Recompute**: `recompute-all-sessions` rebuilds `session_okf_access` and the marker for every
  node; import rebuilds them like ingest. Nothing in the tabs needs a recompute after a server
  upgrade — every number is computed on read.

## Removed features (2026-11-21)

Removed, not deprecated — nothing of it is left in the UI, the routes or the code:

- the verdict card with its Checks block and findings, the KPI tiles, the share histogram, the
  not-read list, the Upkeep panel, the "no OKF analysis yet" banner;
- the value signals (pointer yield, routing miss, searched after reading, dead pointers,
  catalog), the A / B sections, the Agents panel and the agent trail;
- the article drill-down (`okfArticle` URL param) and the routes
  `GET …/reports/okf-usage/article` and `GET …/sessions/:sessionId/okf-usage/trail`;
- the OKF thresholds settings: the Settings → Analysis → "OKF thresholds" section, the
  `okfDefaults` / `okfFixedLimits` fields of the settings responses and the validation of
  `config.okf`;
- the Bytes / Calls toggle and the `okfAgent` URL param;
- server modules `okf-verdict.ts`, `okf-value-signals.ts`, `okf-thresholds.ts`, `okf-trail.ts`,
  `okf-usage-tree.ts` and the algorithm docs `okf-verdict`, `okf-value-signals`.

Still in place although unused by the tabs: the tables `session_okf_event` /
`session_okf_pointer`, the `okf` section of stored repo configs, the extractor's events and
pointers (`extractOkfDetail` still computes them; the facts route uses its `seq`). A follow-up
task drops the tables and the stored section.

The marketing site (`site/`) still shows the old tab until a follow-up task refreshes it — see
[user-docs-and-site.md](user-docs-and-site.md).

## Backward compatibility

| Combination | Behaviour |
|---|---|
| Old hook (< 2.26.0) → new server | No OKF params / lines: `okf_snapshot_id` stays null; extraction still fills `session_okf_access`. The session tab is the one-line "No KB snapshot — update the hook." state; on the repo tab such a session counts in M and, in the personal view, its reads are counted against the reference snapshot of the other sessions. |
| Hook 2.26.0 … 3.0.x → new server | A snapshot without metadata: `snapshot.hasMeta` is false, one line replaces Versions and Wrong format; summary, hot files and explorer work as usual. Bundles whose `okf_version:` sits past byte 512 of `index.md` stay undetected until the hook is updated. |
| New hook → old server | Unknown query params and NDJSON line types are ignored; the upload succeeds. Hook 3.1.0's extra snapshot fields are stored verbatim and appear once the server is upgraded (no re-upload). |
| Old zip → new server / new zip → old server | Imports with no snapshot / `okfSnapshotId` and OKF lines are ignored. |
| Sessions extracted at an older `okf_extract_version` | Their access rows are read as they are; no recompute is needed. Rows of older extractor versions may hold glob paths as `path_key` — the read side drops them (counting rule 1). |
| Rows in `session_okf_event` / `session_okf_pointer` | Left as they are, never read, no longer written (DD-15); deleted with their session. No migration. |
| Stored `config.okf` (thresholds saved before the cut) | Stays in `repo_config` / `team_repo_config`, never read. A settings PUT keeps the stored section whatever the body carries (DD-16): a body with an `okf` section — valid or not — answers 200 and does not change it, so an older client's read-modify-write save still works. |
| Older client → new server | Client and server ship in one build, so the removed response fields have no shim (DD-23): a browser tab opened before a redeploy shows the OKF tab's error state until reload. The removed routes answer 404. Settings responses no longer carry `okfDefaults` / `okfFixedLimits`. |
| Local skills using `GET /api/v2/okf-usage/facts` | Unchanged — same response, `accessSeq` included. |
| Hook | No hook change in the 2026-11-21 cut. OKF v0.3 metadata needs hook `3.1.0`+ (see above). |

Hook side: [hook-api-versioning.md](hook-api-versioning.md) (2.26.0, 3.1.0) and the `okf` config key in
[hook-installation.md](hook-installation.md).
