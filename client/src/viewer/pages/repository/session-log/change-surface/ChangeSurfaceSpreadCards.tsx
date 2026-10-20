/**
 * The five spread-component cards: the inputs behind the single headline
 * concentration number.
 *
 * This tab is the only surface that shows the components; the Summary tile, the report and the
 * analytics chart show only the headline score. Every value is server-computed — the captions
 * quote other payload fields, they never recombine them into a metric.
 */
import type { ReactNode } from 'react';
import {
  formatSurfaceCount,
  formatSurfaceDecimal,
  formatPathDistance,
  formatSurfaceShare,
  CHANGE_SURFACE_NA,
} from '@/lib/change-surface-ui';
import type { ChangeSurfaceAggregate } from '../../../../../models/repositories';

function SpreadCard({
  label,
  value,
  caption,
  hint,
}: {
  label: string;
  value: string;
  caption: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-[180px] flex-1 rounded-md border border-border bg-card px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-bold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{caption}</div>
      {hint ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground/80">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function ChangeSurfaceSpreadCards({
  data,
}: {
  data: ChangeSurfaceAggregate;
}) {
  const largestFolder = data.folderDistribution[0] ?? null;
  const largestCaption =
    largestFolder === null || data.changedFiles === 0
      ? CHANGE_SURFACE_NA
      : `${largestFolder.files.toLocaleString()} of ${data.changedFiles.toLocaleString()} in ${largestFolder.folder}`;

  return (
    <div
      data-testid="change-surface-spread-cards"
      className="flex flex-wrap gap-3"
    >
      <SpreadCard
        label="Files / folder"
        value={formatSurfaceDecimal(data.filesPerFolder, 1)}
        caption={`${data.changedFiles.toLocaleString()} files ÷ ${data.foldersTouched.toLocaleString()} folders`}
        hint="low = thinly spread"
      />
      <SpreadCard
        label="Largest-folder share"
        value={formatSurfaceShare(data.largestFolderShare)}
        caption={largestCaption}
      />
      <SpreadCard
        label="Folder entropy (norm.)"
        value={formatSurfaceDecimal(data.folderEntropyNorm, 2)}
        caption="1.0 = one file per folder"
      />
      <SpreadCard
        label="Mean path distance"
        value={formatPathDistance(data.meanPathDistanceHops)}
        caption="avg tree distance between touched folders"
      />
      <SpreadCard
        label="Single-file folders"
        value={`${formatSurfaceCount(data.singleFileFolders)} of ${data.foldersTouched.toLocaleString()}`}
        caption="long tail of drive-by edits"
      />
    </div>
  );
}
