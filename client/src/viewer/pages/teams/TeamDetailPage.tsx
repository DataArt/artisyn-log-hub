import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { TeamMember } from '../../../models/teams';
import { fetchTeamMembers, fetchTeams } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { TEAM_TABS, type TeamTab } from '../../tab-ids';
import { PageTabs, PageTabsContent } from '../../ui/page-tabs';
import { TeamInvitationsTab } from './tabs/TeamInvitationsTab';
import { TeamMembersTab } from './tabs/TeamMembersTab';
import { TeamRepositoriesTab } from './tabs/TeamRepositoriesTab';
import { TeamOtelTab } from './otel/TeamOtelTab';

type Tab = TeamTab;

const TAB_LABELS: Record<Tab, string> = {
  members: 'Members',
  repositories: 'Repositories',
  invitations: 'Invitations',
  otel: 'OTEL',
};

export function TeamDetailPage() {
  const { teamId: teamIdStr } = useParams<{ teamId: string }>();
  const teamId = parseInt(teamIdStr!, 10);
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('members');

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
  const canSeeOtel =
    team !== undefined &&
    (team.accessMode !== 'restricted' || isOwner || team.myIsManager);
  const role = isOwner ? 'owner' : team?.myIsManager ? 'manager' : 'member';

  if (!team) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading team…</div>
    );
  }

  return (
    <div className="flex flex-col h-full p-6 gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{team.name}</h1>
      </div>

      <PageTabs
        tabs={TEAM_TABS.filter((t) => t !== 'otel' || canSeeOtel).map((t) => ({
          value: t,
          label: TAB_LABELS[t],
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
      </PageTabs>
    </div>
  );
}
