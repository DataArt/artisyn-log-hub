/**
 * Summary tab shell.
 *
 * Kept thin by design (see the plan's Files-to-create table): the state machine and the four
 * per-stage memos live here; section content lives in its own file.
 * `SummaryExecutiveBand`/`SummaryDetectedIssues`/`SummaryExtendedDetails` are all wired into the
 * full-render branch; the incomplete branch omits sections 2 and 3 entirely.
 * `SummaryExtendedDetails` itself renders the per-prompt cost table (`SummaryPromptCostTable`)
 * as its own fifth block, inside the same Card, so the table's edges line up with the two
 * columns above it instead of the page's own (narrower) inset.
 */
import { useMemo, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { SessionLogsData } from '../../../../api';
import type {
  ChangeSurfaceAggregate,
  RepositorySession,
} from '../../../../../models/repositories';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { AiToolVersionHistoryEntry } from '../../../../../models/ai-tool-versions';
import { pickReleaseVersionsAt } from '../../../../lib/release-versions';
import type { ParsedSession } from '../types';
import type { SessionTab } from '../../useRepositoryViewState';
import { Skeleton } from '@/ui/skeleton';
import { TooltipProvider } from '@/ui/tooltip';
import { computeSessionInfoDerived } from '../session-info-derive';
import {
  deriveSessionUsage,
  type SessionUsage,
} from '../usage/session-usage-derive';
import {
  computeTreeCodeImpact,
  type TreeCodeImpact,
} from '../tree-code-impact';
import { getSessionLogsErrorMessage } from '../session-logs-error';
import { computeSessionSummaryDerived } from './session-summary-derive';
import { runDetectors } from './detectors/registry';
import { SummaryExecutiveBand } from './SummaryExecutiveBand';
import { SummaryDetectedIssues } from './SummaryDetectedIssues';
import { SummaryExtendedDetails } from './SummaryExtendedDetails';

export interface SessionSummaryTabProps {
  selectedSession: RepositorySession;
  parsedLogs: ParsedSession | null;
  logsQuery: UseQueryResult<SessionLogsData>;
  mainLogs: Record<string, unknown>[] | null;
  pricing: ModelPricingMap | null | undefined;
  sessionCost: number | null;
  subagentLogsMap: Map<string, Record<string, unknown>[]>;
  /** DB-authoritative agentId -> parentAgentId map (see `SessionLogView.tsx` for full rationale)
   * — same one already threaded to the Charts/Call Tree tabs; reused here so the per-prompt cost
   * table's workflow-cost rate can never disagree with the Logs tab's own. */
  agentParentMap: Map<string, string | null>;
  onSessionTabChange: (tab: SessionTab) => void;
  onGoToTurn: (turnIndex: number) => void;
  /**
   * The `deriveSessionUsage` walk, hoisted into
   * `SessionDetailPane` so it runs once per session-detail render instead of once per tab.
   * Optional: when absent this tab falls back to its own memo, so a standalone render (every
   * existing component test) keeps working unchanged.
   */
  usage?: SessionUsage;
  /** As {@link SessionSummaryTabProps.usage}, for the own/tree code-impact pair. */
  codeImpact?: TreeCodeImpact;
  /**
   * The session tree's change-surface aggregate, fetched once by
   * `SessionDetailPane` (the per-path rows stay lazy behind the Change surface tab). Feeds the
   * Change-surface tile and the three CS detectors. Optional: absent, both simply report "no
   * change-surface data" — never a `0`.
   */
  changeSurface?: ChangeSurfaceAggregate | null;
  /** That aggregate's request is still in flight; the tile renders a skeleton. */
  changeSurfaceLoading?: boolean;
  /**
   * Claude Code release history (ascending), fetched by
   * `SessionDetailPane`. Feeds the `claude-version` detector. Optional so standalone renders
   * (component tests) need no QueryClient; absent means "no reference versions".
   */
  claudeReleaseHistory?: AiToolVersionHistoryEntry[];
}

/** The loading render — `Skeleton` blocks, per `SessionUsageTab.tsx:83-99`. */
function SkeletonBlocks() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function SessionSummaryTab({
  selectedSession,
  parsedLogs,
  logsQuery,
  mainLogs,
  pricing,
  sessionCost,
  subagentLogsMap,
  agentParentMap,
  onSessionTabChange,
  onGoToTurn,
  usage: usageProp,
  codeImpact: codeImpactProp,
  changeSurface,
  changeSurfaceLoading = false,
  claudeReleaseHistory,
}: SessionSummaryTabProps) {
  // A handful of memos, each on its own dependency set, so an unrelated
  // re-render recomputes nothing. These run unconditionally, before the state machine below
  // returns for any branch: the derive's null-parse contract is live code,
  // hit on every session open, not dead code guarded by the `parsedLogs === null` skeleton
  // branch.
  //
  // `usage`/`codeImpact` come first because `info` and `derived`
  // both consume the code-impact pair. `usageProp ?? …` sits *inside* the memo (rather than
  // around it) so that with the prop supplied the transcript walk is never run at all.
  const usage = useMemo(
    () =>
      usageProp ?? deriveSessionUsage(mainLogs, [...subagentLogsMap.values()]),
    [usageProp, mainLogs, subagentLogsMap],
  );

  const subagentStats = logsQuery.data?.subagentStats ?? null;
  const rootStats = logsQuery.data?.rootStats ?? null;
  const codeImpact = useMemo(
    () =>
      codeImpactProp ??
      computeTreeCodeImpact({ usage, subagentStats, rootStats }),
    [codeImpactProp, usage, subagentStats, rootStats],
  );

  const info = useMemo(
    () =>
      computeSessionInfoDerived(
        selectedSession,
        parsedLogs,
        pricing ?? undefined,
        codeImpact,
      ),
    [selectedSession, parsedLogs, pricing, codeImpact],
  );

  const derived = useMemo(
    () =>
      computeSessionSummaryDerived({
        parsedLogs,
        pricing: pricing ?? undefined,
        info,
        codeImpact,
        mainLogs,
        subagentLogsMap,
        agentParentMap,
        sessionSubagentCost: selectedSession.costBreakdown.subagentCost,
        changeSurface,
      }),
    [
      parsedLogs,
      pricing,
      info,
      codeImpact,
      mainLogs,
      subagentLogsMap,
      agentParentMap,
      selectedSession.totalCost,
      changeSurface,
    ],
  );

  // `runDetectors` requires a non-null `parsedLogs` (`DetectorContext`); an absent parse simply
  // yields no findings. Computed unconditionally to keep this chunk's four memos in the shape
  // the spec fixes; only rendered in the full-render branch below (the incomplete render
  // omits sections 2 and 3 entirely on an incomplete session).
  const findings = useMemo(() => {
    if (parsedLogs === null) return [];
    return runDetectors({
      parsedLogs,
      pricing: pricing ?? undefined,
      info,
      summary: derived,
      releaseVersions: pickReleaseVersionsAt(
        claudeReleaseHistory ?? [],
        selectedSession.startTime,
      ),
      sessionVersion: selectedSession.claudeVersion ?? null,
    });
  }, [
    parsedLogs,
    pricing,
    info,
    derived,
    claudeReleaseHistory,
    selectedSession.startTime,
    selectedSession.claudeVersion,
  ]);

  // State machine, in this exact order.
  let content: ReactNode;
  if (logsQuery.isLoading) {
    content = <SkeletonBlocks />;
  } else if (logsQuery.error) {
    content = (
      <div className="flex h-40 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {getSessionLogsErrorMessage(logsQuery.error)}
        </p>
      </div>
    );
  } else if (parsedLogs === null) {
    // Data not present yet — a skeleton, never the "n/a" treatment.
    content = <SkeletonBlocks />;
  } else if (derived.isIncomplete) {
    content = (
      <>
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          Session data incomplete
        </div>
        <SummaryExecutiveBand
          session={selectedSession}
          summary={parsedLogs.summary}
          info={info}
          derived={derived}
          pricing={pricing ?? undefined}
          sessionCost={sessionCost}
          sessionAttribution={logsQuery.data?.sessionAttribution}
          incomplete
          changeSurfaceLoading={changeSurfaceLoading}
        />
      </>
    );
  } else {
    content = (
      <>
        <SummaryExecutiveBand
          session={selectedSession}
          summary={parsedLogs.summary}
          info={info}
          derived={derived}
          pricing={pricing ?? undefined}
          sessionCost={sessionCost}
          sessionAttribution={logsQuery.data?.sessionAttribution}
          incomplete={false}
          changeSurfaceLoading={changeSurfaceLoading}
        />
        <SummaryDetectedIssues
          findings={findings}
          onGoToTurn={onGoToTurn}
          onOpenTab={onSessionTabChange}
        />
        <SummaryExtendedDetails
          parsedLogs={parsedLogs}
          info={info}
          derived={derived}
          pricing={pricing ?? undefined}
          gitBranch={selectedSession.gitBranch ?? null}
          onSessionTabChange={onSessionTabChange}
          onGoToTurn={onGoToTurn}
        />
      </>
    );
  }

  return (
    <TooltipProvider>
      <div
        data-testid="session-summary-tab"
        className="flex h-full flex-col gap-4 overflow-y-auto p-4"
      >
        {content}
      </div>
    </TooltipProvider>
  );
}
