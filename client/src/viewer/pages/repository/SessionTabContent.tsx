import { useQuery } from '@tanstack/react-query';
import { Suspense, useCallback, useState } from 'react';
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
import type { SubagentMetaMap } from './session-log/log-parser';
import { fetchSessionChangeSurface } from '../../api';
import type { SessionLogsQueryView } from './session-parts/useSessionLogParts';
import { AllSessionPartsGate } from './session-parts/AllSessionPartsGate';
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
  usage: SessionUsage;
  codeImpact: TreeCodeImpact;
  /** Undefined until the logs have loaded (the tab bar shows no count then). */
  bashCount: number | undefined;
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
  subagentMeta,
  knownAgentIds,
  pricing,
  repoConfig,
  topN,
  onTopNChange,
  repoUrl,
  sessionCost,
  usage,
  codeImpact,
  bashCount,
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
      agentParentMap={agentParentMap}
      subagentMeta={subagentMeta}
      knownAgentIds={knownAgentIds}
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
    // DD-33: the views below aggregate over the whole agent tree, so they wait for every part.
    <AllSessionPartsGate>
      <Suspense fallback={<LazyFallback />}>
        <SessionBashTab
          mainLogs={mainLogs}
          subagentLogsMap={subagentLogsMap}
          pricing={pricing ?? undefined}
          sessionModel={parsedLogs?.summary.model}
        />
      </Suspense>
    </AllSessionPartsGate>
  ) : isChartTab(sessionTab) ? (
    <AllSessionPartsGate>
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
    </AllSessionPartsGate>
  ) : sessionTab === 'usage' ? (
    <AllSessionPartsGate>
      <SessionUsageTab
        mainLogs={mainLogs}
        subagentLogsMap={subagentLogsMap}
        isLoading={logsQuery.isLoading}
        error={logsQuery.error}
        codeImpact={codeImpact}
      />
    </AllSessionPartsGate>
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
    <AllSessionPartsGate>
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
    </AllSessionPartsGate>
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
    <AllSessionPartsGate key={selectedSession.sessionId} keepOnceLoaded>
      <Suspense fallback={<LazyFallback />}>
        <SessionMapTab
          repoId={repoId}
          sessionId={selectedSession.sessionId}
          teamId={teamId}
          firstPrompt={selectedSession.firstPrompt}
          pricing={pricing ?? undefined}
          repoConfig={repoConfig}
          logs={logsQuery.data}
          logsError={logsQuery.error}
        />
      </Suspense>
    </AllSessionPartsGate>
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
