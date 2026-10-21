import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Invitation } from '../../../../models/teams';
import {
  ApiError,
  cancelInvitation,
  fetchMyInvitations,
  sendInvitation,
} from '../../../api';
import {
  ACCESS_MODE_BADGE_CLASS,
  ACCESS_MODE_LABEL,
} from '../../../lib/access-mode-copy';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { ConfirmDialog } from '../../../ui/confirm-dialog';

interface TeamInvitationsTabProps {
  teamId: number;
  isOwner: boolean;
}

export function TeamInvitationsTab({
  teamId,
  isOwner,
}: TeamInvitationsTabProps) {
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [pendingForceEmail, setPendingForceEmail] = useState<string | null>(
    null,
  );

  const { data: allInvitations = [] } = useQuery({
    queryKey: ['invitations'],
    queryFn: fetchMyInvitations,
  });

  const teamInvitations = allInvitations.filter(
    (i: Invitation) => i.teamId === teamId,
  );

  const inviteMut = useMutation({
    mutationFn: (vars: { email: string; force?: boolean }) =>
      sendInvitation(teamId, vars.email, vars.force),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invitations'] });
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

  const cancelMut = useMutation({
    mutationFn: (invId: number) => cancelInvitation(teamId, invId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  });

  return (
    <>
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2">
          {teamInvitations.map((inv: Invitation) => (
            <li
              key={inv.id}
              className="flex items-center justify-between gap-2 p-3 border border-border rounded-md bg-card"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm">
                  <span className="truncate">{inv.inviteeEmail}</span>
                  {inv.accessMode && (
                    <Badge className={ACCESS_MODE_BADGE_CLASS[inv.accessMode]}>
                      {ACCESS_MODE_LABEL[inv.accessMode]}
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground capitalize">
                  {inv.status}
                </p>
              </div>
              {inv.status === 'pending' && isOwner && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs"
                  onClick={() => cancelMut.mutate(inv.id)}
                >
                  Cancel
                </Button>
              )}
            </li>
          ))}
          {teamInvitations.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No invitations sent.
            </p>
          )}
        </ul>

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
            placeholder="Email address to invite"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={inviteMut.isPending}>
            Send invite
          </Button>
          {inviteError && (
            <p className="text-xs text-destructive">{inviteError}</p>
          )}
        </form>
      </div>

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
