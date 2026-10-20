import { Badge } from '../../ui/badge';

export interface RepoContext {
  key: string;
  value: string;
}

export interface RepositoryHeaderProps {
  repoUrl: string | undefined;
  sessionCountDisplay: React.ReactNode;
  userCountDisplay: React.ReactNode;
  repoContexts: RepoContext[];
  teamId?: number;
}

export function RepositoryHeader({
  repoUrl,
  sessionCountDisplay,
  userCountDisplay,
  repoContexts,
  teamId,
}: RepositoryHeaderProps) {
  return (
    <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3 shrink-0">
      {teamId === undefined && (
        <Badge className="bg-orange-500 text-white">Private repo view</Badge>
      )}
      {/* No access-mode badge here: `AccessModeBadge` in `MainNav` already covers
          the `/teams/:teamId/repos/:repoId` route, and exactly one such badge
          renders per route. */}
      <p className="text-sm font-mono flex-1 min-w-0 truncate">
        {repoUrl ?? '—'}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          Sessions: {sessionCountDisplay}
        </span>
        <span className="flex items-center gap-1">
          Users: {userCountDisplay}
        </span>
        {repoContexts.map((ctx) => (
          <span
            key={`${ctx.key}:${ctx.value}`}
            className="flex items-center gap-1"
          >
            <span className="font-medium text-foreground/70">{ctx.key}:</span>
            <span className="font-mono">{ctx.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
