---
type: "Architecture Guide"
title: "OKF Usage (knowledge-base use tabs)"
description: "How Log Hub measures agents' use of a repository's OKF knowledge bases: the hook's okf-snapshot, the session_okf_access / session_okf_event / session_okf_pointer and okf_snapshots tables and the extraction marker, the extraction, verdict and value signals, the session and repo OKF tabs and the article drill-down, the OKF thresholds settings, the API-key facts route, the team fail-closed filter, lifecycle (recompute, delete, export) and backward compatibility."
tags:
  - okf
  - knowledge-base
  - session-view
  - reports
  - hook
timestamp: "2026-11-05T00:00:00+04:00"
---

# OKF Usage

An **OKF bundle** is a folder whose `index.md` front matter carries `okf_version:` (this repo's
`docs/knowledgebase/` is one). The OKF feature answers: which KB articles did the agents of a
session tree read, searched or listed, how many bytes went into their context, did they start
from the index, and is the KB laid out well for them (verdict). It has two sides — per session
(Session pane → **OKF** tab) and per repository over a period (Repository → **OKF** main tab) — plus
an API-key route that hands the plain facts of one session to a local analysis skill. There is no
LLM anywhere in it (FR-19).

Task of origin: `docs/tasks/done/2026-10-27-okf-usage-tab/` (requirements, impl-plan with the
DD-n design decisions quoted below). The **value signals** — does an article point the agent at
code it then uses, which searches show a missing route, what to change in the KB and where — come
from `2026-11-03-okf-view-kb-value` (GH-88); its decisions are quoted as "value-view DD-n".

## Data flow

1. **Hook** (`send-logs-hook.js`, hook ≥ 2.26.0): on the root session's `artisyn` upload it
   builds the KB snapshot (`okf-snapshot.js` → `okf-snapshot` line) and always prepends an
   `okf-snapshot-ref` line; the full line only when `okf-state.json` does not list the id yet.
   Query params `okfSnapshotId` (+ `okfSnapshotFull=1` with the full line). Detection, ids and
   ignored flags: [algorithms/okf-snapshot.md](algorithms/okf-snapshot.md).
2. **Ingest** (`logs.service.ts` Step 5d2, `okf/okf-snapshot.ts` `storeAndBindOkfSnapshot`): a
   full line is stored in `okf_snapshots` (per owner, `ON CONFLICT DO NOTHING`); the root
   `sessions` row is bound with `okf_snapshot_id = $id WHERE okf_snapshot_id IS NULL` — first
   upload wins, never rebound (DD-21). Both lines are non-activity lines for
   `artisyn-extractor.ts`.
3. **Extraction** (`okf/okf-access-extractor.ts` `extractOkfDetail` via
   `okf/okf-access-writer.ts`): every `claude` / `claude-subagent` body is turned into
   `session_okf_access`, `session_okf_event` and `session_okf_pointer` rows for its own tree node,
   delete-then-insert per node, and the node's extraction marker is set — rules in
   [algorithms/okf-access-extraction.md](algorithms/okf-access-extraction.md). Bash commands go
   through `analyzeBash` from `@loghub/bash-view` with the server's tree-sitter parser
   (`okf/server-bash-parser.ts`). The root's bound snapshot (`loadSnapshotFilesForNode`) gives
   the file sizes for the byte split and the article hashes of the pointer rows. No thresholds
   are applied here: the rows are stored raw.
4. **Read side** (`okf/okf-usage.service.ts`): loads the rows of the tree / the scoped trees and
   the snapshot bodies, applies the team filter, then the verdict
   ([algorithms/okf-verdict.md](algorithms/okf-verdict.md)), the value signals
   ([algorithms/okf-value-signals.md](algorithms/okf-value-signals.md)) and the tree
   (`okf/okf-usage-tree.ts`), all with the thresholds in force for the caller (see "Thresholds").

## Tables

| Table / column | Content |
|---|---|
| `okf_snapshots` | `(user_id, snapshot_id)` unique; `body jsonb` = the snapshot without its `type` (`okfSnapshotId`, `schemaVersion`, `bundles[]`); `created_at` = the repo route's `snapshot.takenAt`. |
| `sessions.okf_snapshot_id` | Bound snapshot of a **root** session (indexed, no FK — an orphan sweep may remove the row under it). Sub-agents resolve their root via `topAncestorIdsSql`. |
| `upload_queue.okf_snapshot_id` | Id of a queued full-body upload, so the known check sees snapshots still in flight. |
| `session_okf_access` | One row per tree node × `(path_key, op, after_own_edit)`: `bytes`, `calls`, `seq` (first-access rank in the node). `op` ∈ `read`, `grep`, `list`, `write`; a folder key ends in `/` (repo root `/`). Since 0091 also `ranged_calls` / `ranged_bytes` (section reads, included in `calls` / `bytes`) and `search_hits` (grep / list calls with a non-empty result). Cascades with its `sessions` row. |
| `session_okf_event` | 0091. One row per tree node × `(ord, op, path)`: the node's **code-side** accesses (`op` ∈ `read`, `search`, `write`; `path` repo-relative, folders end in `/`), `range_from` / `range_to`, `pattern` (≤ 200 characters). `.md` files of the snapshot are not events (they are access rows). At most 3000 per node. |
| `session_okf_pointer` | 0091. One row per tree node × `(read_ord, article_path, pointer)`: a back-ticked repo path in the result of a single-article KB read, with `article_hash` (from the bound snapshot), `is_new`, `followed`, `partial`. A partial read with no pointers stores one row with `pointer = ''`. At most 5000 per node. |
| `sessions.okf_extract_version`, `sessions.okf_events_truncated` | 0091. The **marker**: the writer sets `OKF_EXTRACT_VERSION` (2) on every node it rebuilds, even with zero rows, and `okf_events_truncated` when a cap was hit. `NULL` or `< 2` on a root = "no OKF analysis yet" (FR-11 banner). |

Migrations `server/drizzle/migrations/0075_okf_usage.sql` and `0091_okf_value_signals.sql`
(both additive, no backfill; `initializeDatabase()` re-queues nothing — old sessions get the new
rows only through `recompute-all-sessions`). The event / pointer `ord` is the node's call
ordinal, shared by both tables and the facts route's `accessSeq`. Details:
[db-tables.md](db-tables.md).

## Where the rows are written

`rebuildSessionOkfAccess` / `rebuildOkfAccessForNodes` (`okf/okf-access-writer.ts`) are the only
writers of all three tables and the marker (`writeSessionOkfAccess`, `writeSessionOkfEvents`,
`writeSessionOkfPointers`; per node `DELETE`, then insert with `ON CONFLICT … DO UPDATE` on the
unique key, because the heal and the backfill may race a concurrent writer). They are called
wherever the file stats are written, with the same repo roots:

- ingest — `logs.service.ts` `upsert()` Step 3b';
- import — `logs.service.ts` import path (same writer, roots of the archive);
- heal — `session-file-stats-writer.ts` `rewriteSessionTreeFileStats` (a log that brings the
  roots later rebuilds the tree's rows);
- recompute — `repositories.service.ts` `recomputeOkfAccess`, once per tree from
  `POST /api/v1/repositories/:repoId/recompute-all-sessions` (FR-5: the only way to fill rows for
  sessions ingested before this feature).

A tree node with no usable repo root gets no rows (FR-2).

## Routes

| Route | Auth / scope | Service |
|---|---|---|
| `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` (`teamId?`) | `SessionAuthGuard`; same scope and 403 rules as the change-surface session routes; a session not visible in the scope answers the empty response, not 404 | `OkfUsageService.getSessionOkfUsage` (`repositories.controller.ts`) |
| `GET /api/v1/repositories/:repoId/reports/okf-usage` (`startDate`, `endDate` required; `branches`, `users`, `teamId`, `attr`, `bundle?`) | `SessionAuthGuard`; scope via `resolveUsageScope` (same as `harness-usage`); unknown `bundle` = all | `OkfUsageService.getRepoOkfUsage` (`reports/reports.controller.ts`) |
| `GET /api/v1/repositories/:repoId/reports/okf-usage/article?path=` (same `teamId`, `startDate`, `endDate`, `branches`, `users`, `attr`) | `SessionAuthGuard`; same scope, 403 and team filter as `okf-usage` (`resolveUsageScope`); missing / empty `path` → 400; a `path` that is not a stored KB article in scope → 200 with `found: false` | `OkfUsageService.getRepoOkfArticle` (`reports/reports.controller.ts`) |
| `GET /api/v2/okf-usage/facts?sessionId=` | API key; 400 without `sessionId`; 404 for a missing session and for one whose logs the key's user does not own (DD-33) | `OkfFactsService.getFacts` (`okf/okf-facts.controller.ts`) |
| `POST /api/v2/logs` + `okfSnapshotId?`, `okfSnapshotFull?=1` → `unknownOkfSnapshotId?` | existing upload | `logs-v2.controller.ts` |

Response types: `server/src/logs/okf/okf-usage.types.ts`, mirrored in
`client/src/models/repositories.ts`.

- An invalid `okfSnapshotId` (not `^[0-9a-f]{64}$`) is ignored silently, never a 400; an
  over-cap body (`OKF_SNAPSHOT_MAX_BYTES` = 10 MB) is ignored and the id stays unknown.
- `unknownOkfSnapshotId` comes back on a ref-only upload whose id is neither stored for the user
  nor in a pending / processing / partially uploaded queue row (`isOkfSnapshotKnown`); the hook
  then forgets the id and resends the full body next time.
- The facts route reparses the stored transcripts (never `session_okf_access`): `prompts` (main
  agent, `filterUserPrompts`, each cut to 4000 characters), per agent `kbReads`, `kbSeq`,
  `otherReadsTop` (top 20 non-KB reads), `changes`; and tree-wide `changes`, `reads`, `runs`. No
  tool result text. Prompt filter: [algorithms/okf-task-context.md](algorithms/okf-task-context.md).
  Since the value view each agent also carries `accessSeq` — the ordered accesses
  (`kb_read` / `kb_search` / `kb_write` / `read` / `search` / `write`, with range, pattern and the
  new pointers of a KB read), built on demand from `extractOkfDetail(...).seq`; the client does
  not mirror it.
- Every new response field of the session and repo routes is optional (`thresholds`, `upkeep`,
  `signals`, `eventsTruncated`, tile and tree-node additions, `canRecompute`), so older clients
  and skills ignore them. `canRecompute` uses the authority of `recompute-all-sessions`
  (`RepositoriesService.okfCanRecompute`: team owner in the team view, repo owner in the personal
  view).
- **Article drill-down** (`RepoOkfArticleResponse`): header (`size`, `oldSize`, `hashStatus` =
  `current` / `stale` / `removed` / `unknown`, `areaFromOlderVersion`), `reads` (`whole`,
  `section`, `upkeep`, `partial`), `yield`, `pointers` (dead first), `area`, `catalog`,
  `routingMiss` (with `missing[]` agents and masked `taskHead`), `searchedAfter`, `findings` and
  `sameFindingElsewhere` (top 5). Patterns are never masked; task heads follow the
  `team-no-prompts` masking of `okf-usage`.

## Session OKF tab

`client/src/viewer/pages/repository/session-log/okf/` — `SessionOkfTab.tsx` (tab id `okf`,
between "Harness usage" and "Raw Logs"):

- a one-line "Deeper analysis" hint under the toggle bar (`data-testid="okf-deeper-analysis"`)
  naming the local on-demand command `/log-hub-hooks:kb-analysis <sessionId>` (constant
  `KB_ANALYSIS_COMMAND`; the skill itself is the not-yet-shipped task `2026-10-27-kb-completeness-deep`);
- verdict card (`OkfVerdictCard.tsx`, width-capped at `max-w-4xl`): badge, "partial data" chip,
  clickable Why lines that scroll the tree to the node, Read top 5 with the own-edit icon (a
  tooltip, `data-testid="okf-own-edit-icon"`, explains "read after the agent edited this file
  itself"), "How agents reached the KB" chips (`✓ index` / `grep` / `given`);
- bundle cards (`OkfBundleCards.tsx`): tracked / gitignored, "started from index.md", FILES READ,
  BYTES INTO CONTEXT;
- tree (`OkfTree.tsx`, `okf-tree.ts`, `okf-tree-rows.tsx`): bundle → folder → file, READ heat
  (Bytes / Calls toggle), WRITE bar, markers `folder_scan`, `entry_point`, `own_edit`. A folder or
  bundle node's numbers are its own folder rows plus its children's, so its READ can exceed the
  sum of the visible children; the `folder_scan` text («grep / ls over folder ×N») counts only the
  folder's own rows (`folderScanCounts` in `okf-tree.ts`: node minus children, taken before the
  agent filter drops children). Files not
  read are grey ("not read") and sorted last; accessed files absent from the snapshot carry the
  "not in KB at start" chip, paths outside every bundle form a "Not in the KB snapshot" group;
- Agents panel (`OkfAgentsPanel.tsx`): one row per tree node with its task head (200 characters),
  entry and KB reads; clicking narrows the tree to that agent.
- value view: the verdict subtitle says "upkeep excluded"; Read top 5 carries `§ section ×N`
  chips and a muted "Upkeep" line (articles the agent read because it edited them); a whole-tree
  value-signals tile (`OkfValueSignalsTile.tsx`); the tree gains POINTERS USED "k / n" and EXPL.
  AFTER columns, an expandable per-agent pointer sub-row (✓ followed, "N paths already named in
  its prompt") and "routing miss · N searches" rows for unread articles; the Agents panel gains
  yield, routing misses, upkeep and searches; an "events truncated" note when
  `eventsTruncated`. Finding lines carry a second "→ action" line (`okf-action-text.ts`).
- No snapshot (old hook): amber banner "No KB snapshot for this session …" with a "How to update"
  link to the API-keys page (Install tab); the tree then holds only the accessed `.md` paths, in
  one `bundle: null` group "Accessed KB paths (no snapshot)", and no not-read list.

Verdict strings: `client/src/viewer/lib/okf/okf-verdict-text.ts` (rule id + params → text; an
unknown rule id renders as the id plus raw params).

## Repository OKF tab

`client/src/viewer/pages/repository/okf/` — `RepoOkfTab.tsx` (main tab `okf`, between Reports and
Settings, shown where `canSeeTeamWideTabs` allows):

- filter strip (`OkfFilterStrip.tsx`): dates, branches, users, attributes, bundle, Bytes / Calls;
  applied at once, mirrored to the `okf*` URL params (`okf-url-state.ts`; `setMainTab` drops them
  when leaving the tab);
- verdict card with the anomaly lines, five KPI tiles (`OkfKpiTiles.tsx`), share histogram
  (`OkfShareHistogram.tsx`, four CSS bars), hot files top 10 (`OkfHotFiles.tsx`), not-read list
  (`OkfNotReadList.tsx`, neutral, inline "Show all"), and the tree with markers `hot` / `coarse`
  and the "No longer in KB" group (paths absent from the latest snapshot).
- A bundle's `index.md` is never analysed as an article: it is no hot file, and every share
  (histogram, bundle cards, verdict rules) counts articles only — see "Articles" in
  [algorithms/okf-verdict.md](algorithms/okf-verdict.md).
- The latest snapshot = the bound snapshot of the newest root session in the filtered set
  (DD-29); its bundles define the tree, the KB files and the not-read list.
- value view: the verdict card says what it measures ("access, layout and value proxies"), shows
  a "custom thresholds" / "default thresholds ⚙" chip (`OkfThresholdsChip.tsx`, links to
  Settings via `mtab=settings&stab=analysis&sfocus=okf-thresholds`) and an "→ action" line per
  finding; `info` findings are grey. Tiles add pointer yield, articles with routing misses and the
  upkeep-only count; the tree adds YIELD, EXPL. AFTER and ROUTE MISS columns and the markers
  `routing miss`, `§ section reads`, `catalog`, `N dead`, `upkeep`, `stale`, `not read`; the
  histogram is captioned "bundles of ≥ N files"; hot files get a Yield column; an Upkeep panel
  (`OkfUpkeepPanel.tsx`) lists articles read only to edit them. An info banner
  (`OkfAnalysisCoverageBanner.tsx`) shows when `tiles.sessionsWithoutAnalysis > 0`, with a
  "Recompute all sessions" link only when `canRecompute`.
- **Article drill-down** (`okf/article/`, URL param `okfArticle`): a tree row's file name opens
  it; header, value-signals strip, pointer table (17 rows, then "Show all"; dead first with
  "path not found in any session"), routing-miss / searched-after / catalog blocks with their
  action lines, and "same finding on other articles".

Personal vs team view follows the route (`/repos/:id` vs `/teams/:t/repos/:id` → `teamId`), not a
toggle (DD-32).

## Team filter (fail closed)

With `teamId` both routes run `applyOkfTeamFilter` (`okf/okf-usage-tree.ts`) **before** the
verdict and the tree (DD-30, FR-17): a row survives only when the accessing tree's own snapshot
lists the path `ignored: false` and no contributing snapshot lists it ignored; a folder row only
when a visible file lies under it; snapshot-less trees contribute nothing; bundles whose
`index.md` is ignored are dropped and ignored files leave the file lists. Ignored flags come from
`git check-ignore` on the author's machine, and a failed check marks everything ignored, so a
private KB (`docs/kb-local/`, a gitignored article) never shows in a team view. In the team
session route another member's task heads are also masked for a `team-no-prompts` caller.

The new rows follow the same fail-closed rule (value-view DD-24): a snapshot-less tree keeps no
pointer and no event row; a pointer row stays only when its article is a visible file of the
tree's own snapshot (an ignored article's pointers go); event rows are code paths and are not
filtered by `ignored`. The article route applies the same filter, so an ignored article answers
`found: false` in a team view.

## Thresholds (settings)

The verdict and value-signal thresholds are per-repo settings in `RepoConfigJson.okf`
(`OkfThresholds`, every field optional; defaults and validation in `okf/okf-thresholds.ts`, table
in [algorithms/okf-verdict.md](algorithms/okf-verdict.md)). They are applied at read time only.

- **Resolution per section** (value-view DD-20, `RepositoriesService.resolveOkfThresholds`):
  team view → the team row's `okf` → defaults; personal view → the personal row's `okf` if
  present → the `okf` of the lowest-id team linking the URL → defaults. The chosen section is
  merged field by field; an invalid stored field falls back to its default. Every other config
  field keeps the whole-object `resolveEffectiveConfig()`. Responses carry `thresholds.custom` =
  the fields that differ from the defaults.
- **Save:** the settings PUTs validate `okf` (`validateOkfThresholds`, 400 `okf.<field> …`). A
  save whose stored and new rows are deep-equal except for `okf` skips the derived-stats
  recompute (DD-21). All settings responses carry `okfDefaults` and `okfFixedLimits`, so the
  client keeps no twin of the defaults.
- **Client:** Settings → Analysis → **OKF thresholds** (`OkfThresholdsSection.tsx`) saves only the
  fields that differ from `okfDefaults` (none → the section is dropped), with "Reset to defaults"
  and, in the personal view, "Copy from team settings"; read-only for a non-owner in the team
  view.

## Lifecycle

- **Delete** (`sessions.service.ts` `purgeSessionChildData`): step c2 deletes
  `session_okf_access`, `session_okf_event` and `session_okf_pointer` (a soft delete keeps the
  `sessions` row, so the cascade does not run); step g clears `okf_snapshot_id` with
  `harness_snapshot_id` and resets `okf_extract_version` to `NULL` and `okf_events_truncated` to
  `false`; step h sweeps orphan
  `okf_snapshots` (`deleteOrphanOkfSnapshots`). The team-repo removal (`teams.service.ts`) runs
  the same sweep. See [data-retention.md](data-retention.md).
- **Export / import**: the export zip's session shape carries `okfSnapshotId`; the root's
  `artisyn.jsonl` gets the full `okf-snapshot` line plus a ref line; import stores and rebinds
  like ingest. Older zips (no field, no lines) import with no snapshot (DD-42). See
  [session-export-import.md](session-export-import.md).
- **Recompute**: `recompute-all-sessions` rebuilds all three tables and the marker for every
  node. It is the only way to give sessions ingested before 0091 their events, pointers and
  ranged / search-hit counters; until then the repo tab shows the FR-11 banner. Import rebuilds
  them like ingest.

## Backward compatibility

| Combination | Behaviour |
|---|---|
| Old hook → new server | No OKF params / lines: `okf_snapshot_id` stays null; extraction still fills `session_okf_access` from transcripts; the session tab shows the update-hook banner and the verdict carries `partial_data`. |
| New hook → old server | Unknown query params and NDJSON line types are ignored; the upload succeeds. |
| Old zip → new server | Imports with no snapshot. |
| New zip → old server | `okfSnapshotId` and OKF lines are ignored. |
| Sessions ingested before 0091 → new server | No events / pointers, zero ranged / search-hit counters, marker `NULL`: value signals show "—", `agentEntry` keeps the older search rule (rows without `searchHits`), the even byte split stays, and the repo tab shows the FR-11 banner until `recompute-all-sessions`. Nothing is re-queued at startup. |
| Old client → new server | Every new response field is optional; unknown rule ids (`routing_miss`, `searched_after`, `dead_pointers`, `catalog`) and the `info` severity render raw; the article route is simply not called. |
| New client → old server | The new fields are absent, so the value-signal columns and tiles show no data ("—"); the article route does not exist (404) and the drill-down shows its error state. |
| Old settings rows / older clients saving settings | A row without `okf` resolves to the defaults; a client that does not know `okf` keeps it through the read-modify-write save; an invalid stored field falls back to its default on read. |
| Hook | No change: the value signals come from the transcripts and the existing snapshot. |

Hook side: [hook-api-versioning.md](hook-api-versioning.md) (2.26.0) and the `okf` config key in
[hook-installation.md](hook-installation.md).
