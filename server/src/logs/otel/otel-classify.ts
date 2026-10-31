import {
  TRANSCRIPT_QUERY_SOURCE_PREFIX,
  TRANSCRIPT_QUERY_SOURCES,
} from '../otel-cost.sql';
import type {
  OtelInterval,
  OtelIntervalScope,
  OtelStructure,
} from './otel-facts.types';

/** Inputs of {@link classifyOtelCall} (DD-4). */
export interface OtelClassifyInput {
  /** The call's request_id is in the tree's `session_request_ids`. */
  inTree: boolean;
  /** That request id belongs to a sub-agent transcript of the tree. */
  inSubagentTranscript: boolean;
  querySource: string | null;
  /** The tree has any `session_request_ids` row at all. */
  treeHasRequestIds: boolean;
  /** See {@link isOtelCallProvisional}. */
  provisional: boolean;
}

function isSubagentSource(querySource: string | null): boolean {
  return (
    querySource !== null &&
    querySource.startsWith(TRANSCRIPT_QUERY_SOURCE_PREFIX)
  );
}

/**
 * Structure of one OTEL call (DD-4, algorithm doc `otel-facts.md`):
 * 1. in the tree's request ids → `subagent` when it is in a sub-agent transcript or its
 *    `query_source` starts with `agent:`, else `main`;
 * 2. else, when the tree has no request ids or the call is provisional → the `utilityCostsCte`
 *    fallback: a transcript `query_source` (`TRANSCRIPT_QUERY_SOURCES`) or the `agent:` prefix is
 *    visible (with step 1's split), anything else `hidden`;
 * 3. else `hidden`.
 */
export function classifyOtelCall(input: OtelClassifyInput): OtelStructure {
  const subagent = isSubagentSource(input.querySource);
  if (input.inTree) {
    return input.inSubagentTranscript || subagent ? 'subagent' : 'main';
  }
  if (!input.treeHasRequestIds || input.provisional) {
    if (subagent) return 'subagent';
    if (
      input.querySource !== null &&
      TRANSCRIPT_QUERY_SOURCES.includes(input.querySource)
    ) {
      return 'main';
    }
    return 'hidden';
  }
  return 'hidden';
}

/**
 * A call is provisional while the transcript has not caught up with it (DD-4): its `first_seq`
 * is above the state's `transcript_seq`, or no transcript was seen yet (`transcript_seq` NULL).
 * It uses `first_seq`, so a later confirm or update never makes a call provisional again.
 */
export function isOtelCallProvisional(
  firstSeq: number,
  transcriptSeq: number | null,
): boolean {
  return transcriptSeq === null || firstSeq > transcriptSeq;
}

/** Width of an `otel_cost_buckets` bucket. */
export const OTEL_BUCKET_MS = 5 * 60_000;

/** The 5-minute UTC floor of a time: the `bucket_start` of `otel_cost_buckets` (DD-7). */
export function bucketStart5m(time: Date): Date {
  const ms = time.getTime();
  return new Date(Math.floor(ms / OTEL_BUCKET_MS) * OTEL_BUCKET_MS);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The `auto` chart interval of a period (DD-18): repository (and team) ≤ 24 h → `5m`, ≤ 14 d →
 * `1h`, else `1d`; session ≤ 24 h → `5m`, else `1h`.
 */
export function pickOtelInterval(
  from: Date,
  to: Date,
  scope: OtelIntervalScope,
): OtelInterval {
  const span = to.getTime() - from.getTime();
  if (span <= DAY_MS) return '5m';
  if (scope === 'session') return '1h';
  return span <= 14 * DAY_MS ? '1h' : '1d';
}

/** True for an IANA time-zone name the runtime knows (DD-18: an invalid `tz` is a 400). */
export function isValidOtelTimeZone(tz: string): boolean {
  if (tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
