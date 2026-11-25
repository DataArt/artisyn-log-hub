# Implementation plan — 2026-11-24-otel-events-triage

## TL;DR

- **DB:** one new table `otel_session_events` (migration `0097_otel_session_events.sql`, hand-written, additive). It stores only the FR-2 surfaced kinds plus `hook_execution_complete` runs, keyed `(session_id, event_key)`, with the usual `seq` / `change_kind` / `source_mask` / `first_seq`. No column change on existing tables.
- **Server extraction/writing:** a new pure `extractOtelEvents(lines)` in `otel-records.ts` keeps a per-kind whitelist of attributes, so prompt text, `tool_parameters` and user ids are never stored. A new `upsertOtelEvents` step runs in `applyOtelLines`. `OTEL_PROJECTION_VERSION` goes 2 → 3, which re-projects every stored chunk and fills events for old sessions.
- **API:** `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel` gets two optional fields:
  - `events?: OtelEventRow[]`, filtered by seq in deltas;
  - `hookStats?: OtelHookStats | null`, a `GROUP BY hook_name` computed at read time.

  Event `details` are `null` for masked callers (DD-22). No new route.
- **Client:**
  - markers on `OtelCostChart`, with an Events On/Off toggle kept in local state;
  - a new collapsible `SessionOtelEvents` card, collapsed by default, with a summary of counts per kind in its header;
  - a new `SessionOtelHookOverhead` card;
  - `mergeOtelDelta` learns `events` and `hookStats`.
- **Purge:** `otel_session_events` is deleted explicitly:
  - in `purgeSessionChildData`;
  - in the deleted-root cleanup in `otel-projection.service.ts`.

  The purge table lists in `f18-session-delete-retention.ts`, `s-slife-07` and `s-slife-08` gain the table. New attribute readers `boolAttrOf` / `countAttrOf` go in `otel-chunk.ts`.
- **Hook:** no change. The receiver already forwards every `logs` line.
- **Tests:**
  - algorithm rows in `otel-facts.json` (new kind `events`) and `otel-delta-merge.json`;
  - contract cases in `f25-otel.ts` with fixture rows in `world-v1.sql.ts`;
  - steps in `s-otel-01` and `s-otel-02`;
  - `s-compat-01` must keep passing.
- **KB:**
  - FR-3 `gen_ai.usage.input_tokens` rule in `otel-tabs.md` and `llm-call-math.md`;
  - compatibility-matrix rows, a new "Session events" section and the `db-tables.md` entry;
  - user help in `user-docs/otel-tab.md`.

## Reference

- Requirements: [requirements.md](requirements.md) (FR-3 … FR-5 open; FR-1/FR-2 done)
- Inventory: [otel-inventory.md](otel-inventory.md); capture PoC `docs/pocs/2026-11-24-1526-otel-events-capture/`
- Wireframe: [wireframes/session-otel-events.svg](wireframes/session-otel-events.svg). It was updated in this planning session: chip counts, collapsed card state, local toggle, hidden hook card.
- Planning analysis: [research/design-analysis.md](research/design-analysis.md); research trail: `research/findings-1.md`

## Design Decisions

1. **Storage.**
   - **What exists:** one typed table, `otel_session_events`, closed to the kinds in DD-3. The owner chose typed tables over synthetic `otel_spans` rows on 2026-11-24.
   - **Why the hook aggregate has no table of its own:** `hook_execution_complete` arrives through both channels and again on re-projection. A stored additive sum would double count, so hook runs are stored as rows and deduplicated like the other events.
2. **Event key.**
   - `event_key = otelCallKey(null, record)`, i.e. `rec:` + sha1 of the canonical `{timeUnixNano, attributes}` (`server/src/logs/otel/otel-records.ts:133`). A realtime line and the same chunk line give the same key.
   - Repeats within one batch keep their last occurrence, as in `extractOtelCalls` (`otel-records.ts:187`).
3. **Event name and stored kinds.**
   - **Name:** the `event.name` attribute, else `record.body.stringValue` without its `claude_code.` prefix. Only `signal === 'logs'` lines count.
   - **Stored kinds (`OTEL_EVENT_KINDS`):** `compaction`, `api_error`, `api_retries_exhausted`, `skill_activated`, `subagent_completed`, `permission_mode_changed`, `tool_decision`, `user_prompt_mid_turn`, `hook_execution_complete`.
   - **`user_prompt`:** stored as `user_prompt_mid_turn` only when `delivery.mode === 'mid_turn'`. Every other `user_prompt` is skipped.
   - **Everything else:** any other name is skipped.
4. **Event time and agent.**
   - `event_time` comes from `resolveOtelEventTime` (`otel-records.ts:99`). A record with no resolvable time is skipped.
   - `agent_id` is the `agent_id` attribute (≤255) or null. Null means the main thread.
5. **Details whitelist.** `details` is a flat jsonb object with camelCase keys. Only the keys below are kept; a missing or unparsable value leaves its key out.

   | kind | keys |
   |---|---|
   | compaction | `trigger`, `preTokens`#, `postTokens`#, `durationMs`#, `success`? |
   | api_error | `error`*, `attempt`#, `durationMs`#, `statusCode`#, `model` |
   | api_retries_exhausted | `error`*, `totalAttempts`#, `totalRetryDurationMs`#, `model` |
   | skill_activated | `skillName` (`skill.name`), `skillSource` (`skill.source`), `invocationTrigger` |
   | subagent_completed | `agentType`, `model`, `finalModel`, `modelSwapped`?, `isAsync`?, `durationMs`#, `totalTokens`#, `totalToolUses`# |
   | permission_mode_changed | `fromMode`, `toMode` |
   | tool_decision | `toolName`, `decision`, `source`, `permissionMode`, `classifierVerdict`, `classifierCategory` |
   | user_prompt_mid_turn | *(none: `{}`)* |
   | hook_execution_complete | `hookEvent`, `hookName`, `numHooks`#, `numSuccess`#, `numBlocking`#, `numCancelled`#, `numNonBlockingError`#, `totalDurationMs`#, `stdoutChars`# |

   How each key is read:
   - **Plain keys** map from the snake_case attribute of the same name (e.g. `invocationTrigger` ← `invocation_trigger`).
   - **`#` keys** are non-negative integers parsed from a number *or* a numeric string; Claude Code sends `"5794"` for `compaction.pre_tokens` and for the hook `num_*` attributes.
   - **`?` keys** are booleans parsed from `boolValue` or from the strings `"true"` / `"false"`.
   - **Plain strings** are capped at 255 characters.
   - **`*` keys** (free text) are capped at 200 characters.
6. **Masking (DD-22).** When `masksOtelAttributes` is true:
   - every `events[].details` is `null`; `kind`, `eventTime` and `agentId` stay;
   - `hookStats` is not masked, because hook names are `event:tool` labels with no user content.
7. **Hook overhead (`hookStats`)** is computed at read time from one root's `hook_execution_complete` rows. `hookName` is the event's `hook_name`, falling back to `hook_event`, then `'(unknown)'`. Per `hookName`:

   | field | value |
   |---|---|
   | `runs` | number of rows |
   | `hooks` | Σ `numHooks` |
   | `totalDurationMs` | Σ `totalDurationMs` |
   | `stdoutChars` | Σ `stdoutChars` |
   | `errors` | Σ `numNonBlockingError` |

   - Rows are ordered by `totalDurationMs` descending, then by `hookName`.
   - No allowlist of hook events (requirements FR-2, note of 2026-11-25): any `hook_event` is grouped, so a `PreSkillShellCommand` run (Claude Code 2.1.332+) shows up as its own row. The scenario fixture for the Hook overhead card includes one `hook_execution_complete` with `hook_event = PreSkillShellCommand`, `hook_name = PreSkillShellCommand:Bash`.
   - `totalDurationMs` (top level) = Σ of the rows.
   - `wallMs` = max − min of `event_time` over the root's `otel_calls` rows and its `otel_session_events` rows of every kind, hook runs included. `otel_spans` times are not used. It is null when below 1000 ms.
   - The client derives hooks/run = `hooks / runs`, avg = `totalDurationMs / runs`, share = row / total, and the header % = total / `wallMs`.
8. **Snapshot and delta contract.**

   | response | `events` | `hookStats` |
   |---|---|---|
   | Snapshot | every non-hook event, ordered by `event_time, event_key` | the object, or `null` when there are no hook rows |
   | Delta (non-empty) | rows with `seq > since`, with their stored `change_kind` | always recomputed (object or `null`), so `wallMs` follows new calls |
   | Empty-delta fast path | `[]` | omitted |
   | `emptySession` | `[]` | `null` |

   Events are never deleted outside purge, so a delta never needs a removal.
9. **Write path.**
   - `upsertOtelEvents(tx, rootId, events, source, seq)` follows `upsertOtelSpans` (`otel-facts-writer.ts:1209`):
     - it reads `rt_last_at IS NOT NULL` like `:1220` and inserts with `insertKind(source, hasRealtime)` (`:531`), setting `first_seq = seq = <seq>`;
     - on `ON CONFLICT ON CONSTRAINT otel_session_events_pk` it keeps `first_seq`, ORs `source_mask` and sets `seq`;
     - `change_kind` = `update` when `ROW(kind, event_time, agent_id, details)` differs, `confirm` when only `source_mask` grew, and the row is skipped otherwise.
   - Its `changed` count feeds the `changed` flag of `applyOtelLines`.
   - It does not touch `has_spans` or the buckets.
10. **Backfill.** `OTEL_PROJECTION_VERSION` 2 → 3 (`otel-facts.constants.ts:35`). The startup re-mark (`database-init.ts:176`) re-queues every chunk; the drain re-applies the lines, which inserts events for pre-change sessions. Existing calls and spans only `confirm` or no-op.
11. **Purge.** `otel_session_events` cascades on a session hard delete. It is also deleted explicitly next to `otel_spans`:
    - in `purgeSessionChildData` (`server/src/sessions/sessions.service.ts:296`);
    - in the deleted-root cleanup (`server/src/logs/otel/otel-projection.service.ts:528`).
12. **Client event groups.** Used for chips, the summary and markers.

    | Group | Kinds | Marker |
    |---|---|---|
    | Compaction | `compaction` | C, `#0891b2` |
    | API failures | `api_error`, `api_retries_exhausted` | !, `#dc2626` |
    | Skills | `skill_activated` | S, `#16a34a` |
    | Sub-agents | `subagent_completed` | A, `#7c3aed` |
    | Permissions | `tool_decision`, `permission_mode_changed` | none; list dot `#6b7280` |
    | Mid-turn prompts | `user_prompt_mid_turn` | none; list dot `#f59e0b` |

13. **Markers.**
    - Snapping happens inside `OtelCostChart`, because only the chart knows its rows (`buildOtelChartRows`, `OtelCostChart.tsx:98`, starts in `toISOString()` form).
    - The chart takes `markerEvents?: OtelChartMarkerEvent[]` (`{ eventKey, eventTime, group, color, label, title }`, defined in `otel-chart-data.ts`) and `onMarkerClick?(eventKey)`.
    - It calls `snapChartMarkers(markerEvents, rowStarts)`, also in `otel-chart-data.ts`, which returns `{ start, group, color, label, events[] }`.
    - Each marker group draws one Recharts `ReferenceLine` (dashed) on the bucket row whose `start` is the latest start ≤ `eventTime`. Events before the first row are dropped; events after the last row snap to the last row.
    - Several events of one group in one bucket draw a single marker that shows a count.
    - Hover shows the events of that bucket and group.
    - A click calls `onMarkerClick(events[0].eventKey)` with the earliest event of that marker. The tab then expands the Session events card and sets its `focusKey`; the card resets its chip to All, reveals every row and scrolls to and flashes that row.
    - `markerEventsOf(events)` in `otel-events.ts` builds `markerEvents` from the marker groups only: `color` and `label` (C / ! / S / A) come from `OTEL_EVENT_GROUPS`, and `title` = `eventTitle(e)`. The chart shows the count as `events.length`.
14. **UI state.** All of it is local React state in `SessionOtelTab`, matching the comment at `SessionOtelTab.tsx:14`:
    - the Events toggle, default On;
    - the card's collapsed state, default collapsed;
    - the selected chip, default All;
    - "Show N more".

    No URL parameters.
    - Client constants live in `otel-events.ts`:
      - `OTEL_EVENTS_PAGE_SIZE = 7` (rows before "Show N more");
      - `OTEL_AGENT_ID_PREFIX = 6` (the AGENT column shows `main` or the first 6 characters of the id);
      - the colours inside `OTEL_EVENT_GROUPS`.
    - The server constant `OTEL_HOOK_WALL_MIN_MS = 1000` lives in `otel-facts.constants.ts`.
15. **Visibility (FR-5).**
    - No non-hook events: no toggle, no markers, no Session events card.
    - `hookStats` null or absent: no Hook overhead card.
    - An older server (fields absent) shows the tab exactly as today.
16. **Compaction vs `session_cause_stats`.** The OTEL tab never shows `CacheRatioCauses.compaction`, so no UI cross-reference is added. The KB states the relation.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0097_otel_session_events.sql` | create table + indexes + comments | hand-written, `IF NOT EXISTS`, header like `0089` |
| `server/drizzle/migrations/meta/_journal.json`, `migrations.lock.json` | register / lock migration | `npm run migrations:lock` from `server/` |
| `server/src/database/schema/index.ts` | `otelSessionEvents` Drizzle table | after `otelAgentTotals` |
| `docs/knowledgebase/db_state.sql` | regenerated | `db-state-update` skill |
| `server/src/logs/otel/otel-records.ts` | `extractOtelEvents`, `ExtractedOtelEvent` | pure |
| `server/src/logs/otel-chunk.ts` | `boolAttrOf`, `countAttrOf` helpers | tolerant readers; `countAttrOf` rejects negatives and non-integers, unlike `nullableTokenCountOf` |
| `server/test/contract/registry/f18-session-delete-retention.ts` | purge table list | add `otel_session_events` to `OTEL_TABLES` |
| `tests/scenarios/sessions/s-slife-07.spec.ts`, `s-slife-08.spec.ts` | purge table lists | `SURVIVOR_TABLES` / `OTEL_TABLES` and the `otelRowCounts` expectation |
| `server/src/logs/otel/otel-facts.constants.ts` | `OTEL_EVENT_KINDS`, version 3, caps | |
| `server/src/logs/otel/otel-facts-writer.ts` | `upsertOtelEvents`, wired into `applyOtelLines` | |
| `server/src/logs/otel/otel-projection.service.ts` | cleanup deletes events | |
| `server/src/sessions/sessions.service.ts` | purge deletes events | |
| `server/src/logs/otel/otel-facts.types.ts` | `OtelEventRow`, `OtelHookStats`, response fields | |
| `server/src/logs/otel/otel-facts-read.sql.ts` | `loadSessionEvents`, `loadSessionHookStats` | |
| `server/src/logs/otel/otel-facts.reader.ts` | response assembly, fast path, empty session | |
| `client/src/models/repositories.ts` | mirror types | next to `SessionOtelResponse` (`:1273`) |
| `client/src/viewer/pages/repository/otel/otel-merge.ts` | merge `events` / `hookStats`, `newKeys.events` | |
| `client/src/viewer/pages/repository/session-log/otel/otel-events.ts` | pure helpers: groups, constants, summary, details text, `markerEventsOf`, hook rows | new |
| `client/src/viewer/pages/repository/session-log/otel/SessionOtelEvents.tsx` | collapsible Session events card | new |
| `client/src/viewer/pages/repository/session-log/otel/SessionOtelHookOverhead.tsx` | Hook overhead card | new |
| `client/src/viewer/pages/repository/otel/OtelCostChart.tsx` | optional `markers` prop + legend group | |
| `client/src/viewer/pages/repository/session-log/otel/SessionOtelTab.tsx` | toggle, cards, wiring | |
| `docs/knowledgebase/algorithms/otel-facts.md` + `docs/algorithm-examples/otel-facts.json` | event extraction rule + rows `OF-66…` | |
| `server/src/logs/otel/otel-facts.algo.spec.ts` | `events` kind case | |
| `docs/knowledgebase/algorithms/otel-delta-merge.md` + `docs/algorithm-examples/otel-delta-merge.json` | events merge rows `DM-16…` | |
| `client/src/viewer/pages/repository/otel/otel-merge.algo.test.ts` | compact format gains events / hookStats | |
| `server/test/contract/fixtures/world-v1.sql.ts` | `otel_session_events` rows for s01 | |
| `server/test/contract/registry/f25-otel.ts` | events / hookStats / masked cases | |
| `tests/scenarios/fixtures/otel/otel-lines.ts` | `otelEventLine` builder | |
| `tests/scenarios/helpers/otel.ts` | `resetOtelProjection` / `otelRowCounts` table lists gain `otel_session_events` | `:148`, `:160` |
| `client/src/viewer/pages/repository/otel/otel-chart-data.ts` | `OtelChartMarkerEvent`, `snapChartMarkers` | pure |
| `tests/scenarios/view/s-otel-01.spec.ts`, `s-otel-02.spec.ts` | scenario steps | |
| `docs/knowledgebase/otel-tabs.md`, `db-tables.md`, `llm-call-math.md` | KB | FR-3, FR-5 matrix |
| `user-docs/otel-tab.md` | in-app help | §Session OTEL tab |

## API changes

`GET /api/v1/repositories/:repoId/sessions/:sessionId/otel` takes the same parameters as today. Two optional response fields are added (in `server/src/logs/otel/otel-facts.types.ts`, mirrored in `client/src/models/repositories.ts`):

```ts
export type OtelEventKind =
  | 'compaction' | 'api_error' | 'api_retries_exhausted' | 'skill_activated'
  | 'subagent_completed' | 'permission_mode_changed' | 'tool_decision'
  | 'user_prompt_mid_turn';

/** One surfaced OTEL log event (hook runs are not listed; see hookStats). */
export interface OtelEventRow {
  eventKey: string;
  kind: OtelEventKind;
  eventTime: string;            // ISO
  agentId: string | null;       // null = main thread
  confirmed: boolean;           // (source_mask & OTEL_SOURCE_CHUNK_BIT) !== 0
  /** Whitelisted attributes per Design Decision 5; null when masked (DD-22). */
  details: Record<string, string | number | boolean> | null;
  changeKind: OtelChangeKind;
}

export interface OtelHookStatRow {
  hookName: string;
  runs: number;
  hooks: number;
  totalDurationMs: number;
  stdoutChars: number;
  errors: number;
}

export interface OtelHookStats {
  rows: OtelHookStatRow[];
  totalDurationMs: number;
  wallMs: number | null;
}

// SessionOtelResponse additions (absent from older servers):
events?: OtelEventRow[];
hookStats?: OtelHookStats | null;
```

Snapshot/delta semantics follow Design Decision 8. Old clients ignore both fields.

## Database changes

New table `otel_session_events` (migration `0097_otel_session_events.sql`):

| column | type | constraint |
|---|---|---|
| `session_id` | integer | NOT NULL, FK `sessions(id)` ON DELETE CASCADE (root session) |
| `event_key` | varchar(300) | NOT NULL |
| `kind` | varchar(32) | NOT NULL |
| `event_time` | timestamptz | NOT NULL |
| `agent_id` | varchar(255) | NULL |
| `details` | jsonb | NOT NULL DEFAULT `'{}'` |
| `source_mask` | smallint | NOT NULL |
| `first_seq` | bigint | NOT NULL |
| `seq` | bigint | NOT NULL |
| `change_kind` | varchar(8) | NOT NULL |

- PK `otel_session_events_pk (session_id, event_key)`.
- Indexes:
  - `idx_otel_session_events_session_seq (session_id, seq)`;
  - `idx_otel_session_events_session_kind (session_id, kind)`;
  - `idx_otel_session_events_session_event_time (session_id, event_time)`.
- `COMMENT ON` the table and every column.
- Migration header: purpose, additive only (older servers never read it), implicit backfill through the projection version bump, lock profile (new table, no rewrite).
- Steps:
  1. Write the SQL.
  2. Add the `_journal.json` entry.
  3. `npm run migrations:lock` (from `server/`).
  4. `npm run migrate` on the dev DB.
  5. Run the `db-state-update` skill.

## Test coverage plan

The CLAUDE.md test policy allows three kinds only:

- **Algorithm:**
  - `docs/knowledgebase/algorithms/otel-facts.md` gets an "Event extraction" section, and `otel-facts.json` gets rows `OF-66…` of the new `events` kind, run by `otel-facts.algo.spec.ts`. The rows cover:
    - each stored kind;
    - numeric strings coerced;
    - `tool_parameters` / `prompt` dropped;
    - a non-mid-turn `user_prompt` skipped;
    - an unknown event skipped;
    - a duplicate record collapsing to one row;
    - a missing time skipped;
    - name taken from the body when `event.name` is absent;
    - `error` capped.
  - `otel-delta-merge.md` / `.json` gets rows `DM-16…` for:
    - events merged by key with highlight;
    - `hookStats` absent → kept;
    - a full snapshot replaces both;
    - an older server (both fields absent) keeps `[]` / `null`.
- **API contract:** `server/test/contract/registry/f25-otel.ts` gets new `SESSION_OTEL` cases backed by `otel_session_events` rows for s01 in `world-v1.sql.ts`:
  - `F25-session-events`: snapshot `events` against an oracle SQL;
  - `F25-session-hook-stats`: `hookStats.rows`;
  - `F25-session-events-masked`: team-no-prompts, `details` null;
  - `F25-session-events-delta`: the delta rule of Design Decision 8;
  - existing empty-delta case: `events: []`;
  - the purge list `OTEL_TABLES` in `f18-session-delete-retention.ts` gains the table.

  The purge lists in scenarios `s-slife-07` / `s-slife-08` gain it as well.
- **Scenario:**
  - In `tests/scenarios/view/s-otel-01.spec.ts`, S1's chunk gains one event line per kind plus three hook runs, with steps for:
    - API values;
    - UI markers / toggle / collapsed summary / chips / hook card;
    - a live realtime event highlighted and then confirmed by the chunk without duplicates;
    - the existing AC-12/13 upgrade step re-projecting events;
    - FR-5: the no-OTEL-events session shows no toggle or cards.
  - `s-otel-02` masked step: `details` null and "hidden for your role".
  - `tests/scenarios/hook/s-compat-01.spec.ts` stays unchanged and must pass.

## Visual/UX notes

- **Placement.** The cards go between the KPI tiles / `OtelStructureSection` and Traces: Session events first, then Hook overhead. Both use the existing white bordered section style (`OtelStructureSection`) with a "NEW" badge.
- **Events toggle.** An `OtelSegmented` "Events On | Off" control (`OtelChartControls.tsx:24`), rendered next to the chart controls only when the session has non-hook events. Off hides the markers and the legend's "Events:" group.
- **Session events card, collapsed (default).** The header row shows `▾ SESSION EVENTS NEW`, then the summary:
  - `"<N> events · Compaction 2 · API failures 2 · Skills 3 · Sub-agents 4 · Permissions 12 · Mid-turn prompts 1"`;
  - groups with 0 are omitted, and "API failures" is red (`#b91c1c`, semibold) when > 0;
  - the whole header is a button (`aria-expanded`), and counts update live.
- **Session events card, expanded.**
  - The subtitle reads "Claude Code OTEL log events of this session tree · X of Y shown · newest last".
  - Chips: All + each non-empty group, one at a time.
  - Columns: TIME (local `HH:mm:ss`) / EVENT (marker diamond or dot + title) / AGENT (`main`, or the first 6 chars of `agentId`) / DETAILS.
  - Rows are oldest first. The first 7 rows are shown, then "Show N more ▾" reveals the rest.
  - API-failure rows have a `#fef2f2` background. New rows from a delta get the usual highlight.
- **Row titles and details** (masked → details "hidden for your role"; a title that needs details falls back to the kind label):

  | kind | title | details |
  |---|---|---|
  | compaction | `Compaction · <trigger>` | `182 K → 41 K tokens · 5.8 s` |
  | api_error | `API error` | `<error> · attempt <n> · <model>` |
  | api_retries_exhausted | `API retries exhausted` | `<error> · <totalAttempts> attempts · 1.7 s retrying` |
  | skill_activated | `Skill activated` | `<skillName> · <skillSource> · <invocationTrigger>` |
  | subagent_completed | `Sub-agent completed` | `<agentType> · 1m 56s · 21 K tokens · 7 tool uses` (+ ` · model swapped → <finalModel>` when `modelSwapped`) |
  | permission_mode_changed | `Permission mode changed` | `<fromMode> → <toMode>` |
  | tool_decision | `Tool decision · accepted/rejected` (`accept`/`reject`, other raw) | `<toolName> · by <source> · mode <permissionMode>` (+ ` · classifier <classifierVerdict>[/<classifierCategory>]`) |
  | user_prompt_mid_turn | `Prompt sent mid-turn` | `sent while the turn was running · prompt text not shown` |

- **Hook overhead card.**
  - The header subtitle reads "hook_execution_complete events, grouped by hook event + tool · `<total>` of hook time = `<pct>` % of session wall time". The `%` part is omitted when `wallMs` is null.
  - Columns: HOOK EVENT : TOOL / RUNS / HOOKS/RUN / TOTAL / AVG / STDOUT / ERRORS (red when > 0) / SHARE (88 px track, bar width = share, Cost blue `#3b82f6`).
  - The card is not collapsible and is hidden when `hookStats` is null.
- **Formatting.** Tokens are shown as `K` with no decimals over 1000; durations as `ms` under 1 s, `x.x s` under 60 s, `Xm Ys` above. The helpers live in `otel-events.ts`; reuse `otel-format.ts` where it already has one.
- **Colours.** Light-only palette (`ui-principles.md`). No new lazy chunk; the components live inside the existing `SessionOtelTab` chunk.

## Wireframes

`wireframes/session-otel-events.svg` was updated in this planning session:

- collapsed-state variant with the counts summary, plus the collapse chevron on the expanded card;
- chip counts fixed to All 24 / 7 of 24 / Show 17 more;
- notes changed: toggle in local state, Hook overhead card hidden without hook events, marker click expands the card.

No further wireframe change is needed.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema and migration | 5 | first; table per Database changes |
| 2 | Event extraction (pure) | 5 | needs nothing from chunk 1; algorithm rows live here |
| 3 | Write path, purge, backfill | 5 | needs chunks 1–2 |
| 4 | Read path and route fields | 6 | needs chunk 3; API per API changes |
| 5 | Client data layer | 6 | needs chunk 4 contract (types only) |
| 6 | Client UI | 7 | needs chunk 5 |
| 7 | Knowledgebase and user help | 5 | after behaviour is final |
| 8 | Contract tests and scenario fixtures | 5 | needs chunks 1–4 |
| 9 | Scenario steps | 5 | last; needs chunks 6 and 8 |

The algorithm rows stay in chunks 2 and 5 on purpose: each set of rows tests the pure function written in the same chunk. The KB chunk (7) describes the planned test cases by name before chunks 8 and 9 write them.

### Chunk 1 — Schema and migration
- [ ] Add `otelSessionEvents` Drizzle table to `server/src/database/schema/index.ts` after `otelAgentTotals`: columns, PK and three indexes exactly per Database changes; comment block like `otelSpans`.
- [ ] Write `server/drizzle/migrations/0097_otel_session_events.sql`: guarded `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, `COMMENT ON` table and every column, header per Database changes (follow `0089` header style).
- [ ] Add the `0097` entry to `server/drizzle/migrations/meta/_journal.json` and run `npm run migrations:lock` from `server/`.
- [ ] Apply on the dev DB with `npm run migrate` (from `server/`), then run the `db-state-update` skill to regenerate `docs/knowledgebase/db_state.sql`.
- [ ] Add `otel_session_events` to `docs/knowledgebase/db-tables.md` §"OTEL tab tables": purpose, key, kinds per Design Decision 3, seq/change_kind, cascade + explicit purge per Design Decision 11.

### Chunk 2 — Event extraction (pure)
- [ ] In `server/src/logs/otel/otel-facts.constants.ts` add `OTEL_EVENT_KINDS` (Design Decision 3 list), `OTEL_EVENT_TEXT_MAX = 255`, `OTEL_EVENT_ERROR_MAX = 200`; do not bump the version here.
- [ ] In `server/src/logs/otel-chunk.ts` add `boolAttrOf(attrs, key): boolean | null` (boolValue, or `"true"`/`"false"` string) and `countAttrOf(attrs, key): number | null` (non-negative integer from number or numeric string).
- [ ] In `server/src/logs/otel/otel-records.ts` export `ExtractedOtelEvent { eventKey: string; kind: string; eventTime: Date; agentId: string | null; details: Record<string, string | number | boolean> }` (camelCase keys) and `extractOtelEvents(lines)` implementing Design Decisions 2–5 (name rule, mid-turn filter, whitelist, caps, dedup keep-last, skip missing time).
- [ ] Add section "Event extraction" to `docs/knowledgebase/algorithms/otel-facts.md` (rules per Design Decisions 2–5) and rows `OF-66…` with `input: {kind: "events", lines}` to `docs/algorithm-examples/otel-facts.json`, covering the cases listed in Test coverage plan → Algorithm.
- [ ] Add `{ kind: 'events'; lines: unknown[] }` to `FactsInput` in `server/src/logs/otel/otel-facts.algo.spec.ts` and a `case` whose actual value is `{ rows, distinctKeys }`. `rows` is the `extractOtelEvents` output without `eventKey`, with `eventTime` as ISO; `distinctKeys` is the number of distinct keys. Run `npm run test` from `server/`.

### Chunk 3 — Write path, purge, backfill
- [ ] In `server/src/logs/otel/otel-facts-writer.ts` add `upsertOtelEvents(tx, rootId, events, source, seq): Promise<{ changed: number }>` per Design Decision 9 (jsonb_to_recordset insert, `insertKind`, ON CONFLICT `otel_session_events_pk`, update/confirm rule, `source_mask` OR).
- [ ] Wire it into `applyOtelLines` (`otel-facts-writer.ts:1445`): `extractOtelEvents(lineList)` after spans, add its `changed` to the `changed` expression; return value unchanged otherwise.
- [ ] Delete `otel_session_events` rows next to `otel_spans` in the deleted-root cleanup of `server/src/logs/otel/otel-projection.service.ts:528`.
- [ ] Delete `otelSessionEvents` rows next to `otelSpans` in `purgeSessionChildData` of `server/src/sessions/sessions.service.ts:296`.
- [ ] Bump `OTEL_PROJECTION_VERSION` from 2 to 3 in `otel-facts.constants.ts:35`, updating its comment to name this task's event backfill.

### Chunk 4 — Read path and route fields
- [ ] Add `OtelEventKind`, `OtelEventRow`, `OtelHookStatRow`, `OtelHookStats` and the optional `events?` / `hookStats?` fields of `SessionOtelResponse` to `server/src/logs/otel/otel-facts.types.ts` exactly per API changes.
- [ ] In `server/src/logs/otel/otel-facts-read.sql.ts` add `loadSessionEvents(db, rootId, since, withDetails)` modelled on `loadSessionSpans` (`:1271`): non-hook kinds, `seq > since` in deltas, `NULL::jsonb` details when masked, ordered `event_time, event_key`.
- [ ] In the same file add `loadSessionHookStats(db, rootId): Promise<OtelHookStats | null>` per Design Decision 7: `null` when there are no hook rows; otherwise a `GROUP BY` over the jsonb `details` (e.g. `(details->>'numHooks')::bigint`), plus `wallMs` (null when under `OTEL_HOOK_WALL_MIN_MS`, a new constant in `otel-facts.constants.ts`).
- [ ] In `getSessionOtel` (`server/src/logs/otel/otel-facts.reader.ts:825`) load both in the `Promise.all`, map rows to `OtelEventRow` (`confirmed` from `OTEL_SOURCE_CHUNK_BIT`), and add `events` and `hookStats` to the response.
- [ ] Set `events: []` (no `hookStats`) in the empty-delta fast path (`otel-facts.reader.ts:873`) and `events: [], hookStats: null` in `emptySession` (`:978`).
- [ ] Run `npm run typecheck` and `npm run lint` from `server/`.

### Chunk 5 — Client data layer
- [ ] Mirror `OtelEventKind`, `OtelEventRow`, `OtelHookStatRow`, `OtelHookStats` and the optional `events?` / `hookStats?` fields into `client/src/models/repositories.ts` next to `SessionOtelResponse`, per API changes.
- [ ] In `client/src/viewer/pages/repository/otel/otel-merge.ts`: add `events: ReadonlySet<string>` to `OtelNewKeys` / `EMPTY_OTEL_NEW_KEYS` / `diffOtelBuckets`; in `mergeOtelDelta` merge `events` by `eventKey` (`classifyRows` + `mergeRows`, absent → `[]`), `hookStats` per Design Decision 8 (undefined keeps previous, full without it → null).
- [ ] Add rows `DM-16…` to `docs/algorithm-examples/otel-delta-merge.json` and their rule text to `docs/knowledgebase/algorithms/otel-delta-merge.md`, covering the cases in Test coverage plan → Algorithm.
- [ ] Extend the compact state/delta format and assertions of `client/src/viewer/pages/repository/otel/otel-merge.algo.test.ts` for `events` (key, kind) and `hookStats` (total or null/absent); run `bun run test` from `client/`.
- [ ] Create `client/src/viewer/pages/repository/session-log/otel/otel-events.ts` with pure helpers: `OTEL_EVENT_GROUPS` (Design Decision 12), `eventGroupOf`, `eventSummary(events)` (counts per non-empty group), `eventTitle` / `eventDetailsText` (Visual/UX table), `formatEventDuration`, `formatEventTokens`.
- [ ] In the same file add `markerEventsOf(events)` and `hookRowsView(stats)`. `hookRowsView` derives hooks/run, avg, share and the header pct per Design Decision 7. In `client/src/viewer/pages/repository/otel/otel-chart-data.ts` add `OtelChartMarkerEvent` and `snapChartMarkers(markerEvents, rowStarts)`; both follow Design Decision 13.

### Chunk 6 — Client UI
- [ ] Add optional `markerEvents` and `onMarkerClick(eventKey)` props to `client/src/viewer/pages/repository/otel/OtelCostChart.tsx`, per Design Decision 13. Snap them with `snapChartMarkers` against the chart's own row starts. Draw dashed `ReferenceLine`s with diamond labels and counts, a hover title, and an "Events:" legend group (see `BudgetBurnView.tsx:274`).
- [ ] Create `client/src/viewer/pages/repository/session-log/otel/SessionOtelEvents.tsx`: collapsible card (default collapsed, header button with `aria-expanded`, summary per Visual/UX notes), chips, table, "Show N more" (`OTEL_EVENTS_PAGE_SIZE`), "hidden for your role" when the `attributesMasked` prop is true, highlight via the `newEventKeys` prop, `data-testid="session-otel-events"`.
- [ ] Give `SessionOtelEvents` controlled props `expanded` / `onExpandedChange` and `focusKey`. A new `focusKey` resets the chip to All, shows every row, then scrolls to that row and flashes it; give rows `data-testid="session-otel-event-row"` and `data-kind`.
- [ ] Create `client/src/viewer/pages/repository/session-log/otel/SessionOtelHookOverhead.tsx`: table per Visual/UX notes using `hookRowsView`, share bars, `data-testid="session-otel-hook-overhead"`; render nothing for null stats.
- [ ] In `SessionOtelTab.tsx` add local state (events on, card expanded, focus key) per Design Decision 14; render an `OtelSegmented` Events On/Off next to `OtelChartControls` only when non-hook events exist.
- [ ] In `SessionOtelTab.tsx`, when events are on, pass `markerEventsOf(state.events ?? [])` to `OtelCostChart`. On marker click, expand the card and set `focusKey`. Pass `attributesMasked={status.attributesMasked}` and `newEventKeys={live.newKeys.events}`. Render both cards between `OtelStructureSection` and traces per Design Decision 15.
- [ ] Run `bun run typecheck` and `bun run lint` from `client/`; do a visual check of the tab against `wireframes/session-otel-events.svg` (collapsed and expanded) following the `use-playwright` skill.

### Chunk 7 — Knowledgebase and user help
- [ ] `docs/knowledgebase/otel-tabs.md`: add a "Session events and hook overhead" section (table, extraction, key, masking, delta contract, read-time aggregate, Design Decisions 1–16 in short); add `otel_session_events` to the tables and server-files lists; update the Live-view "Scope cuts" note (line ~548).
- [ ] `docs/knowledgebase/otel-tabs.md`: in span attributes state the FR-3 rule — `gen_ai.usage.input_tokens` = native input + cache read + cache write, never add it to `cache_read_tokens` / `cache_creation_tokens`; Log Hub reads only native token attributes.
- [ ] `docs/knowledgebase/otel-tabs.md` Compatibility matrix (line ~568): one row per surfaced item (8 event kinds + hook runs) with "Claude Code without it → no row / card hidden"; one row "server before this task → fields absent, client unchanged"; projection v3 note.
- [ ] `docs/knowledgebase/llm-call-math.md` §"Two cost sources: computed vs. telemetry": add the FR-3 `gen_ai.usage.input_tokens` rule; `otel-tabs.md` Tests section: name the new algorithm rows, contract cases and scenario steps.
- [ ] `user-docs/otel-tab.md` §"Session OTEL tab": describe the Events toggle and markers, the collapsible Session events card (summary, chips, hidden-for-role), the Hook overhead card and that older Claude Code shows neither.

### Chunk 8 — Contract tests and scenario fixtures
- [ ] Add to `server/test/contract/fixtures/world-v1.sql.ts` `otel_session_events` rows for s01 (one `compaction`, one `tool_decision`, two `hook_execution_complete`, seq ≤ 3 so the cursor stays `v1.3`).
- [ ] Add `SESSION_OTEL` cases `F25-session-events`, `F25-session-hook-stats` and `F25-session-events-masked` and `F25-session-events-delta` (`since=v1.2`: only event rows with seq 3; `hookStats` = the full aggregate) to `server/test/contract/registry/f25-otel.ts`. Use an `eventsSql(delta, masked)` oracle like `spansSql` (`:281`), and assert `events: []` in `F25-session-empty-delta`.
- [ ] Add `otelEventLine(sessionId, { name, at, attrs, agentId? }, opts)` to `tests/scenarios/fixtures/otel/otel-lines.ts` beside `apiRequestLine` (`:102`), writing `event.name`, `body.stringValue = 'claude_code.<name>'` and string/int attributes as Claude Code does (numeric strings for compaction and hook counts).
- [ ] Add `'otel_session_events'` to the table lists of `resetOtelProjection` and `otelRowCounts` in `tests/scenarios/helpers/otel.ts` (`:148`, `:160`).
- [ ] Add `otel_session_events` to the purge table lists in three places:
  - `OTEL_TABLES` in `server/test/contract/registry/f18-session-delete-retention.ts` (~`:9`);
  - `SURVIVOR_TABLES` in `tests/scenarios/sessions/s-slife-07.spec.ts` (~`:55`);
  - `OTEL_TABLES` in `tests/scenarios/sessions/s-slife-08.spec.ts` (`:55`), adjusting its `otelRowCounts` expectation (`:143`).

### Chunk 9 — Scenario steps
- [ ] In `tests/scenarios/view/s-otel-01.spec.ts` add to S1's chunk one event line per surfaced kind (incl. a non-mid-turn `user_prompt` and a `tool_parameters` attribute) plus three hook runs; add an API step asserting `events`, `hookStats` and that `tool_parameters` / prompt never appear.
- [ ] Add a UI step in `s-otel-01` session tab: card collapsed with the summary text, Events toggle hides markers, marker click expands and focuses the row, chips filter, Hook overhead numbers; plus an FR-5 assertion: the setup's no-branch session (it has OTEL calls but no event lines) shows no toggle and no cards.
- [ ] In the `s-otel-01` live test add a realtime batch with one `compaction` line: the delta carries it highlighted; the later chunk confirms it without a duplicate; extend the AC-12/13 upgrade step (`:519`) to assert `events` / `hookStats` equal before and after `resetOtelProjection`.
- [ ] In `tests/scenarios/view/s-otel-02.spec.ts`, after the masked Live-view assertion (`:537`), give the member's session (`root.mem`) one `skill_activated` line; the manager's session OTEL route returns it with `details: null`, and the tab shows "hidden for your role".
- [ ] Run touched scenarios: `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-OTEL-0"` and `--mode a --only scenarios --grep "@S-COMPAT-01"`, then the `adlc-lh:check-health` fast set.
