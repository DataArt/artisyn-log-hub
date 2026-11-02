/**
 * The All views context rail (FR-E3, wireframes g1/g2): Team / Repository / Session the tree is
 * scoped to. Prefilled from the page the map was opened from (URL params), else from the last
 * visit (marked "from Recent"), else "choose…". Team and repository are plain selects; the
 * session field opens the session picker. Every change goes into the URL (`setRail`).
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { fetchRepositorySessions } from '../../api';
import type { RepositorySession } from '../../../models/repositories';
import type { MapRecent } from './map-recent';
import type { NavRepo, NavTeam } from './nav-tree';
import type { MapRail, MapRailParams } from './useNavTreeInput';

export interface MapContextRailProps {
  rail: MapRail;
  repos: readonly NavRepo[];
  /** Every entry before deduplication, the source of team membership. */
  repoEntries: readonly NavRepo[];
  teams: readonly NavTeam[];
  recent: MapRecent;
  onChange: (next: MapRailParams) => void;
  /** Opens the session picker for the rail repository. */
  onChooseSession: () => void;
}

const SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm';

function RailField({
  label,
  fromRecent,
  children,
}: {
  label: string;
  fromRecent: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {fromRecent && (
          <span className="inline-flex items-center gap-0.5 rounded-full border border-border px-1.5 text-[11px]">
            <History className="size-3" aria-hidden />
            from Recent
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

/** The rail session's first prompt from the session list already in the cache (never fetched). */
function useCachedSessionLabel(
  repo: NavRepo | undefined,
  sessionId: string | undefined,
): string | undefined {
  const { data } = useQuery<RepositorySession[]>({
    queryKey: ['repo-sessions', repo?.id, repo?.teamId],
    // Same key and fetcher as MapSessionPicker; `enabled: false` keeps it cache-only, but
    // TanStack Query still logs an error for an observer that has no queryFn at all.
    queryFn: () =>
      repo
        ? fetchRepositorySessions(repo.id, repo.teamId)
        : Promise.resolve([]),
    enabled: false,
  });
  if (!sessionId) return undefined;
  return data?.find((s) => s.sessionId === sessionId)?.firstPrompt ?? undefined;
}

export function MapContextRail({
  rail,
  repos,
  repoEntries,
  teams,
  recent,
  onChange,
  onChooseSession,
}: MapContextRailProps) {
  const repo = repos.find((r) => r.id === rail.repoId);
  const cachedLabel = useCachedSessionLabel(repo, rail.sessionId);
  const sessionLabel = rail.sessionId
    ? `${rail.sessionId.slice(0, 6)} · ${
        cachedLabel ??
        recent.sessions.find((s) => s.sessionId === rail.sessionId)?.label ??
        rail.sessionId
      }`
    : null;
  // A team narrows the repository list to its repositories. Membership comes from the
  // undeduplicated entries: a personal repository shared with the team is deduplicated to its
  // personal entry (no `teamId`) in `repos`, but still has a team entry here.
  const inTeam = (repoId: number, teamId: number) =>
    repoEntries.some((r) => r.id === repoId && r.teamId === teamId);
  const railTeamId = rail.teamId;
  const repoOptions =
    railTeamId !== undefined
      ? repos.filter((r) => inTeam(r.id, railTeamId))
      : repos;
  const recentTag = rail.fromRecent;

  return (
    <section
      aria-label="Context"
      className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3"
    >
      <RailField
        label="Team"
        fromRecent={recentTag && rail.teamId !== undefined}
      >
        <select
          data-testid="map-rail-team"
          className={SELECT_CLASS}
          value={rail.teamId ?? ''}
          disabled={teams.length === 0}
          onChange={(e) => {
            const teamId = e.target.value ? Number(e.target.value) : undefined;
            // Keep the repository only when it belongs to the chosen team (or no team).
            const keepRepo =
              repo !== undefined &&
              (teamId === undefined || inTeam(repo.id, teamId));
            onChange({
              teamId,
              repoId: keepRepo ? repo.id : undefined,
              sessionId: keepRepo ? rail.sessionId : undefined,
            });
          }}
        >
          <option value="">
            {teams.length === 0 ? 'No teams' : 'choose…'}
          </option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </RailField>

      <RailField
        label="Repository"
        fromRecent={recentTag && rail.repoId !== undefined}
      >
        <select
          data-testid="map-rail-repo"
          className={SELECT_CLASS}
          value={rail.repoId ?? ''}
          disabled={repoOptions.length === 0}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : undefined;
            const next = repoOptions.find((r) => r.id === id);
            // A chosen team stays: every option belongs to it. Without one, a team-only
            // repository brings its team along.
            onChange({
              teamId: railTeamId ?? next?.teamId,
              repoId: next?.id,
            });
          }}
        >
          <option value="">
            {repoOptions.length === 0 ? 'No repositories' : 'choose…'}
          </option>
          {repoOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </RailField>

      <RailField
        label="Session"
        fromRecent={recentTag && rail.sessionId !== undefined}
      >
        <button
          type="button"
          data-testid="map-rail-session"
          disabled={repo === undefined}
          title={repo === undefined ? 'Choose a repository first' : undefined}
          onClick={onChooseSession}
          className={`${SELECT_CLASS} truncate text-left disabled:cursor-not-allowed disabled:text-muted-foreground`}
        >
          {sessionLabel ?? 'choose…'}
        </button>
      </RailField>
    </section>
  );
}
