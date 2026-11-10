/**
 * The Spend tab cost slices (2026-11-05 budgets-threshold-alerts, DD-8, Visual notes): a column
 * picker over `SpendView.slices` (kept in the `ssl` URL param), the rows with sessions / cost /
 * share, `Not reported` in muted text and a Total row. A row click opens its sessions.
 */
import { useSearchParams } from 'react-router-dom';
import type { SpendSlice, SpendSliceKind } from '../../../models/budgets';
import { cn } from '@/lib/cn';
import { formatUsdMicros } from '../budgets/budget-format';
import {
  SLICE_NOT_REPORTED_KEY,
  SPEND_SLICE_LABELS,
  SPEND_SLICE_ORDER,
} from './spend-format';

const SLICE_PARAM = 'ssl';

interface Props {
  slices: readonly SpendSlice[];
  spendMicros: number;
  sessions: number;
  /** DD-9: the User column is hidden in the restricted view. */
  restricted: boolean;
  onRowClick: (kind: SpendSliceKind, key: string, label: string) => void;
}

export function SliceTable({
  slices,
  spendMicros,
  sessions,
  restricted,
  onRowClick,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const kinds = SPEND_SLICE_ORDER.filter(
    (k) => (!restricted || k !== 'user') && slices.some((s) => s.kind === k),
  );
  if (kinds.length === 0) return null;

  const requested = searchParams.get(SLICE_PARAM);
  const kind = kinds.find((k) => k === requested) ?? kinds[0];
  const rows = slices.find((s) => s.kind === kind)?.rows ?? [];

  function pick(next: SpendSliceKind) {
    const params = new URLSearchParams(searchParams);
    if (next === kinds[0]) params.delete(SLICE_PARAM);
    else params.set(SLICE_PARAM, next);
    setSearchParams(params, { replace: true });
  }

  return (
    <div className="space-y-2" data-testid="spend-slices">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">Slice by</span>
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => pick(k)}
            className={cn(
              'rounded-md border px-2 py-0.5 text-xs transition-colors',
              k === kind
                ? 'border-blue-600 bg-blue-50 text-blue-700'
                : 'border-border text-muted-foreground hover:bg-accent/50',
            )}
            data-testid={`spend-slice-${k}`}
            aria-pressed={k === kind}
          >
            {SPEND_SLICE_LABELS[k]}
          </button>
        ))}
      </div>
      <table className="w-full max-w-3xl text-sm">
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">
              {SPEND_SLICE_LABELS[kind]}
            </th>
            <th className="py-2 pr-4 text-right font-medium">Sessions</th>
            <th className="py-2 pr-4 text-right font-medium">Cost</th>
            <th className="py-2 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const muted = r.key === SLICE_NOT_REPORTED_KEY;
            return (
              <tr
                key={r.key}
                className={cn(
                  'cursor-pointer border-t border-border hover:bg-accent/50',
                  muted && 'text-muted-foreground',
                )}
                onClick={() => onRowClick(kind, r.key, r.label)}
                data-testid="slice-row"
              >
                <td className="max-w-80 truncate py-1.5 pr-4" title={r.label}>
                  {r.label}
                </td>
                <td className="py-1.5 pr-4 text-right tabular-nums">
                  {r.sessions}
                </td>
                <td className="py-1.5 pr-4 text-right tabular-nums">
                  {formatUsdMicros(r.micros)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {(r.share * 100).toFixed(1)} %
                </td>
              </tr>
            );
          })}
          <tr
            className="border-t-2 border-border font-medium"
            data-testid="slice-total"
          >
            <td className="py-1.5 pr-4">Total</td>
            <td className="py-1.5 pr-4 text-right tabular-nums">{sessions}</td>
            <td className="py-1.5 pr-4 text-right tabular-nums">
              {formatUsdMicros(spendMicros)}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {spendMicros > 0 ? '100.0 %' : '—'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
