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

Rows (12): [`docs/algorithm-examples/otel-trace-assembly.json`](../../algorithm-examples/otel-trace-assembly.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
