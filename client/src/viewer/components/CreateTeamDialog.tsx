import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createTeam } from '../api';
import { useNavigate } from 'react-router-dom';
import { routes } from '../hooks/useHashRoute';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface CreateTeamDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateTeamDialog({ open, onClose }: CreateTeamDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');

  const create = useMutation({
    mutationFn: (name: string) => createTeam(name),
    onSuccess: (team) => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      setNewName('');
      setCreateError('');
      onClose();
      navigate(routes.team(team.id));
    },
    onError: (err: unknown) => {
      setCreateError(err instanceof Error ? err.message : 'Failed');
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (newName.trim()) create.mutate(newName.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          setNewName('');
          setCreateError('');
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Team</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <input
            className="w-full border border-border rounded px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Team name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          {createError && (
            <p className="text-xs text-destructive">{createError}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setNewName('');
                setCreateError('');
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
