import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  AdminTeam,
  CreateAdminUserRequest,
  CreateAdminUserResponse,
} from '../../../../models/admin';
import { ApiError, createAdminUser, fetchAdminTeams } from '../../../api';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Button } from '../../../ui/button';

interface Props {
  onClose: () => void;
  /** Called after the account was created, whether or not the email went out. */
  onCreated: (result: CreateAdminUserResponse) => void;
}

const FIELD_CLASS =
  'w-full border border-border rounded px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring';

/** Maps a create failure to the inline email-field error or the form-level error. */
function describeError(err: unknown): { field?: string; form?: string } {
  if (!(err instanceof ApiError)) {
    return { form: err instanceof Error ? err.message : 'Failed' };
  }
  if (err.statusCode === 409) {
    return { field: 'A user with this email already exists' };
  }
  if (err.statusCode === 429) {
    return {
      form: `Too many requests, try again in ${err.retryAfterSeconds ?? 60}s`,
    };
  }
  if (err.code === 'email_domain_not_allowed') {
    return { field: err.message };
  }
  if (err.code === 'team_not_found') {
    return { form: 'The selected team no longer exists' };
  }
  const message = String(err.message || '');
  return { form: message || `Request failed (${err.statusCode})` };
}

/**
 * Strict-managed "Create user": the account is created without a password and
 * the server emails it a 24 h set-password link.
 */
export function CreateUserModal({ onClose, onCreated }: Props) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [teamId, setTeamId] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [formError, setFormError] = useState('');

  const { data: teams } = useQuery({
    queryKey: ['admin-teams'],
    queryFn: fetchAdminTeams,
  });

  const create = useMutation({
    mutationFn: (req: CreateAdminUserRequest) => createAdminUser(req),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      if (result.teamId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      }
      onCreated(result);
      onClose();
    },
    onError: (err: unknown) => {
      const { field, form } = describeError(err);
      setFieldError(field ?? '');
      setFormError(form ?? '');
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError('');
    setFormError('');
    const trimmed = email.trim();
    if (!trimmed) return;
    create.mutate({
      email: trimmed,
      role,
      teamId: teamId ? Number(teamId) : null,
    });
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
          <DialogTitle>Create user</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            The user gets an email with a link to set their password. The link
            works once and is valid for 24 hours.
          </p>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="create-user-email"
              className="text-xs text-muted-foreground"
            >
              Email
            </label>
            <input
              id="create-user-email"
              className={FIELD_CLASS}
              placeholder="name@example.com"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              autoFocus
              required
            />
            {fieldError && (
              <p className="text-xs text-destructive">{fieldError}</p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="create-user-role"
              className="text-xs text-muted-foreground"
            >
              Role
            </label>
            <select
              id="create-user-role"
              className={FIELD_CLASS}
              value={role}
              onChange={(e) =>
                setRole(e.target.value === 'admin' ? 'admin' : 'user')
              }
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="create-user-team"
              className="text-xs text-muted-foreground"
            >
              Team
            </label>
            <select
              id="create-user-team"
              className={FIELD_CLASS}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">None</option>
              {(teams ?? []).map((t: AdminTeam) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !email.trim()}>
              Create &amp; send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
