import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { fetchMyInvitations, respondToInvitation } from '../../api';
import { useAuth } from '../../context/AuthContext';
import type { Invitation, TeamAccessMode } from '../../../models/teams';
import {
  ACCESS_MODE_BADGE_CLASS,
  ACCESS_MODE_LABEL,
} from '../../lib/access-mode-copy';
import { Badge } from '../../ui/badge';
import { TeamDisclosureModal } from '../teams/TeamDisclosureModal';

export function NotificationBell() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  /**
   * The invitation whose disclosure is currently on screen. Accepting never
   * goes straight to the API: the invitee must to read who can see
   * their prompts and tick the acknowledgement first, and the mode they read
   * travels back as `acknowledgedAccessMode` so a stale card cannot consent to
   * a contract the team no longer has.
   */
  const [invitationToAccept, setInvitationToAccept] =
    useState<Invitation | null>(null);

  const { data: invitations = [] } = useQuery({
    queryKey: ['invitations'],
    queryFn: fetchMyInvitations,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });

  // GET /api/v1/invitations returns both directions — invitations addressed to
  // the caller AND ones the caller sent (a team's Invitations tab needs those).
  // Only the incoming ones belong here: Accept/Decline on an invitation you
  // sent yourself is rejected by the server ("Not your invitation"), and a
  // force-added invitee is already a member, so there is nothing for the
  // inviter to respond to.
  const pending = invitations.filter(
    (i: Invitation) => i.status === 'pending' && i.inviteeId === user?.id,
  );

  const respond = useMutation({
    mutationFn: ({
      invId,
      action,
      acknowledgedAccessMode,
    }: {
      invId: number;
      action: 'accept' | 'decline';
      acknowledgedAccessMode?: TeamAccessMode;
    }) => respondToInvitation(invId, action, acknowledgedAccessMode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invitations'] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });

  const closePanel = useCallback(() => {
    setOpen(false);
    respond.reset();
  }, [respond]);

  // The click-catcher below closes the panel on an outside click; without this
  // Escape does nothing and that invisible full-screen layer keeps swallowing
  // clicks, which reads as a frozen page. Matches UserMenu.tsx, which copied
  // this panel's mechanics and already had Escape-to-close.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closePanel]);

  return (
    <div className="relative">
      <button
        className="relative p-1 rounded hover:bg-accent transition-colors"
        onClick={() => (open ? closePanel() : setOpen(true))}
        aria-label="Notifications"
      >
        <Bell className="size-4 text-muted-foreground" />
        {pending.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-medium">
            {pending.length > 9 ? '9+' : pending.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={closePanel} />
          <div className="absolute right-0 top-8 z-40 w-80 rounded-md border border-border bg-card shadow-lg">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm font-medium">Team invitations</p>
            </div>
            {pending.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                No pending invitations
              </p>
            ) : (
              <ul className="max-h-72 overflow-y-auto">
                {pending.map((inv: Invitation) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border last:border-0"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="text-sm truncate">
                        {inv.teamName ?? `Team #${inv.teamId}`}
                      </span>
                      {inv.accessMode && (
                        <Badge
                          className={ACCESS_MODE_BADGE_CLASS[inv.accessMode]}
                        >
                          {ACCESS_MODE_LABEL[inv.accessMode]}
                        </Badge>
                      )}
                    </span>
                    <div className="flex gap-1 shrink-0">
                      <button
                        className="px-2 py-0.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                        onClick={() => {
                          respond.reset();
                          setInvitationToAccept(inv);
                        }}
                        disabled={respond.isPending}
                      >
                        Accept
                      </button>
                      <button
                        className="px-2 py-0.5 text-xs rounded border border-border hover:bg-accent transition-colors"
                        onClick={() =>
                          respond.mutate({ invId: inv.id, action: 'decline' })
                        }
                        disabled={respond.isPending}
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {respond.isError && invitationToAccept === null && (
              <p className="px-3 py-2 border-t border-border text-xs text-destructive">
                {errorMessage(respond.error)}
              </p>
            )}
          </div>
        </>
      )}

      {/* Rendered outside the panel so closing the bell (or an outside click
          that lands on the dialog overlay) cannot unmount a disclosure the
          invitee is still reading. */}
      {invitationToAccept !== null && (
        <TeamDisclosureModal
          open
          teamName={
            invitationToAccept.teamName ?? `Team #${invitationToAccept.teamId}`
          }
          accessMode={invitationToAccept.accessMode ?? 'restricted'}
          hasTrainer={invitationToAccept.hasTrainer}
          busy={respond.isPending}
          error={respond.isError ? errorMessage(respond.error) : null}
          onAccept={() =>
            respond.mutate(
              {
                invId: invitationToAccept.id,
                action: 'accept',
                acknowledgedAccessMode:
                  invitationToAccept.accessMode ?? 'restricted',
              },
              { onSuccess: () => setInvitationToAccept(null) },
            )
          }
          onCancel={() => {
            setInvitationToAccept(null);
            respond.reset();
          }}
        />
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Could not update the invitation. Please try again.';
}
