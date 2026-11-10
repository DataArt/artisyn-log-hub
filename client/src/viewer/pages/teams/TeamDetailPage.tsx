import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import type { TeamMember } from '../../../models/teams';
import { fetchTeamMembers, fetchTeams } from '../../api';
import { useAuth } from '../../context/AuthContext';
import {
  TEAM_TABS,
  teamWideAccess,
  visibleTabs,
  type TeamTab,
} from '../../tab-ids';
import { PageTabs, PageTabsContent } from '../../ui/page-tabs';
import { TeamInvitationsTab } from './tabs/TeamInvitationsTab';
import { TeamMembersTab } from './tabs/TeamMembersTab';
import { TeamRepositoriesTab } from './tabs/TeamRepositoriesTab';
import { TeamOtelTab } from './otel/TeamOtelTab';
import { BudgetsSection } from '../budgets/BudgetsSection';
import { LazyFallback } from '../../components/LazyFallback';

// The Spend tab loads through the repository tabs barrel, so it shares their chunk (DD-16).
const SpendTab = lazy(() =>
  import('../repository/repository-tabs-lazy-group').then((m) => ({
    default: m.SpendTab,
  })),
);

type Tab = TeamTab;

const DEFAULT_TEAM_TAB: Tab = 'members';

/** A valid team tab id, or `undefined`. */
function parseTeamTab(value: unknown): Tab | undefined {
  return TEAM_TABS.find((t) => t === value);
}

/**
 * The tab a link asked for through `navigate(path, { state: { teamTab } })` (the All views map,
 * the Live view), or `undefined`.
 */
function stateTeamTab(state: unknown): Tab | undefined {
  return parseTeamTab(
    typeof state === 'object' && state !== null && 'teamTab' in state
      ? state.teamTab
      : undefined,
  );
}

/**
 * URL-backed team tab (DD-15): the `ttab` param, else the `location.state` seed, else
 * `members`. A seed is written into the URL once, so the tab survives a refresh; writes replace
 * the history entry and the default tab is dropped from the URL.
 */
function useTeamTabState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  // Read on every render: the first `ttab` write replaces the entry and clears the state.
  const seed = stateTeamTab(location.state);
  const urlTab = parseTeamTab(searchParams.get('ttab'));
  const tab: Tab = urlTab ?? seed ?? DEFAULT_TEAM_TAB;

  useEffect(() => {
    if (
      urlTab === undefined &&
      seed !== undefined &&
      seed !== DEFAULT_TEAM_TAB
    ) {
      const next = new URLSearchParams(searchParams);
      next.set('ttab', seed);
      setSearchParams(next, { replace: true });
    }
  }, [urlTab, seed, searchParams, setSearchParams]);

  function setTab(next: Tab) {
    const nextParams = new URLSearchParams(searchParams);
    if (next === DEFAULT_TEAM_TAB) nextParams.delete('ttab');
    else nextParams.set('ttab', next);
    setSearchParams(nextParams, { replace: true });
  }

  return { tab, setTab };
}

export function TeamDetailPage() {
  const { teamId: teamIdStr } = useParams<{ teamId: string }>();
  const teamId = parseInt(teamIdStr!, 10);
  const { user } = useAuth();
  const { tab, setTab } = useTeamTabState();

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });
  const team = teams.find((t) => t.id === teamId);

  const { data: members = [] } = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => fetchTeamMembers(teamId),
    enabled: tab === 'members',
  });

  const isOwner = team?.ownerId === user?.id;
  const isMember = members.some((m: TeamMember) => m.userId === user?.id);
  /**
   * The OTEL tab follows the analytics rule (FR-34, the repository view's
   * `canSeeTeamWideTabs`): everyone in a `transparent` team, only the owner and
   * managers in a `restricted` one. The server enforces it (403 → "No access").
   */
  const canSeeOtel = team !== undefined && teamWideAccess(team, user?.id);
  const role = isOwner ? 'owner' : team?.myIsManager ? 'manager' : 'member';

  if (!team) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading team…</div>
    );
  }

  return (
    // AppShell's content pane clips (`overflow-hidden`), so the page scrolls itself.
    <div
      className="flex flex-col h-full overflow-y-auto p-6 gap-6"
      data-testid="team-detail-page"
    >
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{team.name}</h1>
      </div>

      <PageTabs
        tabs={visibleTabs('team', { canSeeOtel }).map((r) => ({
          value: r.id,
          label: r.label,
          description: r.description,
        }))}
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        testIdGroup="team"
      >
        <PageTabsContent value="members">
          <TeamMembersTab
            teamId={teamId}
            teamName={team.name}
            members={members}
            isOwner={isOwner}
            isMember={isMember}
            accessMode={team.accessMode}
          />
        </PageTabsContent>

        <PageTabsContent value="repositories">
          <TeamRepositoriesTab teamId={teamId} isOwner={isOwner} />
        </PageTabsContent>

        <PageTabsContent value="invitations">
          <TeamInvitationsTab teamId={teamId} isOwner={isOwner} />
        </PageTabsContent>

        <PageTabsContent value="otel">
          {tab === 'otel' &&
            (canSeeOtel ? (
              <TeamOtelTab
                teamId={teamId}
                accessMode={team.accessMode}
                role={role}
              />
            ) : (
              <div
                className="p-6 text-sm text-muted-foreground"
                data-testid="team-otel-tab"
              >
                No access
              </div>
            ))}
        </PageTabsContent>

        <PageTabsContent value="spend">
          {tab === 'spend' && (
            <Suspense fallback={<LazyFallback />}>
              <SpendTab scope={{ teamId }} />
            </Suspense>
          )}
        </PageTabsContent>

        <PageTabsContent value="settings">
          {tab === 'settings' &&
            (canSeeOtel ? (
              <div className="max-w-4xl" data-testid="team-settings-tab">
                <BudgetsSection scope={{ teamId }} />
              </div>
            ) : (
              <div
                className="p-6 text-sm text-muted-foreground"
                data-testid="team-settings-tab"
              >
                No access
              </div>
            ))}
        </PageTabsContent>
      </PageTabs>
    </div>
  );
}
