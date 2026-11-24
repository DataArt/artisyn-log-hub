import type {
  SystemInfoPartCache,
  SystemInfoPartCacheCounters,
} from '../../../../models';
import { DateTime } from '../../../components/DateTime';
import { formatBytes } from '../../../lib/format';
import { Card } from './system-card';

const LINE = 'mt-1 text-sm font-bold text-foreground';

function hitRate({ hits, misses }: SystemInfoPartCacheCounters): string {
  const total = hits + misses;
  return total === 0 ? '—' : `${Math.round((hits / total) * 100)}%`;
}

/**
 * Admin System tab card for the session-part disk cache. Size, file count and oldest read come
 * from the server's live scan (`current`); an older server without it falls back to the last
 * sweep's numbers.
 */
export function PartCacheCard({
  partCache,
}: {
  partCache: SystemInfoPartCache;
}) {
  const {
    enabled,
    dir,
    maxBytes,
    ttlDays,
    current,
    counters,
    lastSweep,
    removedByDataDeletion,
  } = partCache;
  const size = current ?? lastSweep;

  return (
    <Card label="Part cache" testId="part-cache-card">
      <div
        className="mt-2 text-sm font-bold text-foreground"
        data-testid="part-cache-status"
      >
        {enabled ? 'Enabled' : 'Disabled'}
      </div>
      {enabled && (
        <>
          <div className={LINE} data-testid="part-cache-size">
            {size
              ? `${formatBytes(size.sizeBytes)} of ${formatBytes(maxBytes)} · ${size.fileCount} files`
              : `— of ${formatBytes(maxBytes)}`}
          </div>
          {current?.error && (
            <div className="mt-1 text-xs text-red-500">
              Scan error: {current.error}
            </div>
          )}
          <div className={LINE} data-testid="part-cache-ttl">
            TTL {ttlDays} days · oldest read{' '}
            <DateTime value={size?.oldestReadAt ?? null} />
          </div>
          {counters && (
            <div className={LINE} data-testid="part-cache-requests">
              {counters.hits} hits · {counters.misses} misses (hit rate{' '}
              {hitRate(counters)}) · {counters.fills} files written
            </div>
          )}
          <div className={LINE} data-testid="part-cache-last-sweep">
            {lastSweep ? (
              <>
                Last sweep <DateTime value={lastSweep.at} /> (
                {lastSweep.trigger}): removed {lastSweep.removedTtl.files} files
                / {formatBytes(lastSweep.removedTtl.bytes)} by TTL,{' '}
                {lastSweep.removedCap.files} /{' '}
                {formatBytes(lastSweep.removedCap.bytes)} by cap
              </>
            ) : (
              'No sweep yet'
            )}
          </div>
          {lastSweep?.error && (
            <div className="mt-1 text-xs text-red-500">
              Sweep error: {lastSweep.error}
            </div>
          )}
          <div className={LINE} data-testid="part-cache-deleted">
            Removed with deleted data (this worker):{' '}
            {removedByDataDeletion.files} files /{' '}
            {formatBytes(removedByDataDeletion.bytes)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {current ? (
              <>
                Size as of <DateTime value={current.scannedAt} />
              </>
            ) : (
              'Size and oldest read as of last sweep'
            )}
            {counters &&
              ` · requests since worker start (${counters.workers} worker${counters.workers === 1 ? '' : 's'})`}
          </div>
        </>
      )}
      <div
        className="mt-1 text-xs text-muted-foreground font-mono truncate"
        data-testid="part-cache-dir"
        title={dir}
      >
        {dir}
      </div>
    </Card>
  );
}
