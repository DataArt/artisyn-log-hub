import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { TeamAccessMode, TeamMember } from '../../../../models/teams';
import {
  ApiError,
  deleteTeam,
  leaveTeam,
  removeTeamMember,
  sendInvitation,
  transferTeamOwnership,
  updateTeamMember,
} from '../../../api';
import { useNavigate } from 'react-router-dom';
import { routes } from '../../../hooks/useHashRoute';
import { Button } from '../../../ui/button';
import { ConfirmDialog } from '../../../ui/confirm-dialog';
import { TeamAccessModeCards } from './members/TeamAccessModeCards';
import {
  TeamMemberRolesHeader,
  TeamMemberRow,
  type MemberRoleFlags,
} from './members/TeamMemberRow';
import { TeamRoleHelpTable } from './members/TeamRoleHelpTable';

interface TeamMembersTabProps {
  teamId: number;
  teamName: string;
  members: TeamMember[];
  isOwner: boolean;
  isMember: boolean;
  accessMode: TeamAccessMode;
}

export function TeamMembersTab({
  teamId,
  teamName,
  members,
  isOwner,
  isMember,
  accessMode,
}: TeamMembersTabProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [transferTo, setTransferTo] = useState('');

  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null);
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [pendingForceEmail, setPendingForceEmail] = useState<string | null>(
    null,
  );

  const inviteMut = useMutation({
    mutationFn: (vars: { email: string; force?: boolean }) =>
      sendInvitation(teamId, vars.email, vars.force),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['team-members', teamId],
      });
      setInviteEmail('');
      setInviteError('');
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'user_not_registered') {
        setPendingForceEmail(inviteEmail.trim());
        return;
      }
      setInviteError(
        err instanceof Error ? err.message : 'Failed to send invitation',
      );
    },
  });

  const removeMemberMut = useMutation({
    mutationFn: (userId: number) => removeTeamMember(teamId, userId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['team-members', teamId] }),
  });

  const toggleRoleMut = useMutation({
    mutationFn: ({
      userId,
      flags,
    }: {
      userId: number;
      flags: MemberRoleFlags;
    }) => updateTeamMember(teamId, userId, flags),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['team-members', teamId] }),
  });

  const transferMut = useMutation({
    mutationFn: (userId: number) => transferTeamOwnership(teamId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({
        queryKey: ['team-members', teamId],
      });
      setTransferTo('');
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteTeam(teamId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      navigate(routes.teams);
    },
  });

  const leaveMut = useMutation({
    mutationFn: () => leaveTeam(teamId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      navigate(routes.teams);
    },
  });

  const nonOwnerMembers = members.filter((m: TeamMember) => !m.isOwner);

  return (
    <>
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2">
          {isOwner && <TeamMemberRolesHeader />}
          {members.map((m: TeamMember) => (
            <TeamMemberRow
              key={m.userId}
              member={m}
              canEditRoles={isOwner}
              canRemove={isOwner}
              showDisclosureState={isOwner}
              onToggleRole={(userId, flags) =>
                toggleRoleMut.mutate({ userId, flags })
              }
              onRemove={setMemberToRemove}
            />
          ))}
        </ul>

        {/* Rendered for every viewer: a plain member reading the tab needs to
            know what an "ADLC trainer" beside a colleague's name means. */}
        <TeamRoleHelpTable />

        {/* Invite form */}
        <div className="p-4 border border-border rounded-md bg-card">
          <p className="text-sm font-medium mb-2">Invite member</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (inviteEmail.trim())
                inviteMut.mutate({ email: inviteEmail.trim() });
            }}
          >
            <input
              type="email"
              className="flex-1 border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Email address"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={inviteMut.isPending}>
              Invite
            </Button>
          </form>
          {inviteError && (
            <p className="mt-1 text-xs text-destructive">{inviteError}</p>
          )}
        </div>

        {isOwner && (
          <TeamAccessModeCards
            teamId={teamId}
            accessMode={accessMode}
            nonOwnerMemberCount={nonOwnerMembers.length}
          />
        )}

        {/* Owner controls */}
        {isOwner && nonOwnerMembers.length > 0 && (
          <div className="p-4 border border-border rounded-md bg-card">
            <p className="text-sm font-medium mb-2">Transfer ownership</p>
            <div className="flex gap-2">
              <select
                className="flex-1 border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              >
                <option value="">Select member…</option>
                {nonOwnerMembers.map((m: TeamMember) => (
                  <option key={m.userId} value={String(m.userId)}>
                    {m.email}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!transferTo || transferMut.isPending}
                onClick={() => {
                  if (transferTo) setConfirmTransfer(true);
                }}
              >
                Transfer
              </Button>
            </div>
          </div>
        )}

        {isOwner && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-destructive hover:text-destructive"
            onClick={() => setConfirmDeleteTeam(true)}
            disabled={deleteMut.isPending}
          >
            Delete team
          </Button>
        )}

        {!isOwner && isMember && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-destructive hover:text-destructive"
            onClick={() => setConfirmLeave(true)}
            disabled={leaveMut.isPending}
          >
            Leave team
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={memberToRemove !== null}
        header="Remove member"
        message={`Remove ${memberToRemove?.email} from the team?`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (memberToRemove) removeMemberMut.mutate(memberToRemove.userId);
          setMemberToRemove(null);
        }}
        onCancel={() => setMemberToRemove(null)}
      />

      <ConfirmDialog
        open={confirmTransfer}
        header="Transfer ownership"
        message="Transfer ownership? You will become a regular member."
        confirmLabel="Transfer"
        onConfirm={() => {
          transferMut.mutate(parseInt(transferTo, 10));
          setConfirmTransfer(false);
        }}
        onCancel={() => setConfirmTransfer(false)}
      />

      <ConfirmDialog
        open={confirmDeleteTeam}
        header="Delete team"
        message={`Delete team "${teamName}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          deleteMut.mutate();
          setConfirmDeleteTeam(false);
        }}
        onCancel={() => setConfirmDeleteTeam(false)}
      />

      <ConfirmDialog
        open={confirmLeave}
        header="Leave team"
        message="Leave this team?"
        confirmLabel="Leave"
        destructive
        onConfirm={() => {
          leaveMut.mutate();
          setConfirmLeave(false);
        }}
        onCancel={() => setConfirmLeave(false)}
      />

      <ConfirmDialog
        open={pendingForceEmail !== null}
        header="Not registered yet"
        message="This user is not registered yet — add them anyway? They will see this team and its repository as soon as they first log in."
        confirmLabel="Add anyway"
        onConfirm={() => {
          if (pendingForceEmail)
            inviteMut.mutate({ email: pendingForceEmail, force: true });
          setPendingForceEmail(null);
        }}
        onCancel={() => setPendingForceEmail(null)}
      />
    </>
  );
}
