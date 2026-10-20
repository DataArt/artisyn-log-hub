import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Team, TeamRepository } from '../../models/teams';
import { fetchTeamRepositories } from '../api';
import { routes } from '../hooks/useHashRoute';

interface TeamNavItemProps {
  team: Team;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  activeRepoId: number | null;
  activeTeamId: number | null;
  activeItemRef: React.RefObject<HTMLButtonElement | null>;
}

function TeamNavItem({
  team,
  isActive,
  isExpanded,
  onToggle,
  activeRepoId,
  activeTeamId,
  activeItemRef,
}: TeamNavItemProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const { data: repos = [], error } = useQuery({
    queryKey: ['team-repos', team.id],
    queryFn: () => fetchTeamRepositories(team.id),
    enabled: isExpanded,
  });

  return (
    <>
      <div
        className={`flex items-center w-full transition-colors ${
          isActive
            ? 'bg-accent text-foreground font-medium'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        }`}
      >
        <button
          className="flex items-center justify-center px-2 py-1.5 shrink-0"
          onClick={onToggle}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
        </button>
        <button
          className="flex items-center gap-2 py-1.5 pr-3 text-left flex-1 min-w-0"
          onClick={() => navigate(routes.team(team.id))}
        >
          <Users className="size-3.5 shrink-0" />
          <span className="truncate">{team.name}</span>
        </button>
      </div>

      {isExpanded && (
        <div className="flex flex-col">
          {error ? (
            <p className="pl-8 pr-3 py-1 text-xs text-destructive">
              {error instanceof Error
                ? error.message
                : 'Failed to load repositories'}
            </p>
          ) : (
            repos
              .filter((repo: TeamRepository) => repo.repositoryId !== null)
              .map((repo: TeamRepository) => {
                const repositoryId = repo.repositoryId as number;
                const isActiveRepo =
                  repositoryId === activeRepoId &&
                  activeTeamId === team.id &&
                  location.pathname.startsWith('/teams/');
                return (
                  <button
                    key={repo.id}
                    ref={isActiveRepo ? activeItemRef : null}
                    title={repo.repoUrl}
                    className={`pl-8 pr-3 py-1 text-left text-xs truncate w-full transition-colors ${
                      isActiveRepo
                        ? 'bg-accent text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    }`}
                    onClick={() =>
                      navigate(routes.teamRepo(team.id, repositoryId))
                    }
                  >
                    {repo.repoUrl}
                  </button>
                );
              })
          )}
        </div>
      )}
    </>
  );
}

interface TeamAccordionListProps {
  teams: Team[];
  expandedTeamIds: Set<number>;
  onToggleTeam: (id: number) => void;
  activeTeamId: number | null;
  activeRepoId: number | null;
  activeItemRef: React.RefObject<HTMLButtonElement | null>;
}

export function TeamAccordionList({
  teams,
  expandedTeamIds,
  onToggleTeam,
  activeTeamId,
  activeRepoId,
  activeItemRef,
}: TeamAccordionListProps) {
  return (
    <>
      {teams.map((team: Team) => (
        <TeamNavItem
          key={team.id}
          team={team}
          isActive={activeTeamId === team.id}
          isExpanded={expandedTeamIds.has(team.id)}
          onToggle={() => onToggleTeam(team.id)}
          activeRepoId={activeRepoId}
          activeTeamId={activeTeamId}
          activeItemRef={activeItemRef}
        />
      ))}
    </>
  );
}
