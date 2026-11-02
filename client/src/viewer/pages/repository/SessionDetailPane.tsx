import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, Star, Trash2 } from 'lucide-react';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { RepositorySession } from '../../../models/repositories';
import type { ModelPricingMap } from '../../../models/pricing';
import type { UseQueryResult } from '@tanstack/react-query';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { cn } from '../../lib/cn';
import { useAuth } from '../../context/AuthContext';
import { LazyFallback } from '../../components/LazyFallback';
import { SessionInfoTab } from './session-log/SessionInfoTab';
import { SessionLogView } from './session-log/SessionLogView';
import { SessionDetailHeader } from './SessionDetailHeader';
import { RawLogsTab } from './session-log/RawLogsTab';
import { SessionUsageTab } from './session-log/usage/SessionUsageTab';
import { SessionSummaryTab } from './session-log/summary/SessionSummaryTab';
import { useAiToolVersions } from '../../hooks/useAiToolVersions';
import { AdvisorTab } from './AdvisorTab';
import { deriveSessionUsage } from './session-log/usage/session-usage-derive';
import { computeTreeCodeImpact } from './session-log/tree-code-impact';
import type { ParsedSession } from './session-log/types';
import { fetchSessionChangeSurface, type SessionLogsData } from '../../api';
import type { RepoConfig } from '../../../models/repositories';
import { ToolViewProvider } from './session-log/tool-call-view/ToolViewContext';
import { SessionTabBar } from './SessionTabBar';
import { isChartTab, type TabVisibilityContext } from '../../tab-ids';
import { collectBashCalls } from './session-log/bash-tab/collect-bash-calls';
import { readChartTab, rememberChartTab } from './session-log/charts/chart-tab';
import type { LensId } from './session-lenses';
import { useSessionLens } from './useSessionLens';

import type { SessionTab } from './useRepositoryViewState';

import {
  SessionBashTab,
  SessionChangeSurfaceTab,
  SessionChartsTab,
  SessionHarnessUsageTab,
  SessionOkfTab,
  SessionOtelTab,
  SessionSysctxAnatomyTab,
  SessionToolsTab,
} from './session-lazy-tabs';

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
  logsQuery: UseQueryResult<SessionLogsData>;
  parsedLogs: ParsedSession | null;
  subagentLogsMap: Map<string, Record<string, unknown>[]>;
  agentParentMap: Map<string, string | null>;
  pricing: ModelPricingMap | null | undefined;
  repoConfig: RepoConfig | null;
  topN: number | null;
  onTopNChange: (n: number | null) => void;
  repoUrl: string | undefined;
  sessionCost: number | null;
  isReloadingUpdatedSession: boolean;
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
  pricing,
  repoConfig,
  topN,
  onTopNChange,
  repoUrl,
  sessionCost,
  isReloadingUpdatedSession,
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

  // Cross-tab turn targeting — transient, not a URL param.
  const [targetTurnIndex, setTargetTurnIndex] = useState<number | null>(null);

  // Called by a Summary deep link (a finding, a per-prompt cost row) to jump to a turn in the
  // Logs tab.
  const onGoToTurn = useCallback(
    (turnIndex: number) => {
      setTargetTurnIndex(turnIndex);
      onSessionTabChange('logs');
    },
    [onSessionTabChange],
  );

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
  const usage = useMemo(
    () => deriveSessionUsage(mainLogs, [...subagentLogsMap.values()]),
    [mainLogs, subagentLogsMap],
  );
  const codeImpact = useMemo(
    () => computeTreeCodeImpact({ usage, subagentStats, rootStats }),
    [usage, subagentStats, rootStats],
  );

  // Tools/MCP failure dot (DD-9): any transcript-derived MCP failure, from the memo above — no
  // extra request and no early load of the lazy Tools tab (FR-B3).
  const toolsFailure = useMemo(
    () => usage.mcpServers.some((s) => s.failures > 0),
    [usage],
  );

  // The chart last opened is what a legacy `tab=charts` link reopens (see below).
  const userId = user?.id;
  useEffect(() => {
    if (isChartTab(sessionTab)) rememberChartTab(sessionTab);
  }, [sessionTab]);

  // Bash command count for the tab bar (DD-20) — the same collector the Bash tab lists, no WASM.
  const bashCount = useMemo(
    () => collectBashCalls(mainLogs, subagentLogsMap).length,
    [mainLogs, subagentLogsMap],
  );

  // Release history for the Summary tab's version detector.
  const claudeReleaseHistory = useAiToolVersions();

  // Only the *aggregate* is fetched here, for the Summary tab's
  // Change-surface tile and its three CS detectors; the per-path rows stay behind the Change
  // surface tab's own query. Same query key as that tab uses, so opening the tab reuses this
  // cache entry rather than issuing a second identical request.
  const changeSurfaceQuery = useQuery({
    queryKey: [
      'session-change-surface',
      repoId,
      selectedSession.sessionId,
      teamId,
    ],
    queryFn: () =>
      fetchSessionChangeSurface(repoId, selectedSession.sessionId, teamId),
  });

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
          onClick={() =>
            void queryClient.invalidateQueries({
              queryKey: [
                'session-logs',
                repoId,
                selectedSession.sessionId,
                teamId,
              ],
            })
          }
          title="Refresh"
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
          bashCount={logsQuery.data ? bashCount : undefined}
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

      {isReloadingUpdatedSession && (
        <div className="flex shrink-0 items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading updated session…</span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        <ToolViewProvider
          repoRoot={parsedLogs?.repoRoot ?? ''}
          parsedLogs={parsedLogs}
          subagentLogsMap={subagentLogsMap}
          pricing={pricing ?? undefined}
          sessionModel={parsedLogs?.summary.model}
        >
          {sessionTab === 'summary' ? (
            <SessionSummaryTab
              selectedSession={selectedSession}
              parsedLogs={parsedLogs}
              logsQuery={logsQuery}
              mainLogs={mainLogs}
              pricing={pricing}
              sessionCost={sessionCost}
              subagentLogsMap={subagentLogsMap}
              agentParentMap={agentParentMap}
              onSessionTabChange={onSessionTabChange}
              onGoToTurn={onGoToTurn}
              usage={usage}
              codeImpact={codeImpact}
              changeSurface={changeSurfaceQuery.data ?? null}
              changeSurfaceLoading={changeSurfaceQuery.isLoading}
              claudeReleaseHistory={claudeReleaseHistory}
              bashCount={logsQuery.data ? bashCount : undefined}
              onLensSwitch={handleLensChange}
            />
          ) : sessionTab === 'logs' ? (
            <SessionLogView
              logsData={logsQuery.data}
              isLoading={logsQuery.isLoading}
              error={logsQuery.error}
              pricing={pricing ?? undefined}
              repoConfig={repoConfig}
              sessionSubagentCost={selectedSession.costBreakdown.subagentCost}
              targetTurnIndex={targetTurnIndex}
              onTargetTurnConsumed={() => setTargetTurnIndex(null)}
              targetToolUseId={targetToolUseId}
              onTargetTurnResolved={setTargetTurnIndex}
              onTargetToolUseConsumed={onTargetToolUseConsumed}
              onOpenAnatomy={() => onSessionTabChange('sysctx')}
            />
          ) : sessionTab === 'bash' ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionBashTab
                mainLogs={mainLogs}
                subagentLogsMap={subagentLogsMap}
                pricing={pricing ?? undefined}
                sessionModel={parsedLogs?.summary.model}
              />
            </Suspense>
          ) : isChartTab(sessionTab) ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionChartsTab
                chart={sessionTab}
                onOpenChart={onSessionTabChange}
                parsedLogs={parsedLogs}
                subagentLogsMap={subagentLogsMap}
                agentParentMap={agentParentMap}
                isLoading={logsQuery.isLoading}
                error={logsQuery.error}
                pricing={pricing ?? null}
                logsData={logsQuery.data}
                topN={topN}
                onTopNChange={onTopNChange}
              />
            </Suspense>
          ) : sessionTab === 'usage' ? (
            <SessionUsageTab
              mainLogs={mainLogs}
              subagentLogsMap={subagentLogsMap}
              isLoading={logsQuery.isLoading}
              error={logsQuery.error}
              usage={usage}
              codeImpact={codeImpact}
            />
          ) : sessionTab === 'advisor' ? (
            <AdvisorTab
              turnEndAdvisor={turnEndAdvisor}
              isLoading={logsQuery.isLoading}
              error={logsQuery.error}
            />
          ) : sessionTab === 'change-surface' ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionChangeSurfaceTab
                repoId={repoId}
                sessionId={selectedSession.sessionId}
                teamId={teamId}
              />
            </Suspense>
          ) : sessionTab === 'harness-usage' ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionHarnessUsageTab
                mainLogs={mainLogs}
                subagentLogsMap={subagentLogsMap}
                agentParentMap={agentParentMap}
                workflows={logsQuery.data?.workflows}
                isLoading={logsQuery.isLoading}
                error={logsQuery.error}
              />
            </Suspense>
          ) : sessionTab === 'okf' ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionOkfTab
                repoId={repoId}
                sessionId={selectedSession.sessionId}
                teamId={teamId}
              />
            </Suspense>
          ) : sessionTab === 'tools' ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionToolsTab
                repoId={repoId}
                teamId={teamId}
                sessionId={selectedSession.sessionId}
              />
            </Suspense>
          ) : sessionTab === 'sysctx' ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionSysctxAnatomyTab
                mainLogs={mainLogs}
                harnessSnapshot={logsQuery.data?.harnessSnapshot}
                repoRoot={parsedLogs?.repoRoot ?? ''}
                pricing={pricing}
                sessionModel={parsedLogs?.summary.model}
                isLoading={logsQuery.isLoading}
                error={logsQuery.error}
              />
            </Suspense>
          ) : sessionTab === 'otel' ? (
            <Suspense fallback={<LazyFallback />}>
              <SessionOtelTab
                repoId={repoId}
                sessionId={selectedSession.sessionId}
                teamId={teamId}
              />
            </Suspense>
          ) : sessionTab === 'raw-logs' ? (
            <RawLogsTab
              rawLogs={logsQuery.data?.main ?? []}
              isLoading={logsQuery.isLoading}
              parsedSession={parsedLogs}
              pricing={pricing ?? undefined}
              sessionModel={parsedLogs?.summary.model}
            />
          ) : (
            <SessionInfoTab
              session={selectedSession}
              repoUrl={repoUrl}
              parsedLogs={parsedLogs}
              isLoading={logsQuery.isLoading}
              eventCount={logsQuery.data?.main.length}
              pricing={pricing ?? undefined}
              codeImpact={codeImpact}
            />
          )}
        </ToolViewProvider>
      </div>
    </>
  );
}
