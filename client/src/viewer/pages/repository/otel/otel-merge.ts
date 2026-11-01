/**
 * Client-side merge of OTEL poll results (2026-10-30 otel-tabs-traces, DD-3 / DD-20; algorithm
 * doc `docs/knowledgebase/algorithms/otel-delta-merge.md`).
 *
 * - `mergeOtelDelta` folds a session route response (a `since=` delta or a full snapshot) into
 *   the client state. Rows are keyed by `spanId` (spans), `callKey` (calls) and `start|key`
 *   (buckets).
 * - `diffOtelBuckets` compares two repository / team snapshots (no `since=` there).
 *
 * Highlight rule for spans and calls (DD-3):
 *
 * | Row | Client action |
 * |---|---|
 * | key not yet in client state, kind `new` / `update` / `confirm` | highlighted as new |
 * | key not yet in client state, kind `fill` | counted in `filled`, not highlighted |
 * | known key, kind `update` | highlighted |
 * | known key, kind `confirm` / `reclass` / `fill` | updated silently |
 *
 * Buckets (DD-20): a known bucket is highlighted only when its value grew **and** its kind is
 * `new` or `update`; an unknown bucket follows the span / call table above. The very first
 * snapshot highlights nothing.
 */
import type {
  OtelBucket,
  OtelCallRow,
  OtelChangeKind,
  OtelSpanRow,
  SessionOtelResponse,
} from '../../../../models/repositories';

/** Keys highlighted by one merge: span ids, call keys and bucket `start|key` keys. */
export interface OtelNewKeys {
  spans: ReadonlySet<string>;
  calls: ReadonlySet<string>;
  buckets: ReadonlySet<string>;
}

/** Rows first seen through a `fill` (a gap filled from the regular upload, DD-14). */
export interface OtelFilledCounts {
  calls: number;
  spans: number;
}

export interface OtelMergeResult<S> {
  state: S;
  newKeys: OtelNewKeys;
  filled: OtelFilledCounts;
}

export const EMPTY_OTEL_NEW_KEYS: OtelNewKeys = {
  spans: new Set(),
  calls: new Set(),
  buckets: new Set(),
};

export const NO_OTEL_FILLED: OtelFilledCounts = { calls: 0, spans: 0 };

export function otelBucketKey(b: Pick<OtelBucket, 'start' | 'key'>): string {
  return `${b.start}|${b.key}`;
}

type RowAction = 'highlight' | 'filled' | 'silent';

/** The DD-3 table for one span or call row. */
export function otelRowAction(known: boolean, kind: OtelChangeKind): RowAction {
  if (!known) return kind === 'fill' ? 'filled' : 'highlight';
  return kind === 'update' ? 'highlight' : 'silent';
}

/** Whether a bucket counts as grown: more cost, calls or tokens than before. */
function bucketGrew(prev: OtelBucket, next: OtelBucket): boolean {
  return (
    BigInt(next.costUsdMicros) > BigInt(prev.costUsdMicros) ||
    next.calls > prev.calls ||
    BigInt(next.tokens) > BigInt(prev.tokens)
  );
}

/** The DD-20 rule for one bucket; `prev` is the bucket of the same key in the client state. */
export function otelBucketHighlighted(
  prev: OtelBucket | undefined,
  next: OtelBucket,
): boolean {
  if (prev === undefined)
    return otelRowAction(false, next.changeKind) === 'highlight';
  return (
    (next.changeKind === 'new' || next.changeKind === 'update') &&
    bucketGrew(prev, next)
  );
}

/**
 * Merges rows by key. `full` replaces the row set (rows missing from `incoming` are dropped);
 * otherwise incoming rows replace or extend the existing ones and the rest are kept in place.
 */
function mergeRows<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string,
  full: boolean,
): T[] {
  if (full) return [...incoming];
  const byKey = new Map(incoming.map((r) => [keyOf(r), r]));
  const out: T[] = [];
  for (const row of existing) {
    const key = keyOf(row);
    const replacement = byKey.get(key);
    if (replacement !== undefined) {
      out.push(replacement);
      byKey.delete(key);
    } else {
      out.push(row);
    }
  }
  out.push(...byKey.values());
  return out;
}

function classifyRows<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string,
  kindOf: (row: T) => OtelChangeKind,
): { highlighted: Set<string>; filled: number } {
  const known = new Set(existing.map(keyOf));
  const highlighted = new Set<string>();
  let filled = 0;
  for (const row of incoming) {
    const key = keyOf(row);
    const action = otelRowAction(known.has(key), kindOf(row));
    if (action === 'highlight') highlighted.add(key);
    else if (action === 'filled') filled += 1;
  }
  return { highlighted, filled };
}

/** Highlighted bucket keys of `incoming` against `existing` (DD-20). */
function highlightedBuckets(
  existing: readonly OtelBucket[],
  incoming: readonly OtelBucket[],
): Set<string> {
  const prevByKey = new Map(existing.map((b) => [otelBucketKey(b), b]));
  const out = new Set<string>();
  for (const b of incoming) {
    const key = otelBucketKey(b);
    if (otelBucketHighlighted(prevByKey.get(key), b)) out.add(key);
  }
  return out;
}

const spanKey = (s: OtelSpanRow) => s.spanId;
const callKey = (c: OtelCallRow) => c.callKey;

/**
 * Folds one session route response into the client state.
 *
 * - No state yet: the response becomes the state and nothing is highlighted.
 * - A full snapshot (`full: true`, e.g. after an unknown cursor) replaces every row set but is
 *   still compared with the previous state, so rows it adds are highlighted.
 * - A delta replaces or extends rows by key; `kpis` / `querySources` that are null (an empty
 *   delta) keep their previous value. `cursor`, `interval` and `status` always come from the
 *   response.
 */
export function mergeOtelDelta(
  state: SessionOtelResponse | null,
  delta: SessionOtelResponse,
): OtelMergeResult<SessionOtelResponse> {
  if (state === null) {
    return {
      state: delta,
      newKeys: EMPTY_OTEL_NEW_KEYS,
      filled: NO_OTEL_FILLED,
    };
  }
  const full = delta.full;
  const spans = classifyRows(
    state.spans,
    delta.spans,
    spanKey,
    (s) => s.changeKind,
  );
  const calls = classifyRows(
    state.calls,
    delta.calls,
    callKey,
    (c) => c.changeKind,
  );
  const buckets = highlightedBuckets(state.buckets, delta.buckets);
  return {
    state: {
      cursor: delta.cursor,
      full: delta.full,
      interval: delta.interval,
      status: delta.status,
      buckets: mergeRows(state.buckets, delta.buckets, otelBucketKey, full),
      calls: mergeRows(state.calls, delta.calls, callKey, full),
      spans: mergeRows(state.spans, delta.spans, spanKey, full),
      kpis: delta.kpis ?? (full ? null : state.kpis),
      querySources: delta.querySources ?? (full ? null : state.querySources),
    },
    newKeys: { spans: spans.highlighted, calls: calls.highlighted, buckets },
    filled: { calls: calls.filled, spans: spans.filled },
  };
}

/**
 * Compares two repository / team snapshots (DD-20: re-read without `since=`): the next snapshot
 * becomes the state and its grown `new` / `update` buckets are highlighted. Snapshots carry no
 * span or call rows, so nothing is ever counted as filled.
 */
export function diffOtelBuckets<S extends { buckets: OtelBucket[] }>(
  state: S | null,
  next: S,
): OtelMergeResult<S> {
  if (state === null) {
    return {
      state: next,
      newKeys: EMPTY_OTEL_NEW_KEYS,
      filled: NO_OTEL_FILLED,
    };
  }
  return {
    state: next,
    newKeys: {
      spans: new Set(),
      calls: new Set(),
      buckets: highlightedBuckets(state.buckets, next.buckets),
    },
    filled: NO_OTEL_FILLED,
  };
}
