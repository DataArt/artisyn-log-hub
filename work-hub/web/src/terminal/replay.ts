// Chat recording replay (D17, algorithm `workhub-terminal-replay`).
//
// The recording is the raw output of the `chat` pane; `terminal_resizes` tells at which byte
// offset the pane changed size. The replay cuts the bytes into segments, one per size, and
// resizes xterm before writing each one.

import type { Terminal } from "@xterm/xterm";

import type { RecordingMeta, TermSize } from "../api/workstreams";

/** One replay segment: bytes `[start, end)` written at `cols × rows`. */
export interface ReplaySegment {
  start: number;
  end: number;
  cols: number;
  rows: number;
}

/**
 * Segments of a recording of `totalBytes` bytes that starts at `initial` size.
 *
 * - The segments are contiguous, cover `[0, totalBytes)` and are never empty.
 * - Several resizes at one offset collapse to the last of them.
 * - A resize at or past `totalBytes` is dropped (nothing is written at that size); one at
 *   offset 0 or below sets the size of the first segment.
 * - `resizes` is expected sorted by offset; it is re-sorted stably to be safe.
 */
export function replaySegments(
  totalBytes: number,
  initial: TermSize,
  resizes: readonly { offset: number; cols: number; rows: number }[],
): ReplaySegment[] {
  if (!(totalBytes > 0)) return [];
  const sorted = resizes
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.offset - b.r.offset || a.i - b.i)
    .map(({ r }) => r)
    .filter((r) => r.offset < totalBytes);

  const out: ReplaySegment[] = [];
  let start = 0;
  let size: TermSize = { cols: initial.cols, rows: initial.rows };
  for (const r of sorted) {
    if (r.offset > start) {
      out.push({ start, end: r.offset, cols: size.cols, rows: size.rows });
      start = r.offset;
    }
    size = { cols: r.cols, rows: r.rows };
  }
  out.push({ start, end: totalBytes, cols: size.cols, rows: size.rows });
  return out;
}

function writeAsync(term: Terminal, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/**
 * Writes a recording into `term` segment by segment, resizing before each one. Stops early when
 * `isCancelled()` turns true (the view went away). Bytes beyond the recording are ignored.
 */
export async function playRecording(
  term: Terminal,
  bytes: Uint8Array,
  meta: RecordingMeta,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const total = Math.min(meta.totalBytes, bytes.length);
  for (const seg of replaySegments(total, meta.initial, meta.resizes)) {
    if (isCancelled()) return;
    if (
      seg.cols > 0 &&
      seg.rows > 0 &&
      (term.cols !== seg.cols || term.rows !== seg.rows)
    ) {
      term.resize(seg.cols, seg.rows);
    }
    await writeAsync(term, bytes.subarray(seg.start, seg.end));
  }
}
