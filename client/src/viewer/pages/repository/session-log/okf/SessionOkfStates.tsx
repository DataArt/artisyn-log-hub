/**
 * The fixed states and hints of the session OKF tab (`SessionOkfTab`): loading skeleton, empty
 * state, the "no KB snapshot" banner and the on-demand deeper-analysis hint.
 */
import { useNavigate } from 'react-router-dom';
import { Skeleton } from '@/ui/skeleton';
import { routes } from '../../../../hooks/useHashRoute';

export function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="okf-loading">
      <Skeleton className="h-28 w-full" />
      <div className="flex gap-3">
        <Skeleton className="h-20 w-72" />
        <Skeleton className="h-20 w-72" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="p-8 text-center text-sm text-muted-foreground"
      data-testid="okf-empty"
    >
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1">{body}</div>
    </div>
  );
}

export function NoSnapshotBanner() {
  const navigate = useNavigate();
  return (
    <div
      data-testid="okf-no-snapshot"
      className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
    >
      <div>
        ⚠ No KB snapshot for this session — the tree shows only the paths that
        were accessed (no &quot;not read&quot; list).
      </div>
      <div className="mt-0.5 text-xs">
        Update the Log Hub hook in this repository to see the full KB tree.{' '}
        <button
          type="button"
          onClick={() => {
            void navigate(routes.apiKeys);
          }}
          className="font-medium underline underline-offset-2"
        >
          How to update
        </button>
      </div>
    </div>
  );
}

/** Name of the on-demand KB-analysis skill shipped with the hooks plugin (task kb-completeness-deep). */
const KB_ANALYSIS_COMMAND = '/log-hub-hooks:kb-analysis';

export function DeeperAnalysisHint({ sessionId }: { sessionId: string }) {
  return (
    <p
      data-testid="okf-deeper-analysis"
      className="text-xs text-muted-foreground"
    >
      Deeper analysis (what should have been read, failed searches, KB gaps and
      fixes) runs locally in Claude Code, on demand:{' '}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
        {KB_ANALYSIS_COMMAND} {sessionId}
      </code>
    </p>
  );
}
