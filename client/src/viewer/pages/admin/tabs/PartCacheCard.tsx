import type { SystemInfoPartCache } from '../../../../models';
import { DateTime } from '../../../components/DateTime';
import { formatBytes } from '../../../lib/format';
import { Card } from './system-card';

const LINE = 'mt-1 text-sm font-bold text-foreground';

/** Admin System tab card for the session-part disk cache (size and age are as of the last sweep). */
export function PartCacheCard({
  partCache,
}: {
  partCache: SystemInfoPartCache;
}) {
  const { enabled, dir, maxBytes, ttlDays, lastSweep, removedByDataDeletion } =
    partCache;

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
            {lastSweep
              ? `${formatBytes(lastSweep.sizeBytes)} of ${formatBytes(maxBytes)} · ${lastSweep.fileCount} files`
              : `— of ${formatBytes(maxBytes)}`}
          </div>
          <div className={LINE} data-testid="part-cache-ttl">
            TTL {ttlDays} days · oldest read{' '}
            <DateTime value={lastSweep?.oldestReadAt ?? null} />
          </div>
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
            Size and oldest read as of last sweep
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
