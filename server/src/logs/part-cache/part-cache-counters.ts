import type { SupervisorInfo } from '../../system-info/system-info.types';
import type {
  PartCacheCounters,
  PartCacheCountersView,
} from './part-cache.types';

/**
 * This process's part cache request counters since its start (hit / miss / fill).
 *
 * A module-scoped singleton outside DI, following the `requestMetricsTracker` and
 * `workerStatsReporter` precedent: `PartCacheService` and the request path write it, and
 * `workerStatsReporter` reads it to push the numbers to the cluster primary, so the admin view
 * can sum them over every worker.
 */
class PartCacheCounterStore {
  private readonly counters: PartCacheCounters = {
    hits: 0,
    misses: 0,
    fills: 0,
  };

  /** A cacheable part was served from its cache file. */
  hit(): void {
    this.counters.hits++;
  }

  /** A cacheable part (numeric revision, valid gzip copy) was served from the database. */
  miss(): void {
    this.counters.misses++;
  }

  /** A new cache file was written. */
  fill(): void {
    this.counters.fills++;
  }

  snapshot(): PartCacheCounters {
    return { ...this.counters };
  }
}

export const partCacheCounters = new PartCacheCounterStore();

export function isPartCacheCounters(
  value: unknown,
): value is PartCacheCounters {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.hits === 'number' &&
    typeof v.misses === 'number' &&
    typeof v.fills === 'number'
  );
}

/**
 * Sums the counters over the cluster: every worker's last pushed numbers from the supervisor
 * snapshot, with this process's live numbers in place of its own (possibly ~10 s old) entry.
 * Outside cluster mode (no snapshot) only this process counts.
 */
export function sumPartCacheCounters(
  supervisor: SupervisorInfo,
  own: PartCacheCounters,
  ownInstance: number | null,
): PartCacheCountersView {
  if (!supervisor.clustered) {
    return { ...own, workers: 1 };
  }
  const total: PartCacheCountersView = {
    hits: 0,
    misses: 0,
    fills: 0,
    workers: 0,
  };
  let ownCounted = false;
  for (const p of supervisor.processes) {
    const isOwn = ownInstance !== null && p.instance === ownInstance;
    const counters = isOwn ? own : p.partCache;
    if (!counters) continue;
    if (isOwn) ownCounted = true;
    total.hits += counters.hits;
    total.misses += counters.misses;
    total.fills += counters.fills;
    total.workers++;
  }
  if (!ownCounted) {
    total.hits += own.hits;
    total.misses += own.misses;
    total.fills += own.fills;
    total.workers++;
  }
  return total;
}
