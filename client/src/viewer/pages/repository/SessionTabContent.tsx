import { useQuery } from '@tanstack/react-query';
import { Suspense, useCallback, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  RepoConfig,
  RepositorySession,
} from '../../../models/repositories';
import type { ModelPricingMap } from '../../../models/pricing';
import { LazyFallback } from '../../components/LazyFallback';
import { SessionInfoTab } from './session-log/SessionInfoTab';
import { SessionLogView } from './session-log/SessionLogView';
import { RawLogsTab } from './session-log/RawLogsTab';
import { SessionUsageTab } from './session-log/usage/SessionUsageTab';
import { SessionSummaryTab } from './session-log/summary/SessionSummaryTab';
import { useAiToolVersions } from '../../hooks/useAiToolVersions';
import { AdvisorTab } from './AdvisorTab';
import type { SessionUsage } from './session-log/usage/session-usage-derive';
import type { TreeCodeImpact } from './session-log/tree-code-impact';
import type { ParsedSession } from './session-log/types';
import { fetchSessionChangeSurface, type SessionLogsData } from '../../api';
import { isChartTab } from '../../tab-ids';
import type { LensId } from './session-lenses';
import type { SessionTab } from './useRepositoryViewState';

import {
  SessionBashTab,
  SessionChangeSurfaceTab,
  SessionChartsTab,
  SessionHarnessUsageTab,
  SessionMapTab,
  SessionOkfTab,
  SessionOtelTab,
  SessionSysctxAnatomyTab,
  SessionToolsTab,
} from './session-lazy-tabs';

export interface SessionTabContentProps {
  selectedSession: RepositorySession;
  sessionTab: SessionTab;
  onSessionTabChange: (tab: SessionTab) => void;
  /** The effective lens switch (`useSessionLens`), for the Summary tab's lens links. */
  onLensSwitch: (lens: LensId) => void;
  repoId: number;
  teamId?: number;
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
  usage: SessionUsage;
  codeImpact: TreeCodeImpact;
  /** Undefined until the logs have loaded (the tab bar shows no count then). */
  bashCount: number | undefined;
  /** session-map DD-10: the Map tab hands its own poll to the pane's Refresh button. */
  registerMapRefresh: (fn: (() => void) | null) => void;
  /** `tool_use` id of a Tools/MCP "Open in session" link (`tu` param, DD-19). */
  targetToolUseId?: string | null;
  /** Clears the `tu` param once the Logs tab has acted on it. */
  onTargetToolUseConsumed?: () => void;
}

/** The active session tab's content, below the tab bar of `SessionDetailPane`. */
export function SessionTabContent({
  selectedSession,
  sessionTab,
  onSessionTabChange,
  onLensSwitch,
  repoId,
  teamId,
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
  usage,
  codeImpact,
  bashCount,
  registerMapRefresh,
  targetToolUseId,
  onTargetToolUseConsumed,
}: SessionTabContentProps) {
  const mainLogs = logsQuery.data?.main ?? null;
  const turnEndAdvisor = logsQuery.data?.turnEndAdvisor ?? null;

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

  return sessionTab === 'summary' ? (
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
      bashCount={bashCount}
      onLensSwitch={onLensSwitch}
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
  ) : sessionTab === 'session-map' ? (
    <Suspense fallback={<LazyFallback />}>
      <SessionMapTab
        repoId={repoId}
        sessionId={selectedSession.sessionId}
        teamId={teamId}
        firstPrompt={selectedSession.firstPrompt}
        pricing={pricing ?? undefined}
        repoConfig={repoConfig}
        registerRefresh={registerMapRefresh}
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
  );
}
