---
reviewed: no
reviewer: none
---

# Work Hub terminal replay segments

## Purpose

A workstream's chat recording is the raw byte stream of its terminal, which changed size while it
ran. To replay it faithfully (chat-tab scrollback and the history replay), the bytes are cut into
segments, each written after resizing the terminal to the size it had when those bytes were
produced.

## Code

- Implementation: `work-hub/web/src/terminal/replay.ts` (`replaySegments`; `playRecording` writes
  the segments into xterm, resizing before each). The resizes come from the server's recording
  meta (`GET …/recording/meta`: `totalBytes`, `initial`, `resizes`).
- Twins: none.
- Test: `work-hub/web/src/terminal/replay.algo.test.ts` (vitest), run by `npm run test:algo` from
  `work-hub/` (`bun run test` in `work-hub/web/`).

## Input and output

`totalBytes`, the `initial` size `{cols, rows}` and the resizes `[{offset, cols, rows}]` →
segments `[{start, end, cols, rows}]`, bytes `[start, end)` written at `cols × rows`.

## Rules

1. `totalBytes` of 0 (or less) → no segments.
2. Sort the resizes by `offset` (stable: equal offsets keep their order) and drop every resize with
   `offset >= totalBytes`.
3. Start with `start = 0` and the initial size. For each remaining resize in order: if its
   `offset > start`, close the segment `[start, offset)` at the current size and set
   `start = offset`; in every case the resize's size becomes the current size.
4. Close the last segment `[start, totalBytes)` at the current size.

So the segments are contiguous, cover `[0, totalBytes)`, are never empty, several resizes at one
offset collapse to the last of them, and a resize at offset 0 sets the first segment's size.
Segments are cut by offset only; two neighbours may have the same size.

## Edge cases

- No resizes: TR-01. Several: TR-02; given unsorted: TR-11.
- Same offset collapses to the last: TR-03.
- Offset 0: alone TR-04, with a later one TR-05.
- Offset past the end TR-06, exactly at the end TR-07, at the last byte TR-08.
- Zero bytes: TR-09, with a resize TR-10.
- A resize to the same size still cuts: TR-12.

## Examples

`input` is `{totalBytes, initial: {cols, rows}, resizes: [{offset, cols, rows}]}`;
`expected.segments` is the whole result, compared exactly.

Rows (12): [`docs/algorithm-examples/workhub-terminal-replay.json`](../../algorithm-examples/workhub-terminal-replay.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- An empty segment emitted for a resize at the current start -> TR-03, TR-04.
- The first of several same-offset resizes kept -> TR-03.
- `offset > totalBytes` instead of `>=` for dropping -> TR-07.
- A segment for zero bytes -> TR-09.
- Resizes not sorted -> TR-11.
- Neighbours of equal size merged -> TR-12.

## Where the result is visible

The chat tab of a workstream (earlier output in scrollback before the live attach) and the
read-only history replay: wrapped lines and full-screen redraws look as they did when recorded.
