import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ColumnDef, Row } from '@tanstack/react-table';
import type { AdminUser } from '../../../../models/admin';
import {
  adminDeleteUser,
  adminGenerateResetLink,
  fetchAdminUsers,
  updateAdminUserRole,
} from '../../../api';
import { useDebounce } from '../../../hooks/useDebounce';
import { useAuth } from '../../../context/AuthContext';
import { PageState } from '../../../components/PageState';
import { DateTime } from '../../../components/DateTime';
import { AdminDataTable } from '../AdminDataTable';
import { Button } from '../../../ui/button';
import { ConfirmDialog } from '../../../ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip';
import { RenameUserEmailModal } from './RenameUserEmailModal';
import { ResetPasswordLinkModal } from './ResetPasswordLinkModal';

function RoleActionCell({
  row,
  currentUserId,
  onToggle,
  isPending,
}: {
  row: Row<AdminUser>;
  currentUserId: number;
  onToggle: (user: AdminUser) => void;
  isPending: boolean;
}) {
  const user = row.original;
  const isSelf = user.id === currentUserId;
  const label = user.role === 'user' ? 'Make Admin' : 'Revoke Admin';

  if (isSelf) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="outline" size="sm" disabled>
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Cannot revoke your own admin role</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() => onToggle(user)}
    >
      {label}
    </Button>
  );
}

/**
 * Admin hard-delete action. Self-deletion is rejected by the server
 * (it would leave a live session bound to a deleted user), so the caller's own
 * row shows the same disabled-with-tooltip treatment as RoleActionCell.
 */
function DeleteActionCell({
  row,
  currentUserId,
  onDelete,
  isPending,
}: {
  row: Row<AdminUser>;
  currentUserId: number;
  onDelete: (user: AdminUser) => void;
  isPending: boolean;
}) {
  const user = row.original;
  const isSelf = user.id === currentUserId;

  if (isSelf) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="destructive" size="sm" disabled>
              Delete
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Cannot delete your own account here — use the account menu
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      variant="destructive"
      size="sm"
      disabled={isPending}
      onClick={() => onDelete(user)}
    >
      Delete
    </Button>
  );
}

export function AdminUsersTab() {
  const [filterText, setFilterText] = useState('');
  const debouncedFilter = useDebounce(filterText, 300);
  const [confirmUser, setConfirmUser] = useState<AdminUser | null>(null);
  const [resetLink, setResetLink] = useState<{
    email: string;
    resetUrl: string;
  } | null>(null);
  const [renameUser, setRenameUser] = useState<AdminUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: users,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['admin-users'],
    queryFn: fetchAdminUsers,
  });

  const roleMutation = useMutation({
    mutationFn: (user: AdminUser) =>
      updateAdminUserRole(user.id, user.role === 'user' ? 'admin' : 'user'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (user: AdminUser) => adminDeleteUser(user.id, user.email),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const resetLinkMutation = useMutation({
    mutationFn: (user: AdminUser) => adminGenerateResetLink(user.id),
    onSuccess: ({ resetUrl }, user) => {
      setResetLink({ email: user.email, resetUrl });
    },
  });

  const columns: ColumnDef<AdminUser, unknown>[] = [
    {
      id: 'email',
      accessorKey: 'email',
      header: 'Email',
      enableGlobalFilter: true,
    },
    {
      id: 'role',
      accessorKey: 'role',
      header: 'Role',
      enableGlobalFilter: false,
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: 'Created',
      enableGlobalFilter: false,
      cell: ({ getValue }) => <DateTime value={getValue() as string | null} />,
    },
    {
      id: 'teamCount',
      accessorKey: 'teamCount',
      header: 'Teams',
      enableGlobalFilter: false,
    },
    {
      id: 'lastActivity',
      header: 'Last Activity',
      accessorFn: (r) => r.lastActivity ?? null,
      enableGlobalFilter: false,
      cell: ({ getValue }) => <DateTime value={getValue() as string | null} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      enableGlobalFilter: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <RoleActionCell
            row={row}
            currentUserId={currentUser?.id ?? -1}
            onToggle={(user) => setConfirmUser(user)}
            isPending={roleMutation.isPending}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={resetLinkMutation.isPending}
            onClick={() => resetLinkMutation.mutate(row.original)}
          >
            Reset Password
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRenameUser(row.original)}
          >
            Rename Email
          </Button>
          <DeleteActionCell
            row={row}
            currentUserId={currentUser?.id ?? -1}
            onDelete={(user) => setDeleteUser(user)}
            isPending={deleteMutation.isPending}
          />
        </div>
      ),
    },
  ];

  if (isLoading) return <PageState message="Loading…" />;
  if (isError)
    return <PageState message="Failed to load users." variant="error" />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <input
        className="w-64 border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Filter by email…"
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
      />
      <AdminDataTable
        columns={columns}
        data={users ?? []}
        globalFilter={debouncedFilter}
      />
      <ConfirmDialog
        open={confirmUser !== null}
        header={
          confirmUser?.role === 'user'
            ? 'Grant admin role?'
            : 'Revoke admin role?'
        }
        message={
          confirmUser?.role === 'user'
            ? `Grant admin access to ${confirmUser.email}?`
            : `Revoke admin access from ${confirmUser?.email}? They will lose all admin privileges.`
        }
        confirmLabel={
          confirmUser?.role === 'user' ? 'Make Admin' : 'Revoke Admin'
        }
        destructive={confirmUser?.role === 'admin'}
        onConfirm={() => {
          if (confirmUser) roleMutation.mutate(confirmUser);
          setConfirmUser(null);
        }}
        onCancel={() => setConfirmUser(null)}
      />
      {/* Admin variant of the delete confirmation: the operator must type the
          TARGET's email exactly (the self-service dialog uses the word
          "delete"), and the email stays visible in the message. */}
      <ConfirmDialog
        open={deleteUser !== null}
        header="Delete this user's account?"
        message={
          deleteUser
            ? `Permanently deletes ${deleteUser.email} — their profile, credentials, and any personal repositories they own (with all their sessions), plus all of their sessions and logs. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        requiresTyping={deleteUser?.email ?? ''}
        onConfirm={() => {
          if (deleteUser) deleteMutation.mutate(deleteUser);
          setDeleteUser(null);
        }}
        onCancel={() => setDeleteUser(null)}
      />
      {resetLink && (
        <ResetPasswordLinkModal
          email={resetLink.email}
          resetUrl={resetLink.resetUrl}
          onClose={() => setResetLink(null)}
        />
      )}
      {renameUser && (
        <RenameUserEmailModal
          user={renameUser}
          onClose={() => setRenameUser(null)}
        />
      )}
    </div>
  );
}
