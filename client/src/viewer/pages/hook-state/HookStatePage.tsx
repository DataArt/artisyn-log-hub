import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { ApiError, fetchHookState } from '../../api';
import { PageState } from '../../components/PageState';
import { formatRelativeDate } from '../../../lib/format';
import { HookStatusCard } from './HookStatusCard';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 404) {
      return 'No hook state reported for this repository yet.';
    }
    if (error.statusCode === 403) return 'No access';
  }
  return 'Error';
}

function logLineClass(line: string): string | undefined {
  if (/\[(error|fail)\]/i.test(line)) return 'text-red-400';
  if (/\[warn\]/i.test(line)) return 'text-amber-400';
  return undefined;
}

export function HookStatePage() {
  const { repoId: repoIdStr } = useParams<{ repoId: string }>();
  const repoId = parseInt(repoIdStr!, 10);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['hook-state', repoId],
    queryFn: () => fetchHookState(repoId),
  });

  if (isLoading) return <PageState message="Loading…" />;
  if (isError || !data)
    return <PageState message={errorMessage(error)} variant="error" />;

  const hasIssues =
    data.outdated ||
    data.recommendations.length > 0 ||
    data.nonUploadableLogs.length > 0;

  return (
    <div className="flex flex-col gap-5 p-4 max-w-5xl">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-lg font-semibold">Hook State</h1>
          <p className="truncate text-sm text-muted-foreground">
            {data.repoUrl}
          </p>
        </div>
        <button
          onClick={() =>
            void Promise.all([
              queryClient.invalidateQueries({
                queryKey: ['hook-state', repoId],
              }),
              queryClient.invalidateQueries({ queryKey: ['hook-repos'] }),
            ])
          }
          title="Refresh"
          className="flex shrink-0 items-center justify-center rounded border border-border p-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <HookStatusCard detail={data} hasIssues={hasIssues} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Recommendations
        </h2>
        <div className="rounded-md border border-border bg-card">
          {data.recommendations.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No recommendations.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.recommendations.map((rec) => (
                <li
                  key={rec.rule}
                  className="flex items-start justify-between gap-4 p-3"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-orange-500" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">{rec.message}</span>
                      <span className="text-xs text-muted-foreground">
                        rule: {rec.rule}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeDate(rec.detectedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Non-uploadable logs (last attempt)
        </h2>
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          {data.nonUploadableLogs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No upload failures.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
                  <th className="px-4 py-2">File</th>
                  <th className="px-4 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.nonUploadableLogs.map((log, i) => (
                  <tr key={`${log.file}-${i}`}>
                    <td className="px-4 py-2 font-mono text-xs">{log.file}</td>
                    <td className="px-4 py-2 text-destructive">{log.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Errors &amp; warnings
        </h2>
        <div className="rounded-md border border-border bg-card">
          {data.errors.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No errors or warnings.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.errors.map((line, i) => (
                <li
                  key={i}
                  className="p-3 text-sm text-amber-700 dark:text-amber-400"
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Hook log (last {data.logTail.length} lines)
        </h2>
        {/* Intentional dark-surface exception to the app's light-only color scheme —
            see docs/knowledgebase/ui-principles.md § Hook log tail (dark surface). */}
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-400">
          {data.logTail.length === 0
            ? 'No log data.'
            : data.logTail.map((line, i) => (
                <div key={i} className={logLineClass(line)}>
                  {line}
                </div>
              ))}
        </pre>
      </section>
    </div>
  );
}
