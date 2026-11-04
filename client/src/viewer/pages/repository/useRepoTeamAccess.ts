import { useQuery } from '@tanstack/react-query';
import { fetchTeams } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { teamWideAccess } from '../../tab-ids';

/**
 * What this caller may reach of a repository opened inside a team (`teamId`); a personal repo
 * view (`teamId` undefined) keeps every tab and never shows the restricted notice.
 */
export function useRepoTeamAccess(teamId: number | undefined): {
  canSeeTeamWideTabs: boolean;
  showRestrictedNotice: boolean;
} {
  const { user } = useAuth();

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: teamId !== undefined,
  });
  const currentTeam =
    teamId !== undefined ? teams.find((t) => t.id === teamId) : undefined;

  /**
   * What this caller may reach inside a `restricted` team. Mirrors the server-side
   * scope — the tabs are a cosmetic second layer over
   * real 403s, never the enforcement itself.
   *
   * While the `['teams']` query is still in flight `currentTeam` is `undefined`,
   * which reads as "not restricted" so the tab bar does not flash a narrower set
   * and then widen.
   */
  const isRestrictedTeam = currentTeam?.accessMode === 'restricted';
  const isTeamOwner =
    currentTeam !== undefined &&
    user != null &&
    currentTeam.ownerId === user.id;

  /**
   * Team owner and `manager` keep Analytics / Reports / Settings. The app admin role
   * grants nothing here — an admin is scoped by their team role like anyone else.
   */
  const canSeeTeamWideTabs =
    currentTeam === undefined || teamWideAccess(currentTeam, user?.id);

  /**
   * Only a caller whose scope really is `own-only` gets the notice — a `manager`
   * and an `adlc trainer` both see every member's rows, so the "you see only your
   * own sessions" wording would be wrong for them.
   */
  const showRestrictedNotice =
    isRestrictedTeam &&
    !isTeamOwner &&
    !currentTeam?.myIsManager &&
    !currentTeam?.myIsAdlcTrainer;

  return { canSeeTeamWideTabs, showRestrictedNotice };
}
