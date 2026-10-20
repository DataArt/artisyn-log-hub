import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { AdminRepo } from '../../../../models/admin';
import {
  fetchAdminRepos,
  removeAdminRepo,
  removeTeamRepository,
} from '../../../api';
import { useDebounce } from '../../../hooks/useDebounce';
import { PageState } from '../../../components/PageState';
import { DateTime } from '../../../components/DateTime';
import { AdminDataTable } from '../AdminDataTable';
import { ConfirmDialog } from '../../../ui/confirm-dialog';
import { Button } from '../../../ui/button';
import { formatBytes } from '../../../lib/format';

function RemoveButton({ row }: { row: AdminRepo }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasSessions = row.rawUploadCount > 0;
  const message = hasSessions
    ? `Permanently delete this repo and all ${row.rawUploadCount} session(s)? This cannot be undone.`
    : 'Remove this repo? It has no uploaded sessions and will be permanently deleted.';

  async function handleConfirm() {
    setError(null);
    setLoading(true);
    try {
      if (row.id !== null) {
        await removeAdminRepo(row.id);
      } else {
        await removeTeamRepository(row.teamId!, row.teamRepoId!);
      }
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['admin-repos'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove repository');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="destructive"
        disabled={loading}
        onClick={() => setOpen(true)}
      >
        {loading ? 'Removing…' : 'Remove'}
      </Button>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
      <ConfirmDialog
        open={open}
        header="Remove repository"
        message={message}
        confirmLabel={loading ? 'Removing…' : 'Delete'}
        cancelLabel="Cancel"
        destructive
        requiresTyping="confirm"
        onConfirm={() => void handleConfirm()}
        onCancel={() => {
          if (!loading) setOpen(false);
        }}
      />
    </>
  );
}

const columns: ColumnDef<AdminRepo, unknown>[] = [
  {
    id: 'repoUrl',
    accessorKey: 'repoUrl',
    header: 'Repository',
    enableGlobalFilter: true,
  },
  {
    id: 'ownerEmail',
    accessorKey: 'ownerEmail',
    header: 'Owner',
    enableGlobalFilter: false,
    cell: ({ getValue }) => (getValue() as string | null) ?? '—',
  },
  {
    id: 'teamName',
    accessorKey: 'teamName',
    header: 'Team',
    enableGlobalFilter: false,
    cell: ({ getValue }) => (getValue() as string | undefined) ?? '—',
  },
  {
    id: 'sessionCount',
    accessorKey: 'sessionCount',
    header: 'Sessions',
    enableGlobalFilter: false,
  },
  {
    id: 'rawUploadCount',
    accessorKey: 'rawUploadCount',
    header: 'Raw Uploads',
    enableGlobalFilter: false,
  },
  {
    id: 'logSize',
    accessorKey: 'logSize',
    header: 'Log Size',
    enableGlobalFilter: false,
    cell: ({ getValue }) => formatBytes(getValue() as number),
  },
  {
    id: 'maxUploadBytes',
    accessorKey: 'maxUploadBytes',
    header: 'Max Upload',
    enableGlobalFilter: false,
    cell: ({ getValue }) => {
      const v = getValue() as number | null;
      if (v === null) return <span className="text-muted-foreground">—</span>;
      if (v > 40 * 1024 * 1024) {
        return (
          <span className="bg-amber-100 text-amber-800 font-semibold rounded px-1">
            {formatBytes(v)} ⚠
          </span>
        );
      }
      return formatBytes(v);
    },
  },
  {
    id: 'lastSession',
    header: 'Last Session',
    accessorFn: (r) => r.lastSession ?? null,
    enableGlobalFilter: false,
    cell: ({ getValue }) => <DateTime value={getValue() as string | null} />,
  },
  {
    id: 'firstSeen',
    header: 'First Seen',
    accessorFn: (r) => r.firstSeen ?? null,
    enableGlobalFilter: false,
    cell: ({ getValue }) => <DateTime value={getValue() as string | null} />,
  },
  {
    id: 'actions',
    header: 'Actions',
    enableGlobalFilter: false,
    enableSorting: false,
    cell: ({ row }) => <RemoveButton row={row.original} />,
  },
];

function getRowClassName(row: AdminRepo): string {
  if (row.rawUploadCount === 0) {
    return 'bg-orange-50 dark:bg-orange-950/20 border-l-2 border-orange-500';
  }
  return '';
}

export function AdminReposTab() {
  const [filterText, setFilterText] = useState('');
  const debouncedFilter = useDebounce(filterText, 300);

  const {
    data: repos,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['admin-repos'],
    queryFn: fetchAdminRepos,
  });

  if (isLoading) return <PageState message="Loading…" />;
  if (isError)
    return <PageState message="Failed to load repositories." variant="error" />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <input
        className="w-64 border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Filter by repository URL…"
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
      />
      <AdminDataTable
        columns={columns}
        data={repos ?? []}
        globalFilter={debouncedFilter}
        getRowClassName={getRowClassName}
      />
    </div>
  );
}
