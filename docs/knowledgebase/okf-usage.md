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
generated: { by: "human:denistsyplakov", at: "2026-11-20T22:15:00+04:00" }
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
   ignored flags: [algorithms/okf-snapshot.md](algorithms/okf-snapshot.md). Hook `3.1.0`+ also
   sends the OKF v0.3 front-matter metadata (bundle `okfVersion` / `title` / `description`, file
   `meta`) — see "OKF v0.3 metadata and article rules" below.
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
   (`okf/server-bash-parser.ts`). The root's bound snapshot (`loadSnapshotForNode`: its files and
   its bundle roots) gives the file sizes for the byte split, the article hashes of the pointer
   rows and the bundle roots that OKF v0.3 pointer resolution needs (`./x` / `../x` against the
   article's folder, `/x` against the bundle root, a bare path article-relative first — rules 14
   and 15 of the extraction doc). No thresholds are applied here: the rows are stored raw.
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
| `sessions.okf_extract_version`, `sessions.okf_events_truncated` | 0091. The **marker**: the writer sets `OKF_EXTRACT_VERSION` (4) on every node it rebuilds, even with zero rows, and `okf_events_truncated` when a cap was hit. `NULL` or `< 4` on a root = "no OKF analysis yet" (FR-11 banner; after a version bump every older-version root counts there until recompute). Version 2 nodes keep their rows and `search_hits` (read while `okf_extract_version >= OKF_SEARCH_HITS_MIN_VERSION`, 2); 3 only tightened the pointer rule (no identifiers / versions / `(`, see okf-access-extraction rule 14); 4 resolves pointers per OKF v0.3 §6 (`./`, `../`, bundle-rooted `/x`, bare paths article-relative first, the candidate chosen in a final pass). Rows of version 2 / 3 stay valid, but their stored pointers may hold spans the newer rule drops or resolves to another path until `recompute-all-sessions`. The session trail re-extracts per request and always uses the current rule. |

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
| `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage/trail?agent=` (`teamId?`) | `SessionAuthGuard`; same scope, 403 and team rules as the session route; missing / empty `agent` → 400; a session with no visible row in the scope, or an `agent` that is not a node of its tree → 404 | `OkfUsageService.getSessionOkfTrail` (`repositories.controller.ts`) |
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
  (`kb_read` / `kb_search` / `kb_write` / `read` / `search` / `write`, with range, pattern, the
  new pointers of a KB read and, since package 3, `hit` on search items), built on demand from
  `extractOkfDetail(...).seq`; the client does not mirror it.
- **Agent trail** (package 3, `SessionOkfTrailResponse`): `agent` `{id, label}` (label masked
  like `agents[].label`), `truncated`, `items[]` = one node's `seq` rebuilt from its transcript
  per request (transcript loader `loadOkfNodeTranscripts` shared with the facts route, the
  writer's `loadSnapshotForNode` for the snapshot files and bundle roots), capped at `OKF_TRAIL_MAX_ITEMS`
  (2000). Each item may carry `hit` (search found something — the extraction's DD-6 test of the
  call's result, read per request, never stored), `inArea` (articles read earlier whose DD-12
  area the code read / search falls in) and `followedAt` (a KB read's new pointer → first later
  call touching it) — [algorithms/okf-value-signals.md](algorithms/okf-value-signals.md) rule 11.
  The areas come from the same all-time scope as the session route (`loadAllTimeSignalRows`
  without its touched-paths query). Team view: a snapshot-less tree shows nothing, KB items only
  for visible files. Patterns are never masked; no task text. No DB or migration change.
- Every new response field of the session and repo routes is optional (`thresholds`, `upkeep`,
  `signals`, `eventsTruncated`, tile and tree-node additions, `canRecompute`), so older clients
  and skills ignore them. `canRecompute` uses the authority of `recompute-all-sessions`
  (`RepositoriesService.okfCanRecompute`: team owner in the team view, repo owner in the personal
  view).
- **Article drill-down** (`RepoOkfArticleResponse`): header (`size`, `oldSize`, `hashStatus` =
  `current` / `stale` / `removed` / `unknown`, `areaFromOlderVersion`), `reads` (`whole`,
  `section`, `upkeep`, `partial`), `yield`, `pointers` (dead first), `area`, `catalog`,
  `routingMiss` (with `missing[]` agents and masked `taskHead`), `searchedAfter` (since package 3
  with optional `pairs[]` `{sessionId, agentId, label, searches}` — the root session, the agent and
  its masked description), `findings` and `sameFindingElsewhere` (top 5). Patterns are never masked; task heads follow the
  `team-no-prompts` masking of `okf-usage`. It carries none of the OKF v0.3 metadata fields (the
  chips live on the tree rows).

## OKF v0.3 metadata and article rules

Task `2026-11-19-okf-v03-support`. Algorithm doc of the derivation:
[algorithms/okf-metadata.md](algorithms/okf-metadata.md) (`okf/okf-metadata.ts`, pure, no DB).

**Snapshot fields (hook `3.1.0`+, additive, `schemaVersion` stays 1).** The hook reads the first
8192 bytes of every bundle file (was 512 for detection only) and parses its front matter:

- per bundle, from the bundle-root `index.md`: `okfVersion`, `title`, `description` — each only
  when the value is present (quotes stripped, inline `#` comments cut, `''` / `null` / `~` / block
  scalars absent, capped at 200 characters);
- per file (`index.md` included): `meta` = `{frontMatter, hasGenerated, hasTimestamp}` always, plus
  `type`, `status`, `superseded_by`, `stale_after` when present.

The body is stored verbatim; `normaliseSnapshot` (`okf/okf-snapshot.ts`) copies the strings
(truncated to 200), maps `superseded_by` / `stale_after` to `supersededBy` / `staleAfter`, ignores
wrong types and never drops a bundle or file for bad metadata (FR-4). Hook side (snapshot id,
cache entry, size guard): [hook-api-versioning.md](hook-api-versioning.md) "OKF snapshot metadata".

**Derived API fields** (all optional; absent for a bundle without hook metadata —
`hasHookMeta(bundle)` = some file has `meta` — so old-hook data renders exactly as before, FR-9):

| Field | Where | Rule |
|---|---|---|
| `title`, `description`, `okfVersion` | `OkfBundleSummary` (session and repo routes) | copied from the bundle |
| `newerFormatHint` | `OkfBundleSummary` | `okfVersionHint`: absent / not `major.minor[.patch]` / below `0.3` → `true` (`0.3`, `0.3.1`, `0.10`, `1.0` → `false`) |
| `articlesWithHints`, `hintReasons` | `OkfBundleSummary` | articles (`bundleArticles`) with ≥ 1 format hint, and the distinct hints in the order `no_front_matter`, `no_type`, `v01_timestamp` |
| `deprecated`, `supersededBy` | file `OkfTreeNode`, `kb_read` `OkfTrailItem` | `status` is `deprecated` (any case); `superseded_by` resolved repo-relative (`/x` → bundle root, else the article's folder; `..` collapsed; escaping the repo → raw value), only for a deprecated article |
| `pastStaleAfter` | file `OkfTreeNode` | `stale_after` before the reference time, or unparseable (`YYYY-MM-DD` = 00:00 UTC; date-time needs `Z` or an offset). Reference time: the root session's start on the session route and the trail, now on the repo route. Distinct from the value-signals `stale` marker |
| `formatHints` | file `OkfTreeNode` | `no_front_matter`, `no_type` (front matter without `type`), `v01_timestamp` (`timestamp` without `generated`) — advice only, never a finding |

Each tree-node / trail key is set only when true / non-empty. Team view (DD-S8): everything is
derived after `applyOkfTeamFilter`, and a `supersededBy` whose target is not a visible article
becomes `null`, so a hidden path never leaks. The verdict, checks and value signals do not use
the metadata.

**Article rules (FR-2, every hook version).** `bundleArticles` (`okf/okf-verdict.ts`) excludes the
bundle's own `index.md`, **any** `index.md` / `log.md` at any depth (`isReservedOkfName`) and
dot-paths. Reserved files still count as KB access (an `index.md` / `log.md` read is a KB read;
`agentEntry` = `index` only for the bundle's own `index.md`), but they are never hot files,
not-read entries or part of a share. A file whose path below its bundle root has a segment
starting with `.` (e.g. `kb/.drafts/a.md`) is dropped by `normaliseSnapshot` and `bundleOfPath`
returns `null` for it: it is not KB at all (no verdict, entry point, tree row or bytes) and the
extractor treats it as code. **Effect:** for every bundle with nested `index.md` / `log.md` or
dot-path files the article counts ("N of M articles read", KB files tile), shares, the histogram,
hot files and the per-file verdict rules change on the next view — computed on read, no recompute
needed.

## Session OKF tab

`client/src/viewer/pages/repository/session-log/okf/` — `SessionOkfTab.tsx` (tab id `okf`,
between "Harness usage" and "Raw Logs"):

- agent names: one helper, `client/src/viewer/lib/okf/okf-agent-label.ts` — `main` for the root,
  `1.N · <text>` for the N-th sub-agent of `agents[]` (server order), text = `agents[].label`
  (optional, `sessions.agent_description`, masked like the prompt in a team-no-prompts view), else
  the task head, else 8 characters of the id after `agent-`; finding text resolves `agentId` through
  the same map (`formatOkfFinding(f, agentName)`), the repo drill-down falls back to the short id;
- a one-line "Deeper analysis" hint at the bottom of the tab (`data-testid="okf-deeper-analysis"`)
  naming the local on-demand command `/log-hub-hooks:kb-analysis <sessionId>` (constant
  `KB_ANALYSIS_COMMAND`; the skill itself is the not-yet-shipped task `2026-10-27-kb-completeness-deep`);
- **A/B split** (2026-11-05, `OkfSection.tsx`, shared with the repo tab): section
  `okf-section-a` "A · How the KB was navigated (verified)" holds the verdict card and the KB
  folder cards; section `okf-section-b` "B · Did the articles help? (heuristic — check by hand)"
  holds the value-signals tile and legend, with an intro line and a count "N signals to check"
  (`searchedAfterPairs + routingMissArticles + deadPointers`) or "nothing to check" (no count on
  an older server without `signals`). The tree and the Agents panel stay below both sections.
- **Agent trail** (package 3, `OkfAgentTrail.tsx`, `OkfTrailRow.tsx`, grouping in `okf-trail.ts`):
  section B shows the selected agent's trail — `okfAgent=<agent id>` in the URL (hook
  `useOkfAgentParam`, helpers in `okf-url-state.ts`), set by an Agents panel click (which also
  narrows the tree, as before) or by the "Check by hand: show an agent's trail" link under the
  tile's "searched without / after reading" cells (first agent with `routingMisses` /
  `searchedAfter`; `agents[].searchedAfter` is a package-3 optional field). Episodes start at a
  KB article read; a read lists its new code paths with "opened / searched at #N" or "never
  opened", an "── after reading: N searches in its area, M files opened ──" line follows, rows in
  the area of an article read earlier are highlighted ("in area of …"), searches show the full
  pattern and `found` / `nothing found`; loading / error / empty / truncated states and a "Judge:
  …" hint. `okfAgent` is dropped by `setSessionTab` (another tab), `switchLens` (a lens without
  the OKF tab), `handleSessionSelect` (another session), `setMainTab` and `okfRepoTabParams`.
- **Checks block** (`OkfChecksBlock.tsx`, inside the verdict card under the badge, both
  variants): one line per `verdict.checks` entry — ✓ / ! / – by `status`, a short name, the
  counted value with its threshold and, for a finding, a "→ action" line; texts in
  `client/src/viewer/lib/okf/okf-check-text.ts` (unknown rule → raw params). Hidden when the
  server sends no `checks`. The session variant ends with a line pointing to the repository
  OKF tab (link via `okfRepoTabParams` in `okf-url-state.ts`, the same params as
  `setMainTab('okf')`; shown only when `canSeeTeamWideTabs`).
- verdict card (`OkfVerdictCard.tsx`, width-capped at `max-w-4xl`): badge, "partial data" chip,
  clickable Why lines that scroll the tree to the node, Read top 5 with the own-edit icon (a
  tooltip, `data-testid="okf-own-edit-icon"`, explains "read after the agent edited this file
  itself"), "How agents reached the KB" chips (`via index.md` / `via search` / `path given in its task`);
- KB folder cards (`OkfBundleCards.tsx`, session only): one card per bundle with a file read —
  tracked / gitignored, "started from index.md", "N of M articles read", BYTES INTO CONTEXT; the
  untouched bundles are one line "N other KB folders not opened: …" (`okf-bundle-idle`). With
  hook metadata the heading is the bundle `title` (root as a muted mono sub-line), the
  `description` is clamped to two lines, an "OKF x.y" chip follows the tracked chip, and sky
  advice lines say "N articles can be improved" (+ the hint reasons) and "ⓘ Newer format available
  (0.3)";
- tree (`OkfTree.tsx`, `okf-tree.ts`, `okf-tree-rows.tsx`, `okf-tree-columns.tsx`): header
  "KB folder → file", READ heat (Bytes / Calls toggle), WRITE bar on the repo variant only, a
  flexible markers cell (shrinks and truncates first; the name keeps `min-w-32`), a column legend
  under both variants. Session variant: a folder's "not read" children fold into one
  "N articles not read in this session · show" row (`okf-tree-unread-group`, local state;
  `scrollToNode` opens the group on the path) and are hidden while the agent filter is on. The
  Agents panel sits beside the tree from a 56rem tab width (container query `@4xl/okf`), below
  it otherwise; markers `folder_scan`, `entry_point`, `own_edit`. A folder or
  bundle node's numbers are its own folder rows plus its children's, so its READ can exceed the
  sum of the visible children; the `folder_scan` text («grep / ls over folder ×N») counts only the
  folder's own rows (`folderScanCounts` in `okf-tree.ts`: node minus children, taken before the
  agent filter drops children). Files not
  read are grey ("not read") and sorted last (repo variant; folded on the session variant); accessed files absent from the snapshot carry the
  "not in KB at start" chip, paths outside every bundle form a "Not in the KB snapshot" group. OKF v0.3 chips
  (`okf-tree-meta-chips.tsx`, both variants; `OkfTree` gets `bundleInfo` from `data.bundles`): the
  bundle row shows the `title` and sky "ⓘ newer format (0.3)" / "ⓘ N can improve"; a file row shows
  amber "deprecated" with "→ <replacement>" (a button when the replacement is a file of the tree),
  amber "past stale_after" and sky "ⓘ can improve" (reasons in its tooltip). The trail
  (`OkfTrailRow.tsx`) shows the amber "deprecated" chip on a `kb_read` of a deprecated article;
- Agents panel (`OkfAgentsPanel.tsx`, header "Agents · N"): one row per tree node with its label,
  entry, task head (200 characters; not repeated when it is the label) and KB reads; clicking
  narrows the tree to that agent and opens its trail (`okfAgent`).
- value view: the verdict subtitle says "upkeep excluded"; Read top 5 carries "1 partial read
  (line range)" / "N partial reads" chips and a muted "Upkeep" line (articles the agent read
  because it edited them); a whole-tree "Value signals (heuristic)" tile
  (`OkfValueSignalsTile.tsx`, each cell with a visible caption); the tree gains CODE PATHS
  FOLLOWED "k / n" and SEARCHED AFTER READING columns, an expandable per-agent sub-row behind
  "code paths shown · N agents" (✓ followed, "N paths already named in its prompt") and
  "searched without reading · N searches" rows for unread articles; the Agents panel gains
  paths followed, searched w/o reading, edited KB and code searches; an "events truncated" note when
  `eventsTruncated`. Finding lines carry a second "→ action" line (`okf-action-text.ts`).
- No snapshot (old hook): amber banner "No KB snapshot for this session …" with a "How to update"
  link to the API-keys page (Install tab); the tree then holds only the accessed `.md` paths, in
  one `bundle: null` group "Accessed KB paths (no snapshot)", and no not-read list.

Verdict strings: `client/src/viewer/lib/okf/okf-verdict-text.ts` (rule id + params → text; an
unknown rule id renders as the id plus raw params). Check strings: `okf-check-text.ts`.

**`verdict.checks`** (2026-11-05, optional on both routes): one `{rule, status: 'ok' | 'finding'
| 'na', params}` per structure rule of the level, always present when the verdict is — session
`kb_used`, `entry`, `session_share`, `upkeep`; repo `kb_sessions`, `kb_flood`, `always_read`,
`coarse_article` — with the nearest actual value and its threshold. Computed in `okf-verdict.ts`
in the same pass as the rules; definitions in [algorithms/okf-verdict.md](algorithms/okf-verdict.md)
rules 13–14. They cover structure (group A) only: the repo route's merged value-signal findings
never change a check.

## Repository OKF tab

`client/src/viewer/pages/repository/okf/` — `RepoOkfTab.tsx` (main tab `okf`, between Reports and
Settings, shown where `canSeeTeamWideTabs` allows):

- filter strip (`OkfFilterStrip.tsx`): dates, branches, users, attributes, KB folder (bundle), Bytes / Calls;
  applied at once, mirrored to the `okf*` URL params (`okf-url-state.ts`; `setMainTab` drops them
  when leaving the tab);
- section A: verdict card with the Checks block and the structure findings only (`isStructureFinding`:
  `session_share`, `always_read`, `kb_flood`, `coarse_article`), five KPI tiles
  (`OkfKpiTiles.tsx`); section B: the value-signal tiles (`OkfSignalTiles`) and the value-signal
  findings (`OkfSignalFindings.tsx`), count = number of value-signal findings. The server still
  merges those findings into one level (`mergeSignalFindings`); the card's subtitle says how many
  non-info value-signal findings count for it. Below: share histogram
  (`OkfShareHistogram.tsx`, four CSS bars), hot files top 10 (`OkfHotFiles.tsx`), not-read list
  (`OkfNotReadList.tsx`, neutral, inline "Show all"), and the tree with markers `hot` / `coarse`
  and the "No longer in KB" group (paths absent from the latest snapshot).
- A bundle's `index.md` — and since OKF v0.3 support any nested `index.md` / `log.md` and every
  dot-path file — is never analysed as an article: it is no hot file and not in the not-read
  list, and every share (histogram, bundle cards, verdict rules) counts articles only — see
  "OKF v0.3 metadata and article rules" above and "Articles" in
  [algorithms/okf-verdict.md](algorithms/okf-verdict.md).
- The latest snapshot = the bound snapshot of the newest root session in the filtered set
  (DD-29); its bundles define the tree, the KB files and the not-read list.
- value view: the verdict card says what it measures ("access, layout and value proxies"), shows
  a "custom thresholds" / "default thresholds ⚙" chip (`OkfThresholdsChip.tsx`, links to
  Settings via `mtab=settings&stab=analysis&sfocus=okf-thresholds`) and an "→ action" line per
  finding; `info` findings are grey. Tiles add pointer yield, articles with routing misses and the
  upkeep-only count; the tree adds PATHS FOLLOWED, SEARCHED AFTER READING and SEARCHED WITHOUT
  READING columns and the markers `routing miss`, "N partial reads", `catalog`, `N dead`,
  `upkeep`, `stale`, `not read`; the histogram is captioned "KB folders of ≥ N files"; hot
  files get a Yield column; the side column sits beside the tree from a 72rem tab width
  (container query `@6xl/okfrepo`; the tree keeps `TREE_MIN_WIDTH` 720 px when dragged); an Upkeep panel
  (`OkfUpkeepPanel.tsx`) lists articles read only to edit them. An info banner
  (`OkfAnalysisCoverageBanner.tsx`) shows when `tiles.sessionsWithoutAnalysis > 0`, with a
  "Recompute all sessions" link only when `canRecompute`.
- **Article drill-down** (`okf/article/`, URL param `okfArticle`): a tree row's file name opens
  it; header, value-signals strip, pointer table (17 rows, then "Show all"; dead first with
  "path not found in any session"), routing-miss / searched-after / catalog blocks with their
  action lines, and "same finding on other articles". Package 3: every routing-miss "missing agent"
  row and every searched-after agent (`searchedAfter.pairs`, `OkfArticleAgentLinks.tsx`) links to
  the session OKF tab with that agent's trail (`okfSessionTrailParams`: `session`, `tab=okf`,
  `okfAgent`).

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
| Sessions extracted at version 2 → server with version 3 | Rows stay valid and are still read (incl. `search_hits`); only their stored pointers may include non-path spans (`Logger.error`, `2.31.0`) the stricter rule drops, which can inflate the yield denominator / dead pointers until rebuilt. The repo tab counts them in the FR-11 banner; `recompute-all-sessions` rewrites them. No migration. |
| Old client → new server | Every new response field is optional (incl. package 3's `hit`, `agents[].searchedAfter`, `searchedAfter.pairs`; the trail route is simply not called); unknown rule ids (`routing_miss`, `searched_after`, `dead_pointers`, `catalog`) and the `info` severity render raw; the article route is simply not called. |
| New client → old server | The new fields are absent, so the value-signal columns and tiles show no data ("—"), the Checks block is hidden and section B shows no count; the article route does not exist (404) and the drill-down shows its error state; the trail route answers 404 → the trail shows its error line, the drill-down shows no searched-after agents. |
| Old settings rows / older clients saving settings | A row without `okf` resolves to the defaults; a client that does not know `okf` keeps it through the read-modify-write save; an invalid stored field falls back to its default on read. |
| Sessions extracted at version 3 → server with version 4 (OKF v0.3) | Rows stay valid and are read; only their stored pointers keep the old resolution (`./x`, `../x` and article-relative bare paths unresolved or resolved repo-relative), so yield / dead pointers may differ until `recompute-all-sessions`; they count in the FR-11 banner meanwhile. No migration. |
| Server v4 (OKF v0.3) + old hook (< 3.1.0) | No bundle `okfVersion` / `title` / `description` and no file `meta`: `hasHookMeta` is false, so no title, version chip, hints or deprecated / stale_after chips — the tab looks as before. The FR-2 article rules and v0.3 pointer resolution apply anyway (they need no hook change): article counts / shares change for bundles with nested `index.md` / `log.md` or dot-path files. Bundles whose `okf_version:` sits past byte 512 of `index.md` stay undetected until the hook is updated. |
| Hook 3.1.0 + old server | The extra snapshot fields are unknown to it and stored verbatim in `okf_snapshots.body` (its `normaliseSnapshot` ignores them); nothing is shown until the server is upgraded, then the stored metadata appears on the next view (no re-upload). The snapshot id changes once per repo (new fields in the id), costing one full resend. |
| Hook | Value signals: no change — they come from the transcripts and the existing snapshot. OKF v0.3 metadata needs hook `3.1.0`+ (see above). |

Hook side: [hook-api-versioning.md](hook-api-versioning.md) (2.26.0, 3.1.0) and the `okf` config key in
[hook-installation.md](hook-installation.md).
