/**
 * Append ingest decision (algorithm `ingest-append`, 2026-11-24-traffic-optimization DD-6;
 * algorithm doc `docs/knowledgebase/algorithms/ingest-append.md`).
 *
 * Pure: decides what the queue worker does with an append row (`upload_queue.start_line` set) —
 * a delta of a `claude` / `claude-subagent` transcript that starts at record `startLine`:
 * - `stale` — the row is older than the stored body: discard it, as a superseded upload;
 * - `upload-full` — there is no stored body, or its record count does not match `startLine`:
 *   the delta cannot be applied, the hook must re-upload the whole file;
 * - `append` — the stored body ends exactly where the delta starts: store body + delta.
 */

/** The stored `logs` row of the append row's `(session, log_type)`, or `null` when there is none. */
export interface IngestAppendStored {
  /** `logs.body_received_at`; NULL for a body written by an older path. */
  receivedAt: Date | null;
  /** Records in the stored body (`jsonb_array_length`); NULL when the body is not an array. */
  lineCount: number | null;
}

export interface IngestAppendInput {
  stored: IngestAppendStored | null;
  /** `upload_queue.received_at` of the append row. */
  rowReceivedAt: Date;
  /** `upload_queue.start_line` — the 0-based record index the delta starts at. */
  startLine: number;
}

export type IngestAppendDecision = 'stale' | 'upload-full' | 'append';

export function decideIngestAppend(
  input: IngestAppendInput,
): IngestAppendDecision {
  const { stored, rowReceivedAt, startLine } = input;
  if (stored === null) return 'upload-full';
  if (
    stored.receivedAt !== null &&
    rowReceivedAt.getTime() < stored.receivedAt.getTime()
  ) {
    return 'stale';
  }
  if (stored.lineCount === null || stored.lineCount !== startLine) {
    return 'upload-full';
  }
  return 'append';
}
