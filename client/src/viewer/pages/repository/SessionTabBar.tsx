import { Lock } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { tabTestId } from '../../tab-ids';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../ui/tooltip';
import type { SessionTab } from './useRepositoryViewState';

interface Props {
  sessionTab: SessionTab;
  onSessionTabChange: (tab: SessionTab) => void;
  /** The session has a Turn-End Cost Advisor result — shows the Advisor tab. */
  showAdvisor: boolean;
  /** The viewer may read this session's raw logs — shows the Raw Logs tab. */
  canSeeRawLogs: boolean;
  /** Bash commands in the session tree, shown muted after the Bash label; absent → no count. */
  bashCount?: number;
}

interface TabEntry {
  id: SessionTab;
  label: ReactNode;
  visible?: boolean;
  /** Wraps the trigger button, e.g. in a tooltip. */
  wrap?: (button: ReactNode) => ReactNode;
}

/**
 * The session detail pane's tab bar (DD-20): one data-driven list of triggers, in tab-bar order,
 * each carrying `data-testid="tab-session-<id>"`. Conditional tabs (Advisor, Raw Logs) are
 * listed with their condition; the Bash tab is always shown, after Logs.
 */
export function SessionTabBar({
  sessionTab,
  onSessionTabChange,
  showAdvisor,
  canSeeRawLogs,
  bashCount,
}: Props) {
  const tabs: TabEntry[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'info', label: 'Info' },
    { id: 'logs', label: 'Logs' },
    {
      id: 'bash',
      label: (
        <>
          Bash
          {bashCount !== undefined && (
            <span
              className="ml-1.5 font-mono text-xs text-muted-foreground"
              data-testid="session-bash-count"
            >
              {bashCount}
            </span>
          )}
        </>
      ),
    },
    { id: 'charts', label: 'Charts' },
    { id: 'advisor', label: 'Advisor', visible: showAdvisor },
    { id: 'usage', label: 'Statistics' },
    { id: 'change-surface', label: 'Change surface' },
    { id: 'harness-usage', label: 'Harness usage' },
    { id: 'okf', label: 'OKF' },
    {
      id: 'raw-logs',
      label: (
        <>
          <Lock className="size-[1em] text-amber-500 stroke-[2.5]" />
          Raw Logs
        </>
      ),
      visible: canSeeRawLogs,
      wrap: (button) => (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent
              side="bottom"
              variant="light"
              className="max-w-[280px] bg-amber-50 border-amber-300 text-amber-900"
            >
              <p className="font-semibold text-xs">Only visible to you</p>
              <p className="text-xs mt-0.5">
                Raw logs contain unfiltered session data. Other users viewing
                this session cannot see this tab.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
    },
  ];

  return (
    <>
      {tabs
        .filter((t) => t.visible !== false)
        .map((t) => {
          const button = (
            <button
              key={t.id}
              data-testid={tabTestId('session', t.id)}
              onClick={() => onSessionTabChange(t.id)}
              className={cn(
                'flex items-center gap-1 px-3 py-2 text-sm transition-colors',
                sessionTab === t.id
                  ? 'border-b-2 border-primary font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          );
          return t.wrap ? (
            <Fragment key={t.id}>{t.wrap(button)}</Fragment>
          ) : (
            button
          );
        })}
    </>
  );
}
