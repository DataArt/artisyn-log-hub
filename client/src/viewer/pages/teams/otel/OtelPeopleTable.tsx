/**
 * The People table of the team OTEL tab (2026-10-30 otel-tabs-traces, DD-29): every person of
 * the period and filters, most expensive first, with a cost trend and a "live" chip. Clicking a
 * row filters the whole tab to that person (clicking the selected person clears it).
 */
import { cn } from '@/lib/cn';
import type { OtelTeamPersonRow } from '../../../../models/teams';
import {
  formatCount,
  formatMicrosUsd,
  formatShare,
  otelCacheReadRatio,
} from '../../repository/otel/otel-format';
import { OtelSparkline } from '../../repository/otel/OtelKpiTile';

export interface OtelPeopleTableProps {
  people: readonly OtelTeamPersonRow[];
  /** The person the tab is filtered to, or null. */
  selectedUserId: number | null;
  onSelect: (userId: number | null) => void;
}

export function OtelPeopleTable({
  people,
  selectedUserId,
  onSelect,
}: OtelPeopleTableProps) {
  return (
    <section className="rounded-md border p-4" data-testid="otel-people-table">
      <h3 className="text-sm font-semibold">People</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        click a row to filter the tab to that person
      </p>
      {people.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No one has OTEL data in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-3 font-medium">person</th>
                <th className="py-1.5 pr-3 text-right font-medium">sessions</th>
                <th className="py-1.5 pr-3 text-right font-medium">cost</th>
                <th className="py-1.5 pr-3 text-right font-medium">hidden</th>
                <th className="py-1.5 pr-3 text-right font-medium">
                  cache read
                </th>
                <th className="py-1.5 pr-3 font-medium">models</th>
                <th className="py-1.5 pr-3 text-right font-medium">repos</th>
                <th className="py-1.5 pr-3 font-medium">trend</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const selected = p.userId === selectedUserId;
                const ratio = otelCacheReadRatio(
                  Number(p.inputTokens) || 0,
                  Number(p.cacheReadTokens) || 0,
                  Number(p.cacheWriteTokens) || 0,
                );
                return (
                  <tr
                    key={p.userId}
                    className={cn(
                      'cursor-pointer border-b last:border-b-0 hover:bg-accent',
                      selected && 'bg-blue-50',
                    )}
                    onClick={() => onSelect(selected ? null : p.userId)}
                    aria-selected={selected}
                    data-testid="otel-person-row"
                  >
                    <td className="py-1.5 pr-3">{p.email}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {formatCount(p.sessions)}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {formatMicrosUsd(p.costUsdMicros)}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {formatMicrosUsd(p.hiddenCostUsdMicros)}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {ratio === null ? 'n/a' : formatShare(ratio)}
                    </td>
                    <td
                      className="max-w-[220px] truncate py-1.5 pr-3"
                      title={p.models.join(', ')}
                    >
                      {p.models.join(', ') || '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {formatCount(p.repositories)}
                    </td>
                    <td className="w-24 py-1.5 pr-3">
                      <OtelSparkline values={p.trend} />
                    </td>
                    <td className="py-1.5 whitespace-nowrap">
                      {p.live && (
                        <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                          live
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
