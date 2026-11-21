/**
 * Session OKF tab: one summary card per KB folder (OKF bundle) this session opened — the
 * front-matter title (root as a muted sub-line) or the root, its description, the
 * tracked/gitignored and "OKF x.y" chips, the "started from index.md" marker, "N of M articles
 * read", bytes that went into context, and the sky advice lines "N articles can be improved" and
 * "Newer format available". Old-hook data has no metadata, so those parts are absent. KB folders
 * with no file read are not cards: one muted line lists them ("2 other KB folders not opened: …").
 */
import { formatBytes } from '@/lib/format';
import type { OkfBundleSummary } from '../../../../../models/repositories';
import { OKF_HINT_LABELS } from './okf-tree';

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

/** Sky advice lines (never a warning): articles that can be improved, a newer OKF format. */
function BundleAdvice({ b }: { b: OkfBundleSummary }) {
  const improve = b.articlesWithHints ?? 0;
  if (improve === 0 && !b.newerFormatHint) return null;
  return (
    <div className="space-y-1 text-[11px]">
      {improve > 0 ? (
        <div data-testid="okf-bundle-can-improve">
          <div className="text-sky-700 dark:text-sky-300">
            {improve.toLocaleString()} {improve === 1 ? 'article' : 'articles'}{' '}
            can be improved
          </div>
          {b.hintReasons && b.hintReasons.length > 0 ? (
            <div className="text-muted-foreground">
              {b.hintReasons.map((r) => OKF_HINT_LABELS[r]).join(' · ')}
            </div>
          ) : null}
        </div>
      ) : null}
      {b.newerFormatHint ? (
        <div data-testid="okf-bundle-newer-format">
          <div className="text-sky-700 dark:text-sky-300">
            ⓘ Newer format available (0.3)
          </div>
          <div className="text-muted-foreground">
            Advice — this bundle still works as is.
          </div>
        </div>
      ) : null}
    </div>
  );
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
                {b.title ? (
                  <span
                    data-testid="okf-bundle-title"
                    className="min-w-0 truncate text-xs font-medium"
                  >
                    {b.title}
                  </span>
                ) : (
                  <span className="min-w-0 truncate font-mono text-xs font-medium">
                    {b.root}
                  </span>
                )}
                <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">
                  {b.ignored ? 'gitignored' : 'tracked'}
                </span>
                {b.okfVersion ? (
                  <span
                    data-testid="okf-bundle-version"
                    className="rounded border border-border px-1 text-[10px] text-muted-foreground"
                  >
                    OKF {b.okfVersion}
                  </span>
                ) : null}
              </div>
              {b.title ? (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {b.root}
                </div>
              ) : null}
              {b.description ? (
                <div
                  data-testid="okf-bundle-description"
                  className="line-clamp-2 text-[11px] text-muted-foreground"
                  title={b.description}
                >
                  {b.description}
                </div>
              ) : null}
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
              <BundleAdvice b={b} />
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
