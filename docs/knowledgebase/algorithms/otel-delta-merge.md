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
or null (it stands for the KPI object). `input.state` may be null (nothing loaded yet).

`input.kind`:
- `merge` → `mergeOtelDelta(state, delta)` as `{ calls, spans, buckets, kpis, highlighted,
  filled }`: `calls` lists the state's calls as `key:v` in order, `spans` the span ids in order,
  `buckets` the bucket keys `start|key`; `highlighted` holds the highlighted keys per kind
  (sorted); `filled` the filled counts.
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

## Edge cases

- First load: DM-01. Unknown keys of every kind: DM-02, DM-03. Known keys: DM-04, DM-09.
- Realtime + confirm within one poll: DM-02 (call `c3`).
- Merge order and replacement: DM-06. Snapshot replacement: DM-07.
- Empty delta keeps rows and KPIs: DM-05.
- Buckets: grew + update vs grew + confirm vs unchanged + update vs unknown: DM-08.
- Snapshot diff: DM-10; first snapshot: DM-11.

## Examples

```examples
[
  {
    "id": "DM-01",
    "input": {"kind": "merge", "state": null, "delta": {"full": true, "kpis": 1, "calls": [{"key": "c1", "kind": "new", "v": 1}], "spans": [{"id": "s1", "kind": "new"}], "buckets": []}},
    "expected": {"calls": ["c1:1"], "spans": ["s1"], "kpis": 1, "highlighted": {"calls": [], "spans": [], "buckets": []}, "filled": {"calls": 0, "spans": 0}},
    "note": "Rule 1: the first response becomes the state, nothing highlighted"
  },
  {
    "id": "DM-02",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 1, "calls": [], "spans": [], "buckets": []},
      "delta": {"full": false, "kpis": 2, "calls": [{"key": "c1", "kind": "new", "v": 1}, {"key": "c2", "kind": "update", "v": 2}, {"key": "c3", "kind": "confirm", "v": 3}], "spans": [{"id": "s1", "kind": "confirm"}], "buckets": []}},
    "expected": {"calls": ["c1:1", "c2:2", "c3:3"], "highlighted": {"calls": ["c1", "c2", "c3"], "spans": ["s1"], "buckets": []}, "filled": {"calls": 0, "spans": 0}},
    "note": "Rule 2: unknown keys with new / update / confirm are highlighted; c3 and s1 came by realtime and were confirmed in the same poll, so the client first sees them as confirm"
  },
  {
    "id": "DM-03",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 1, "calls": [], "spans": [], "buckets": []},
      "delta": {"full": false, "kpis": 2, "calls": [{"key": "c1", "kind": "fill", "v": 1}, {"key": "c2", "kind": "fill", "v": 1}], "spans": [{"id": "s1", "kind": "fill"}], "buckets": []}},
    "expected": {"calls": ["c1:1", "c2:1"], "spans": ["s1"], "highlighted": {"calls": [], "spans": [], "buckets": []}, "filled": {"calls": 2, "spans": 1}},
    "note": "Rule 2: unknown fill rows are added silently and counted: 2 calls, 1 span"
  },
  {
    "id": "DM-04",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 1, "calls": [{"key": "a", "kind": "new", "v": 1}, {"key": "b", "kind": "new", "v": 1}, {"key": "c", "kind": "new", "v": 1}, {"key": "d", "kind": "new", "v": 1}], "spans": [], "buckets": []},
      "delta": {"full": false, "kpis": 1, "calls": [{"key": "a", "kind": "update", "v": 2}, {"key": "b", "kind": "confirm", "v": 1}, {"key": "c", "kind": "reclass", "v": 1}, {"key": "d", "kind": "fill", "v": 1}], "spans": [], "buckets": []}},
    "expected": {"calls": ["a:2", "b:1", "c:1", "d:1"], "highlighted": {"calls": ["a"], "spans": [], "buckets": []}, "filled": {"calls": 0, "spans": 0}},
    "note": "Rule 2: a known key is highlighted only for update (a); confirm, reclass and fill on known keys are silent and a known fill is not counted"
  },
  {
    "id": "DM-05",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 7, "calls": [{"key": "a", "kind": "new", "v": 1}], "spans": [{"id": "s1", "kind": "new"}], "buckets": [{"start": "2026-10-30T10:00:00.000Z", "key": "main", "cost": "100", "calls": 1, "tokens": "10", "kind": "new"}]},
      "delta": {"full": false, "kpis": null, "calls": [], "spans": [], "buckets": []}},
    "expected": {"calls": ["a:1"], "spans": ["s1"], "buckets": ["2026-10-30T10:00:00.000Z|main"], "kpis": 7, "highlighted": {"calls": [], "spans": [], "buckets": []}, "filled": {"calls": 0, "spans": 0}},
    "note": "Rules 4, 5: an empty delta keeps every row and the previous KPIs (7)"
  },
  {
    "id": "DM-06",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 1, "calls": [{"key": "a", "kind": "new", "v": 1}, {"key": "b", "kind": "new", "v": 1}], "spans": [], "buckets": []},
      "delta": {"full": false, "kpis": 2, "calls": [{"key": "b", "kind": "update", "v": 9}, {"key": "c", "kind": "new", "v": 3}], "spans": [], "buckets": []}},
    "expected": {"calls": ["a:1", "b:9", "c:3"], "kpis": 2, "highlighted": {"calls": ["b", "c"], "spans": [], "buckets": []}},
    "note": "Rule 4: b is replaced in place (v 1 -> 9), c is appended, a stays; b known + update and c unknown + new are both highlighted"
  },
  {
    "id": "DM-07",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 1, "calls": [{"key": "a", "kind": "new", "v": 1}, {"key": "b", "kind": "new", "v": 1}], "spans": [], "buckets": []},
      "delta": {"full": true, "kpis": null, "calls": [{"key": "b", "kind": "confirm", "v": 1}, {"key": "c", "kind": "new", "v": 3}], "spans": [], "buckets": []}},
    "expected": {"calls": ["b:1", "c:3"], "kpis": null, "highlighted": {"calls": ["c"], "spans": [], "buckets": []}},
    "note": "Rule 4: a snapshot replaces the set (a is dropped); compared with the old state c is new -> highlighted, b known + confirm -> silent. Rule 5: a snapshot's null kpis is taken as is"
  },
  {
    "id": "DM-08",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 1, "calls": [], "spans": [], "buckets": [
        {"start": "2026-10-30T10:00:00.000Z", "key": "main", "cost": "100", "calls": 1, "tokens": "10", "kind": "new"},
        {"start": "2026-10-30T10:00:00.000Z", "key": "hidden", "cost": "100", "calls": 1, "tokens": "10", "kind": "new"},
        {"start": "2026-10-30T10:00:00.000Z", "key": "subagent", "cost": "100", "calls": 1, "tokens": "10", "kind": "new"}
      ]},
      "delta": {"full": false, "kpis": 1, "calls": [], "spans": [], "buckets": [
        {"start": "2026-10-30T10:00:00.000Z", "key": "main", "cost": "150", "calls": 2, "tokens": "20", "kind": "update"},
        {"start": "2026-10-30T10:00:00.000Z", "key": "hidden", "cost": "150", "calls": 2, "tokens": "20", "kind": "confirm"},
        {"start": "2026-10-30T10:00:00.000Z", "key": "subagent", "cost": "100", "calls": 1, "tokens": "10", "kind": "update"},
        {"start": "2026-10-30T10:05:00.000Z", "key": "main", "cost": "50", "calls": 1, "tokens": "5", "kind": "new"}
      ]}},
    "expected": {"highlighted": {"calls": [], "spans": [], "buckets": ["2026-10-30T10:00:00.000Z|main", "2026-10-30T10:05:00.000Z|main"]}},
    "note": "Rule 3: main grew (100 -> 150) with update -> highlighted; hidden grew but confirm -> silent; subagent update without growth -> silent; the 10:05 bucket is unknown and new -> highlighted"
  },
  {
    "id": "DM-09",
    "input": {"kind": "merge",
      "state": {"full": true, "kpis": 1, "calls": [{"key": "a", "kind": "new", "v": 1}], "spans": [{"id": "s1", "kind": "new"}], "buckets": []},
      "delta": {"full": false, "kpis": 1, "calls": [{"key": "a", "kind": "new", "v": 1}], "spans": [{"id": "s1", "kind": "new"}], "buckets": []}},
    "expected": {"highlighted": {"calls": [], "spans": [], "buckets": []}, "filled": {"calls": 0, "spans": 0}},
    "note": "Rule 2: a known key with kind new (sent again) is updated silently"
  },
  {
    "id": "DM-10",
    "input": {"kind": "diff",
      "state": {"full": true, "kpis": 1, "calls": [], "spans": [], "buckets": [
        {"start": "2026-10-30T00:00:00.000Z", "key": "main", "cost": "100", "calls": 1, "tokens": "10", "kind": "new"},
        {"start": "2026-10-30T00:00:00.000Z", "key": "hidden", "cost": "100", "calls": 1, "tokens": "10", "kind": "new"}
      ]},
      "delta": {"full": true, "kpis": 1, "calls": [], "spans": [], "buckets": [
        {"start": "2026-10-30T00:00:00.000Z", "key": "main", "cost": "100", "calls": 1, "tokens": "30", "kind": "update"},
        {"start": "2026-10-30T00:00:00.000Z", "key": "hidden", "cost": "120", "calls": 1, "tokens": "10", "kind": "reclass"}
      ]}},
    "expected": {"highlighted": ["2026-10-30T00:00:00.000Z|main"]},
    "note": "Rules 3, 6: main grew in tokens (10 -> 30) with update -> highlighted; hidden grew but by reclass -> silent"
  },
  {
    "id": "DM-11",
    "input": {"kind": "diff", "state": null,
      "delta": {"full": true, "kpis": 1, "calls": [], "spans": [], "buckets": [
        {"start": "2026-10-30T00:00:00.000Z", "key": "main", "cost": "100", "calls": 1, "tokens": "10", "kind": "new"}
      ]}},
    "expected": {"highlighted": []},
    "note": "Rule 6: the first snapshot highlights nothing"
  }
]
```

## Mutations

- "A known `confirm` row is highlighted" -> DM-04.
- "An unknown `confirm` row is silent" (realtime + confirm in one poll loses its highlight) -> DM-02.
- "Unknown `fill` rows highlighted, or not counted" -> DM-03.
- "A delta drops rows it does not mention" -> DM-05, DM-06.
- "Buckets highlighted on any change" (without the growth check) -> DM-08 (subagent).
- "Buckets highlighted for every kind" -> DM-08 (hidden), DM-10.
- "Empty delta clears KPIs" -> DM-05.

## Where the result is visible

The OTEL tabs: the highlight of new rows in the session's call list and waterfall and of grown
chart buckets, and the transient "Filled N calls / M spans from the regular upload." notice.
