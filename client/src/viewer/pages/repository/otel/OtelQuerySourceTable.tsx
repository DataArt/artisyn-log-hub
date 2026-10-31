/**
 * The `query_source` breakdown table of the OTEL tabs (2026-10-30 otel-tabs-traces, DD-21): one
 * row per source with its dictionary description, a "hidden" chip and a "new" chip for a name
 * the server's dictionary does not know.
 */
import type { OtelQuerySourceRow } from '../../../../models/repositories';
import {
  formatContextToOutput,
  formatCount,
  formatMicrosUsd,
  formatShare,
  microsToUsd,
} from './otel-format';

export interface OtelQuerySourceTableProps {
  rows: readonly OtelQuerySourceRow[];
  /** Session tab: the sessions column says nothing there. */
  showSessions?: boolean;
}

export function OtelQuerySourceTable({
  rows,
  showSessions = true,
}: OtelQuerySourceTableProps) {
  const sorted = [...rows].sort(
    (a, b) =>
      (microsToUsd(b.costUsdMicros) ?? 0) - (microsToUsd(a.costUsdMicros) ?? 0),
  );
  return (
    <section
      className="rounded-md border p-4"
      data-testid="otel-query-source-table"
    >
      <h3 className="mb-2 text-sm font-semibold">query_source breakdown</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 pr-3 font-medium">query_source</th>
              <th className="py-1.5 pr-3 font-medium">description</th>
              <th className="py-1.5 pr-3 text-right font-medium">calls</th>
              {showSessions && (
                <th className="py-1.5 pr-3 text-right font-medium">sessions</th>
              )}
              <th className="py-1.5 pr-3 text-right font-medium">cost</th>
              <th className="py-1.5 pr-3 text-right font-medium">share</th>
              <th className="py-1.5 pr-3 text-right font-medium">hidden</th>
              <th className="py-1.5 pr-3 text-right font-medium">
                ctx : output
              </th>
              <th className="py-1.5 font-medium">models</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.querySource}
                className="border-b last:border-b-0"
                data-testid="otel-qs-row"
              >
                <td className="py-1.5 pr-3">
                  <span className="font-mono">
                    {r.querySource || '(unknown)'}
                  </span>
                  {r.hidden && (
                    <span className="ml-1.5 rounded bg-red-50 px-1 text-[10px] text-red-700">
                      hidden
                    </span>
                  )}
                  {!r.known && (
                    <span
                      className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] text-amber-800"
                      title="Not in Log Hub's query_source dictionary yet"
                      data-testid="otel-qs-new"
                    >
                      new
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-muted-foreground">
                  {r.description ?? '— (not in dictionary)'}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {formatCount(r.calls)}
                </td>
                {showSessions && (
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatCount(r.sessions)}
                  </td>
                )}
                <td className="py-1.5 pr-3 text-right font-mono">
                  {formatMicrosUsd(r.costUsdMicros)}
                </td>
                <td className="py-1.5 pr-3 text-right">
                  {formatShare(r.share)}
                </td>
                <td className="py-1.5 pr-3 text-right">
                  {r.hiddenShare > 0 ? formatShare(r.hiddenShare) : '—'}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {formatContextToOutput(r.contextToOutput)}
                </td>
                <td className="py-1.5">{r.models.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
