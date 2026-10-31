---
reviewed: no
reviewer: none
---

# OTEL trace assembly: turns, turn header, time split, turn order

## Purpose

The session OTEL tab shows each turn of a session as a waterfall of trace spans with a header
(start, duration, cost, hidden cost, LLM calls, depth, spans, waiting, output tokens), a "Time"
bar that splits the turn into waiting / model / tool / other, and a navigator that orders turns.
Claude Code exports a span when it ends, so a running turn's spans arrive before their parents,
and small utility calls (`prompt_suggestion`) come as traces of their own. This rule turns the
flat span rows into turns the user can read while the session is still running.

## Code

- Implementation: `client/src/viewer/pages/repository/session-log/otel/otel-trace-assembly.ts`
  — `assembleOtelTraces`, `splitOtelTurnTime`, `orderOtelTurns`, `unionIntervalsMs`.
- Twins: none. The server stores the spans and their rollups (`otel_spans`); the assembly is
  client-only.
- Test: `client/src/viewer/pages/repository/session-log/otel/otel-trace-assembly.algo.test.ts`.

## Input and output

Times are seconds from a fixed `T0` (the test uses `2026-10-30T10:00:00Z`). A span is
`{ t, id, p, n, s, e, cost?, rollup?, req?, hidden? }`: trace id, span id, parent span id (or
null), name, start, end (null = still open), own cost and rollup in micro-USD, request id, and
whether its call is hidden. Name shorthands: `interaction`, `llm`, `tool`, `blocked`, `exec` for
`claude_code.interaction`, `claude_code.llm_request`, `claude_code.tool`,
`claude_code.tool.blocked_on_user` and `claude_code.tool.execution`. `rollup` defaults to
`cost`. A call is `{ req, out }` (request id, output tokens).

`input.kind`:
- `assemble` → `{ turns }`. Each turn is `{ traceId, inProgress, standaloneOnly, tree, header }`.
  `tree` writes the turn's root rows separated by `|`; a row is its key followed by its
  children in `[ … ]`, comma-separated; `*` marks an attached standalone row and `?` an orphan.
  The header uses `startS` / `endS` (seconds from `T0`) instead of absolute milliseconds; only
  the listed fields are compared.
- `split` → the `splitOtelTurnTime` of turn number `turn` (0-based, in assembly order).
- `order` → `{ order }`: the trace ids of `orderOtelTurns(turns, order)`.

## Rules

1. **Group and hang.** Spans are grouped by trace; a span whose parent is in its trace becomes
   that parent's child. Children are ordered by start, then span id.
2. **Orphans.** A span whose parent has not arrived is an orphan. A trace's orphans go under one
   provisional row `pending:<traceId>`, ordered by start. Its start is the earliest orphan
   start, its end the latest end below it (an open span counts with its start), and its rollup
   the sum of the orphans' rollups. A turn with a provisional row is `inProgress`. When the
   parent arrives the orphans hang under it and the provisional row disappears.
3. **Standalone traces.** A trace with no `interaction` span, no orphans and only `llm` roots is
   standalone. It attaches, as extra root rows marked standalone, to the turn whose
   `[start, end]` contains its start (the latest-starting one when several do); else to the turn
   that started last before it; with neither it is a turn of its own (`standaloneOnly`, rows not
   marked standalone).
4. **Root rows** of a turn: its own roots by start (provisional row included), then its attached
   standalone rows by start. Turns are ordered by start, then trace id.
5. **Header** over every node of every root row:
   - `startS` / `endS`: earliest start, latest end (an open span counts with its start);
     `durationMs = (endS - startS) · 1000`;
   - `costUsdMicros`: sum of the rollups of the non-standalone root rows;
     `standaloneCostUsdMicros`: sum of the standalone rows' rollups;
   - `hiddenCostUsdMicros`: own cost of the `llm` spans whose call is hidden;
   - `llmCalls`: `llm` spans; `spans`: real spans (the provisional row is not one); `depth`:
     the deepest node, root rows at 0;
   - `waitingMs`: the union of the closed `blocked` intervals, clipped to the turn;
   - `outputTokens`: sum of `out` of the calls whose `req` matches an `llm` span's request id.
6. **Time split** (`splitOtelTurnTime`, FR-31). Over every closed span of the turn (standalone
   rows included), clipped to the turn: `W` = `blocked` intervals, `M` = `llm`, `T` = `exec`.
   `waiting = |W|`, `model = |W ∪ M| − |W|`, `tool = |W ∪ M ∪ T| − |W ∪ M|`,
   `other = max(0, duration − |W ∪ M ∪ T|)`. Each instant counts once, in the priority waiting →
   model → tool.
7. **Turn order** (`orderOtelTurns`, FR-30): `start` ascending; `cost` by `costUsdMicros`
   descending; `slowest` by `durationMs` descending; ties by start, then trace id.

## Edge cases

- A complete turn with nested tool spans: TA-01.
- Orphans before their interaction (running turn): TA-02; the same spans after the parent
  arrives (re-parent): TA-03; an orphan beside an existing root (AC-19): TA-06.
- Standalone attached by containment and by "latest before": TA-04; no earlier turn: TA-05.
- Time split with an overlapping sub-agent LLM call and a main-thread tool (AC-24): TA-07;
  running turn with an open span: TA-08; waiting inside a tool execution: TA-09.
- Turn order with a cost tie: TA-10, TA-11, TA-12.

## Examples

```examples
[
  {
    "id": "TA-01",
    "input": {"kind": "assemble", "spans": [
      {"t": "T1", "id": "i1", "p": null, "n": "interaction", "s": 0, "e": 60, "rollup": 3000},
      {"t": "T1", "id": "l1", "p": "i1", "n": "llm", "s": 1, "e": 10, "cost": 1000, "req": "r1", "hidden": false},
      {"t": "T1", "id": "t1", "p": "i1", "n": "tool", "s": 10, "e": 40},
      {"t": "T1", "id": "e1", "p": "t1", "n": "exec", "s": 20, "e": 40},
      {"t": "T1", "id": "b1", "p": "t1", "n": "blocked", "s": 12, "e": 20},
      {"t": "T1", "id": "l2", "p": "i1", "n": "llm", "s": 40, "e": 60, "cost": 2000, "req": "r2", "hidden": false}
    ], "calls": [{"req": "r1", "out": 100}, {"req": "r2", "out": 50}]},
    "expected": {"turns": [{"traceId": "T1", "inProgress": false, "standaloneOnly": false, "tree": "i1[l1,t1[b1,e1],l2]",
      "header": {"startS": 0, "endS": 60, "durationMs": 60000, "costUsdMicros": 3000, "standaloneCostUsdMicros": 0, "hiddenCostUsdMicros": 0, "llmCalls": 2, "depth": 2, "spans": 6, "waitingMs": 8000, "outputTokens": 150}}]},
    "note": "Rules 1, 5: children by start (l1 1, t1 10, l2 40; b1 12, e1 20); cost = i1 rollup 3000; 2 llm spans; deepest b1/e1 at depth 2; waiting = b1 12..20 = 8 s; output 100 + 50"
  },
  {
    "id": "TA-02",
    "input": {"kind": "assemble", "spans": [
      {"t": "T2", "id": "l1", "p": "i2", "n": "llm", "s": 5, "e": 15, "cost": 500, "req": "r1"},
      {"t": "T2", "id": "t1", "p": "i2", "n": "tool", "s": 15, "e": 25}
    ], "calls": []},
    "expected": {"turns": [{"traceId": "T2", "inProgress": true, "standaloneOnly": false, "tree": "pending:T2[l1?,t1?]",
      "header": {"startS": 5, "endS": 25, "durationMs": 20000, "costUsdMicros": 500, "llmCalls": 1, "depth": 1, "spans": 2}}]},
    "note": "Rule 2: parent i2 missing -> both are orphans under pending:T2; its rollup = 500 + 0; the provisional row is not counted in spans; orphans sit at depth 1"
  },
  {
    "id": "TA-03",
    "input": {"kind": "assemble", "spans": [
      {"t": "T2", "id": "l1", "p": "i2", "n": "llm", "s": 5, "e": 15, "cost": 500, "req": "r1"},
      {"t": "T2", "id": "t1", "p": "i2", "n": "tool", "s": 15, "e": 25},
      {"t": "T2", "id": "i2", "p": null, "n": "interaction", "s": 0, "e": 30, "rollup": 500}
    ], "calls": []},
    "expected": {"turns": [{"traceId": "T2", "inProgress": false, "tree": "i2[l1,t1]",
      "header": {"startS": 0, "endS": 30, "durationMs": 30000, "costUsdMicros": 500, "spans": 3}}]},
    "note": "Rule 2: the interaction arrived; l1 and t1 hang under it, no provisional row, the turn is no longer in progress"
  },
  {
    "id": "TA-04",
    "input": {"kind": "assemble", "spans": [
      {"t": "A", "id": "a", "p": null, "n": "interaction", "s": 0, "e": 60, "rollup": 1000},
      {"t": "S1", "id": "s1", "p": null, "n": "llm", "s": 30, "e": 32, "cost": 40, "req": "rs1", "hidden": true},
      {"t": "S2", "id": "s2", "p": null, "n": "llm", "s": 70, "e": 71, "cost": 10, "req": "rs2", "hidden": false},
      {"t": "B", "id": "b", "p": null, "n": "interaction", "s": 100, "e": 160, "rollup": 2000}
    ], "calls": []},
    "expected": {"turns": [
      {"traceId": "A", "standaloneOnly": false, "tree": "a|s1*|s2*", "header": {"startS": 0, "endS": 71, "durationMs": 71000, "costUsdMicros": 1000, "standaloneCostUsdMicros": 50, "hiddenCostUsdMicros": 40, "llmCalls": 2, "spans": 3}},
      {"traceId": "B", "tree": "b", "header": {"startS": 100, "costUsdMicros": 2000, "standaloneCostUsdMicros": 0}}
    ]},
    "note": "Rule 3: s1 at 30 lies in A's [0, 60] -> A; s2 at 70 lies in no turn, A (start 0) is the latest turn started before 70 (B starts at 100) -> A. Rule 5: A's cost stays the interaction rollup 1000, standalone = 40 + 10, hidden = s1's 40; the header end is s2's end 71"
  },
  {
    "id": "TA-05",
    "input": {"kind": "assemble", "spans": [
      {"t": "X", "id": "x1", "p": null, "n": "llm", "s": 0, "e": 2, "cost": 30},
      {"t": "Y", "id": "y", "p": null, "n": "interaction", "s": 10, "e": 20, "rollup": 700}
    ], "calls": []},
    "expected": {"turns": [
      {"traceId": "X", "inProgress": false, "standaloneOnly": true, "tree": "x1", "header": {"startS": 0, "costUsdMicros": 30, "standaloneCostUsdMicros": 0}},
      {"traceId": "Y", "standaloneOnly": false, "tree": "y", "header": {"startS": 10, "costUsdMicros": 700}}
    ]},
    "note": "Rule 3: x1 starts before every turn and no turn contains it -> a turn of its own, its row not marked standalone, so its 30 counts as the turn cost. Rule 4: X (0) before Y (10)"
  },
  {
    "id": "TA-06",
    "input": {"kind": "assemble", "spans": [
      {"t": "T6", "id": "i6", "p": null, "n": "interaction", "s": 0, "e": 50, "rollup": 0},
      {"t": "T6", "id": "e6", "p": "t6", "n": "exec", "s": 20, "e": 30}
    ], "calls": []},
    "expected": {"turns": [{"traceId": "T6", "inProgress": true, "tree": "i6|pending:T6[e6?]", "header": {"startS": 0, "endS": 50, "spans": 2, "depth": 1}}]},
    "note": "Rule 2 (AC-19): e6's parent tool t6 has not arrived, so e6 sits under pending:T6 as a root row next to i6 until it does; the turn is in progress"
  },
  {
    "id": "TA-07",
    "input": {"kind": "split", "turn": 0, "spans": [
      {"t": "T7", "id": "i", "p": null, "n": "interaction", "s": 0, "e": 100},
      {"t": "T7", "id": "l1", "p": "i", "n": "llm", "s": 0, "e": 30},
      {"t": "T7", "id": "t", "p": "i", "n": "tool", "s": 20, "e": 60},
      {"t": "T7", "id": "e", "p": "t", "n": "exec", "s": 20, "e": 60},
      {"t": "T7", "id": "l2", "p": "t", "n": "llm", "s": 40, "e": 50},
      {"t": "T7", "id": "t2", "p": "i", "n": "tool", "s": 65, "e": 90},
      {"t": "T7", "id": "b", "p": "t2", "n": "blocked", "s": 70, "e": 80},
      {"t": "T7", "id": "e2", "p": "t2", "n": "exec", "s": 80, "e": 90}
    ], "calls": []},
    "expected": {"durationMs": 100000, "waitingMs": 10000, "modelMs": 40000, "toolMs": 30000, "otherMs": 20000},
    "note": "Rule 6 (AC-24): W = [70,80] = 10 s; W u M = [0,30] + [40,50] + [70,80] = 50 s -> model 40 s (the sub-agent call l2 inside the tool counts as model); W u M u T = [0,60] + [70,90] = 80 s -> tool 30 s; other = 100 - 80 = 20 s"
  },
  {
    "id": "TA-08",
    "input": {"kind": "split", "turn": 0, "spans": [
      {"t": "T8", "id": "l1", "p": "i8", "n": "llm", "s": 0, "e": 10},
      {"t": "T8", "id": "b1", "p": "t8", "n": "blocked", "s": 15, "e": 25},
      {"t": "T8", "id": "l2", "p": "i8", "n": "llm", "s": 20, "e": null}
    ], "calls": []},
    "expected": {"durationMs": 25000, "waitingMs": 10000, "modelMs": 10000, "toolMs": 0, "otherMs": 5000},
    "note": "Rules 5, 6: a running turn (all orphans) ends at its latest span end 25 (open l2 counts with its start 20); open l2 is left out of the split; W = 10, M adds l1 0..10 = 10, no exec, other = 25 - 20 = 5"
  },
  {
    "id": "TA-09",
    "input": {"kind": "split", "turn": 0, "spans": [
      {"t": "T9", "id": "i", "p": null, "n": "interaction", "s": 0, "e": 50},
      {"t": "T9", "id": "t", "p": "i", "n": "tool", "s": 5, "e": 45},
      {"t": "T9", "id": "e", "p": "t", "n": "exec", "s": 5, "e": 45},
      {"t": "T9", "id": "b", "p": "t", "n": "blocked", "s": 10, "e": 20}
    ], "calls": []},
    "expected": {"durationMs": 50000, "waitingMs": 10000, "modelMs": 0, "toolMs": 30000, "otherMs": 10000},
    "note": "Rule 6: waiting 10..20 inside the execution 5..45 counts as waiting only; tool = |[5,45]| - 10 = 30; other = 50 - 40 = 10"
  },
  {
    "id": "TA-10",
    "input": {"kind": "order", "order": "start", "spans": [
      {"t": "C", "id": "c", "p": null, "n": "interaction", "s": 40, "e": 70, "rollup": 500},
      {"t": "A", "id": "a", "p": null, "n": "interaction", "s": 0, "e": 10, "rollup": 300},
      {"t": "B", "id": "b", "p": null, "n": "interaction", "s": 20, "e": 25, "rollup": 500}
    ]},
    "expected": {"order": ["A", "B", "C"]},
    "note": "Rule 7: start 0, 20, 40"
  },
  {
    "id": "TA-11",
    "input": {"kind": "order", "order": "cost", "spans": [
      {"t": "C", "id": "c", "p": null, "n": "interaction", "s": 40, "e": 70, "rollup": 500},
      {"t": "A", "id": "a", "p": null, "n": "interaction", "s": 0, "e": 10, "rollup": 300},
      {"t": "B", "id": "b", "p": null, "n": "interaction", "s": 20, "e": 25, "rollup": 500}
    ]},
    "expected": {"order": ["B", "C", "A"]},
    "note": "Rule 7: B and C tie at 500 -> earlier start B first; A 300 last"
  },
  {
    "id": "TA-12",
    "input": {"kind": "order", "order": "slowest", "spans": [
      {"t": "C", "id": "c", "p": null, "n": "interaction", "s": 40, "e": 70, "rollup": 500},
      {"t": "A", "id": "a", "p": null, "n": "interaction", "s": 0, "e": 10, "rollup": 300},
      {"t": "B", "id": "b", "p": null, "n": "interaction", "s": 20, "e": 25, "rollup": 500}
    ]},
    "expected": {"order": ["C", "A", "B"]},
    "note": "Rule 7: durations C 30 s, A 10 s, B 5 s"
  }
]
```

## Mutations

- "Orphans dropped instead of kept under a provisional row" -> TA-02, TA-06.
- "Standalone cost added to the interaction cost" -> TA-04.
- "Standalone attaches only by containment" -> TA-04 (s2).
- "Time split counts overlaps twice" (sum of intervals instead of unions) -> TA-07.
- "Waiting inside a tool also counted as tool time" -> TA-09.
- "Open spans counted in the split up to now" -> TA-08.
- "Cost ties broken by trace id first" -> TA-11.

## Where the result is visible

Session view → OTEL tab: the trace navigator (turn list, order picker, "Time" bar), the
waterfall rows ("turn in progress" row, attached utility calls) and the turn header.
