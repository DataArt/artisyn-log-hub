/**
 * One summary card per OKF bundle: root, tracked/gitignored chip, the "started from index.md"
 * marker (session route) or the count of sessions that did (repo route), files read and bytes
 * that went into context. Shared by the session and repo OKF tabs.
 */
import { formatBytes } from '@/lib/format';
import type { OkfBundleSummary } from '../../../../../models/repositories';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}

function filesRead(b: OkfBundleSummary): string {
  if (b.files === null) return `${b.filesRead.toLocaleString()} / ?`;
  const pct = b.share === null ? '' : ` · ${Math.round(b.share * 100)} %`;
  return `${b.filesRead.toLocaleString()} / ${b.files.toLocaleString()}${pct}`;
}

export function OkfBundleCards({
  bundles,
  onBundleClick,
}: {
  bundles: readonly OkfBundleSummary[];
  onBundleClick?: (root: string) => void;
}) {
  if (bundles.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3" data-testid="okf-bundle-cards">
      {bundles.map((b) => (
        <button
          key={b.root}
          type="button"
          data-testid="okf-bundle-card"
          onClick={() => onBundleClick?.(b.root)}
          className="w-72 space-y-2 rounded-md border border-border bg-card p-3 text-left hover:bg-accent/40"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate font-mono text-xs font-medium">
              {b.root}
            </span>
            <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">
              {b.ignored ? 'gitignored' : 'tracked'}
            </span>
          </div>
          {b.startedFromIndex === true ? (
            <div className="text-[11px] text-green-700">
              ✓ started from index.md
            </div>
          ) : null}
          {b.sessionsStartedFromIndex !== null &&
          b.sessionsStartedFromIndex > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              {b.sessionsStartedFromIndex.toLocaleString()} sessions started
              from index.md
            </div>
          ) : null}
          <div className="flex gap-6">
            <Stat label="Files read" value={filesRead(b)} />
            <Stat label="Bytes into context" value={formatBytes(b.readBytes)} />
          </div>
        </button>
      ))}
    </div>
  );
}
