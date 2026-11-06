/**
 * FR-11 banner of the repo OKF tab: "X of Y sessions in this period have no OKF analysis yet"
 * (root sessions whose `okf_extract_version` is missing or older than the current one, DD-11).
 * The "Recompute all sessions" link shows only when the server says the caller may run it
 * (`canRecompute`, the same authority as `recompute-all-sessions`); it calls the same API as
 * Settings → Maintenance and, on success, refetches the OKF usage of this repo.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Info, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { recomputeAllSessions } from '../../../api';

export function OkfAnalysisCoverageBanner({
  repoId,
  teamId,
  sessionsWithoutAnalysis,
  sessionsInPeriod,
  canRecompute,
  className,
}: {
  repoId: number;
  teamId?: number;
  sessionsWithoutAnalysis: number;
  sessionsInPeriod: number;
  canRecompute: boolean;
  /** Extra classes for the banner box (e.g. outer margin). */
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  async function handleRecompute() {
    setMessage(null);
    setRunning(true);
    try {
      const result = await recomputeAllSessions(repoId, teamId);
      setMessage({
        kind: 'success',
        text: `Recomputed ${result.recomputed} session${result.recomputed === 1 ? '' : 's'}.`,
      });
      await queryClient.invalidateQueries({
        queryKey: ['repo-okf-usage', repoId],
      });
    } catch (e) {
      setMessage({
        kind: 'error',
        text: e instanceof Error && e.message ? e.message : 'Recompute failed',
      });
    } finally {
      setRunning(false);
    }
  }

  // Once a recompute succeeds the refetched usage has no session left without analysis; the
  // banner stays mounted with just its result message, so the user sees what happened.
  const pending = sessionsWithoutAnalysis > 0;
  if (!pending && message === null) return null;

  return (
    <div
      data-testid="okf-analysis-banner"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs ${className ?? ''}`}
    >
      <Info className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
      {pending ? (
        <span>
          {sessionsWithoutAnalysis.toLocaleString()} of{' '}
          {sessionsInPeriod.toLocaleString()} sessions in this period have no
          OKF analysis yet
        </span>
      ) : null}
      {canRecompute && pending ? (
        <button
          type="button"
          data-testid="okf-analysis-recompute"
          disabled={running}
          onClick={() => void handleRecompute()}
          className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline disabled:opacity-60 dark:text-sky-300"
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : null}
          Recompute all sessions
        </button>
      ) : null}
      {message ? (
        <span
          data-testid="okf-analysis-recompute-result"
          className={
            message.kind === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground'
          }
        >
          {message.text}
        </span>
      ) : null}
    </div>
  );
}
