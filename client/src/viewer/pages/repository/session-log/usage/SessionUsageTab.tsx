/**
 * The session view's "Usage" tab.
 *
 * Carries only the figures the usage analytics add: the tool outcome/duration table, the TTL and
 * `service_tier` token splits, the per-`iterations` drill-down, and the diff-based productivity
 * counters. The Charts → Tool Heatmap sub-tab and the Info → Tokens & Cost section are
 * untouched and remain the single source for what they already render, so no figure appears in
 * two tabs.
 *
 * Every figure is derived client-side from the already-fetched `/logs` payload, the same way
 * `SessionChartsTab` works — the pre-computed-column rule targets repository-scope aggregates.
 */
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import {
  formatCount,
  formatDiffCoverageNote,
  NO_VALUE,
} from '@/lib/usage-analytics-format';
import type { TreeCodeImpact } from '../tree-code-impact';
import { deriveSessionUsage, type SessionUsage } from './session-usage-derive';
import { SessionIterationsDrilldown } from './SessionIterationsDrilldown';
import { SessionTokenBreakdown } from './SessionTokenBreakdown';
import { SessionToolTable } from './SessionToolTable';

interface Props {
  /** Raw main-transcript lines from the `/logs` payload. */
  mainLogs: Record<string, unknown>[] | null;
  /** Raw descendant sub-agent transcripts, keyed by their session id. */
  subagentLogsMap?: Map<string, Record<string, unknown>[]>;
  isLoading: boolean;
  error: unknown;
  /**
   * The `deriveSessionUsage` walk, hoisted into
   * `SessionDetailPane` so it runs once per session-detail render instead of once per tab.
   * Optional: when absent this tab falls back to its own memo, so a standalone render (every
   * existing component test) keeps working unchanged.
   */
  usage?: SessionUsage;
  /**
   * D1 — the own/tree code-impact pair from `SessionDetailPane`. The diff-based added/removed
   * tiles and the coverage note read from it only (`rootStats` + `subagentStats`, i.e. the
   * `session_stats` tree rollup), never from the transcript walk. Absent, or carrying `null`
   * diff counts, the tiles show "—" and the note says "No diff data".
   */
  codeImpact?: TreeCodeImpact | null;
}

function formatNullableCount(n: number | null | undefined): string {
  return n === null || n === undefined ? NO_VALUE : formatCount(n);
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border px-4 py-3 min-w-[150px]">
      <div className="text-xs text-muted-foreground">
        {hint ? (
          <Tooltip>
            <TooltipTrigger className="underline decoration-dotted text-left">
              {label}
            </TooltipTrigger>
            <TooltipContent className="max-w-[360px]">{hint}</TooltipContent>
          </Tooltip>
        ) : (
          label
        )}
      </div>
      <div className="mt-1 font-mono text-lg font-bold">{value}</div>
    </div>
  );
}

export function SessionUsageTab({
  mainLogs,
  subagentLogsMap,
  isLoading,
  error,
  usage: usageProp,
  codeImpact,
}: Props) {
  // `usageProp ?? …` inside the memo (rather than around it) is what
  // keeps the walk from running twice: with the prop supplied the derive is never called.
  const usage = useMemo(
    () =>
      usageProp ??
      deriveSessionUsage(
        mainLogs,
        subagentLogsMap ? [...subagentLogsMap.values()] : [],
      ),
    [usageProp, mainLogs, subagentLogsMap],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-sm text-muted-foreground">Error</p>
      </div>
    );
  }

  const { productivity } = usage;

  return (
    <TooltipProvider>
      <div
        className="flex flex-col gap-4 p-4 overflow-y-auto"
        data-testid="session-usage-tab"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Productivity counters</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <StatTile
                label="Lines added (diff-based)"
                value={formatNullableCount(codeImpact?.linesAdded)}
                hint="Lines prefixed + in each Edit/Write result's structured diff. A different measure from the written-lines metric in Repository Analytics, which counts lines written with no delta and no removals."
              />
              <StatTile
                label="Lines removed (diff-based)"
                value={formatNullableCount(codeImpact?.linesRemoved)}
                hint="Lines prefixed - in each Edit/Write result's structured diff. The written-lines metric has no removal counterpart."
              />
              <StatTile
                label="Commits"
                value={formatCount(productivity.commits)}
                hint="git commit invocations in Bash commands, counted per invocation."
              />
              <StatTile
                label="Pull requests"
                value={formatCount(productivity.pullRequests)}
                hint="gh pr create invocations in Bash commands, counted per invocation."
              />
              <StatTile label="Turns" value={formatCount(usage.turnCount)} />
            </div>
            <p className="text-xs text-muted-foreground max-w-[70ch]">
              {formatDiffCoverageNote(
                codeImpact?.diffCoveredCalls ?? null,
                codeImpact?.diffTotalCalls ?? null,
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Tool analytics</CardTitle>
          </CardHeader>
          <CardContent>
            <SessionToolTable usage={usage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Cache TTL and service tier
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SessionTokenBreakdown usage={usage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Per-API-call iterations breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SessionIterationsDrilldown usage={usage} />
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
