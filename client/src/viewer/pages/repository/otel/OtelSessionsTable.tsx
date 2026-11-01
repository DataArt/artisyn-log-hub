/**
 * The sessions table of the repository OTEL tab (2026-10-30 otel-tabs-traces): newest first, a
 * "live" chip, an "unconfirmed" chip for sessions with realtime calls the regular upload has not
 * confirmed yet (DD-14), and a click that opens the session's OTEL tab.
 */
import type { OtelSessionRow } from '../../../../models/repositories';
import { formatLocalTimestamp } from '../../../lib/format';
import { formatCount, formatMicrosUsd } from './otel-format';

export interface OtelSessionsTableProps {
  sessions: readonly OtelSessionRow[];
  onOpen: (sessionId: string) => void;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function OtelSessionsTable({
  sessions,
  onOpen,
}: OtelSessionsTableProps) {
  return (
    <section
      className="rounded-md border p-4"
      data-testid="otel-sessions-table"
    >
      <h3 className="text-sm font-semibold">Sessions</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        click a row to open the session OTEL tab
      </p>
      {sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No sessions in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-3 font-medium">started</th>
                <th className="py-1.5 pr-3 font-medium">first prompt</th>
                <th className="py-1.5 pr-3 font-medium">user</th>
                <th className="py-1.5 pr-3 font-medium">Claude Code</th>
                <th className="py-1.5 pr-3 text-right font-medium">calls</th>
                <th className="py-1.5 pr-3 text-right font-medium">cost</th>
                <th className="py-1.5 pr-3 text-right font-medium">hidden</th>
                <th className="py-1.5 pr-3 font-medium">traces</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.sessionId}
                  className="cursor-pointer border-b last:border-b-0 hover:bg-accent"
                  onClick={() => onOpen(s.sessionId)}
                  data-testid="otel-session-row"
                >
                  <td className="py-1.5 pr-3 whitespace-nowrap font-mono">
                    {formatLocalTimestamp(s.startedAt)}
                  </td>
                  <td
                    className="max-w-[320px] py-1.5 pr-3"
                    title={s.firstPrompt ?? undefined}
                  >
                    {s.firstPrompt ? truncate(s.firstPrompt, 60) : '—'}
                  </td>
                  <td className="py-1.5 pr-3">{s.userEmail ?? '—'}</td>
                  <td className="py-1.5 pr-3 font-mono">
                    {s.ccVersion ?? '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatCount(s.calls)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatMicrosUsd(s.costUsdMicros)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatMicrosUsd(s.hiddenCostUsdMicros)}
                  </td>
                  <td className="py-1.5 pr-3">{s.hasTraces ? 'yes' : 'no'}</td>
                  <td className="py-1.5 whitespace-nowrap">
                    {s.unconfirmedCalls > 0 && (
                      <span
                        className="mr-1.5 rounded border border-dotted border-sky-400 bg-sky-50 px-1 text-[10px] text-sky-800"
                        title={`${s.unconfirmedCalls} calls received in realtime, not yet confirmed by the regular upload`}
                        data-testid="otel-session-unconfirmed"
                      >
                        unconfirmed
                      </span>
                    )}
                    {s.live ? (
                      <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                        live
                      </span>
                    ) : (
                      <span className="text-blue-600">open ›</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted-foreground">
            traces = "no" for sessions recorded by a hook without trace support
            — charts still work from OTEL logs.
          </p>
        </div>
      )}
    </section>
  );
}
