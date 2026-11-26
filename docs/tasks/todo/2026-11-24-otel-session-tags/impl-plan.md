---
type: "Plan"
title: "Session Tags from OTEL Resource Attributes — implementation plan"
description: "Plan for replacing hook-config session context with session_tags fed by OTEL resource attributes, with tag filter / group-by across sessions, analytics, reports and Spend."
---

# Implementation plan — 2026-11-24-otel-session-tags

## TL;DR

- **New table `session_tags`** `(session_id → sessions.id, key, value, source)` on the root session,
  mirroring `session_attribution`'s FK/cascade; migration `0098` copies every `contexts` /
  `log_contexts` pair there with `source='config'` and drops both old tables. No new service or
  background process — the OTEL projection writer fills it.
- **Extraction lives in `applyOtelLines`** (both chunk and realtime paths) via a pure
  `extractOtelTags(lines)` next to `extractOtelAccount`; backfill = `OTEL_PROJECTION_VERSION` 2 → 3
  (existing re-projection path, no second mechanism).
- **`tag=` / `groupBy=tag:` mirror `attr=` / `groupBy=attr:`** through one new helper module
  (copy of `attribute-filter.sql.ts`) on every route that already takes `attr=`; multi-value keys
  **fan out** (Q1 answered 2026-11-25), reusing `GroupByFanOutCaveat`. Rejected: per-call cost split
  — would need tags on `otel_calls` and cannot work for `source='config'`.
- **One new endpoint** `GET /api/v1/repositories/:repoId/session-tags/values` (clone of
  `session-attribution/values`). Team Spend has no repo, so Spend gets its tag keys inside its own
  response (`tagKeys`) instead of a second, team-scoped discovery route.
- **Spend gains a `tag` slice** selected with a `tagKey` query param (rows = values + "(untagged)",
  fan-out); `spend/sessions` drill-down accepts `slice=tag`.
- **Show, don't limit:** the per-session cap is 500 pairs (runaway guard only); junk tags are
  surfaced as a "noisy key" warning (> 10 values of one key in a session) in the session header and
  pickers, computed at read time — no extra storage. Rejected: a tight cap (old 20), which would hide
  the user's misconfiguration.
- **Hook / installer:** stop reading/writing `context` (hook MINOR bump); the server keeps accepting
  `prompt_start.context` from old hooks and ignores it.
- **External surface:** 1 new route, additive `tags` fields and `tag=` / `groupBy=tag:` / `tagKey`
  params, both `.../contexts` routes keep their shape (repo route gains scoping + access filter),
  `contexts` / `log_contexts` replaced by `session_tags`, hook stops sending an optional field — all
  backward compatible.

## Reference

[requirements.md](requirements.md)

## Architecture decisions

- Storage columns are unbounded `text`; the 64 / 256 / 500 limits are enforced only by the OTEL
  extractor, so the migration copies legacy `config` pairs (keys ≤ 255, values ≤ 4000) unchanged —
  "no data is lost" wins over the new limits for historical rows (they already fit a btree, the old
  `UNIQUE(context_key, context_value)` held them).
- Noise is derived at read time from `session_tags`, never stored: a key is noisy for a session
  when it has more than `TAG_NOISY_VALUES_PER_SESSION = 10` distinct values there; the session is
  "at limit" when it has `OTEL_TAG_MAX_PAIRS` `otel` rows. Discovery marks a key noisy when any
  session in scope is noisy on it.
- The 500-pair cap counts `source='otel'` rows of the root and is applied inside `applyOtelLines`,
  which already runs under the `otel_session_state` row lock, so chunk and realtime writers cannot
  race past it; first written wins (chunk and realtime order is not fixed, so "first seen" means
  first processed).
- `'tag'` joins the `SpendSliceKind` union but not the `SPEND_SLICE_KINDS` default list, so default
  slices and the Budget report's `topSlices` stay unchanged.
- Tag writes do not bump `otel_session_state.seq` — tags are not part of the OTEL tab's `since=`
  delta.
- Writers skip roots whose `sessions.deleted = true`; soft delete (`purgeSessionChildData`) and the
  team-delete cleanup delete `session_tags` explicitly (soft delete keeps the `sessions` row, so the
  FK cascade only covers hard delete).
- Migration root resolution: `log_contexts.log_id → logs.session_id → sessions`, walked up
  `parent_session_id` to the root; pairs whose session no longer exists are dropped (they were
  orphans already).
- Reads dedupe across sources: the `tags` arrays, discovery and `.../contexts` return each
  `(key, value)` once; the `tags` array keeps `source` and, when a pair has both sources, reports
  `otel`.
- Session list: tag filter and "By tag" grouping run client-side over each row's `tags`, exactly
  like the existing Session Attributes filter; the selection is mirrored into the URL `tag=` param.
  The server `sessions` / `sessions/branches` routes also accept `tag=` for API parity (FR-7).
- Reports and Analytics get one shared, URL-backed `TagFilterControl` (pattern:
  `okf/OkfFilterStrip.tsx` + `okf-url-state.ts`) and a TAGS optgroup beside ATTRIBUTES in the
  Group-by menus; every fetcher forwards `tag=`.
- The repository-header chips switch from `fetchRepositoryContexts` to the discovery endpoint with
  the header's current period / branch / user scope; `fetchRepositoryContexts` is removed from the
  client.
- User docs: a "Tagging sessions" section is added to `user-docs/otel-tab.md` next to its existing
  `OTEL_RESOURCE_ATTRIBUTES` text (no new page / `nav.json` entry).

Internal contracts shared between chunks:

- `server/src/logs/tag-filter.sql.ts` (new, chunk 3):
  `type TagFilter = { key: string; values: string[] | null }` (`null` = any value);
  `parseTagFilters(raw: string | string[] | undefined): TagFilter[]` (splits on the first `:`, 400 on
  empty key); `tagFilterSql(filters, rootSessionIdColumn): SQL` (AND across keys, OR within a key,
  one `EXISTS` per key); `parseGroupByTagKey(groupBy): string | null` (`tag:<key>`);
  `tagGroupKeysSql(key, rootSessionIdColumn)` (set-returning, yields `'(untagged)'` sentinel when
  absent); `UNTAGGED_GROUP = '__untagged__'` as the group key, label "(untagged)";
  `assertNoGroupByTagFilterConflict(groupByKey, filters)` — 400 when the same key is both grouped
  and filtered, exactly like `assertNoGroupByAttrFilterConflict`.
- `AnalyticsScope` gains `tagFilters: TagFilter[]` next to `attributeFilters`;
  `loadScopedRootSessions` applies it.
- `extractOtelTags(lines: OtelLine[]): { key: string; value: string }[]` in `otel-records.ts`
  (chunk 2) — deny-list constant `OTEL_TAG_DENY_PREFIXES` and limits `OTEL_TAG_MAX_KEY = 64`,
  `OTEL_TAG_MAX_VALUE = 256`, `OTEL_TAG_MAX_PAIRS = 500` in `otel-facts.constants.ts`;
  `TAG_NOISY_VALUES_PER_SESSION = 10` next to them (server-only; the client gets the verdict).
- Shared DTO `SessionTag = { key: string; value: string; source: 'otel' | 'config' }` (server types
  and client model).

## External surface

**API** (all session-data routes keep their current guards and team visible-users / owner rules;
admin still gets no session data):

- NEW `GET /api/v1/repositories/:repoId/session-tags/values` — query `teamId?`, `startDate?`,
  `endDate?`, `branch?`, `userEmail?`; response
  `{ tags: Record<key, { value: string; sessionCount: number }[]>; noisyKeys: string[] }` over root
  sessions in scope the caller may open (same scope/access code as `session-attribution/values`).
  Backward compatible (new).
- CHANGED session list rows (`GET :repoId/sessions`, `GET :repoId/sessions/branches` rows) — add
  `tags: SessionTag[]` (root's tags for sub-agents). Additive.
- CHANGED session detail (`GET .../sessions/:sessionId/logs` meta and the parts manifest, where
  `sessionAttribution` is returned today) — add `tags: SessionTag[]` and
  `tagNoise: { noisyKeys: { key: string; values: number }[]; atLimit: boolean }`. Additive.
- CHANGED every route that accepts `attr=` (repositories: `sessions`, `sessions/branches`,
  `analytics/timeline`, `analytics/change-surface`, `analytics/work-time`; reports: executive-summary,
  cache-read-ratio, harness-usage, okf-usage, change-surface, attribution-breakdown, tool-analytics,
  token-usage, productivity-counters, active-sessions, claude-versions; usage-analytics: tools,
  tokens, productivity, active-sessions, claude-versions) — accept repeatable `tag=<key>` /
  `tag=<key>:<value>`; 400 on an empty key. Additive (absent = no filter).
- CHANGED every route that accepts `groupBy=attr:<key>` (timeline, change-surface analytics + report,
  work-time, cache-read-ratio, harness-usage) — accept `groupBy=tag:<key>`; no validation against
  attribute definitions; groups = values + `__untagged__`; a session with several values appears in
  each group; response carries the same fan-out flag the `attr:` path already returns; 400 when the
  same key is also given in `tag=` (as for `attr:`). Additive.
- CHANGED `GET :repoId/spend` and `GET /api/v1/teams/:teamId/spend` — optional `tagKey`; response
  `SpendView` gains `tagKeys: string[]` (keys present on roots in scope) and, when `tagKey` is given,
  one extra `slices[]` entry `{ kind: 'tag', tagKey, rows }` (rows keyed by value plus
  `__untagged__`, fan-out; `SpendSliceKind` gains `'tag'`, `SpendSlice` gains optional `tagKey`).
  Additive for old clients (they never send `tagKey`, they ignore the extra field).
- CHANGED `GET :repoId/spend/sessions` and `GET /api/v1/teams/:teamId/spend/sessions` — accept
  `slice=tag` with `tagKey` and `key=<value|__untagged__>`. Additive.
- CHANGED `GET :repoId/contexts` — same `{ key, value }[]` shape, now read from `session_tags`
  (deduped), restricted to sessions the caller may open (team visible-users filter, owner filter),
  optional `startDate` / `endDate` / `branch` / `userEmail`; without them, all-time. Shape
  compatible; may now return fewer pairs (the AC-10a fix).
- CHANGED `GET :repoId/sessions/:sessionId/contexts` — same shape, read from `session_tags` of the
  session's root. Compatible.
- `POST` hook ingest of `prompt_start` — still accepts a `context` field and stores the line
  verbatim; it is no longer projected. Compatible with old hooks.

**DB** (migration `0098_session_tags.sql`, hand-written, `COMMENT ON` each table/column):

- NEW `session_tags`: `id serial PK`; `session_id integer NOT NULL REFERENCES sessions(id) ON DELETE
  CASCADE` (always the root); `key text NOT NULL`; `value text NOT NULL`; `source varchar(32) NOT
  NULL` (`'otel'` | `'config'`); `created_at timestamptz NOT NULL DEFAULT now()`;
  `UNIQUE (session_id, key, value, source)`; index `(key, value, session_id)` for `tag=` EXISTS and
  discovery.
- Data move: insert one row per distinct `(root session, context_key, context_value)` from
  `log_contexts ⋈ contexts ⋈ logs ⋈ sessions` with `source='config'`; then `DROP TABLE log_contexts,
  contexts`. Runs as a no-op on a clean DB. Not reversible by design (requirements).
- Backfill of OTEL tags: no SQL migration. Changed after the Pi deploy on 2026-11-25: a full
  re-projection (requeue of every v2 chunk) took ~38 min at 100 % Postgres CPU with four worker
  heap OOMs on a Pi 3B, so `OTEL_PROJECTION_FULL_REQUEUE_BELOW = 2` keeps v2 chunks out of the
  startup requeue and the projection drain's light tag-only upgrade (`upgradeTagsOnly`) re-stamps
  them v3 in SQL, reading into Node only the chunks whose `resource` has a key outside the deny-list.

**Other:**

- Hook `log-hub.json`: `context` key dropped from `CONFIG_DEFAULTS` / `CONFIG_TYPES`; an old config
  that still has it is ignored silently. `prompt_start` no longer carries `context`. Hook MINOR
  version bump recorded in `hook-api-versioning.md`. Compatible both ways.
- Installer: new `log-hub.json` template has no `context`; `.env` → `log-hub.json` conversion no
  longer maps `CTX_*`, prints one line that `CTX_*` is unused and labels go into
  `OTEL_RESOURCE_ATTRIBUTES`. Existing configs are not rewritten.
- OTEL resource attributes: user keys outside the deny-list are now read (contract in requirements
  FR-2); nothing changes in what the receiver sends.
- Client URL params: `tag=` (session list, Analytics, Reports), `groupBy=tag:<key>` (Analytics,
  Reports), `tagKey=` (Spend). Old bookmarks unaffected.

## Test coverage plan

- Algorithm: `docs/algorithm-examples/otel-facts.json` gets `kind: "tags"` rows (deny-list incl.
  `team.name` kept, multi-value, trimming / coercion / empty, case-sensitive keys, 300-char value
  dropped via `$repeat`, 25 attributes → 25 pairs, 510 pairs → 500); `docs/knowledgebase/algorithms/otel-facts.md`
  documents the rule; picked up by the existing `otel-facts.algo.spec.ts`.
- API contract: new row for `session-tags/values` (copy of `F17-attribution-values`, incl. a
  team-scoped caller who must not see another member's pairs); update `F14-contexts*` (scoping +
  visible-users filter), `F17-session-contexts*`, `f18-session-delete-retention.ts` (`session_tags`
  purged on soft delete); add `tag=` / `groupBy=tag:` / Spend `tagKey` variants to existing rows of
  one session-list, one analytics, one report and the spend routes; world-v1 fixture seeds
  `session_tags` instead of `contexts`.
- Scenario: `s-otel-01` / `s-otel-02` — OTEL lines with `feature` / `team.name` via
  `OtelCallSpec.resourceAttributes` produce tags from chunk and realtime, `resetOtelProjection`
  proves the backfill (AC-2..4, AC-9), 12 `build.sha` values yield `tagNoise` and `noisyKeys`
  (AC-9a); `s-ingest-02` — the old-hook `context` step stays and asserts
  no error and no projected pair (AC-11); `s-slife-07` — tags gone after delete; `s-team-02` /
  `s-acc-01` — `.../contexts` and discovery hide pairs of non-visible sessions (AC-8, AC-10a);
  `s-budg-01` — Spend tag slice sums + "(untagged)" (AC-7); `s-anlt-01` / `s-rept-01` — `tag=`
  filter and `groupBy=tag:` with fan-out caveat (AC-6, AC-7a); a UI step in an existing session-list
  scenario for header tags, filter and "By tag" grouping (AC-5, AC-6).
- Migration: `migrations-data-integrity` / `post-impl-check-migrations` — clean DB + a DB with
  seeded contexts (AC-10).

## Visual/UX notes

- Session header: a "TAGS" row under the HeaderStat grid beside Session Attributes, chips
  `key=value`, tooltip with source, long values ellipsised with full value in `title`; no row when
  empty (wireframe `session-header-tags.svg`). Under it, a warning line per noisy key and one for
  the 500 limit, with the "remove it from `OTEL_RESOURCE_ATTRIBUTES`" hint (FR-10); pickers show a
  warning icon + the same hint on noisy keys.
- Session list: "BY TAG" optgroup in the view-mode select (only keys from discovery), group headers
  with count / duration / cost plus "(untagged)"; row chip for the grouped key + "+N"; filter
  popover gets a TAGS section under SESSION ATTRIBUTES with "(any value)" per key
  (wireframe `session-list-tag-filter-group.svg`; its "open question" captions are stale — FR-6
  rules apply).
- Spend: "Tag: <key> ⌄" chip after the existing slice chips, hidden when `tagKeys` is empty; table
  FEATURE / SESSIONS / COST / SHARE with "(untagged)"; fan-out caveat when shares exceed 100 %.
- Analytics / Reports: TAGS optgroup in Group by; tag filter control in the filter bar; existing
  `GroupByFanOutCaveat` reused.
- All "context" wording in the UI becomes "tags"; tag text is rendered as text (no HTML).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema, migration, context removal | 5 | first; drops tables the old code writes |
| 2 | OTEL tag extraction + backfill | 5 | needs chunk 1 table |
| 3 | Tag filter helper, sessions & discovery routes | 6 | needs chunk 1; contracts per Architecture decisions |
| 4 | Analytics / reports tag plumbing | 4 | needs chunk 3 helper |
| 5 | Spend tag slice | 4 | needs chunk 3 helper |
| 6 | Hook and installer | 4 | independent of server chunks |
| 7 | Client: session header, repo header, session list | 5 | needs chunks 3 API |
| 8 | Client: Analytics, Reports, Spend | 4 | needs chunks 4–5 API |
| 9 | Tests | 5 | after all code chunks |
| 10 | Docs | 4 | last |

### Chunk 1 — Schema, migration, context removal
`session_tags` exists, legacy context data lives there, and nothing writes or reads `contexts` / `log_contexts`.
Where: `server/drizzle/migrations`, `server/src/database/schema`, ingest (`logs.service.ts`, `artisyn-extractor.ts`), `sessions.service.ts`, `teams.service.ts`
- [ ] Migration `0098_session_tags.sql` creates `session_tags` and moves/drops data per External surface → DB; journal and migrations lock updated; runs clean on an empty DB and on a DB with seeded contexts
- [ ] Drizzle schema has `session_tags`, no `contexts` / `log_contexts`; `db_state.sql` regenerated (`db-state-update` skill)
- [ ] `extractContextPairs()` and ingest "Step 6" are gone; a `prompt_start` with `context` still ingests without error
- [ ] Soft session delete and team delete remove the session's `session_tags` rows; orphan-context cleanup code is gone
- [ ] Server typecheck, lint and build pass

### Chunk 2 — OTEL tag extraction + backfill
OTEL lines from both channels produce `source='otel'` tags on the root session, including already ingested sessions.
Where: `server/src/logs/otel/` (`otel-records.ts`, `otel-facts-writer.ts`, `otel-facts.constants.ts`)
- [ ] `extractOtelTags` implements FR-2 / FR-3 / NFR limits per Architecture decisions contract
- [ ] `applyOtelLines` upserts the extracted pairs idempotently for the root, enforces the 500-pair cap under the state lock and skips deleted roots
- [ ] `OTEL_PROJECTION_VERSION` is 3 and the startup re-queue re-projects older roots
- [ ] `otel-facts.json` has the `tags` rows from the Test coverage plan and server `npm run test` passes
- [ ] Server typecheck and lint pass

### Chunk 3 — Tag filter helper, sessions & discovery routes
Server can filter by tag, returns tags on session rows and details, and serves discovery and the reworked contexts routes.
Where: new `server/src/logs/tag-filter.sql.ts`, `scoped-sessions.sql.ts`, `repositories.controller.ts` (sessions, branches, session meta, contexts, discovery)
- [ ] `tag-filter.sql.ts` exports the contract in Architecture decisions; `AnalyticsScope.tagFilters` is honoured by `loadScopedRootSessions`
- [ ] Session list rows and session detail carry `tags` (and detail `tagNoise`) per External surface (sub-agents get the root's tags)
- [ ] `sessions` and `sessions/branches` accept `tag=` per External surface
- [ ] `GET :repoId/session-tags/values` works per External surface under the session access rules
- [ ] Both `.../contexts` routes read `session_tags`, keep their shape, and the repo route applies scope and visible-users filtering (AC-10a)
- [ ] `server-endpoint-map.md` lists the new route and the changed contexts access rule; typecheck/lint pass

### Chunk 4 — Analytics / reports tag plumbing
Every route that takes `attr=` / `groupBy=attr:` also takes `tag=` / `groupBy=tag:`.
Where: `repositories.controller.ts` analytics routes, `reports/reports.controller.ts`, `analytics/usage-analytics.controller.ts`, `change-surface-aggregate.service.ts`, `cache-read-ratio.service.ts`, `harness-usage.service.ts`, work-time
- [ ] Every route listed in External surface accepts `tag=` and limits all its numbers to matching sessions
- [ ] Every `groupBy=attr:` route accepts `groupBy=tag:<key>` with values + `__untagged__` groups and fan-out, without definition validation
- [ ] The fan-out flag is set whenever a session lands in more than one tag group
- [ ] Server typecheck, lint, `npm run test` pass; `npm run perf` shows no > 20 % degradation

### Chunk 5 — Spend tag slice
Spend can be sliced by a tag key, for a repo and for a team.
Where: `server/src/logs/budgets/` (spend service, types, query parsing, controllers)
- [ ] `SpendView.tagKeys` and the `tag` slice behave per External surface; the "(untagged)" row plus deduped tagged rows cover the period total when no session has two values
- [ ] `spend/sessions?slice=tag` drill-down returns the sessions behind a row, including `__untagged__`
- [ ] Old requests without `tagKey` return the same payload as before plus `tagKeys`
- [ ] `budgets.md` documents the tag slice; typecheck/lint pass

### Chunk 6 — Hook and installer
The hook and installer no longer know about `context`.
Where: `hook/.claude/telemetry_tool/` (`env-context.js`, `telemetry-hook.js`), `artisyn-hooks-installer/src/install.ts`, `scripts/build-hooks-installer.js`
- [ ] `context` is gone from hook config defaults/types, `getEnvContext()` and `prompt_start`; a config with `context` runs without warning
- [ ] Hook version has a MINOR bump recorded in `hook-api-versioning.md`
- [ ] Installer template has no `context`; `.env` conversion prints the one-line `CTX_*` notice per External surface
- [ ] `hook/` `npm test`, `npm run build:hooks-installer` pass and the dogfooded install under `.artisyn/marketplace/plugins/log-hub-hooks/` is refreshed per `.claude/rules/hook.md`

### Chunk 7 — Client: session header, repo header, session list
Users see tags on a session, scoped chips in the repo header, and can filter / group the session list by tag.
Where: `client/src/viewer` (`api.ts`, models, `useRepositoryData.ts`, `RepositoryHeader.tsx`, `SessionDetailHeader.tsx`, `session-list/*`)
- [ ] Session header shows a TAGS row and the FR-10 noise / limit warnings per Visual/UX notes; nothing when no tags
- [ ] Repository header chips come from the discovery endpoint with the current scope; `fetchRepositoryContexts` is removed
- [ ] Session list has a TAGS filter section and "By tag" grouping per FR-6, mirrored in URL `tag=`; noisy keys carry the warning hint
- [ ] UI wording says "tags", not "context"; tag text is escaped
- [ ] Client lint, typecheck, `bun run test` pass; visual check of the three wireframed states

### Chunk 8 — Client: Analytics, Reports, Spend
Analytics and Reports filter and group by tag; Spend slices by tag.
Where: `client/src/viewer/pages/repository/analytics/*`, `reports/*`, `pages/spend/*`, shared `TagFilterControl`
- [ ] Every Analytics and Reports screen has the tag filter in its filter bar, URL-backed, forwarded as `tag=` on every request
- [ ] Group-by menus show a TAGS section from discovery (noisy keys marked); `groupBy=tag:` renders values + "(untagged)" and the fan-out caveat when flagged
- [ ] Spend shows the "Tag: <key>" chip only when `tagKeys` is non-empty and renders the tag slice with drill-down
- [ ] Client lint, typecheck, `bun run test` pass; visual check of Spend and one Analytics + one Reports screen

### Chunk 9 — Tests
The changed behaviour is covered by the three allowed test kinds.
Where: `server/test/contract/registry/`, world-v1 fixture, `tests/scenarios/`
- [ ] Contract rows per Test coverage plan exist and `npm run test:contract` passes
- [ ] Scenario steps per Test coverage plan exist and the touched scenarios pass in their declared modes
- [ ] The old-hook `context` step proves the line ingests and no pair is projected
- [ ] No unit / e2e / integration test was added
- [ ] Full health check (`finalRun: true`) passes

### Chunk 10 — Docs
KB, user docs and in-app help describe tags, not context.
Where: `docs/knowledgebase/` (`hook-installation.md`, `db-tables.md`, `otel-receiver.md`, `session-metrics-scope.md`, `turn-end-cost-advisor.md` cross-ref, `index.md` if needed), `user-docs/otel-tab.md`
- [ ] `hook-installation.md` drops the `context` / `CTX_*` sections and explains labelling via `OTEL_RESOURCE_ATTRIBUTES`
- [ ] `db-tables.md` ER diagram and delete notes show `session_tags` instead of `contexts` / `log_contexts`
- [ ] `session-metrics-scope.md` documents the TAGS group-by section and fan-out; `otel-receiver.md` notes user resource keys become tags
- [ ] `user-docs/otel-tab.md` has a "Tagging sessions" section and `npm run build:help` regenerates in-app help
