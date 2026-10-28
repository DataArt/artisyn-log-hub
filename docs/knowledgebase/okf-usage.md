---
type: "Architecture Guide"
title: "OKF Usage (knowledge-base use tabs)"
description: "How Log Hub measures agents' use of a repository's OKF knowledge bases: the hook's okf-snapshot, the session_okf_access and okf_snapshots tables, the extraction and verdict, the session and repo OKF tabs, the API-key facts route, the team fail-closed filter, lifecycle (recompute, delete, export) and backward compatibility."
tags:
  - okf
  - knowledge-base
  - session-view
  - reports
  - hook
timestamp: "2026-10-28T00:00:00+04:00"
---

# OKF Usage

An **OKF bundle** is a folder whose `index.md` front matter carries `okf_version:` (this repo's
`docs/knowledgebase/` is one). The OKF feature answers: which KB articles did the agents of a
session tree read, searched or listed, how many bytes went into their context, did they start
from the index, and is the KB laid out well for them (verdict). It has two sides — per session
(Session pane → **OKF** tab) and per repository over a period (Repository → **OKF** main tab) — plus
an API-key route that hands the plain facts of one session to a local analysis skill. There is no
LLM anywhere in it (FR-19).

Task of origin: `docs/tasks/todo/2026-10-27-okf-usage-tab/` (requirements, impl-plan with the
DD-n design decisions quoted below).

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
3. **Extraction** (`okf/okf-access-extractor.ts` via `okf/okf-access-writer.ts`): every
   `claude` / `claude-subagent` body is turned into `session_okf_access` rows for its own tree
   node, delete-then-insert per node — rules in
   [algorithms/okf-access-extraction.md](algorithms/okf-access-extraction.md). Bash commands go
   through `analyzeBash` from `@loghub/bash-view` with the server's tree-sitter parser
   (`okf/server-bash-parser.ts`).
4. **Read side** (`okf/okf-usage.service.ts`): loads the rows of the tree / the scoped trees and
   the snapshot bodies, applies the team filter, then the verdict
   ([algorithms/okf-verdict.md](algorithms/okf-verdict.md)) and the tree (`okf/okf-usage-tree.ts`).

## Tables

| Table / column | Content |
|---|---|
| `okf_snapshots` | `(user_id, snapshot_id)` unique; `body jsonb` = the snapshot without its `type` (`okfSnapshotId`, `schemaVersion`, `bundles[]`); `created_at` = the repo route's `snapshot.takenAt`. |
| `sessions.okf_snapshot_id` | Bound snapshot of a **root** session (indexed, no FK — an orphan sweep may remove the row under it). Sub-agents resolve their root via `topAncestorIdsSql`. |
| `upload_queue.okf_snapshot_id` | Id of a queued full-body upload, so the known check sees snapshots still in flight. |
| `session_okf_access` | One row per tree node × `(path_key, op, after_own_edit)`: `bytes`, `calls`, `seq` (first-access rank in the node). `op` ∈ `read`, `grep`, `list`, `write`; a folder key ends in `/` (repo root `/`). Cascades with its `sessions` row. |

Migration `server/drizzle/migrations/0075_okf_usage.sql` (additive, no backfill). Details:
[db-tables.md](db-tables.md).

## Where the rows are written

`rebuildSessionOkfAccess` / `rebuildOkfAccessForNodes` (`okf/okf-access-writer.ts`) are called
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
| `GET /api/v2/okf-usage/facts?sessionId=` | API key; 400 without `sessionId`; 404 for a missing session and for one whose logs the key's user does not own (DD-33) | `OkfFactsService.getFacts` (`okf/okf-facts.controller.ts`) |
| `POST /api/v2/logs` + `okfSnapshotId?`, `okfSnapshotFull?=1` → `unknownOkfSnapshotId?` | existing upload | `logs-v2.controller.ts` |

Response types: `server/src/logs/okf/okf-usage.types.ts`, mirrored in
`client/src/models/repositories.ts`. Full field lists: [api-reference.md](api-reference.md).

- An invalid `okfSnapshotId` (not `^[0-9a-f]{64}$`) is ignored silently, never a 400; an
  over-cap body (`OKF_SNAPSHOT_MAX_BYTES` = 10 MB) is ignored and the id stays unknown.
- `unknownOkfSnapshotId` comes back on a ref-only upload whose id is neither stored for the user
  nor in a pending / processing / partially uploaded queue row (`isOkfSnapshotKnown`); the hook
  then forgets the id and resends the full body next time.
- The facts route reparses the stored transcripts (never `session_okf_access`): `prompts` (main
  agent, `filterUserPrompts`, each cut to 4000 characters), per agent `kbReads`, `kbSeq`,
  `otherReadsTop` (top 20 non-KB reads), `changes`; and tree-wide `changes`, `reads`, `runs`. No
  tool result text. Prompt filter: [algorithms/okf-task-context.md](algorithms/okf-task-context.md).

## Session OKF tab

`client/src/viewer/pages/repository/session-log/okf/` — `SessionOkfTab.tsx` (tab id `okf`,
between "Harness usage" and "Raw Logs"):

- verdict card (`OkfVerdictCard.tsx`): badge, "partial data" chip, clickable Why lines that scroll
  the tree to the node, Read top 5 with the own-edit icon, "How agents reached the KB" chips
  (`✓ index` / `grep` / `given`);
- bundle cards (`OkfBundleCards.tsx`): tracked / gitignored, "started from index.md", FILES READ,
  BYTES INTO CONTEXT;
- tree (`OkfTree.tsx`, `okf-tree.ts`, `okf-tree-rows.tsx`): bundle → folder → file, READ heat
  (Bytes / Calls toggle), WRITE bar, markers `folder_scan`, `entry_point`, `own_edit`; files not
  read are grey ("not read") and sorted last; accessed files absent from the snapshot carry the
  "not in KB at start" chip, paths outside every bundle form a "Not in the KB snapshot" group;
- Agents panel (`OkfAgentsPanel.tsx`): one row per tree node with its task head (200 characters),
  entry and KB reads; clicking narrows the tree to that agent.
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
- The latest snapshot = the bound snapshot of the newest root session in the filtered set
  (DD-29); its bundles define the tree, the KB files and the not-read list.

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

## Lifecycle

- **Delete** (`sessions.service.ts` `purgeSessionChildData`): step c2 deletes
  `session_okf_access` (a soft delete keeps the `sessions` row, so the cascade does not run);
  step g clears `okf_snapshot_id` with `harness_snapshot_id`; step h sweeps orphan
  `okf_snapshots` (`deleteOrphanOkfSnapshots`). The team-repo removal (`teams.service.ts`) runs
  the same sweep. See [data-retention.md](data-retention.md).
- **Export / import**: the export zip's session shape carries `okfSnapshotId`; the root's
  `artisyn.jsonl` gets the full `okf-snapshot` line plus a ref line; import stores and rebinds
  like ingest. Older zips (no field, no lines) import with no snapshot (DD-42). See
  [session-export-import.md](session-export-import.md).
- **Recompute**: `recompute-all-sessions` rebuilds `session_okf_access` for every node.

## Backward compatibility

| Combination | Behaviour |
|---|---|
| Old hook → new server | No OKF params / lines: `okf_snapshot_id` stays null; extraction still fills `session_okf_access` from transcripts; the session tab shows the update-hook banner and the verdict carries `partial_data`. |
| New hook → old server | Unknown query params and NDJSON line types are ignored; the upload succeeds. |
| Old zip → new server | Imports with no snapshot. |
| New zip → old server | `okfSnapshotId` and OKF lines are ignored. |

Hook side: [hook-api-versioning.md](hook-api-versioning.md) (2.26.0) and the `okf` config key in
[hook-installation.md](hook-installation.md).
