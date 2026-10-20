import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { TeamAccessMode } from '../../../../../models/teams';
import { updateTeamAccessMode } from '../../../../api';
import {
  ACCESS_MODE_DESCRIPTION,
  ACCESS_MODE_LABEL,
  ACCESS_MODE_SECTION_HINT,
  ACCESS_MODE_SECTION_TITLE,
  TRANSPARENT_DISABLED_NOTE,
  transparentLockNote,
} from '../../../../lib/access-mode-copy';
import { Badge } from '../../../../ui/badge';

interface TeamAccessModeCardsProps {
  teamId: number;
  accessMode: TeamAccessMode;
  /**
   * Members of this team other than the owner, counted client-side from the
   * list the tab already holds. Above zero the team is
   * locked to `restricted` — the privacy promise those members joined under
   * cannot be revoked.
   */
  nonOwnerMemberCount: number;
}

const MODES: TeamAccessMode[] = ['restricted', 'transparent'];

/**
 * Owner-only access-mode control on the Members tab: two selectable cards replacing the old single "Allow members to see
 * each other's sessions" checkbox.
 *
 * When the team has non-owner members the Transparent card is disabled and
 * `transparentLockNote()` is rendered permanently — the reason is stated up
 * front, never as a failure after pressing something.
 */
export function TeamAccessModeCards({
  teamId,
  accessMode,
  nonOwnerMemberCount,
}: TeamAccessModeCardsProps) {
  const queryClient = useQueryClient();
  const locked = nonOwnerMemberCount > 0;

  const modeMut = useMutation({
    mutationFn: (next: TeamAccessMode) => updateTeamAccessMode(teamId, next),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });

  return (
    <div
      className="flex flex-col gap-3 p-4 border border-border rounded-md bg-card"
      data-testid="team-access-mode-cards"
    >
      <div>
        <p className="text-sm font-medium">{ACCESS_MODE_SECTION_TITLE}</p>
        <p className="text-xs text-muted-foreground">
          {ACCESS_MODE_SECTION_HINT}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {MODES.map((mode) => {
          const selected = accessMode === mode;
          const disabled =
            modeMut.isPending || (mode === 'transparent' && locked);
          return (
            <label
              key={mode}
              className={[
                'flex flex-col gap-1 rounded-md border p-3',
                selected ? 'border-primary bg-accent/40' : 'border-border',
                disabled && !selected
                  ? 'opacity-60 cursor-not-allowed'
                  : 'cursor-pointer',
              ].join(' ')}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`team-access-mode-${teamId}`}
                  value={mode}
                  aria-label={ACCESS_MODE_LABEL[mode]}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => {
                    if (!selected) modeMut.mutate(mode);
                  }}
                />
                <span className="text-sm font-medium">
                  {ACCESS_MODE_LABEL[mode]}
                </span>
                {mode === 'restricted' && (
                  <Badge variant="secondary">default</Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {ACCESS_MODE_DESCRIPTION[mode]}
              </span>
              {mode === 'transparent' && locked && (
                <span className="text-xs text-muted-foreground">
                  {TRANSPARENT_DISABLED_NOTE}
                </span>
              )}
            </label>
          );
        })}
      </div>

      {locked && (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          data-testid="transparent-lock-note"
        >
          {transparentLockNote(nonOwnerMemberCount)}
        </p>
      )}

      {modeMut.isError && (
        <p className="text-xs text-destructive">
          {modeMut.error instanceof Error && modeMut.error.message
            ? modeMut.error.message
            : 'Could not change the access mode. Please try again.'}
        </p>
      )}
    </div>
  );
}
