/**
 * The KPI tiles of the repo OKF tab (styled like the executive-summary `KpiTiles`): KB
 * files, not read, KB sessions (+ upkeep-only), started from index, median file share per
 * session (section A); `OkfSignalTiles` — when the server sends them — pointer yield and
 * articles with routing misses (section B). The "not read" and "started from index" tiles are information only — never a finding.
 */
import { okfCount } from '@/lib/okf/okf-check-text';
import type { RepoOkfUsageResponse } from '../../../../models/repositories';

function pct(share: number): string {
  return `${Math.round(share * 100)} %`;
}

function Tile({
  label,
  value,
  subLine,
  accent,
  testId,
}: {
  label: string;
  value: string;
  subLine?: string;
  accent: string;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="relative overflow-hidden rounded-md border border-border bg-background p-3 pl-4"
    >
      <span
        className={`absolute inset-y-0 left-0 w-1 ${accent}`}
        aria-hidden="true"
      />
      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <p className="mt-2 text-lg font-bold text-foreground">{value}</p>
      <p className="mt-1 min-h-4 text-[11px] text-muted-foreground">
        {subLine ?? ''}
      </p>
    </div>
  );
}

function snapshotLine(snapshot: RepoOkfUsageResponse['snapshot']): string {
  if (!snapshot) return 'no snapshot in this period';
  const day = snapshot.takenAt.slice(0, 10);
  return snapshot.branch
    ? `snapshot ${day} (${snapshot.branch})`
    : `snapshot ${day}`;
}

export function OkfKpiTiles({
  tiles,
  snapshot,
  bundleCount,
}: {
  tiles: RepoOkfUsageResponse['tiles'];
  snapshot: RepoOkfUsageResponse['snapshot'];
  bundleCount: number;
}) {
  const fromIndexShare =
    tiles.kbSessions > 0 ? tiles.startedFromIndex / tiles.kbSessions : null;
  const upkeepOnly = tiles.upkeepOnlySessions ?? 0;
  return (
    <div
      data-testid="okf-kpi-tiles"
      className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
    >
      <Tile
        testId="okf-tile-kb-files"
        label={`KB files · ${bundleCount} ${bundleCount === 1 ? 'KB folder' : 'KB folders'}`}
        value={tiles.kbFiles.toLocaleString()}
        subLine={snapshotLine(snapshot)}
        accent="bg-blue-500"
      />
      <Tile
        testId="okf-tile-not-read"
        label="Not read (period) · info only"
        value={tiles.notRead.toLocaleString()}
        subLine="files"
        accent="bg-slate-400"
      />
      <Tile
        testId="okf-tile-sessions"
        label="Sessions in filter · touched KB"
        value={`${tiles.kbSessions.toLocaleString()} / ${tiles.totalSessions.toLocaleString()}`}
        subLine={
          upkeepOnly > 0
            ? `+ ${upkeepOnly.toLocaleString()} upkeep-only (not counted)`
            : undefined
        }
        accent="bg-violet-500"
      />
      <Tile
        testId="okf-tile-from-index"
        label="Started from index · info only"
        value={`${tiles.startedFromIndex.toLocaleString()} / ${tiles.kbSessions.toLocaleString()}`}
        subLine={fromIndexShare === null ? undefined : pct(fromIndexShare)}
        accent="bg-slate-400"
      />
      <Tile
        testId="okf-tile-share"
        label="Median file share / session"
        value={tiles.medianShare === null ? 'n/a' : pct(tiles.medianShare)}
        subLine={
          tiles.maxShare === null
            ? 'no snapshot-bound session'
            : `max ${pct(tiles.maxShare)}`
        }
        accent="bg-teal-500"
      />
    </div>
  );
}

/**
 * The value-signal tiles (section B of the repo OKF tab): pointer yield and articles with
 * routing misses. Hidden on an older server, which omits the fields.
 */
export function OkfSignalTiles({
  tiles,
}: {
  tiles: RepoOkfUsageResponse['tiles'];
}) {
  if (
    tiles.pointerYield === undefined &&
    tiles.routingMissArticles === undefined
  ) {
    return null;
  }
  return (
    <div
      data-testid="okf-signal-tiles"
      className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <Tile
        testId="okf-tile-pointer-yield"
        label="Pointer yield"
        value={
          tiles.pointerYield && tiles.pointerYield.n > 0
            ? `${tiles.pointerYield.k.toLocaleString()} of ${tiles.pointerYield.n.toLocaleString()} reads`
            : '—'
        }
        subLine="reads with a new pointer that was followed"
        accent="bg-emerald-500"
      />
      <Tile
        testId="okf-tile-routing-miss"
        label="Articles with routing misses"
        value={(tiles.routingMissArticles ?? 0).toLocaleString()}
        subLine={`${okfCount(tiles.routingMissPairs ?? 0, 'miss', 'misses')}, counted per agent and article`}
        accent="bg-amber-500"
      />
    </div>
  );
}
