import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { TeamRepository } from '../../../../models/teams';
import {
  addTeamRepository,
  fetchMyRepositories,
  fetchTeamRepositories,
  removeTeamRepository,
  unlinkTeamRepository,
} from '../../../api';
import { Button } from '../../../ui/button';
import { ConfirmDialog } from '../../../ui/confirm-dialog';

interface TeamRepositoriesTabProps {
  teamId: number;
  isOwner: boolean;
  isAdmin: boolean;
}

type RepoAction = { repo: TeamRepository; action: 'remove' | 'unlink' };

export function TeamRepositoriesTab({
  teamId,
  isOwner,
  isAdmin,
}: TeamRepositoriesTabProps) {
  const queryClient = useQueryClient();
  const [repoUrl, setRepoUrl] = useState('');
  const [repoError, setRepoError] = useState('');
  const [repoAction, setRepoAction] = useState<RepoAction | null>(null);
  const [removeError, setRemoveError] = useState('');

  const canRemove = isOwner || isAdmin;

  const { data: repos = [] } = useQuery({
    queryKey: ['team-repos', teamId],
    queryFn: () => fetchTeamRepositories(teamId),
  });

  const { data: myRepos = [] } = useQuery({
    queryKey: ['my-repos'],
    queryFn: fetchMyRepositories,
  });

  const addRepoMut = useMutation({
    mutationFn: (url: string) => addTeamRepository(teamId, url),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team-repos', teamId] });
      setRepoUrl('');
      setRepoError('');
    },
    onError: (err: unknown) => {
      setRepoError(
        err instanceof Error ? err.message : 'Failed to add repository',
      );
    },
  });

  const removeRepoMut = useMutation({
    mutationFn: (repoId: number) => removeTeamRepository(teamId, repoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team-repos', teamId] });
      setRemoveError('');
    },
    onError: (err: unknown) => {
      setRemoveError(
        err instanceof Error ? err.message : 'Failed to remove repository',
      );
    },
  });

  const unlinkRepoMut = useMutation({
    mutationFn: (repoId: number) => unlinkTeamRepository(teamId, repoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team-repos', teamId] });
      setRemoveError('');
    },
    onError: (err: unknown) => {
      setRemoveError(
        err instanceof Error ? err.message : 'Failed to unlink repository',
      );
    },
  });

  const handleConfirm = () => {
    if (!repoAction) return;
    if (repoAction.action === 'unlink') {
      unlinkRepoMut.mutate(repoAction.repo.id);
    } else {
      removeRepoMut.mutate(repoAction.repo.id);
    }
    setRepoAction(null);
  };

  const handleCancel = () => {
    setRepoAction(null);
  };

  const getDialogProps = (action: RepoAction) => {
    const { repo, action: actionType } = action;
    if (actionType === 'unlink') {
      return {
        header: 'Unlink repository?',
        message:
          'Remove this repo from the team? Session data is preserved and the repo can be re-added.',
        confirmLabel: 'Unlink',
        destructive: false,
        requiresTyping: undefined as string | undefined,
      };
    }
    if (repo.sessionCount === 0) {
      return {
        header: 'Remove repository?',
        message:
          'Remove this repo from the team? It has no uploaded sessions and will be permanently deleted.',
        confirmLabel: 'Remove',
        destructive: false,
        requiresTyping: 'confirm',
      };
    }
    return {
      header: 'Remove repository?',
      message: `Permanently delete this repo and all ${repo.sessionCount} session(s)? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
      requiresTyping: 'confirm',
    };
  };

  return (
    <div className="flex flex-col gap-4">
      {repos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories added yet.
        </p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-left">
                <th className="pb-2 font-medium">URL</th>
                <th className="pb-2 font-medium w-20 text-right">Sessions</th>
                {canRemove && (
                  <th className="pb-2 font-medium text-right">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {repos.map((r: TeamRepository) => {
                const isOrphan = r.sessionCount === 0;
                return (
                  <tr
                    key={r.id}
                    className={
                      isOrphan
                        ? 'border-l-2 border-orange-500 bg-orange-50 dark:bg-orange-950/20'
                        : ''
                    }
                  >
                    <td className="py-2 pl-2 pr-4 truncate max-w-xs">
                      {r.repoUrl}
                    </td>
                    <td className="py-2 text-right w-20 tabular-nums">
                      {r.sessionCount}
                    </td>
                    {canRemove && (
                      <td className="py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {r.sessionCount > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              onClick={() =>
                                setRepoAction({ repo: r, action: 'unlink' })
                              }
                            >
                              Unlink
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive text-xs"
                            onClick={() =>
                              setRepoAction({ repo: r, action: 'remove' })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {removeError && (
            <p className="text-xs text-destructive">{removeError}</p>
          )}
        </>
      )}

      {isOwner && (
        <>
          {/* Manual URL input */}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (repoUrl.trim()) addRepoMut.mutate(repoUrl.trim());
            }}
          >
            <input
              className="flex-1 border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Paste repository URL… (recommended way - attach repo via My API Keys -> Full Auto Install and pick repo from list)"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={addRepoMut.isPending}>
              Add
            </Button>
          </form>
          {repoError && <p className="text-xs text-destructive">{repoError}</p>}

          {/* My repos not yet in this team */}
          {(() => {
            const teamUrls = new Set(
              repos.map((r: TeamRepository) => r.repoUrl),
            );
            const available = myRepos.filter((r) => !teamUrls.has(r.repoUrl));
            if (available.length === 0) return null;
            return (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  My repositories
                </p>
                <ul className="flex flex-col gap-1">
                  {available.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 border border-border rounded-md bg-card/50 hover:bg-accent/30 cursor-pointer"
                      onClick={() => addRepoMut.mutate(r.repoUrl)}
                    >
                      <span className="text-sm truncate">{r.repoUrl}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        + Add
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </>
      )}

      {repoAction &&
        (() => {
          const dialogProps = getDialogProps(repoAction);
          return (
            <ConfirmDialog
              open={repoAction !== null}
              header={dialogProps.header}
              message={dialogProps.message}
              confirmLabel={dialogProps.confirmLabel}
              destructive={dialogProps.destructive}
              requiresTyping={dialogProps.requiresTyping}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
            />
          );
        })()}
    </div>
  );
}
