import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminUser } from '../../../../models/admin';
import { renameAdminUserEmail } from '../../../api';
import { useAuthConfig } from '../../../hooks/useAuthConfig';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Button } from '../../../ui/button';

interface Props {
  user: AdminUser;
  onClose: () => void;
  /** Called with the new address after a successful rename. */
  onRenamed?: (email: string) => void;
}

export function RenameUserEmailModal({ user, onClose, onRenamed }: Props) {
  const queryClient = useQueryClient();
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState('');
  const { data: authConfig } = useAuthConfig();
  const isStrictManaged = authConfig?.mode === 'strict-managed';

  const rename = useMutation({
    mutationFn: (email: string) => renameAdminUserEmail(user.id, email),
    onSuccess: (_result, email) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      onRenamed?.(email.toLowerCase());
      onClose();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed');
    },
  });

  function handleRename(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newEmail.trim()) rename.mutate(newEmail.trim());
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Email</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleRename} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">
              Current email
            </label>
            <input
              className="w-full border border-border rounded px-3 py-2 text-sm bg-muted/40 text-muted-foreground"
              value={user.email}
              readOnly
              disabled
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">New email</label>
            <input
              className="w-full border border-border rounded px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="new.email@example.com"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              autoFocus
            />
          </div>
          {isStrictManaged && (
            <p className="text-xs text-muted-foreground">
              Links already sent to the current email stop working, and the
              password is cleared: send the person a new link with{' '}
              <span className="font-medium">Resend link</span> after the rename.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
