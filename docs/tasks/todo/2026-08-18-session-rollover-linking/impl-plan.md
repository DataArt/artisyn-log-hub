# T-102: Session Rollover Linking — Implementation Plan

## TL;DR

- New pure-function server module `server/src/logs/session-continuation.ts` (uuid-chain extraction +
  layered predecessor resolution + kind mapping + first-human-prompt extraction) — no new NestJS
  service/DI, called from `LogsService`/`RepositoriesService`.
- DB: 5 new nullable columns + 2 indexes on `sessions` (`continued_from_session_id`,
  `continuation_kind`, `first_line_uuid`, `last_line_uuid`, `uuid_count`) — migration `0058`, no
  backfill (recompute is how historical sessions get linked).
- API: `GET :repoId/sessions` (existing endpoint) response gains `continuationKind`, `continuedFrom`,
  `continuedIn`, `chainPosition`, `firstPromptInherited` — no new endpoints.
- Hook (`hook/` is source of truth): `lifecycle-hook.js` `SessionStart`/`SessionEnd` record
  `source`/`reason` — additive, backward-compatible. Version bump 2.10.0 → 2.11.0, then
  `npm run build:hooks-installer` + dogfood mirror refresh under
  `.artisyn/marketplace/plugins/log-hub-hooks/`.
- Client: 2 new components (`ContinuationBreadcrumb.tsx`, `SessionInfoContinuationSection.tsx`) plus
  a small `SessionItem` addition (chain marker + inherited-prompt line) — no new pages/routes.
- No changes to cost/analytics aggregation anywhere — Option A is read-path/UI only.
- Export/import: `SessionJson` gains 2 fields, round-tripped via `importSessionLog()`'s existing
  always-upsert path (same mechanism as `parentSessionId`/`workflowRunId`).

## Reference

Requirements: `docs/tasks/todo/2026-08-18-session-rollover-linking/requirements.md` (evidence trail in
this folder's `notes.md`).

## Design Decisions

1. **Schema.** `sessions` gains 5 nullable columns, siblings to `parentSessionId` (no FK, no cycle
   check): `continuedFromSessionId` (varchar 255, weak ref), `continuationKind` (varchar 16, app-level
   enum `'fork' | 'resume' | 'unknown'`, no DB `CHECK` — matches the project's existing no-DB-constraint
   precedent for this table), `firstLineUuid` / `lastLineUuid` (varchar 64), `uuidCount` (integer).
   Indexes: `sessions_continued_from_session_id_idx` (reverse "continued in" lookup, mirrors
   `sessions_parent_session_id_idx`) and `sessions_last_line_uuid_idx` (powers the indexed
   uuid-containment candidate query in Decision 3).
2. **Detection module shape.** New `server/src/logs/session-continuation.ts`, pure functions only (no
   NestJS DI), mirroring `claude-extractor.ts`'s style so it is unit-testable with inline fixture
   arrays — no new test-fixture directory/convention needed.
3. **Layer 2 — uuid containment, O(indexed lookup).** A background-fork copy reproduces the
   predecessor's entire transcript verbatim as a leading prefix, so `N.firstLineUuid === P.firstLineUuid`
   for the true predecessor `P`, and `P.lastLineUuid` appears in `N`'s own parsed uuid list at index
   `P.uuidCount - 1`. Candidate query: `SELECT * FROM sessions WHERE last_line_uuid = ANY(<N's uuids>)
   AND id != N AND deleted = false`; a candidate `S` is CONFIRMED only when
   `S.firstLineUuid === N.uuidsInOrder[0]` AND `S.uuidCount === indexOf(N, S.lastLineUuid) + 1` — this
   is what lets 3 denormalized columns replace a full per-line uuid index table. Rank confirmed
   candidates by `uuidCount` descending; the top rank is the immediate predecessor.
4. **Layer 3 — snake_case hint.** The most-frequent snake_case `session_id` value stamped on `N`'s own
   lines that differs from `N`'s own id, used only when Layer 2 finds nothing and only when a `sessions`
   row with that id actually exists (non-deleted, top-level) — recorded as "origin of copied content",
   per `docs/knowledgebase/session-id-vs-sessionid.md`, never as a per-line join key.
5. **Kind mapping.** Hook `SessionStart.source` seeds the kind when present (`'resume'` → `resume`,
   `'fork'` → `fork`); Layer 2 success always yields `fork` (uuid copies never happen on `--resume`,
   per notes.md's measurement); Layer 3 success always yields `resume`. Final kind = hook seed if
   present, else the resolving layer's kind, else — when `sessionKind: "bg"` was observed on `N`'s own
   lines or a hook seed existed but nothing resolved an id — `'unknown'` with `continuedFromSessionId
   = null` (satisfies AC3's "recorded as a continuation of unknown origin"). A session with none of
   these signals gets no continuation row at all — all 5 columns stay `NULL`, and every UI surface
   (breadcrumb row, Info section, list marker) is entirely absent, per every wireframe's stated
   "no link" state.
6. **Ambiguous ties.** Layer 2 returning ≥2 equally-ranked confirmed candidates (0 occurrences
   measured) persists no link, falls through to Layer 3, and logs one warning — no new persisted
   "ambiguous" state, keeping the schema at exactly the 5 columns above.
7. **Hook-seed lookup, no new column for it.** At `claude`-log detection time, the hook `source` seed
   is read by querying the sibling artisyn log's stored body
   (`SELECT body FROM logs WHERE session_id = X AND log_type = 'artisyn'`) for a `hook_event_name:
   'SessionStart'` line's `source` field — not a new denormalized column. An artisyn log that hasn't
   arrived yet (or predates this task, per hook backward-compatibility) yields no seed and detection
   falls through to Layers 2/3; `recomputeForRepo` re-derives once later data lands (AC7).
8. **Call sites and idempotency.** Detection runs in `LogsService.upsert()`'s existing
   `logType === 'claude'` branch (never for `claude-subagent` — those already roll up via
   `parent_session_id`/`descendantSessionsCte`) and in `RepositoriesService.recomputeSessionStats()`'s
   existing loop over `claude`-type `sessionRows`. It is never gated on `isNewInsert` (mirrors the
   Step-5 precedent at `logs.service.ts:206-212`), but the WRITE only overwrites
   `continuedFromSessionId`/`continuationKind`/uuid columns when a fresh non-null resolution exists —
   `COALESCE(<new>, sessions.<col>)`, the same idiom `logs.firstPrompt`'s
   `COALESCE(excluded.first_prompt, ...)` already uses — so a later upload/recompute that resolves
   nothing never clears an already-recorded link (AC4).
9. **First-prompt repair (applies to every claude-log ingest, not just detected continuations).**
   After parsing claude lines, scan for the first `type === 'user'` line whose `origin` is absent or
   `origin.kind === 'human'`, reusing `stripIdeOpenedFiles` (exported from `artisyn-extractor.ts`) for
   cleanup. `isNonQualifyingPromptContent` (exported from `claude-extractor.ts`, previously
   file-local) judges whether the sibling artisyn `logs.firstPrompt` currently looks synthetic. When a
   qualifying candidate is found AND the artisyn value is `NULL` or synthetic:
   `UPDATE logs SET first_prompt = <candidate> WHERE session_id = X AND log_type = 'artisyn'`. No
   candidate found → the stored column is left untouched; Decision 10 covers continuation sessions
   with no human prompt of their own at all.
10. **Inherited-prompt display (read-time only, never persisted).** In `getRepositorySessions`'s
    response mapping: when a session's own `firstPrompt` still looks synthetic
    (`isNonQualifyingPromptContent`) AND it has a resolved, visible `continuedFromSessionId` whose
    target has a non-synthetic `firstPrompt`, the API response substitutes that prompt and sets
    `firstPromptInherited: true`. The stored `logs.firstPrompt` value is never overwritten with
    borrowed content — only the response substitutes it.
11. **Link visibility ("existing repo-scoped session endpoint").** `getRepositorySessions` resolves
    every `continuedFrom`/`continuedIn` target with one additional batched query scoped by the SAME
    `repoCondition`/`ownerCondition` the method already computes (deliberately WITHOUT
    `branchCondition` — branch is a display filter, not an access boundary). A target absent from
    that scoped result renders client-side as non-clickable text + tooltip (wireframe state 4) —
    never a dead link. No new endpoint.
12. **Chain position.** Computed in the same query group as Decision 11 by walking
    `continued_from_session_id` forward and backward, depth-capped at 50 (mirrors
    `descendantSessionsCte`'s existing cap, same "no FK/cycle-check" reason), returned as
    `{ index, total } | null`.
13. **Client navigation.** The breadcrumb link, Info-tab links, and list-marker tooltip all navigate
    via `useSearchParams()` setting `session=<targetSessionId>` (the existing `?session=` mechanism in
    `useRepositoryViewState.ts`) — never a repo switch, since a *visible* target is by construction in
    the current repo/owner scope (Decision 11).
14. **Export/import.** `SessionJson` gains `continuationKind`/`continuedFromSessionId`, mirroring the
    existing optional `parentSessionId`/`workflowRunId` fields. `importSessionLog()`'s Step 1 (which
    already always-upserts `parentSessionId`/`workflowRunId` regardless of the keep-longer merge
    outcome, per Design Decision 14 in `export-import-zip.ts`'s doc comments) is extended the same way
    for these two fields. `firstLineUuid`/`lastLineUuid`/`uuidCount` do NOT round-trip through
    export/import — they are re-derived deterministically by the same detection call
    `importSessionLog()`'s Step 3 already makes for `claude`-type bodies.
15. **Hook change.** `lifecycle-hook.js`'s `SessionStart` case gains `event.source = input.source ||
    null;`; a new `case 'SessionEnd':` (currently folded into the no-op `default`) gains `event.reason
    = input.reason || null;`. Purely additive fields on the existing artisyn event shape — an
    older/unmodified server ignores them with zero impact, per CLAUDE.md's hook backward-compatibility
    rule. MINOR version bump (new backward-compatible telemetry fields).

## Files to create/modify

| File | Purpose | Note |
|---|---|---|
| `server/src/database/schema/index.ts` | Add 5 columns + 2 indexes to `sessions` | Decision 1 |
| `server/drizzle/migrations/0058_session_continuation.sql` | New migration | Decision 1 |
| `server/drizzle/migrations/meta/_journal.json` | Register migration 0058 | — |
| `server/src/logs/session-continuation.ts` | New: uuid-chain extraction, predecessor resolution, kind mapping, first-human-prompt extraction | Decisions 2-5, 9 |
| `server/src/logs/session-continuation.spec.ts` | New: unit tests, inline fixtures | — |
| `server/src/logs/claude-extractor.ts` | Export `isNonQualifyingPromptContent` | Decision 9 |
| `server/src/logs/artisyn-extractor.ts` | Export `stripIdeOpenedFiles` | Decision 9 |
| `server/src/logs/logs.service.ts` | `upsert()` Step 1: write continuation columns for `logType==='claude'`; new first-prompt repair call; `importSessionLog()`: always-upsert new fields + new params | Decisions 7-9, 14 |
| `server/src/logs/repositories.service.ts` | `recomputeSessionStats()`: add detection call per claude session row | Decision 8 |
| `server/src/logs/repositories.controller.ts` | `getRepositorySessions()`: batched continuation-resolution query + response fields | Decisions 10-12 |
| `server/src/logs/export-import-zip.ts` | `SessionJson`: add 2 fields | Decision 14 |
| `server/src/logs/repository-export-import.service.ts` | Thread new fields through export build + `importOneSession()` | Decision 14 |
| `docs/knowledgebase/db-tables.md` | Document new `sessions` columns | — |
| `docs/knowledgebase/server-endpoint-map.md` | Document `:repoId/sessions` response additions | — |
| `docs/knowledgebase/api-reference.md` | Same | — |
| `hook/.claude/telemetry_tool/lifecycle-hook.js` | `SessionStart`/`SessionEnd`: record `source`/`reason` | Decision 15 |
| `hook/.claude/telemetry_tool/version.json` | Bump 2.10.0 → 2.11.0 | Decision 15 |
| `hook/.claude/telemetry_tool/__tests__/lifecycle-hook.test.js` | New test cases | — |
| `.artisyn/marketplace/plugins/log-hub-hooks/scripts/lifecycle-hook.js` + `version.json` | Dogfood mirror refresh | `.claude/rules/hook.md` |
| `.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json` | Version bump | `.claude/rules/hook.md` |
| `INSTALL_HOOK.md` | Regenerated | `update-install-instructions` skill |
| `client/src/models/repositories.ts` | `RepositorySession`: 5 new optional fields | Decision 13 |
| `client/src/viewer/pages/repository/session-log/ContinuationBreadcrumb.tsx` | New: header breadcrumb, 5 states | Visual/UX notes |
| `client/src/viewer/pages/repository/SessionDetailHeader.tsx` | Render breadcrumb after attribution row | — |
| `client/src/viewer/pages/repository/session-log/SessionInfoContinuationSection.tsx` | New: Info-tab section | Visual/UX notes |
| `client/src/viewer/pages/repository/session-log/SessionInfoTab.tsx` | Insert new section between Identity/Timeline | — |
| `client/src/viewer/pages/repository/session-list/session-list-helpers.tsx` | `SessionItem`: chain marker + inherited-prompt line + hover tooltip | Visual/UX notes |
| `docs/knowledgebase/client-component-map.md` | Register 2 new components | — |

## API changes

`GET /api/v1/repositories/:repoId/sessions` (existing endpoint, response items extended):

```
continuationKind: 'fork' | 'resume' | 'unknown' | null
continuedFrom: { sessionId: string; startTime: string; endTime: string; firstPrompt: string; visible: true }
              | { sessionId: string; visible: false } | null
continuedIn: Array<{ sessionId: string; startTime: string; endTime: string; firstPrompt: string; visible: boolean }>
chainPosition: { index: number; total: number } | null
firstPromptInherited: boolean
```

`POST /api/v1/repositories/:repoId/recompute-all-sessions` — unchanged request/response contract; now
also re-derives continuation links as a side effect (Decision 8).

No new endpoints.

## Database changes

Migration `0058_session_continuation.sql` (all `ADD COLUMN` with no default — no full-table rewrite;
indexes use `CREATE INDEX IF NOT EXISTS`, never `CONCURRENTLY`, per `.claude/rules/db-migration.md`):

```sql
ALTER TABLE sessions ADD COLUMN continued_from_session_id varchar(255);
ALTER TABLE sessions ADD COLUMN continuation_kind varchar(16);
ALTER TABLE sessions ADD COLUMN first_line_uuid varchar(64);
ALTER TABLE sessions ADD COLUMN last_line_uuid varchar(64);
ALTER TABLE sessions ADD COLUMN uuid_count integer;
CREATE INDEX IF NOT EXISTS sessions_continued_from_session_id_idx ON sessions (continued_from_session_id);
CREATE INDEX IF NOT EXISTS sessions_last_line_uuid_idx ON sessions (last_line_uuid);
```

Migration safety review:
```
[x] No full-table rewrites with blocking locks (no DEFAULT on any ADD COLUMN)
[x] No index uses CONCURRENTLY
[x] No destructive drops
[x] NOT NULL additions have no existing NULLs risk (all 5 columns nullable)
[x] Long-running DML is batched / deferred (no DML at all — no backfill, per Decision 1/requirements)
[x] Idempotent (CREATE INDEX IF NOT EXISTS)
```

No backfill: existing sessions get linked retroactively only via a `recompute-all-sessions` call
(Decision 8), matching `docs/knowledgebase/db-tables.md`'s existing no-backfill convention.

## Test coverage plan

- **`session-continuation.spec.ts` (unit, inline fixtures)**: uuid-prefix match resolves the immediate
  predecessor and ranks a 3-session chain correctly; snake_case-only fallback (`--resume`, no uuid
  overlap) resolves `kind='resume'`; a hook seed overrides the layer-derived kind; an ambiguous tie
  (2 equally-ranked candidates) persists no link and falls through to Layer 3; first-human-prompt
  extraction picks the first `origin.kind==='human'`-or-absent line and skips `task-notification`
  lines.
- **`session-continuation.e2e-spec.ts` (new, real DB)**: replicate the motivating pair (chunked,
  out-of-order upload — continuation's claude log lands before the origin's) and assert
  `continued_from_session_id`/`continuation_kind` resolve correctly after both direct `upsert()` and
  `recompute-all-sessions`; assert re-upload never clears an established link (AC4); assert a `bg`
  session with no resolvable uuid overlap gets `continuation_kind='unknown'`,
  `continued_from_session_id=NULL` (AC3); assert zero false positives across sessions sharing no
  uuids/hook signal (AC2); assert `getRepositorySessions`'s new response fields, including the
  "target outside repo scope" `visible: false` case and `firstPromptInherited`.
- **`repository-export-import.spec.ts` (extend)**: export a repo containing a detected pair, import
  into an empty instance, assert the link is preserved in both directions (AC6).
- **`lifecycle-hook.test.js` (extend)**: `SessionStart` writes `source` when present; `SessionEnd`
  writes `reason` when present; both write `null` (not throw) when the input lacks the field
  (pre-upgrade CLI shape).
- **Client unit (vitest)**: `ContinuationBreadcrumb.test.tsx` — all 5 wireframe states incl. "no link →
  absent"; `SessionInfoContinuationSection.test.tsx` — normal/resume/unresolved variants incl.
  "no link/candidate → section absent"; `session-list-helpers.test.tsx` — chain marker + inherited-prompt
  line + tooltip rendering, and marker absence when no link.

## Visual/UX notes

- **Header breadcrumb** (`session-detail-continuation-breadcrumb.svg`): one indigo row
  (`#eef2ff` bg / `#c7d2fe` border) inserted between the attribution row and the tab bar in
  `SessionDetailHeader.tsx` — visible on every tab. States: later session ("Continues from" + kind/gap
  pill + chain position + "View whole chain →"), earlier session ("Continued in"), middle-of-chain
  (both arrows), target-out-of-scope (plain gray, non-clickable id + tooltip, no indigo fill), amber
  unresolved/unverified (`#fffbeb`/`#fcd34d`, no navigation). Row is entirely absent when no link
  exists — no empty placeholder.
- **Info tab section** (`session-info-continuation-section.svg`): new "CONTINUATION" `CollapsibleSection`
  (light indigo card, `#f8f9ff`/`#c7d2fe`) inserted between Identity and Timeline in
  `SessionInfoTab.tsx`: Kind, gap, Continues-from/Continued-in links, Chain position, display-only
  Chain-cost sum (explicitly labeled "= X + Y · not an aggregation change"), First-prompt-source,
  Detected-by/Detected-at evidence rows. Unresolved/ambiguous variants use the amber card style.
  Absent entirely when no link/candidate.
- **List chain marker** (`session-list-chain-marker.svg`): ⇄ indigo marker + `3px` left edge bar
  (`#6366f1` for the later session, `#c7d2fe` for the origin) on `SessionItem` rows in a detected pair;
  inherited-prompt line renders italic, muted, with "inherited from `<id>`" caption; hover reuses the
  existing `ViewportPopover.tsx` (no new popup machinery) showing the chain list + a display-only
  "chain total"; amber ⚠ marker for unverified candidates (no chain list, no inherited prompt). No
  clickable link inside the row itself — clicking the row still opens that session; chain navigation
  lives in the header breadcrumb.
- Copy rule: "Continues from" / "Continued in" wording never changes with kind — the kind + measured
  gap live only in the pill, so a wrong kind guess never changes the primary wording.

## Wireframes

No wireframe changes needed — implement `session-detail-continuation-breadcrumb.svg`,
`session-list-chain-marker.svg`, and `session-info-continuation-section.svg` as depicted.
`chain-scope-unified-timeline.svg` (the deferred full-merge alternative) is out of scope for this
task and needs no implementation.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema & migration | 5 | No dependencies |
| 2 | Detection module + first-prompt helper | 5 | Depends on Chunk 1 (columns referenced by tests/types) |
| 3 | Wire detection into ingest, recompute & import | 6 | Depends on Chunk 2 |
| 4 | Hook: record source/reason | 7 | Independent of Chunks 1-3; can run in parallel |
| 5 | API response | 5 | Depends on Chunk 3 (columns populated) |
| 6 | Client model + header breadcrumb | 5 | Depends on Chunk 5 (response shape) |
| 7 | Client Info-tab section + list marker | 5 | Depends on Chunk 5 |
| 8 | Tests | 4 | Depends on Chunks 1-7 |

### Chunk 1 — Schema & migration
- [ ] Add `continuedFromSessionId`, `continuationKind`, `firstLineUuid`, `lastLineUuid`, `uuidCount`
      columns to the `sessions` pgTable in `server/src/database/schema/index.ts`, per Design Decision 1.
- [ ] Add `sessions_continued_from_session_id_idx` and `sessions_last_line_uuid_idx` indexes, per
      Design Decision 1.
- [ ] Create `server/drizzle/migrations/0058_session_continuation.sql` with the SQL in Database
      changes above.
- [ ] Add a matching entry (`idx: 58`, tag `0058_session_continuation`) to
      `server/drizzle/migrations/meta/_journal.json`.
- [ ] Run `npm run migrate` from `server/` and verify it succeeds against the dev DB's existing
      `sessions` rows.

### Chunk 2 — Detection module + first-prompt helper
- [ ] Create `server/src/logs/session-continuation.ts` exporting `extractUuidChain(lines)` — single
      pass reading `uuid`/`parentUuid`/`sessionKind`/snake_case `session_id`, returns
      `{uuidsInOrder, firstLineUuid, lastLineUuid, uuidCount, sessionKindBg, snakeCaseOriginHint}`
      per Design Decision 2.
- [ ] Add `resolveContinuationCandidate(chain, ownSessionId, hookSourceSeed, candidateLookup)`
      implementing the Layer 2/3 + kind-mapping priority of Design Decisions 3-6, with an injectable
      `candidateLookup` for unit-test fixtures.
- [ ] Add `extractFirstHumanPromptFromClaudeLines(lines)` per Design Decision 9, reusing
      `stripIdeOpenedFiles` (export it from `artisyn-extractor.ts`).
- [ ] Export `isNonQualifyingPromptContent` from `claude-extractor.ts` (remove its file-local
      modifier) for reuse by the new module, per Design Decision 9.
- [ ] Write `server/src/logs/session-continuation.spec.ts` per the unit-test bullets in Test coverage
      plan.

### Chunk 3 — Wire detection into ingest, recompute & import
- [ ] In `LogsService.upsert()` Step 1 (`server/src/logs/logs.service.ts:94-118`), for
      `logType === 'claude'` only: look up the hook seed via one
      `SELECT body FROM logs WHERE session_id=X AND log_type='artisyn'` query (Design Decision 7), call
      `extractUuidChain`/`resolveContinuationCandidate` (production `candidateLookup` = one indexed
      `sessions` query per Design Decision 3, implemented in `session-continuation.ts`).
- [ ] Spread the 5 resulting values into the same `insert().values({...})` object (mirrors the existing
      `parentSessionId`/`workflowRunId` conditional spread) AND extend the upsert's `set` clause with
      `COALESCE(excluded.col, sessions.col)` for each — per Design Decision 8, both halves are required.
- [ ] After Step 2's log upsert, add the first-human-prompt repair call (Design Decision 9): update the
      sibling artisyn `logs.firstPrompt` when a qualifying candidate is found and the existing value is
      null/synthetic.
- [ ] In `RepositoriesService.recomputeSessionStats()`'s existing loop over the claude-only
      `sessionRows` (`server/src/logs/repositories.service.ts:1487`, NOT the `logRows` cause-stats loop
      at line 1450 which also covers `claude-subagent` rows), add the same detection call as a plain
      `UPDATE sessions SET ...` (row already exists; no `onConflictDoUpdate` needed).
- [ ] Add `continuationKind`/`continuedFromSessionId` parameters to `importSessionLog()`'s signature;
      extend its Step 1 upsert to always-write them when present, mirroring `parentSessionId`/
      `workflowRunId` (Design Decision 14).
- [ ] Thread `meta.continuationKind`/`meta.continuedFromSessionId` from
      `repository-export-import.service.ts`'s `importOneSession()` call into `importSessionLog()`, and
      populate the same 2 fields when building `sessionJson` on export (`repository-export-import.service.ts:610`).

### Chunk 4 — Hook: record source/reason
- [ ] In `hook/.claude/telemetry_tool/lifecycle-hook.js`, add `event.source = input.source || null;`
      inside the existing `case 'SessionStart':` block, alongside the existing `event.git` line.
- [ ] Add a new `case 'SessionEnd': event.reason = input.reason || null; break;` (currently folds into
      the no-op `default` case).
- [ ] Add test cases to `hook/.claude/telemetry_tool/__tests__/lifecycle-hook.test.js` asserting
      `source`/`reason` are written when present in the input and `null` when absent.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.11.0` (MINOR), per `.claude/rules/hook.md`.
- [ ] Run `npm run build:hooks-installer` from repo root, then copy the changed hook files and
      `version.json` into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/` and bump
      `.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json`'s version to match, per
      `.claude/rules/hook.md`.
- [ ] Run the `update-install-instructions` skill to refresh `INSTALL_HOOK.md`.
- [ ] Run `npm run lint:fix` then `npm run lint` from `hook/`, and `npm test` from `hook/`, per
      `.claude/rules/hook.md` — not covered by `repo-health-checks.json`, so this must be run manually.

### Chunk 5 — API response
- [ ] In `RepositoriesController.getRepositorySessions()` (`server/src/logs/repositories.controller.ts:371`),
      add a batched query resolving `continuedFrom`/`continuedIn` targets scoped by the method's
      existing `repoCondition`/`ownerCondition` (no `branchCondition`), per Design Decision 11,
      returning per-target `{sessionId, startTime, endTime, firstPrompt, visible}`.
- [ ] Add chain-position computation (forward/backward walk of `continued_from_session_id`, depth
      capped at 50), per Design Decision 12, returned as `chainPosition: {index, total} | null`.
- [ ] Add `firstPromptInherited` substitution logic to the same method's response mapping (around
      line 768-798), per Design Decision 10.
- [ ] Add `continuationKind`, `continuedFrom`, `continuedIn`, `chainPosition`, `firstPromptInherited`
      to the returned object shape.
- [ ] Update `docs/knowledgebase/server-endpoint-map.md`, `docs/knowledgebase/api-reference.md`, and
      `docs/knowledgebase/db-tables.md` to document the new columns/response fields.

### Chunk 6 — Client model + header breadcrumb
- [ ] Add `continuationKind`, `continuedFrom`, `continuedIn`, `chainPosition`, `firstPromptInherited`
      optional fields to `RepositorySession` in `client/src/models/repositories.ts`.
- [ ] Create `client/src/viewer/pages/repository/session-log/ContinuationBreadcrumb.tsx` rendering the
      5 states from `session-detail-continuation-breadcrumb.svg`, per Visual/UX notes.
- [ ] Wire navigation via `useSearchParams()` setting `session=<targetSessionId>`, per Design
      Decision 13.
- [ ] Render `<ContinuationBreadcrumb>` in `SessionDetailHeader.tsx` immediately after the attribution
      row (after the `{attributionState !== 'off' && (...)}` block).
- [ ] Update `docs/knowledgebase/client-component-map.md` with the new component.

### Chunk 7 — Client Info-tab section + list marker
- [ ] Create `client/src/viewer/pages/repository/session-log/SessionInfoContinuationSection.tsx`
      (`CollapsibleSection` + `InfoRow`s) per `session-info-continuation-section.svg`'s
      normal/resume/unverified/ambiguous variants.
- [ ] Insert `<SessionInfoContinuationSection>` in `SessionInfoTab.tsx` between the Identity section
      (ends line 74) and the Timeline section (starts line 76).
- [ ] In `session-list-helpers.tsx`'s `SessionItem`, add the ⇄ indigo chain marker + left edge bar and
      the italic inherited-prompt line, per `session-list-chain-marker.svg`.
- [ ] Add the marker's hover tooltip using the existing `ViewportPopover.tsx` showing chain members +
      display-only chain-total cost, per the same wireframe.
- [ ] Update `docs/knowledgebase/client-component-map.md` for the new section component.

### Chunk 8 — Tests
- [ ] Add `server/test/session-continuation.e2e-spec.ts` per the e2e bullets in Test coverage plan.
- [ ] Extend `server/test/repository-export-import.spec.ts` asserting a detected pair's link survives
      export → import into an empty instance (AC6).
- [ ] Add client unit tests: extend `session-list-helpers.test.tsx`; create
      `ContinuationBreadcrumb.test.tsx` and `SessionInfoContinuationSection.test.tsx`, covering every
      documented state including "absent when no link" and "target outside scope, non-clickable".
- [ ] Run `bun run typecheck` (client) and `npm run typecheck` (server) and fix any resulting errors.
