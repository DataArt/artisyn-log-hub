/**
 * The Change surface tab's headline row (6 cells).
 *
 * Every figure is read straight off the server payload: the same numbers the
 * Summary tile, the report and the analytics chart render, never a client-side recomputation.
 */
import type { ReactNode } from 'react';
import {
  bandTextClass,
  bandLabel,
  formatAncestorDepth,
  formatConcentration,
  formatLinesAdded,
  formatLinesRemoved,
  formatSurfaceCount,
} from '@/lib/change-surface-ui';
import type { ChangeSurfaceAggregate } from '../../../../../models/repositories';

function HeadlineCell({
  label,
  value,
  valueClassName,
  caption,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  caption: ReactNode;
}) {
  return (
    <div className="min-w-[150px] flex-1 border-l border-border px-4 py-3 first:border-l-0 first:pl-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-xl font-bold ${valueClassName ?? ''}`}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{caption}</div>
    </div>
  );
}

export function ChangeSurfaceHeadline({
  data,
}: {
  data: ChangeSurfaceAggregate;
}) {
  const modules = data.topLevelModules;
  const moduleCaption =
    modules.length > 0 ? modules.slice(0, 6).join(' / ') : 'none';

  return (
    <div
      data-testid="change-surface-headline"
      className="flex flex-wrap items-stretch rounded-md border border-border bg-card px-4 py-1"
    >
      <HeadlineCell
        label="Changed files"
        value={formatSurfaceCount(data.changedFiles)}
        caption="distinct paths, whole tree"
      />
      <HeadlineCell
        label="Folders touched"
        value={formatSurfaceCount(data.foldersTouched)}
        caption="full dir paths, siblings distinct"
      />
      <HeadlineCell
        label="Concentration"
        value={formatConcentration(data.concentration)}
        caption={
          <span className={bandTextClass(data.band)}>
            {bandLabel(data.band)}
          </span>
        }
      />
      <HeadlineCell
        label="Lines +/−"
        value={
          <span className="whitespace-nowrap">
            <span className="text-green-600">
              {formatLinesAdded(data.linesAdded)}
            </span>{' '}
            <span className="text-red-600">
              {formatLinesRemoved(data.linesRemoved)}
            </span>
          </span>
        }
        caption={`diff-based, ${data.diffCoveredFiles.toLocaleString()} of ${data.changedFiles.toLocaleString()} files covered`}
      />
      <HeadlineCell
        label="Top-level modules"
        value={formatSurfaceCount(modules.length)}
        caption={moduleCaption}
      />
      <HeadlineCell
        label="Common ancestor"
        value={formatAncestorDepth(data.commonAncestorDepth)}
        caption={
          data.commonAncestorDepth === 0
            ? 'repo root — reaches everywhere'
            : 'shared prefix of every changed path'
        }
      />
    </div>
  );
}
