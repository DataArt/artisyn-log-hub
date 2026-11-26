/**
 * The Spend tab cost slices (2026-11-05 budgets-threshold-alerts, DD-8, Visual notes): a column
 * picker over `SpendView.slices` (kept in the `ssl` URL param), the rows with sessions / cost /
 * share, `Not reported` in muted text and a Total row. A row click opens its sessions.
 *
 * otel-session-tags: a "Tag: <key>" chip after the slice chips (only when the period has tag
 * keys) picks the `tag` slice — `ssl=tag` plus `tagKey=<key>`, which makes the server add that
 * slice. Its rows are the key's values plus "(untagged)"; a session with several values counts in
 * each, so shares can sum above 100 % and a caveat says so.
 */
import { ChevronDown } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { SpendSlice, SpendSliceKind } from '../../../models/budgets';
import { cn } from '@/lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { formatUsdMicros } from '../budgets/budget-format';
import {
  SLICE_NOT_REPORTED_KEY,
  SPEND_SLICE_LABELS,
  SPEND_SLICE_ORDER,
  SPEND_TAG_KEY_PARAM,
} from './spend-format';
import { UNTAGGED_GROUP } from '../../lib/session-tags';

const SLICE_PARAM = 'ssl';

interface Props {
  slices: readonly SpendSlice[];
  spendMicros: number;
  sessions: number;
  /** DD-9: the User column is hidden in the restricted view. */
  restricted: boolean;
  /** Tag keys on the period's root sessions; the Tag chip is hidden when empty. */
  tagKeys: readonly string[];
  /** The selected tag key (`tagKey` URL param), if any. */
  tagKey: string | undefined;
  onRowClick: (kind: SpendSliceKind, key: string, label: string) => void;
}

const CHIP =
  'rounded-md border px-2 py-0.5 text-xs transition-colors inline-flex items-center gap-1';
const CHIP_ON = 'border-blue-600 bg-blue-50 text-blue-700';
const CHIP_OFF = 'border-border text-muted-foreground hover:bg-accent/50';

export function SliceTable({
  slices,
  spendMicros,
  sessions,
  restricted,
  tagKeys,
  tagKey,
  onRowClick,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const kinds = SPEND_SLICE_ORDER.filter(
    (k) => (!restricted || k !== 'user') && slices.some((s) => s.kind === k),
  );
  const tagSlice = slices.find((s) => s.kind === 'tag');
  const showTagChip = tagKeys.length > 0;
  if (kinds.length === 0 && !showTagChip) return null;

  const requested = searchParams.get(SLICE_PARAM);
  const kind: SpendSliceKind | undefined =
    requested === 'tag' && tagKey !== undefined
      ? 'tag'
      : (kinds.find((k) => k === requested) ?? kinds[0]);
  const rows =
    kind === 'tag'
      ? (tagSlice?.rows ?? [])
      : (slices.find((s) => s.kind === kind)?.rows ?? []);
  // Fan-out: a session with several values of the key counts in full in each row.
  const shareSum = rows.reduce((sum, r) => sum + r.share, 0);
  const fanOut = kind === 'tag' && shareSum > 1.0005;

  function pick(next: SpendSliceKind) {
    const params = new URLSearchParams(searchParams);
    if (next === kinds[0]) params.delete(SLICE_PARAM);
    else params.set(SLICE_PARAM, next);
    params.delete(SPEND_TAG_KEY_PARAM);
    setSearchParams(params, { replace: true });
  }

  function pickTagKey(key: string) {
    const params = new URLSearchParams(searchParams);
    params.set(SLICE_PARAM, 'tag');
    params.set(SPEND_TAG_KEY_PARAM, key);
    setSearchParams(params, { replace: true });
  }

  const firstColumn =
    kind === 'tag' && tagKey !== undefined
      ? tagKey
      : kind !== undefined
        ? SPEND_SLICE_LABELS[kind]
        : '';

  return (
    <div className="space-y-2" data-testid="spend-slices">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">Slice by</span>
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => pick(k)}
            className={cn(CHIP, k === kind ? CHIP_ON : CHIP_OFF)}
            data-testid={`spend-slice-${k}`}
            aria-pressed={k === kind}
          >
            {SPEND_SLICE_LABELS[k]}
          </button>
        ))}
        {showTagChip && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(CHIP, kind === 'tag' ? CHIP_ON : CHIP_OFF)}
                data-testid="spend-slice-tag"
                aria-pressed={kind === 'tag'}
              >
                <span className="max-w-48 truncate">
                  {kind === 'tag' && tagKey !== undefined
                    ? `Tag: ${tagKey}`
                    : 'Tag'}
                </span>
                <ChevronDown className="size-3 opacity-60" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-1">
              <div
                className="flex max-h-72 flex-col overflow-y-auto"
                data-testid="spend-tag-keys"
              >
                {tagKeys.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => pickTagKey(k)}
                    title={k}
                    className={cn(
                      'truncate rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-accent/50',
                      k === tagKey && kind === 'tag' && 'bg-accent',
                    )}
                    data-testid="spend-tag-key"
                  >
                    {k}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {kind !== undefined && (
        <table className="w-full max-w-3xl text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="max-w-80 truncate py-2 pr-4 font-medium">
                {firstColumn}
              </th>
              <th className="py-2 pr-4 text-right font-medium">Sessions</th>
              <th className="py-2 pr-4 text-right font-medium">Cost</th>
              <th className="py-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const muted =
                r.key === SLICE_NOT_REPORTED_KEY || r.key === UNTAGGED_GROUP;
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
              <td className="py-1.5 pr-4 text-right tabular-nums">
                {sessions}
              </td>
              <td className="py-1.5 pr-4 text-right tabular-nums">
                {formatUsdMicros(spendMicros)}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {spendMicros > 0 ? '100.0 %' : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {fanOut && (
        <p
          className="max-w-3xl text-xs text-amber-700 dark:text-amber-300"
          data-testid="spend-tag-fanout"
        >
          ⚠ A session with several values of this tag counts in full in every
          matching row, so the rows add up to more than the total.
        </p>
      )}
    </div>
  );
}
