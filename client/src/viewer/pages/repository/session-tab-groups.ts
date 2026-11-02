/**
 * The visible session tabs with their registry rows — what the session tab row renders. (The
 * file name predates the one-level bar: session groups are only More-menu section headers now.)
 */
import {
  SESSION_TABS,
  visibleTabs,
  type SessionTab,
  type TabRow,
  type TabVisibilityContext,
} from '../../tab-ids';

/** A visible session registry row with its typed tab id. */
export interface VisibleSessionRow {
  row: TabRow;
  tab: SessionTab;
}

/** The visible session tabs for `ctx`, in registry order, with their rows (aliases dropped). */
export function visibleSessionRows(
  ctx: TabVisibilityContext,
): VisibleSessionRow[] {
  return visibleTabs('session', ctx).flatMap((row) => {
    const tab = SESSION_TABS.find((t) => t === row.id);
    return tab === undefined ? [] : [{ row, tab }];
  });
}
