/**
 * The Repositories table of the team OTEL tab (2026-10-30 otel-tabs-traces, DD-29): every team
 * repository with OTEL data in the period and filters, most expensive first. "open OTEL ›" opens
 * the repository in the team view on its OTEL tab. Unlike the rest of the tab, a session linked
 * to two team repositories counts in each of them (the footer says so).
 */
import type { OtelTeamRepositoryRow } from '../../../../models/teams';
import {
  formatCount,
  formatMicrosUsd,
} from '../../repository/otel/otel-format';

export interface OtelRepositoriesTableProps {
  repositories: readonly OtelTeamRepositoryRow[];
  onOpen: (repoId: number) => void;
}

export function OtelRepositoriesTable({
  repositories,
  onOpen,
}: OtelRepositoriesTableProps) {
  return (
    <section
      className="rounded-md border p-4"
      data-testid="otel-repositories-table"
    >
      <h3 className="text-sm font-semibold">Repositories</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        click a row to open the repository&apos;s OTEL tab
      </p>
      {repositories.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No repository has OTEL data in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-3 font-medium">repository</th>
                <th className="py-1.5 pr-3 text-right font-medium">people</th>
                <th className="py-1.5 pr-3 text-right font-medium">sessions</th>
                <th className="py-1.5 pr-3 text-right font-medium">cost</th>
                <th className="py-1.5 pr-3 text-right font-medium">hidden</th>
                <th className="py-1.5 pr-3 text-right font-medium">live</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {repositories.map((r) => (
                <tr
                  key={r.repoId}
                  className="cursor-pointer border-b last:border-b-0 hover:bg-accent"
                  onClick={() => onOpen(r.repoId)}
                  data-testid="otel-repository-row"
                >
                  <td
                    className="max-w-[420px] truncate py-1.5 pr-3 font-mono"
                    title={r.repoUrl}
                  >
                    {r.repoUrl}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatCount(r.people)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatCount(r.sessions)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatMicrosUsd(r.costUsdMicros)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {formatMicrosUsd(r.hiddenCostUsdMicros)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {r.liveSessions > 0 ? formatCount(r.liveSessions) : '—'}
                  </td>
                  <td className="py-1.5 whitespace-nowrap text-blue-600">
                    open OTEL ›
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted-foreground">
            A session linked to several team repositories counts in each of them
            here; every other number on this tab counts it once.
          </p>
        </div>
      )}
    </section>
  );
}
