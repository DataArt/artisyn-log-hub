---
reviewed: no
reviewer: none
---

# OTEL delta merge: what a poll changes and what it highlights

## Purpose

The OTEL tabs poll the server while a session runs. The session tab sends `since=<cursor>` and
gets only the changed rows; the repository and team tabs re-read a snapshot. Rows that are new
to the user are briefly highlighted, while rows that only got confirmed by the hook's regular
upload, reclassified, or filled into a gap change silently (filled rows are counted for the
"Filled N calls / M spans" notice). This rule decides how a response is folded into the client
state and which keys it highlights.

## Code

- Implementation: `client/src/viewer/pages/repository/otel/otel-merge.ts` — `mergeOtelDelta`,
  `diffOtelBuckets`, `otelRowAction`, `otelBucketHighlighted`.
- Twins: none. The server stamps each row's `change_kind` (DD-3); the client applies the table
  below.
- Test: `client/src/viewer/pages/repository/otel/otel-merge.algo.test.ts`.

## Input and output

A state and a response are compact: `{ full, kpis, calls, spans, buckets }`. A call is
`{ key, kind, v }` (call key, change kind, a cost value that shows which copy of a row survived),
a span `{ id, kind }`, a bucket `{ start, key, cost, calls, tokens, kind }`. `kpis` is a number
or null (it stands for the KPI object). An optional `plan` is a string, null or absent (it
stands for the account object carrying that plan; absent = an older server). `input.state` may be
null (nothing loaded yet).

`input.kind`:
- `merge` → `mergeOtelDelta(state, delta)` as `{ calls, spans, buckets, kpis, highlighted,
  filled }`: `calls` lists the state's calls as `key:v` in order, `spans` the span ids in order,
  `buckets` the bucket keys `start|key`; `highlighted` holds the highlighted keys per kind
  (sorted); `filled` the filled counts; `plan` the state's plan string, `null`, or `"absent"`
  when the state has no `plan` field.
- `diff` → `diffOtelBuckets(state, next)` (repository / team snapshots) as `{ highlighted }`
  (bucket keys only).

## Rules

1. **First load.** With no state, the response becomes the state and nothing is highlighted.
2. **Calls and spans** (DD-3), per incoming row:

   | Row | Action |
   |---|---|
   | key not in the state, kind `new` / `update` / `confirm` | highlighted |
   | key not in the state, kind `fill` | counted in `filled`, not highlighted |
   | key in the state, kind `update` | highlighted |
   | key in the state, kind `new` / `confirm` / `reclass` / `fill` | updated silently |

   A row that arrived by realtime and was confirmed by a chunk within one poll reaches the
   client as an unknown key with kind `confirm`, so it is still highlighted.
3. **Buckets** (DD-20). An unknown bucket follows rule 2. A known bucket is highlighted only
   when it **grew** (more cost, calls or tokens) **and** its kind is `new` or `update`.
4. **Merge by key.** A delta (`full: false`) replaces a row of the same key in place and
   appends new keys after the existing rows; rows it does not mention stay. A snapshot
   (`full: true`) replaces each row set entirely, but is still compared with the previous state
   for highlighting.
5. **Empty delta.** `kpis: null` in a delta keeps the previous KPIs (a snapshot with null
   clears them).
6. **Repository / team snapshots** (`diffOtelBuckets`): the next snapshot becomes the state;
   buckets are highlighted by rule 3; the first snapshot highlights nothing.
7. **Account plan** (task `2026-11-03-otel-cost-attribution`, DD-10). The session route sends
   `plan` (the account object, or `null` when nothing is reported) on snapshots and deltas alike.
   A response that carries the field replaces the previous value, `null` included, even when the
   rest of the delta is empty. A response without the field (an older server) keeps the previous
   value; a state that never had it stays without it.

## Edge cases

- First load: DM-01. Unknown keys of every kind: DM-02, DM-03. Known keys: DM-04, DM-09.
- Realtime + confirm within one poll: DM-02 (call `c3`).
- Merge order and replacement: DM-06. Snapshot replacement: DM-07.
- Empty delta keeps rows and KPIs: DM-05.
- Buckets: grew + update vs grew + confirm vs unchanged + update vs unknown: DM-08.
- Snapshot diff: DM-10; first snapshot: DM-11.
- Plan: replaced by the delta DM-12, replaced by `null` DM-13, absent keeps it DM-14, never sent
  DM-15.

## Examples

Rows (15): [`docs/algorithm-examples/otel-delta-merge.json`](../../algorithm-examples/otel-delta-merge.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "A known `confirm` row is highlighted" -> DM-04.
- "An unknown `confirm` row is silent" (realtime + confirm in one poll loses its highlight) -> DM-02.
- "Unknown `fill` rows highlighted, or not counted" -> DM-03.
- "A delta drops rows it does not mention" -> DM-05, DM-06.
- "Buckets highlighted on any change" (without the growth check) -> DM-08 (subagent).
- "Buckets highlighted for every kind" -> DM-08 (hidden), DM-10.
- "Empty delta clears KPIs" -> DM-05.
- "`plan` kept from the state like the KPIs" (`delta.plan ?? state.plan`) -> DM-13; "an absent
  `plan` clears it" -> DM-14; "a delta's `plan` ignored" -> DM-12.

## Where the result is visible

The OTEL tabs: the highlight of new rows in the session's call list and waterfall and of grown
chart buckets, and the transient "Filled N calls / M spans from the regular upload." notice.
