/**
 * Session OKF tab: one summary card per KB folder (OKF bundle) this session opened — root,
 * tracked/gitignored chip, the "started from index.md" marker, "N of M articles read" and bytes
 * that went into context. KB folders with no file read are not cards: one muted line lists them
 * ("2 other KB folders not opened: …").
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

/** "2 of 116 articles read" — a count, not a share: reading few articles is not bad. */
function articlesRead(b: OkfBundleSummary): string {
  const read = b.filesRead.toLocaleString();
  if (b.files === null) return `${read} read`;
  return `${read} of ${b.files.toLocaleString()} ${b.files === 1 ? 'article' : 'articles'} read`;
}

export function OkfBundleCards({
  bundles,
  onBundleClick,
}: {
  bundles: readonly OkfBundleSummary[];
  onBundleClick?: (root: string) => void;
}) {
  if (bundles.length === 0) return null;
  const opened = bundles.filter((b) => b.filesRead > 0);
  const idle = bundles.filter((b) => b.filesRead === 0);
  return (
    <div className="space-y-2" data-testid="okf-bundle-cards">
      {opened.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {opened.map((b) => (
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
              <div className="text-sm" data-testid="okf-bundle-articles">
                {articlesRead(b)}
              </div>
              <Stat
                label="Bytes into context"
                value={formatBytes(b.readBytes)}
              />
            </button>
          ))}
        </div>
      ) : null}
      {idle.length > 0 ? (
        <div
          data-testid="okf-bundle-idle"
          className="text-xs text-muted-foreground"
        >
          {idle.length}
          {opened.length > 0 ? ' other' : ''}{' '}
          {idle.length === 1 ? 'KB folder' : 'KB folders'} not opened:{' '}
          {idle.map((b, i) => (
            <span key={b.root}>
              {i > 0 ? ', ' : ''}
              <button
                type="button"
                className="font-mono hover:underline"
                onClick={() => onBundleClick?.(b.root)}
              >
                {b.root}
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
