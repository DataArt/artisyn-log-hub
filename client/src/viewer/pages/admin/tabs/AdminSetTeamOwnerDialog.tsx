import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminTeam, AdminTeamMember } from '../../../../models/admin';
import { fetchAdminTeamMembers, setAdminTeamOwner } from '../../../api';
import { Button } from '../../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';

interface AdminSetTeamOwnerDialogProps {
  team: AdminTeam;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * FR-8 "Set new owner" — the one team action an admin has without being a member.
 * The picker lists member identity only (email); no session data is fetched.
 */
export function AdminSetTeamOwnerDialog({
  team,
  open,
  onOpenChange,
}: AdminSetTeamOwnerDialogProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');

  const { data: members = [], isLoading } = useQuery({
    queryKey: ['admin-team-members', team.id],
    queryFn: () => fetchAdminTeamMembers(team.id),
    enabled: open,
  });
  const candidates = members.filter((m: AdminTeamMember) => !m.isOwner);

  const setOwner = useMutation({
    mutationFn: (userId: number) => setAdminTeamOwner(team.id, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      void queryClient.invalidateQueries({
        queryKey: ['admin-team-members', team.id],
      });
      close();
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : 'Failed to set the new owner');
    },
  });

  function close() {
    setSelected('');
    setError('');
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !setOwner.isPending) close();
      }}
    >
      <DialogContent data-testid="admin-set-team-owner-dialog">
        <DialogHeader>
          <DialogTitle>Set new owner — {team.name}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Current owner: {team.ownerEmail}
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This team has no other members.
          </p>
        ) : (
          <select
            className="border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="New owner"
          >
            <option value="">Select member…</option>
            {candidates.map((m: AdminTeamMember) => (
              <option key={m.userId} value={String(m.userId)}>
                {m.email}
              </option>
            ))}
          </select>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={setOwner.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!selected || setOwner.isPending}
            onClick={() => {
              setError('');
              setOwner.mutate(Number(selected));
            }}
          >
            Set owner
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
