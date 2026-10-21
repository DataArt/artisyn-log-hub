import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { AdminTeam } from '../../../../models/admin';
import { fetchAdminTeams } from '../../../api';
import { useDebounce } from '../../../hooks/useDebounce';
import { PageState } from '../../../components/PageState';
import { DateTime } from '../../../components/DateTime';
import { AdminDataTable } from '../AdminDataTable';
import { Button } from '../../../ui/button';
import { AdminSetTeamOwnerDialog } from './AdminSetTeamOwnerDialog';

function SetOwnerButton({ team }: { team: AdminTeam }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Set new owner
      </Button>
      <AdminSetTeamOwnerDialog team={team} open={open} onOpenChange={setOpen} />
    </>
  );
}

const columns: ColumnDef<AdminTeam, unknown>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Team',
    enableGlobalFilter: true,
  },
  {
    id: 'ownerEmail',
    accessorKey: 'ownerEmail',
    header: 'Owner',
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
    id: 'memberCount',
    accessorKey: 'memberCount',
    header: 'Members',
    enableGlobalFilter: false,
  },
  {
    id: 'repoCount',
    accessorKey: 'repoCount',
    header: 'Repos',
    enableGlobalFilter: false,
  },
  {
    id: 'actions',
    header: 'Actions',
    enableGlobalFilter: false,
    enableSorting: false,
    cell: ({ row }) => <SetOwnerButton team={row.original} />,
  },
];

export function AdminTeamsTab() {
  const [filterText, setFilterText] = useState('');
  const debouncedFilter = useDebounce(filterText, 300);

  const {
    data: teams,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['admin-teams'],
    queryFn: fetchAdminTeams,
  });

  if (isLoading) return <PageState message="Loading…" />;
  if (isError)
    return <PageState message="Failed to load teams." variant="error" />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <input
        className="w-64 border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Filter by team name…"
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
      />
      <AdminDataTable
        columns={columns}
        data={teams ?? []}
        globalFilter={debouncedFilter}
      />
    </div>
  );
}
