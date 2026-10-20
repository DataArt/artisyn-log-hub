/**
 * The tab's two "by type" axes plus the small breakdowns beside them.
 *
 * Axis A is the raw file extension (repo-independent, comparable across repos); axis B is the
 * fixed five-value file-kind taxonomy — deliberately not the repo's
 * configurable `fileCategories`, so the axis means the same thing in every repository.
 *
 * `deleted` is always `0`: deletions go through `Bash rm`, not through an Edit/Write call, so
 * they are not derivable here. The row is shown anyway, so the absence
 * reads as "none recorded" rather than as a missing category.
 */
import { useMemo, type ReactNode } from 'react';
import {
  formatExtension,
  formatLinesAdded,
  formatLinesRemoved,
} from '@/lib/change-surface-ui';
import type {
  ChangeSurfaceAggregate,
  FileKind,
} from '../../../../../models/repositories';

const FILE_KIND_LABELS: Record<FileKind, string> = {
  source: 'source',
  test: 'test',
  config: 'config',
  docs: 'docs',
  other: 'other',
};

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-[280px] flex-1 rounded-md border border-border bg-card px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {subtitle ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground/80">
          {subtitle}
        </div>
      ) : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * Per-module file counts. The aggregate carries the module *names* only, so the counts are
 * folded here out of the server's own folder distribution (whose file counts sum to
 * `changedFiles`) — a display regroup of one server figure, not a second metric.
 */
function moduleCounts(
  data: ChangeSurfaceAggregate,
): { module: string; files: number }[] {
  const byModule = new Map<string, number>();
  for (const row of data.folderDistribution) {
    const key = row.folder === '.' ? '.' : (row.folder.split('/')[0] ?? '.');
    byModule.set(key, (byModule.get(key) ?? 0) + row.files);
  }
  return [...byModule.entries()]
    .map(([module, files]) => ({ module, files }))
    .sort((a, b) => b.files - a.files || a.module.localeCompare(b.module));
}

export function ChangeSurfaceBreakdowns({
  data,
}: {
  data: ChangeSurfaceAggregate;
}) {
  const modules = useMemo(() => moduleCounts(data), [data]);
  const uncovered = Math.max(0, data.changedFiles - data.diffCoveredFiles);

  return (
    <div
      data-testid="change-surface-breakdowns"
      className="flex flex-wrap gap-3"
    >
      <Panel
        title="Axis A — file extension"
        subtitle="repo-independent, comparable across repos"
      >
        {data.byExtension.length === 0 ? (
          <div className="text-xs text-muted-foreground">No files</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase text-muted-foreground">
                <th className="py-1 font-medium">Ext</th>
                <th className="py-1 text-right font-medium">Files</th>
                <th className="py-1 text-right font-medium">+</th>
                <th className="py-1 text-right font-medium">−</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {data.byExtension.slice(0, 12).map((row) => (
                <tr key={row.extension} className="border-t border-border/60">
                  <td className="py-1">{formatExtension(row.extension)}</td>
                  <td className="py-1 text-right">
                    {row.files.toLocaleString()}
                  </td>
                  <td className="py-1 text-right text-green-600">
                    {formatLinesAdded(row.linesAdded)}
                  </td>
                  <td className="py-1 text-right text-red-600">
                    {formatLinesRemoved(row.linesRemoved)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          Change kind:{' '}
          <span className="font-mono">added {data.byChangeKind.added}</span> ·{' '}
          <span className="font-mono">
            modified {data.byChangeKind.modified}
          </span>{' '}
          ·{' '}
          <span className="font-mono">deleted {data.byChangeKind.deleted}</span>{' '}
          (deletions are not derivable from Edit/Write calls)
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Diff coverage: {data.diffCoveredFiles.toLocaleString()} of{' '}
          {data.changedFiles.toLocaleString()} files
          {uncovered > 0
            ? `; ${uncovered.toLocaleString()} show +0 / −0 with no diff coverage.`
            : '.'}
        </div>
      </Panel>

      <Panel
        title="Axis B — derived file kind"
        subtitle="fixed taxonomy, identical in every repository"
      >
        {data.byFileKind.length === 0 ? (
          <div className="text-xs text-muted-foreground">No files</div>
        ) : (
          <ul className="space-y-1.5">
            {data.byFileKind.map((row) => (
              <li key={row.kind} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span>{FILE_KIND_LABELS[row.kind]}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {row.files.toLocaleString()} · {Math.round(row.share * 100)}
                    %
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 w-full rounded-full bg-muted">
                  <div
                    className="h-1.5 rounded-full bg-blue-500"
                    style={{
                      width: `${Math.min(100, Math.round(row.share * 100))}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Top-level modules touched">
        {modules.length === 0 ? (
          <div className="text-xs text-muted-foreground">No files</div>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {modules.map((row) => (
              <li
                key={row.module}
                className="rounded border border-border px-2 py-0.5 text-xs"
              >
                <span className="font-mono">
                  {row.module === '.' ? '. (repo root)' : `${row.module}/`}
                </span>{' '}
                <span className="tabular-nums text-muted-foreground">
                  {row.files.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 text-[11px] text-muted-foreground">
          {data.outsideRepoFiles > 0 ? (
            <>
              + {data.outsideRepoFiles.toLocaleString()} path
              {data.outsideRepoFiles === 1 ? '' : 's'} outside the repo (
              {formatLinesAdded(data.outsideRepoLinesAdded)}{' '}
              {formatLinesRemoved(data.outsideRepoLinesRemoved)}) — listed in
              the tree, excluded from folder / spread / module math.
            </>
          ) : (
            <>0 paths outside the repo.</>
          )}
        </div>
      </Panel>
    </div>
  );
}
