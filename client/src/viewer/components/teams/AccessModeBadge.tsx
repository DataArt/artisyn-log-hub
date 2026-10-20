import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';

import type { Team, TeamMember } from '../../../models/teams';
import { fetchTeamMembers, fetchTeams } from '../../api';
import {
  ACCESS_MODE_BADGE_CLASS,
  ACCESS_MODE_LABEL,
  ACCESS_MODE_TOOLTIP_ANALYTICS,
} from '../../lib/access-mode-copy';
import { Badge } from '../../ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../ui/tooltip';

/**
 * The two routes that carry a team context, as built by
 * `routes.team` / `routes.teamRepo` in `hooks/useHashRoute.ts`:
 * `/teams/:teamId` and `/teams/:teamId/repos/:repoId`. Everything else —
 * `/teams` (the list), `/repos/:repoId`, `/main`, `/admin` — has no current
 * team, and the badge renders nothing there (the badge
 * follows the route; there is no global "current team").
 */
const TEAM_ROUTE_RE = /^\/teams\/(\d+)(?:\/repos\/\d+)?\/?$/;

export function teamIdFromPath(pathname: string): number | null {
  const match = TEAM_ROUTE_RE.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Header badge: names the access mode of the team whose route is
 * currently open, immediately left of the Help button in `MainNav`.
 *
 * The mode comes from the `['teams']` query the app already keeps warm, so the
 * badge costs no extra request. The tooltip's owner/trainer emails need the
 * member list, which is fetched lazily on the first hover/focus —
 * mounting it in the nav must not add a members round-trip to every page load.
 */
export function AccessModeBadge() {
  const { pathname } = useLocation();
  const teamId = teamIdFromPath(pathname);
  const [tooltipOpened, setTooltipOpened] = useState(false);

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: teamId !== null,
  });
  const team = teams.find((t: Team) => t.id === teamId);

  const { data: members = [] } = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => fetchTeamMembers(teamId!),
    enabled: teamId !== null && tooltipOpened,
  });

  // No team context, or the team is not in the caller's list yet — render
  // nothing rather than a placeholder that would shift the nav on load.
  if (teamId === null || !team) return null;

  const mode = team.accessMode;
  const readers = [
    ...members
      .filter((m: TeamMember) => m.isOwner)
      .map((m: TeamMember) => `${m.email} (owner)`),
    ...members
      .filter((m: TeamMember) => m.isAdlcTrainer && !m.isOwner)
      .map((m: TeamMember) => `${m.email} (trainer)`),
  ];

  return (
    <TooltipProvider>
      <Tooltip onOpenChange={(open) => open && setTooltipOpened(true)}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="access-mode-badge"
            aria-label={`${team.name} — ${ACCESS_MODE_LABEL[mode]} team`}
            className="flex cursor-help items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="max-w-40 truncate text-sm text-muted-foreground">
              {team.name}
            </span>
            <Badge className={ACCESS_MODE_BADGE_CLASS[mode]}>
              {ACCESS_MODE_LABEL[mode]}
            </Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent
          data-testid="access-mode-badge-tooltip"
          className="max-w-80"
        >
          <div className="flex flex-col gap-1">
            {readers.map((line) => (
              <span key={line}>{line}</span>
            ))}
            <span>{ACCESS_MODE_TOOLTIP_ANALYTICS}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
