import type * as React from 'react';
import type { RepositorySession } from '../../../../models/repositories';
import type { ModelPricingMap } from '../../../../models/pricing';
import type { ParsedSession } from './types';
import { formatDuration, formatInt, formatBytes } from './log-parser';
import { formatCost, formatLocalTimestamp } from '../../../lib/format';
import { Skeleton } from '../../../ui/skeleton';
import { CollapsibleSection, InfoRow } from './session-info-primitives';
import { SessionInfoTokensCostSection } from './SessionInfoTokensCostSection';
import { SessionInfoWorkflowsSection } from './SessionInfoWorkflowsSection';
import { SessionInfoMcpSection } from './SessionInfoMcpSection';
import { SessionInfoVisionSection } from './SessionInfoVisionSection';
import { computeSessionInfoDerived } from './session-info-derive';
import type { TreeCodeImpact } from './tree-code-impact';

interface Props {
  session: RepositorySession;
  repoUrl: string | undefined;
  parsedLogs: ParsedSession | null;
  isLoading: boolean;
  eventCount: number | undefined;
  pricing: ModelPricingMap | undefined;
  /**
   * Own/tree code-impact pair, derived once per session-detail render by
   * `SessionDetailPane`. Optional: without it every lines/files figure on this tab falls back
   * to its root-only scope, which keeps standalone renders (tests, ad-hoc usage)
   * working unchanged.
   */
  codeImpact?: TreeCodeImpact | null;
}

/**
 * The muted line under a tree-scoped value, e.g.
 * `0 own · 19 457 in 22 sub-agents`. Returns `undefined` when the session delegated to nobody,
 * so a plain single-transcript session keeps its unchanged single-line rows.
 */
function scopeSecondary(
  codeImpact: TreeCodeImpact | null | undefined,
  own: number,
  tree: number,
): string | undefined {
  const descendants = codeImpact?.descendants ?? 0;
  if (descendants <= 0) return undefined;
  const suffix = descendants === 1 ? 'sub-agent' : 'sub-agents';
  return `${formatInt(own)} own · ${formatInt(tree - own)} in ${descendants} ${suffix}`;
}

export function SessionInfoTab({
  session,
  repoUrl,
  parsedLogs,
  isLoading,
  eventCount,
  pricing,
  codeImpact,
}: Props) {
  const showSkeleton = isLoading && parsedLogs === null;

  const {
    wallClockMs,
    workflowSubagentTokens,
    workflowStats,
    derived,
    subAgentCost,
    workflowEstimatedCost,
    showWorkflowCostRow,
    productivityLines,
    productivityCost,
    skillsDisplay,
    claudeMdFiles,
  } = computeSessionInfoDerived(session, parsedLogs, pricing, codeImpact);

  const val = (v: React.ReactNode) =>
    showSkeleton ? <Skeleton className="h-4 w-24" /> : (v ?? '—');

  // The session's model has no `model_pricing` row, so every money cell in the
  // Tokens & Cost table is unknown rather than zero. `pricing === undefined` means the
  // rates are still loading and must not be mistaken for "unpriced".
  // The headline is the tree figure (root + every descendant); the own/tree split
  // moves to the row's secondary line. Falls back to the root-only parse when no
  // `codeImpact` was threaded in.
  const linesChangedDisplay =
    codeImpact?.linesTree ?? parsedLogs?.summary.linesChanged ?? 0;

  const sessionModel = parsedLogs?.summary.model ?? null;
  const unpricedModel =
    sessionModel != null && pricing != null && pricing[sessionModel] == null
      ? sessionModel
      : null;

  return (
    <div className="p-4 overflow-auto">
      <div className="max-w-2xl">
        {/* 1. Identity */}
        <CollapsibleSection title="Identity">
          <InfoRow label="UUID">{session.sessionId}</InfoRow>
          <InfoRow label="Repository">{repoUrl ?? '—'}</InfoRow>
          <InfoRow label="Branch">{session.gitBranch ?? '—'}</InfoRow>
          <InfoRow label="User">{session.userEmail ?? '—'}</InfoRow>
        </CollapsibleSection>

        {/* 2. Timeline */}
        <CollapsibleSection title="Timeline">
          <InfoRow label="Start">
            {formatLocalTimestamp(session.startTime)}
          </InfoRow>
          <InfoRow label="End">{formatLocalTimestamp(session.endTime)}</InfoRow>
          <InfoRow label="Duration">
            {wallClockMs != null ? formatDuration(wallClockMs) : '—'}
          </InfoRow>
          <InfoRow label="Autonomous work time">
            {val(
              parsedLogs
                ? formatDuration(parsedLogs.summary.totalWorkTimeMs)
                : null,
            )}
          </InfoRow>
        </CollapsibleSection>

        {/* 3. Activity */}
        <CollapsibleSection title="Activity">
          <InfoRow label="Log records">
            {val(
              eventCount != null
                ? formatInt(eventCount)
                : parsedLogs
                  ? '—'
                  : null,
            )}
          </InfoRow>
          <InfoRow label="Prompts">
            {val(parsedLogs ? formatInt(parsedLogs.summary.promptCount) : null)}
          </InfoRow>
          <InfoRow
            label="Sub-agents spawned"
            title={
              derived && derived.subAgentsTree > derived.subAgents
                ? `${formatInt(derived.subAgentsTree)} sub-agent transcript(s) in this session tree; ${formatInt(derived.subAgents)} activated directly by the Task tool — the rest were spawned by a workflow.`
                : undefined
            }
          >
            {val(derived ? formatInt(derived.subAgentsTree) : null)}
          </InfoRow>
          <InfoRow label="Skills invoked">{val(skillsDisplay)}</InfoRow>
          <InfoRow label="Skills context">
            {val(
              derived && derived.skillsBytes > 0
                ? `${formatBytes(derived.skillsBytes)} (~${formatInt(derived.skillsTokens)} tokens)`
                : '—',
            )}
          </InfoRow>
          <InfoRow label="Rules injected">
            {val(derived ? derived.rulesDisplay : null)}
          </InfoRow>
          <InfoRow label="Rules context">
            {val(
              derived && derived.rulesBytes > 0
                ? `${formatBytes(derived.rulesBytes)} (~${formatInt(derived.rulesTokens)} tokens)`
                : '—',
            )}
          </InfoRow>
        </CollapsibleSection>

        {/* 4. Tokens & Cost — budget table */}
        <SessionInfoTokensCostSection
          session={session}
          parsedLogs={parsedLogs}
          showSkeleton={showSkeleton}
          derived={derived}
          subAgentCost={subAgentCost}
          workflowSubagentTokens={workflowSubagentTokens}
          workflowEstimatedCost={workflowEstimatedCost}
          showWorkflowCostRow={showWorkflowCostRow}
          unpricedModel={unpricedModel}
        />

        {/* 5. Workflows — omit entirely if none ran */}
        {workflowStats && (
          <SessionInfoWorkflowsSection
            workflowStats={workflowStats}
            workflowSubagentTokens={workflowSubagentTokens}
            workflowEstimatedCost={workflowEstimatedCost}
          />
        )}

        {/* 6. Files & Tools */}
        <CollapsibleSection title="Files &amp; Tools">
          {parsedLogs &&
          Object.keys(parsedLogs.summary.fileStats).length > 0 ? (
            <table className="border-collapse mb-2">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="text-left font-medium pb-0.5 pr-4">
                    Category
                  </th>
                  <th className="text-right font-medium pb-0.5 pr-4">Reads</th>
                  <th className="text-right font-medium pb-0.5">Bytes</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(parsedLogs.summary.fileStats).map(
                  ([cat, stats]) => (
                    <tr key={cat} className="hover:bg-muted/30">
                      <td className="py-px pr-4 text-xs text-muted-foreground capitalize">
                        {cat}
                      </td>
                      <td className="py-px pr-4 text-right text-sm font-mono">
                        {formatInt(stats.files)}
                      </td>
                      <td className="py-px text-right text-sm font-mono">
                        {formatBytes(stats.bytes)}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : showSkeleton ? (
            <Skeleton className="h-16 w-full mb-2" />
          ) : null}
          <InfoRow
            label="Edit/write calls"
            title="Counts Edit/Write/MultiEdit calls, not distinct files."
            secondary={
              derived
                ? scopeSecondary(
                    codeImpact,
                    codeImpact?.filesOwn ?? derived.filesEditedWritten,
                    derived.filesEditedWritten,
                  )
                : undefined
            }
          >
            {val(derived ? formatInt(derived.filesEditedWritten) : null)}
          </InfoRow>
          <InfoRow
            label="Lines changed"
            secondary={
              parsedLogs
                ? scopeSecondary(
                    codeImpact,
                    codeImpact?.linesOwn ?? linesChangedDisplay,
                    linesChangedDisplay,
                  )
                : undefined
            }
          >
            {val(parsedLogs ? formatInt(linesChangedDisplay) : null)}
          </InfoRow>
          <InfoRow label="Log size (events)">
            {val(
              eventCount != null
                ? formatInt(eventCount)
                : parsedLogs
                  ? '—'
                  : null,
            )}
          </InfoRow>
        </CollapsibleSection>

        {/* 7. MCP Usage */}
        <SessionInfoMcpSection mcpCalls={parsedLogs?.mcpCalls} />

        {/* 8. Vision */}
        <SessionInfoVisionSection
          parsedLogs={parsedLogs}
          imageCost={derived?.imageCost ?? null}
          imageSources={derived?.imageSources ?? []}
        />

        {/* 8. Productivity */}
        <CollapsibleSection title="Productivity">
          <InfoRow label="Lines / autonomous hr">
            {val(parsedLogs ? (productivityLines ?? '—') : null)}
          </InfoRow>
          <InfoRow label="Cost / autonomous hr">
            {val(parsedLogs ? (productivityCost ?? '—') : null)}
          </InfoRow>
          <InfoRow label="Cost / line">
            {val(
              parsedLogs
                ? derived?.costPerLine != null
                  ? formatCost(derived.costPerLine)
                  : '—'
                : null,
            )}
          </InfoRow>
        </CollapsibleSection>

        {/* 9. CLAUDE.md Context — omit entirely if absent */}
        {parsedLogs?.summary.claudeMd && (
          <CollapsibleSection title="CLAUDE.md Context">
            <InfoRow label="Total bytes">
              {formatBytes(parsedLogs.summary.claudeMd.totalBytes)}
            </InfoRow>
            <InfoRow label="Est. tokens">
              {formatInt(parsedLogs.summary.claudeMd.estTokens)}
            </InfoRow>
            <InfoRow label="Files">
              <span className="whitespace-pre-wrap">{claudeMdFiles}</span>
            </InfoRow>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}
