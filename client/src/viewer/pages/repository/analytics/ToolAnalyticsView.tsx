/**
 * Repository-scope tool analytics: a ranked table of every tool used, with outcome
 * split, duration statistics and coverage, plus an MCP-per-server rollup.
 *
 * Three deliberate display rules from the requirements:
 *  - the ranking population is EVERY `tool_use` block, including Read/Edit/Write/Glob/Skill
 *    and Task — not `log-parser.ts`'s SKIP set;
 *  - `unresolved` (no result, or rejected/permission-denied) is its own column and is excluded
 *    from the success-rate denominator, so an abandoned call never inflates a failure rate;
 *  - there is no summed "total tool time" anywhere — parallel batches overlap in wall clock,
 *    and rows containing such calls are badged instead.
 */
import { useState } from 'react';
import { Badge } from '@/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import {
  formatCount,
  formatCountOrDash,
  formatCoverage,
  formatDurationSources,
  formatSuccessRate,
  formatToolDuration,
  NO_VALUE,
} from '@/lib/usage-analytics-format';
import type {
  ToolAnalyticsResponse,
  ToolAnalyticsRow,
} from '../../../../models/repositories';

type AgentScope = 'all' | 'main' | 'sub';

const AGENT_SCOPE_LABELS: { value: AgentScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'main', label: 'Main agent' },
  { value: 'sub', label: 'Sub-agents' },
];

function rowsForScope(
  data: ToolAnalyticsResponse,
  scope: AgentScope,
): ToolAnalyticsRow[] {
  if (scope === 'main') return data.mainAgent;
  if (scope === 'sub') return data.subAgent;
  return data.tools;
}

/** Per-chart empty block, per `docs/knowledgebase/ui-principles.md`. */
function NoToolActivity({ scope }: { scope: AgentScope }) {
  const what =
    scope === 'main'
      ? 'main-agent tool activity'
      : scope === 'sub'
        ? 'sub-agent tool activity'
        : 'tool activity';
  return (
    <div className="flex items-center justify-center h-40 text-sm text-muted-foreground border border-dashed rounded-md">
      No {what} in the selected range.
    </div>
  );
}

export function ToolAnalyticsView({ data }: { data: ToolAnalyticsResponse }) {
  const [scope, setScope] = useState<AgentScope>('all');
  const rows = rowsForScope(data, scope);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4" data-testid="tool-analytics-view">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <ToggleGroup
            type="single"
            value={scope}
            onValueChange={(v) => {
              if (v) setScope(v as AgentScope);
            }}
            className="shrink-0"
          >
            {AGENT_SCOPE_LABELS.map((opt) => (
              <ToggleGroupItem
                key={opt.value}
                value={opt.value}
                className="text-xs px-3"
              >
                {opt.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="text-xs text-muted-foreground">
            {formatCount(data.totalCalls)} tool calls
            {data.parallelBatchCalls > 0 && (
              <>
                {' · '}
                {formatCount(data.parallelBatchCalls)} ran in an overlapping
                batch
              </>
            )}
          </div>
        </div>

        {rows.length === 0 ? (
          <NoToolActivity scope={scope} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Success rate</TableHead>
                  <TableHead className="text-right">Failures</TableHead>
                  <TableHead className="text-right">
                    <Tooltip>
                      <TooltipTrigger className="underline decoration-dotted">
                        Unresolved
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[320px]">
                        No matching tool result, or the call was rejected /
                        permission-denied / interrupted. Excluded from the
                        success-rate denominator — these say nothing about the
                        tool.
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                  <TableHead className="text-right">
                    <Tooltip>
                      <TooltipTrigger className="underline decoration-dotted">
                        Median
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[320px]">
                        Interpolated from fixed duration buckets at repository
                        scope, so it is marked ≈. The session Usage tab shows an
                        exact median.
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead>
                    <Tooltip>
                      <TooltipTrigger className="underline decoration-dotted">
                        Duration coverage
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[320px]">
                        How many of this tool's calls had a measurable duration,
                        out of its total calls — some call records carry no
                        timing data, so the stats to the left may be based on
                        only part of the total.
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.tool}>
                    <TableCell className="font-mono text-xs">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {/* Own element so the name is addressable on its own —
                            the badges beside it are part of the same cell. */}
                        <span>{row.tool}</span>
                        {row.mcpServer !== null && (
                          <Badge
                            variant="secondary"
                            className="text-[10px] font-normal"
                          >
                            {row.mcpServer}
                          </Badge>
                        )}
                        {row.parallelBatchCalls > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className="text-[10px] font-normal"
                              >
                                overlapping
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[320px]">
                              {formatCount(row.parallelBatchCalls)} of these
                              calls were issued in one batch and ran
                              concurrently, so their durations overlap in wall
                              clock and must not be added up.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(row.calls)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatSuccessRate(row.failureRate)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCountOrDash(row.failures)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCountOrDash(row.unresolved)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatToolDuration(
                        row.durationP50Ms,
                        row.durationApproximate,
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatToolDuration(row.durationMaxMs, false)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.durationCoveredCalls > 0 ? (
                        <Tooltip>
                          <TooltipTrigger className="underline decoration-dotted">
                            {formatCoverage(
                              row.durationCoveredCalls,
                              row.calls,
                            )}
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[360px]">
                            Sources —{' '}
                            {formatDurationSources(row.durationBySource)}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        NO_VALUE
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">MCP servers</h3>
          {data.mcpServers.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground border border-dashed rounded-md">
              No MCP tool activity in the selected range.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Server</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Failures</TableHead>
                    <TableHead className="text-right">Unresolved</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.mcpServers.map((server) => (
                    <TableRow key={server.server}>
                      <TableCell className="font-mono text-xs">
                        {server.server}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCount(server.calls)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCountOrDash(server.failures)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCountOrDash(server.unresolved)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    </TooltipProvider>
  );
}
