import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useState } from 'react';
import type { Team } from '../../../models/teams';
import { deleteTeam, fetchTeams } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { routes } from '../../hooks/useHashRoute';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';

function TeamCard({
  team,
  userId,
  onDelete,
}: {
  team: Team;
  userId: number | undefined;
  onDelete: (team: Team) => void;
}) {
  const navigate = useNavigate();
  const isOwner = team.ownerId === userId;
  const roleLabel = isOwner ? 'Owner' : 'Member';

  return (
    <li
      className="flex items-center justify-between p-4 border border-border rounded-md bg-card hover:bg-accent/30 cursor-pointer"
      onClick={() => navigate(routes.team(team.id))}
    >
      <div>
        <p className="text-sm font-medium">{team.name}</p>
        <p className="text-xs text-muted-foreground">{roleLabel}</p>
      </div>
      {isOwner && (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(team);
          }}
        >
          Delete
        </Button>
      )}
    </li>
  );
}

export function TeamsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<Team | null>(null);

  const { data: teams = [], isLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const remove = useMutation({
    mutationFn: (teamId: number) => deleteTeam(teamId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });

  // `GET /teams` returns only the caller's own teams; the filter only guards against
  // an older server that still listed every team for an admin.
  const myTeams = teams.filter((t: Team) => t.isMember !== false);

  return (
    <div className="flex flex-col h-full p-6 gap-6">
      <div className="flex items-center gap-2">
        <Users className="size-5" />
        <h1 className="text-xl font-semibold">Teams</h1>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading teamsâ€¦</p>
      ) : (
        <>
          {myTeams.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No teams yet. Use + Add Team in the left panel to create one.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {myTeams.map((team: Team) => (
                <TeamCard
                  key={team.id}
                  team={team}
                  userId={user?.id}
                  onDelete={setPendingDelete}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        header="Delete team"
        message={`Delete team "${pendingDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
