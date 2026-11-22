/**
 * "Hot files" table of the OKF view: every KB article that was read, with its sessions / agents,
 * reads, ≈ tokens and ≈ $. Index files (`index.md` / `log.md`) are read by design, so they are
 * not listed — one line below the table sums them. Sorted by ≈ Tokens descending at first; a
 * click on a numeric header sorts by it, a second click flips the direction; ties go by path
 * ascending. The first `OKF_HOT_FILES_TOP` rows are shown until "Show all".
 */
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { formatApproxCost, formatApproxTokens } from '@/lib/okf/okf-format';
import type {
  OkfUsageFile,
  OkfUsageUnit,
} from '../../../../../models/repositories';
import { OkfTip } from './OkfTip';
import {
  OKF_HOT_FILES_TOP,
  OKF_TIP_COST,
  OKF_TIP_READS,
  OKF_TIP_TOKENS,
  OKF_UNIT_LABEL,
  okfCostCoverageText,
} from './okf-view-text';

type SortKey = 'units' | 'reads' | 'tokens' | 'cost';

function sortValue(file: OkfUsageFile, key: SortKey): number {
  // A file without a cost sorts below every priced one.
  if (key === 'cost') return file.cost ?? -1;
  return file[key];
}

function indexLineText(files: readonly OkfUsageFile[]): string {
  const tokens = files.reduce((s, f) => s + f.tokens, 0);
  const priced = files.filter((f) => f.cost !== null);
  const cost =
    priced.length === 0 ? null : priced.reduce((s, f) => s + (f.cost ?? 0), 0);
  const lead =
    files.length === 1
      ? '1 index file is not listed'
      : `${files.length} index files are not listed`;
  return `${lead}: ≈ ${formatApproxTokens(tokens)} tokens, ≈ ${formatApproxCost(cost, true)} — see the explorer`;
}

export function OkfHotFilesTable({
  files,
  unit,
  readsWithoutCost,
}: {
  files: OkfUsageFile[];
  unit: OkfUsageUnit;
  readsWithoutCost: number;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDesc, setSortDesc] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const dir = sortDesc ? -1 : 1;
    return files
      .filter((f) => f.units > 0 && !f.index)
      .sort((a, b) => {
        const d = sortValue(a, sortKey) - sortValue(b, sortKey);
        if (d !== 0) return d * dir;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
  }, [files, sortKey, sortDesc]);
  const indexFiles = useMemo(
    () => files.filter((f) => f.index && f.units > 0),
    [files],
  );
  const shown = showAll ? rows : rows.slice(0, OKF_HOT_FILES_TOP);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const columns: { key: SortKey; label: string; tip?: ReactNode }[] = [
    { key: 'units', label: OKF_UNIT_LABEL[unit] },
    {
      key: 'reads',
      label: 'Reads',
      tip: (
        <OkfTip testId="okf-tip-reads" label="About Reads">
          {OKF_TIP_READS}
        </OkfTip>
      ),
    },
    {
      key: 'tokens',
      label: '≈ Tokens',
      tip: (
        <OkfTip testId="okf-tip-tokens" label="About ≈ Tokens">
          {OKF_TIP_TOKENS}
        </OkfTip>
      ),
    },
    {
      key: 'cost',
      label: '≈ $',
      tip: (
        <OkfTip testId="okf-tip-cost" label="About the KB cost">
          <p>{OKF_TIP_COST}</p>
          <p className="mt-1">{okfCostCoverageText(readsWithoutCost)}</p>
        </OkfTip>
      ),
    },
  ];

  return (
    <section
      data-testid="okf-hot-files"
      className="rounded-md border border-border bg-card p-3"
    >
      <h3 className="mb-1.5 text-sm font-semibold text-foreground">
        Hot files
      </h3>
      {rows.length === 0 ? (
        <div className="py-2 text-xs text-muted-foreground">No KB reads</div>
      ) : (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground">
              <th className="px-1 py-1 text-left font-medium">File</th>
              {columns.map((col) => {
                const active = sortKey === col.key;
                const Arrow = sortDesc ? ArrowDown : ArrowUp;
                return (
                  <th
                    key={col.key}
                    aria-sort={
                      active ? (sortDesc ? 'descending' : 'ascending') : 'none'
                    }
                    className="w-[5.5rem] px-1 py-1 text-right font-medium"
                  >
                    <span className="inline-flex items-center justify-end gap-1">
                      <button
                        type="button"
                        data-testid={`okf-hot-sort-${col.key}`}
                        onClick={() => handleSort(col.key)}
                        className={`inline-flex items-center gap-0.5 hover:text-foreground ${
                          active ? 'text-foreground' : ''
                        }`}
                      >
                        {col.label}
                        {active ? <Arrow className="size-3" /> : null}
                      </button>
                      {col.tip}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr
                key={f.path}
                data-testid="okf-hot-row"
                data-path={f.path}
                className="border-b border-border/50 last:border-b-0"
              >
                <td className="px-1 py-1">
                  {/* Truncated from the left: the file name stays visible. */}
                  <span
                    title={f.path}
                    className="block truncate text-left font-mono [direction:rtl]"
                  >
                    <bdi>{f.path}</bdi>
                  </span>
                </td>
                <td className="px-1 py-1 text-right font-mono tabular-nums">
                  {f.units}
                </td>
                <td className="px-1 py-1 text-right font-mono tabular-nums">
                  {f.reads}
                </td>
                <td className="px-1 py-1 text-right font-mono tabular-nums">
                  {formatApproxTokens(f.tokens)}
                </td>
                <td className="px-1 py-1 text-right font-mono tabular-nums">
                  {formatApproxCost(f.cost, false)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > OKF_HOT_FILES_TOP && !showAll ? (
        <button
          type="button"
          data-testid="okf-hot-show-all"
          onClick={() => setShowAll(true)}
          className="mt-2 block text-xs font-medium text-primary underline underline-offset-2"
        >
          Show all {rows.length} files
        </button>
      ) : null}
      {indexFiles.length > 0 ? (
        <p
          data-testid="okf-hot-index-line"
          className="mt-2 text-xs text-muted-foreground"
        >
          {indexLineText(indexFiles)}
        </p>
      ) : null}
    </section>
  );
}
