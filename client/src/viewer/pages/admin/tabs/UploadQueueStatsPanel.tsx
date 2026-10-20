import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UploadQueueStatus } from '../../../../models';
import { fetchAdminUploadQueueStats } from '../../../api';
import { PageState } from '../../../components/PageState';
import { formatBytes, formatDuration } from '../../../lib/format';

/**
 * One labelled group of stats inside the panel. Groups sit side by side and wrap as a unit,
 * so a narrow viewport never splits a group's tiles across two rows.
 */
function StatGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

/**
 * A compact stat tile. Fixed 92px width — narrow enough that all four groups fit a single
 * row on a 1920px viewport with the left nav open — and a fixed-height caption line on
 * **every** tile — even
 * the ones with no caption — so tiles line up in a clean grid across all four groups instead
 * of each group setting its own height.
 */
function Stat({
  label,
  value,
  caption,
  title,
}: {
  label: string;
  value: ReactNode;
  caption?: string;
  title?: string;
}) {
  return (
    <div
      className="w-[92px] rounded-md border border-border bg-muted/30 px-2 py-1.5"
      title={title}
    >
      <div className="truncate text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-bold leading-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="h-[14px] truncate text-[10px] leading-[14px] text-muted-foreground">
        {caption ?? ''}
      </div>
    </div>
  );
}

/**
 * En dash, matching what `formatDuration(null)` returns — so a "not measurable in this
 * window" rate reads the same as a "not measurable" duration.
 */
const DASH = '–';

/**
 * `formatBytes` takes a bare `number`, so the two rate formatters below handle the `null`
 * case themselves rather than widening the shared helper's signature: a `null` rate must
 * render as a dash, never as `0`, `Infinity` or `NaN`.
 */
function formatFileRate(v: number | null): string {
  return v == null ? DASH : `${v.toFixed(2)}/s`;
}

function formatByteRate(v: number | null): string {
  return v == null ? DASH : `${formatBytes(v)}/s`;
}

/**
 * Human label for a *window* length, used in the group headings. `formatDuration` tops out at
 * minutes, so it renders the 7-day retention window as "10080m 0s" — correct but unreadable
 * in a heading. Days and hours are added here rather than in the shared helper, whose
 * minute-granularity output the rest of the app depends on.
 *
 * Still derived from the response, never hard-coded, so an operator who overrides
 * UPLOAD_QUEUE_STATS_WINDOW_MS does not get a heading that lies.
 */
function formatWindowLabel(ms: number): string {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  if (ms >= DAY && ms % DAY === 0) {
    const days = ms / DAY;
    return `${days}d`;
  }
  if (ms >= HOUR && ms % HOUR === 0) {
    const hours = ms / HOUR;
    return `${hours}h`;
  }
  return formatDuration(ms);
}

/** Short enough to fit a 92px tile; the untruncated wording goes in the `title`. */
const STATUS_LABELS: Record<
  UploadQueueStatus,
  { short: string; full: string }
> = {
  pending: { short: 'Pending', full: 'Pending' },
  processing: { short: 'Processing', full: 'Processing' },
  partially_uploaded: { short: 'Partial', full: 'Partially uploaded' },
  failed: { short: 'Failed', full: 'Failed' },
  rejected_foreign_session: {
    short: 'Rejected',
    full: 'Rejected: foreign session',
  },
};

/**
 * The worker load / throughput / latency block above the admin Upload Queue list.
 *
 * Deliberately its own component with its own `useQuery`, not inline markup in
 * `AdminUploadQueueTab`: the tab is already close to the component-size split threshold, and
 * this keeps the panel's fetch independent of the list's, so either can fail without taking
 * the other down.
 *
 * Layout: one full-width panel of compact fixed-width tiles in four labelled groups. It has
 * enough content to earn the full width (per `.claude/rules/client.md`), and stays inside a
 * ~200px height budget — one tile row on a wide screen, two when the groups wrap.
 *
 * Utilisation is a bounded 0-100% ratio, so per `docs/knowledgebase/ui-principles.md` it uses
 * the default foreground colour rather than `zoneColor()`.
 */
export function UploadQueueStatsPanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-upload-queue-stats'],
    queryFn: fetchAdminUploadQueueStats,
    refetchInterval: 5_000,
  });

  if (isLoading) return <PageState message="Loading…" />;
  if (isError || !data)
    return (
      <PageState message="Failed to load upload queue stats." variant="error" />
    );

  const stats = data;
  // Headings are derived from the response, never hard-coded, so overriding
  // UPLOAD_QUEUE_STATS_WINDOW_MS server-side cannot produce a UI that lies about its window.
  const windowLabel = formatWindowLabel(stats.windowMs);
  const retentionLabel = formatWindowLabel(stats.retentionWindowMs);

  return (
    <div className="w-full rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <StatGroup label="Queue">
          {stats.byStatus.map((bucket) => (
            <Stat
              key={bucket.status}
              label={STATUS_LABELS[bucket.status].short}
              title={STATUS_LABELS[bucket.status].full}
              value={bucket.files}
              caption={formatBytes(bucket.bytes)}
            />
          ))}
          <Stat
            label="Total"
            value={stats.total.files}
            caption={formatBytes(stats.total.bytes)}
          />
        </StatGroup>

        <StatGroup label={`Worker · last ${windowLabel}`}>
          <Stat
            label="Utilisation"
            value={`${stats.worker.utilizationPercent.toFixed(0)}%`}
            caption={`${stats.worker.instanceCount} instances`}
            title={`Worker active time as a share of ${stats.worker.instanceCount} instances × the ${windowLabel} window`}
          />
          <Stat
            label="Files/sec"
            value={formatFileRate(stats.worker.filesPerSec)}
            caption={`${stats.worker.successCount} ok · ${stats.worker.failureCount} fail`}
          />
          <Stat
            label="Throughput"
            value={formatByteRate(stats.worker.bytesPerSec)}
          />
          <Stat
            label="Drain ETA"
            value={formatDuration(stats.drainEtaMs)}
            title="Estimated time to clear the pending backlog at the measured rate"
          />
        </StatGroup>

        <StatGroup label={`Queue latency · last ${windowLabel}`}>
          <Stat label="Avg" value={formatDuration(stats.latency.avgMs)} />
          <Stat label="p95" value={formatDuration(stats.latency.p95Ms)} />
          <Stat label="Min" value={formatDuration(stats.latency.minMs)} />
          <Stat label="Max" value={formatDuration(stats.latency.maxMs)} />
        </StatGroup>

        <StatGroup label={`Avg speed · last ${retentionLabel}`}>
          <Stat
            label="Files/sec"
            value={formatFileRate(stats.worker7d.filesPerSec)}
            caption={`${stats.worker7d.successCount} files`}
          />
          <Stat
            label="Throughput"
            value={formatByteRate(stats.worker7d.bytesPerSec)}
            caption={`${stats.worker7d.successCount} files`}
          />
        </StatGroup>
      </div>
    </div>
  );
}
