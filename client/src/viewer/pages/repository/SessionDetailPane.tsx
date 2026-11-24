import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Star, Trash2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import type { RepositorySession } from '../../../models/repositories';
import type { ModelPricingMap } from '../../../models/pricing';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { cn } from '../../lib/cn';
import { useAuth } from '../../context/AuthContext';
import { SessionDetailHeader } from './SessionDetailHeader';
import { deriveSessionUsage } from './session-log/usage/session-usage-derive';
import { computeTreeCodeImpact } from './session-log/tree-code-impact';
import type { ParsedSession } from './session-log/types';
import type { SubagentMetaMap } from './session-log/log-parser';
import type { SessionLogsQueryView } from './session-parts/useSessionLogParts';
import type { RepoConfig } from '../../../models/repositories';
import { ToolViewProvider } from './session-log/tool-call-view/ToolViewContext';
import { SessionTabBar } from './SessionTabBar';
import { SessionTabContent } from './SessionTabContent';
import { SessionLoadBanners } from './SessionLoadBanners';
import {
  SessionPartsProvider,
  type SessionPartsValue,
} from './session-parts/SessionPartsContext';
import { isChartTab, type TabVisibilityContext } from '../../tab-ids';
import { collectBashCalls } from './session-log/bash-tab/collect-bash-calls';
import { readChartTab, rememberChartTab } from './session-log/charts/chart-tab';
import type { LensId } from './session-lenses';
import { useSessionLens } from './useSessionLens';

import type { SessionTab } from './useRepositoryViewState';

export interface SessionDetailPaneProps {
  selectedSession: RepositorySession;
  sessionTab: SessionTab;
  onSessionTabChange: (tab: SessionTab) => void;
  /** The `lens` URL param (DD-7); `null` → the remembered `session-lens`, then `DEFAULT_LENS`. */
  lensParam: LensId | null;
  /** Writes `lens` and its default tab in one URL update (`switchLens`). */
  onLensSwitch: (lens: LensId, defaultTab: SessionTab) => void;
  isFavorite: boolean;
  favoriteMutationPending: boolean;
  onFavoriteToggle: (newValue: boolean) => void;
  repoId: number;
  teamId?: number;
  showDeleteDialog: boolean;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  deleteLoading: boolean;
  logsQuery: SessionLogsQueryView;
  parsedLogs: ParsedSession | null;
  subagentLogsMap: Map<string, Record<string, unknown>[]>;
  agentParentMap: Map<string, string | null>;
  /** Every manifest sub-agent's `.meta.json` labels, loaded or not. */
  subagentMeta: SubagentMetaMap;
  /** Bare ids of every sub-agent in the manifest, loaded or not (DD-31). */
  knownAgentIds: ReadonlySet<string>;
  pricing: ModelPricingMap | null | undefined;
  repoConfig: RepoConfig | null;
  topN: number | null;
  onTopNChange: (n: number | null) => void;
  repoUrl: string | undefined;
  sessionCost: number | null;
  isReloadingUpdatedSession: boolean;
  /** On-demand loading of this session's log parts, provided to the tabs (DD-30a). */
  sessionParts: SessionPartsValue;
  /** The parts manifest's `derivedLagging` flag (DD-14). */
  derivedLagging: boolean;
  /** `tool_use` id of a Tools/MCP "Open in session" link (`tu` param, DD-19). */
  targetToolUseId?: string | null;
  /** Clears the `tu` param once the Logs tab has acted on it. */
  onTargetToolUseConsumed?: () => void;
}

export function SessionDetailPane({
  selectedSession,
  sessionTab,
  onSessionTabChange,
  lensParam,
  onLensSwitch,
  isFavorite,
  favoriteMutationPending,
  onFavoriteToggle,
  repoId,
  teamId,
  showDeleteDialog,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  deleteLoading: _deleteLoading,
  logsQuery,
  parsedLogs,
  subagentLogsMap,
  agentParentMap,
  subagentMeta,
  knownAgentIds,
  pricing,
  repoConfig,
  topN,
  onTopNChange,
  repoUrl,
  sessionCost,
  isReloadingUpdatedSession,
  sessionParts,
  derivedLagging,
  targetToolUseId,
  onTargetToolUseConsumed,
}: SessionDetailPaneProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // The server decides who may read a session's logs (owner, any member of a transparent
  // team, the restricted-team roles — never the app admin role as such); in a team view
  // the tab follows that answer.
  const canSeeRawLogs =
    !!selectedSession.userId &&
    (user?.id === selectedSession.userId ||
      (teamId !== undefined && logsQuery.isSuccess));

  // Every tab, the Session Map included, reads the parts: Refresh re-reads the manifest.
  const handleRefresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ['session-logs', repoId, selectedSession.sessionId, teamId],
    });
  };

  useEffect(() => {
    if (sessionTab === 'raw-logs' && !canSeeRawLogs && !logsQuery.isPending) {
      onSessionTabChange('summary');
    }
  }, [sessionTab, canSeeRawLogs, onSessionTabChange]);

  // The transcript walk and the own/tree code-impact pair are
  // derived once here, at the session-detail level, and handed to every tab that needs them.
  // Previously the Summary and Statistics tabs each ran their own `deriveSessionUsage` walk
  // over the same logs, and the Info tab had no access to the tree figures at all — which is
  // how a delegating session came to show "0 lines changed" beside "22 sub-agents". Memoised on
  // the raw payload, so switching tabs never re-walks.
  const mainLogs = logsQuery.data?.main ?? null;
  const subagentStats = logsQuery.data?.subagentStats ?? null;
  const rootStats = logsQuery.data?.rootStats ?? null;
  // Root transcript only (DD-33): sub-agent parts load on demand, so a tree walk here would
  // shift as they arrive. The tree figures come from `subagentStats` (`computeTreeCodeImpact`).
  const usage = useMemo(() => deriveSessionUsage(mainLogs), [mainLogs]);
  const codeImpact = useMemo(
    () => computeTreeCodeImpact({ usage, subagentStats, rootStats }),
    [usage, subagentStats, rootStats],
  );

  // Tools/MCP failure dot (DD-9): any transcript-derived MCP failure across the tree — no
  // extra request and no early load of the lazy Tools tab (FR-B3). Hidden until every part is
  // loaded (DD-33), so it never flips as sub-agent parts arrive.
  const { allLoaded } = sessionParts;
  const toolsFailure = useMemo(
    () =>
      allLoaded &&
      deriveSessionUsage(mainLogs, [
        ...subagentLogsMap.values(),
      ]).mcpServers.some((s) => s.failures > 0),
    [allLoaded, mainLogs, subagentLogsMap],
  );

  // The chart last opened is what a legacy `tab=charts` link reopens (see below).
  const userId = user?.id;
  useEffect(() => {
    if (isChartTab(sessionTab)) rememberChartTab(sessionTab);
  }, [sessionTab]);

  // Bash command count for the tab bar (DD-20) — the same collector the Bash tab lists, no WASM.
  // Undefined (no badge) until every part is loaded (DD-33).
  const bashCount = useMemo(
    () =>
      allLoaded && logsQuery.data
        ? collectBashCalls(mainLogs, subagentLogsMap).length
        : undefined,
    [allLoaded, logsQuery.data, mainLogs, subagentLogsMap],
  );

  // A stale/bookmarked `tab=charts` deep link — the charts used to be sub-tabs of one Charts tab
  // and are plain session tabs now — opens the chart this browser last showed (Dashboard by
  // default), as the old Charts tab did.
  useEffect(() => {
    if (sessionTab === 'charts') {
      onSessionTabChange(readChartTab());
    }
  }, [sessionTab, onSessionTabChange]);

  // A stale/bookmarked `tab=advisor` deep link redirects to Summary once the
  // logs have loaded and there is in fact no advisor result to show (the tab button itself is
  // never rendered in that case, so this only catches a direct URL edit).
  const turnEndAdvisor = logsQuery.data?.turnEndAdvisor ?? null;
  useEffect(() => {
    if (
      sessionTab === 'advisor' &&
      !logsQuery.isLoading &&
      turnEndAdvisor == null
    ) {
      onSessionTabChange('summary');
    }
  }, [sessionTab, logsQuery.isLoading, turnEndAdvisor, onSessionTabChange]);

  // What the tab registry's session predicates look at (Advisor, Raw Logs).
  const tabVisibility: TabVisibilityContext = useMemo(
    () => ({ hasAdvisorResult: turnEndAdvisor != null, canSeeRawLogs }),
    [turnEndAdvisor, canSeeRawLogs],
  );

  // The effective lens (DD-7): URL → remembered `session-lens` → `DEFAULT_LENS`; never written
  // on load, so no `tab=` opens Summary and an explicit `tab=` wins.
  const { lens, switchLens: handleLensChange } = useSessionLens(
    userId,
    lensParam,
    tabVisibility,
    onLensSwitch,
  );

  return (
    <>
      <SessionDetailHeader
        session={selectedSession}
        parsedLogs={parsedLogs}
        sessionCost={sessionCost}
        pricing={pricing ?? null}
        sessionAttribution={logsQuery.data?.sessionAttribution ?? null}
      />

      {/* flex-wrap: on narrow panes the trailing Remove button moves to a second row instead
          of being clipped by the pane's overflow-hidden. */}
      <div className="shrink-0 flex flex-wrap items-center border-b border-border px-4">
        <button
          onClick={() => onFavoriteToggle(!isFavorite)}
          aria-label="Toggle favorite"
          aria-pressed={isFavorite}
          disabled={favoriteMutationPending}
          className={`mr-1 flex items-center justify-center rounded border border-border p-1 transition-colors hover:bg-accent/50 disabled:opacity-50 ${isFavorite ? 'text-yellow-400 hover:text-yellow-500' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <Star
            className="size-3.5"
            fill={isFavorite ? 'currentColor' : 'none'}
          />
        </button>
        <button
          onClick={handleRefresh}
          title="Refresh"
          data-testid="session-refresh"
          className="mr-2 flex items-center justify-center rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <RefreshCw
            className={cn('size-3.5', logsQuery.isFetching && 'animate-spin')}
          />
        </button>
        <SessionTabBar
          sessionTab={sessionTab}
          onSessionTabChange={onSessionTabChange}
          lens={lens}
          onLensChange={handleLensChange}
          ctx={tabVisibility}
          bashCount={bashCount}
          toolsFailure={toolsFailure}
        />
        {user?.id === selectedSession.userId && (
          // Icon-only, so the one row of session tabs keeps its width; the label is the
          // accessible name and the tooltip.
          <button
            onClick={onDeleteRequest}
            aria-label="Remove"
            title="Remove session"
            className="ml-auto flex items-center rounded border border-destructive/30 p-1 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteDialog}
        header="Remove Session?"
        message="This will permanently delete all logs and data for this session. This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive={true}
        onConfirm={onDeleteConfirm}
        onCancel={onDeleteCancel}
      />

      <SessionLoadBanners
        isReloadingUpdatedSession={isReloadingUpdatedSession}
        derivedLagging={derivedLagging}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <SessionPartsProvider value={sessionParts}>
          <ToolViewProvider
            repoRoot={parsedLogs?.repoRoot ?? ''}
            parsedLogs={parsedLogs}
            subagentLogsMap={subagentLogsMap}
            pricing={pricing ?? undefined}
            sessionModel={parsedLogs?.summary.model}
          >
            <SessionTabContent
              selectedSession={selectedSession}
              sessionTab={sessionTab}
              onSessionTabChange={onSessionTabChange}
              onLensSwitch={handleLensChange}
              repoId={repoId}
              teamId={teamId}
              logsQuery={logsQuery}
              parsedLogs={parsedLogs}
              subagentLogsMap={subagentLogsMap}
              agentParentMap={agentParentMap}
              subagentMeta={subagentMeta}
              knownAgentIds={knownAgentIds}
              pricing={pricing}
              repoConfig={repoConfig}
              topN={topN}
              onTopNChange={onTopNChange}
              repoUrl={repoUrl}
              sessionCost={sessionCost}
              usage={usage}
              codeImpact={codeImpact}
              bashCount={bashCount}
              targetToolUseId={targetToolUseId}
              onTargetToolUseConsumed={onTargetToolUseConsumed}
            />
          </ToolViewProvider>
        </SessionPartsProvider>
      </div>
    </>
  );
}
