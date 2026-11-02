import { useMemo } from 'react';
import type { TabVisibilityContext } from '../../tab-ids';
import { TooltipProvider } from '../../ui/tooltip';
import type { LensId } from './session-lenses';
import { visibleSessionRows } from './session-tab-groups';
import { SessionLensRow } from './SessionLensRow';
import { SessionLensSwitcher } from './SessionLensSwitcher';
import type { SessionTabDecorations } from './SessionTabTrigger';
import type { SessionTab } from './useRepositoryViewState';

interface Props {
  sessionTab: SessionTab;
  onSessionTabChange: (tab: SessionTab) => void;
  /** The effective lens: which tabs the row shows (`all` = every visible tab). */
  lens: LensId;
  onLensChange: (lens: LensId) => void;
  /** What decides the conditional tabs (Advisor: `hasAdvisorResult`, Raw Logs: `canSeeRawLogs`). */
  ctx: TabVisibilityContext;
  /** Bash commands in the session tree, shown muted after the Bash label; absent → no count. */
  bashCount?: number;
  /** Transcript-derived MCP failures exist → the Tools/MCP failure dot (DD-9). */
  toolsFailure: boolean;
}

/**
 * The session detail pane's tab bar: one level of tabs. The "View" select (the lens) comes
 * first, then the lens's single row (`SessionLensRow`, DD-7) with "More ▾" for every other tab.
 * Each trigger carries `data-testid="tab-session-<id>"`, its description tooltip and its per-id
 * decoration (Bash count, Raw Logs lock, Tools/MCP failure dot). Conditional tabs follow the
 * registry predicates over `ctx`.
 */
export function SessionTabBar({
  sessionTab,
  onSessionTabChange,
  lens,
  onLensChange,
  ctx,
  bashCount,
  toolsFailure,
}: Props) {
  const decorations: SessionTabDecorations = useMemo(
    () => ({ bashCount, toolsFailure }),
    [bashCount, toolsFailure],
  );
  const rows = useMemo(() => visibleSessionRows(ctx), [ctx]);
  return (
    <TooltipProvider>
      <SessionLensSwitcher lens={lens} onLensChange={onLensChange} />
      <SessionLensRow
        lens={lens}
        sessionTab={sessionTab}
        onSessionTabChange={onSessionTabChange}
        rows={rows}
        decorations={decorations}
      />
    </TooltipProvider>
  );
}
