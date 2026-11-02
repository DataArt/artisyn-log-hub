import { useCallback, useMemo } from 'react';
import { readUserItem, writeUserItem } from '../../lib/user-storage';
import type { SessionTab, TabVisibilityContext } from '../../tab-ids';
import {
  DEFAULT_LENS,
  lensDefaultTab,
  parseLens,
  type LensId,
} from './session-lenses';
import { visibleSessionRows } from './session-tab-groups';

/**
 * The effective session lens and its switch handler (DD-7).
 *
 * Effective lens = the URL `lens` param (`lensParam`), else the lens this user last picked
 * (`session-lens`), else `DEFAULT_LENS`. Reading never writes a lens or a default tab, so a URL
 * without `tab=` opens Summary under every lens and an explicit `tab=` always wins. A switch
 * remembers the lens and hands `onLensSwitch` the lens's default tab among the visible ones.
 */
export function useSessionLens(
  userId: number | string | null | undefined,
  lensParam: LensId | null,
  ctx: TabVisibilityContext,
  onLensSwitch: (lens: LensId, defaultTab: SessionTab) => void,
): { lens: LensId; switchLens: (lens: LensId) => void } {
  const storedLens = useMemo(
    () =>
      readUserItem(
        userId,
        'session-lens',
        (raw) => parseLens(raw) ?? undefined,
      ),
    [userId],
  );
  const lens: LensId = lensParam ?? storedLens ?? DEFAULT_LENS;

  const switchLens = useCallback(
    (next: LensId) => {
      writeUserItem(userId, 'session-lens', next);
      const visible = visibleSessionRows(ctx).map((r) => r.tab);
      onLensSwitch(next, lensDefaultTab(next, visible));
    },
    [userId, ctx, onLensSwitch],
  );

  return { lens, switchLens };
}
