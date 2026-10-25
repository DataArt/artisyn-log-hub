import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Loader2 } from 'lucide-react';
import type { SystemInfoWorkerProcess } from '../../../../models';
import { downloadLogsArchive, fetchSystemInfo } from '../../../api';
import { PageState } from '../../../components/PageState';
import { DateTime } from '../../../components/DateTime';
import { formatBytes } from '../../../lib/format';
import { cn } from '../../../lib/cn';
import { Button } from '../../../ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../../../ui/table';

type DotColor = 'green' | 'gray' | 'red';

const DOT_CLASSES: Record<DotColor, string> = {
  green: 'bg-emerald-600',
  gray: 'bg-gray-400',
  red: 'bg-red-500',
};

function StatusDot({ color }: { color: DotColor }) {
  return (
    <span
      className={cn('inline-block size-2.5 rounded-full', DOT_CLASSES[color])}
    />
  );
}

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const s = totalSeconds % 60;
    return `${totalMinutes}m ${s}s`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h ${mins}m`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}

function rowStatusColor(status: string, clustered: boolean): DotColor {
  if (!clustered) return 'gray';
  const s = status.toLowerCase();
  if (s.includes('online')) return 'green';
  if (s.includes('error') || s.includes('stop')) return 'red';
  return 'gray';
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background p-4">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function SecondaryTile({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-bold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{caption}</div>
    </div>
  );
}

function DownloadLogsTile() {
  const [state, setState] = useState<'idle' | 'downloading' | 'error'>('idle');
  // Checked synchronously (unlike `state`, which only updates on next render)
  // so a rapid second click can't slip through before the button disables.
  const inFlightRef = useRef(false);

  const handleClick = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setState('downloading');
    try {
      await downloadLogsArchive();
      setState('idle');
    } catch {
      setState('error');
    } finally {
      inFlightRef.current = false;
    }
  };

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        Logs Archive
      </div>
      <Button
        variant="outline"
        size="xs"
        className="mt-1.5 w-full"
        disabled={state === 'downloading'}
        onClick={handleClick}
      >
        {state === 'downloading' ? (
          <>
            <Loader2 className="animate-spin" />
            In progress
          </>
        ) : (
          <>
            <Download />
            Download ZIP
          </>
        )}
      </Button>
      {state === 'error' && (
        <div className="mt-1 text-[10px] text-red-500">Download failed</div>
      )}
    </div>
  );
}

function useUpdatedAgoLabel(dataUpdatedAt: number): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!dataUpdatedAt) return '';
  const secondsAgo = Math.max(
    0,
    Math.round((Date.now() - dataUpdatedAt) / 1000),
  );
  return `Updated ${secondsAgo}s ago`;
}

export function AdminSystemTab() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['admin-system'],
    queryFn: fetchSystemInfo,
    refetchInterval: 10_000,
  });

  const updatedAgoLabel = useUpdatedAgoLabel(dataUpdatedAt);

  if (isLoading) return <PageState message="Loading…" />;
  if (isError || !data)
    return <PageState message="Failed to load system info." variant="error" />;

  const {
    instances,
    cpus,
    loadAverage,
    memory,
    uptime,
    db,
    dbSpace,
    build,
    node,
    eventLoopLagMs,
    requests,
    disk,
    supervisor,
  } = data;

  const instancesCaption = supervisor.clustered
    ? `Cluster mode · ${
        instances.actual === instances.expected
          ? 'all running'
          : `${instances.actual} of ${instances.expected} running`
      }`
    : 'No supervisor detected · single process';

  const memoryProcessFraction =
    memory.systemTotalBytes > 0
      ? Math.min(100, (memory.processRssBytes / memory.systemTotalBytes) * 100)
      : 0;

  const shortCommit =
    build.gitCommit === 'unknown' ? 'unknown' : build.gitCommit.slice(0, 7);

  const poolActive = db.pool.total - db.pool.idle;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot color="green" />
          <span className="text-xs text-muted-foreground">
            Auto-refreshing every 10s ·{' '}
            {supervisor.clustered
              ? 'aggregated across all cluster workers'
              : 'running as a single process (no cluster)'}
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground/70">
          {updatedAgoLabel}
        </span>
      </div>

      {/* Core card grid: 3 columns -> 1 column on narrow viewports */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card label="Node Instances">
          <div className="mt-2 flex items-center gap-2">
            <span className="text-2xl font-bold text-foreground">
              {instances.actual} / {instances.expected}
            </span>
            <StatusDot color={supervisor.clustered ? 'green' : 'gray'} />
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            {instancesCaption}
          </div>
        </Card>

        <Card label="Visible CPUs">
          <div className="mt-2 text-2xl font-bold text-foreground">
            {cpus.visible}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            availableParallelism() · raw cores: {cpus.raw}
          </div>
        </Card>

        <Card label="Database">
          <div className="mt-2 flex items-center gap-2">
            <span
              className={cn(
                'text-xl font-bold',
                db.connected ? 'text-emerald-600' : 'text-red-500',
              )}
            >
              {db.connected ? 'Connected' : 'Disconnected'}
            </span>
            <StatusDot color={db.connected ? 'green' : 'red'} />
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            {db.pingMs !== null
              ? `Ping latency: ${db.pingMs} ms`
              : 'Ping latency: n/a'}
          </div>
        </Card>

        <Card label="Memory">
          <div className="mt-2 text-xl font-bold text-foreground">
            {formatBytes(memory.processRssBytes)} /{' '}
            {formatBytes(memory.systemTotalBytes)}
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-blue-500"
              style={{ width: `${memoryProcessFraction}%` }}
            />
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Process · System: {formatBytes(memory.systemUsedBytes)} /{' '}
            {formatBytes(memory.systemTotalBytes)}
          </div>
        </Card>

        <Card label="Uptime">
          <div className="mt-2 text-xl font-bold text-foreground">
            {formatUptime(uptime.processSeconds)}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Process uptime
          </div>
          <div className="text-[11px] text-muted-foreground">
            {uptime.containerSeconds !== null
              ? `Container: ${formatUptime(uptime.containerSeconds)}`
              : 'Container: n/a (no container)'}
          </div>
        </Card>

        <Card label="Load Average">
          <div className="mt-2 text-xl font-bold text-foreground">
            {loadAverage.map((v) => v.toFixed(2)).join(' / ')}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            1m / 5m / 15m
          </div>
          <div className="text-[11px] text-muted-foreground">
            vs. {cpus.visible} visible CPUs
          </div>
        </Card>
      </div>

      {/* Secondary metrics strip: 6 tiles + the logs-archive tile, wraps to 2
          columns on narrow viewports */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SecondaryTile
          label="Build"
          value={build.version}
          caption={`git ${shortCommit}`}
        />
        <SecondaryTile
          label="Node / Env"
          value={node.version}
          caption={node.env}
        />
        <SecondaryTile
          label="Event Loop"
          value={`${eventLoopLagMs.toFixed(1)} ms`}
          caption="lag, this instance"
        />
        <SecondaryTile
          label="DB Pool"
          value={`${poolActive} / ${db.pool.max}`}
          caption="active, per instance"
        />
        <SecondaryTile
          label="Disk"
          value={`${formatBytes(disk.logsDirBytes)} / ${formatBytes(disk.filesystemTotalBytes)}`}
          caption="logs directory"
        />
        <DownloadLogsTile />
        <SecondaryTile
          label="Requests"
          value={`${requests.perSecond} / s`}
          caption={`active req: ${requests.active}`}
        />
      </div>

      {/* DB Space card — omitted entirely when the DB role lacks size-inspection rights.
          Wrapped in the same 3-column grid as the core cards so it takes up one card's
          width instead of stretching full-page-wide with a large empty area. */}
      {dbSpace.available &&
        dbSpace.logsTableRowEstimate !== null &&
        dbSpace.logsTableBytes !== null &&
        dbSpace.databaseTotalBytes !== null && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card label="DB Space">
              <div className="mt-2 text-sm font-bold text-foreground">
                Logs table: {dbSpace.logsTableRowEstimate.toLocaleString()} rows
                · {formatBytes(dbSpace.logsTableBytes)}
              </div>
              <div className="mt-1 text-sm font-bold text-foreground">
                Database total: {formatBytes(dbSpace.databaseTotalBytes)}
              </div>
            </Card>
          </div>
        )}

      {/* Per-instance breakdown table */}
      <div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Per-Instance Breakdown
          </span>
          {!supervisor.clustered && (
            <span className="text-[11px] text-muted-foreground">
              Running without a supervisor — showing this process only
            </span>
          )}
        </div>
        <div className="mt-2 rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PID</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead>Restarts</TableHead>
                <TableHead>Last Restart</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {supervisor.processes.map((proc: SystemInfoWorkerProcess) => (
                <TableRow key={proc.instance ?? proc.pid}>
                  <TableCell>{proc.pid}</TableCell>
                  <TableCell>
                    {proc.memoryBytes !== null ? (
                      formatBytes(proc.memoryBytes)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{proc.restarts}</TableCell>
                  <TableCell>
                    {proc.lastRestartAt !== null ? (
                      <DateTime value={proc.lastRestartAt} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot
                        color={rowStatusColor(
                          proc.status,
                          supervisor.clustered,
                        )}
                      />
                      {proc.status}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
