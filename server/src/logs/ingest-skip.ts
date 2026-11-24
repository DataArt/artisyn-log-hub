import { INGEST_VERSION } from './ingest-version';

/**
 * Server hash skip (DD-20 of 2026-11-23-session-logs-streaming; algorithm doc
 * `docs/knowledgebase/algorithms/ingest-hash-skip.md`).
 *
 * Pure: decides whether a staged upload can be dropped without parsing because the stored row
 * already holds the same body, derived by the same `INGEST_VERSION`, for the same user and — for
 * transcripts — against the same tree edit records.
 */

/** The stored `logs` row of the upload's `(session, log_type)`, or `null` when there is none. */
export interface IngestSkipStored {
  bodySha256: string | null;
  ingestVersion: number | null;
  userId: number;
  statsEditSha256: string | null;
}

export interface IngestSkipIncoming {
  logType: string;
  bodySha256: string;
  userId: number;
  /** `readTreeEditSha` of the upload's session (`''` when the tree has no edit records). */
  treeEditSha256: string;
}

export type IngestSkipDecision = 'skip' | 'process';

/** Whole-file types whose identical re-upload changes nothing. */
const SKIPPABLE_TYPES: ReadonlySet<string> = new Set([
  'claude',
  'claude-subagent',
  'tool-calls',
]);

/** Types whose derived stats also depend on the tree's artisyn edit records. */
const TRANSCRIPT_TYPES: ReadonlySet<string> = new Set([
  'claude',
  'claude-subagent',
]);

/** True for the log types `decideIngestSkip` can ever answer `skip` for. */
export function isIngestSkippableType(logType: string): boolean {
  return SKIPPABLE_TYPES.has(logType);
}

export function decideIngestSkip(
  stored: IngestSkipStored | null,
  incoming: IngestSkipIncoming,
): IngestSkipDecision {
  if (!SKIPPABLE_TYPES.has(incoming.logType)) return 'process';
  if (stored === null) return 'process';
  if (stored.bodySha256 === null) return 'process';
  if (stored.bodySha256 !== incoming.bodySha256) return 'process';
  if (stored.ingestVersion !== INGEST_VERSION) return 'process';
  if (stored.userId !== incoming.userId) return 'process';
  if (
    TRANSCRIPT_TYPES.has(incoming.logType) &&
    stored.statsEditSha256 !== incoming.treeEditSha256
  ) {
    return 'process';
  }
  return 'skip';
}
