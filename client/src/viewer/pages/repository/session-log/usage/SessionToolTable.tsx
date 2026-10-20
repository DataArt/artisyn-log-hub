/**
 * Per-tool table for one session's Usage tab.
 *
 * The median here is **exact** (computed from the raw per-call durations), so no `≈` prefix
 * appears — unlike the repository-scope table, which interpolates from a bucket histogram.
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
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import {
  formatCount,
  formatCountOrDash,
  formatCoverage,
  formatDurationSources,
  formatSuccessRate,
  formatToolDuration,
  NO_VALUE,
} from '@/lib/usage-analytics-format';
import type { SessionUsage, SessionToolRow } from './session-usage-derive';

type AgentScope = 'all' | 'main' | 'sub';

const SCOPES: { value: AgentScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'main', label: 'Main agent' },
  { value: 'sub', label: 'Sub-agents' },
];

export function SessionToolTable({ usage }: { usage: SessionUsage }) {
  const [scope, setScope] = useState<AgentScope>('all');
  const rows: SessionToolRow[] =
    scope === 'main'
      ? usage.mainAgent
      : scope === 'sub'
        ? usage.subAgent
        : usage.tools;

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <ToggleGroup
            type="single"
            value={scope}
            onValueChange={(v) => {
              if (v) setScope(v as AgentScope);
            }}
            className="shrink-0"
          >
            {SCOPES.map((opt) => (
              <ToggleGroupItem
                key={opt.value}
                value={opt.value}
                className="text-xs px-3"
              >
                {opt.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">
            {formatCount(usage.totalCalls)} tool calls
            {usage.parallelBatchCalls > 0 &&
              ` · ${formatCount(usage.parallelBatchCalls)} ran in an overlapping batch`}
          </span>
        </div>

        {rows.length === 0 ? (
          <div className="flex items-center justify-center h-28 text-sm text-muted-foreground border border-dashed rounded-md">
            No{' '}
            {scope === 'sub'
              ? 'sub-agent '
              : scope === 'main'
                ? 'main-agent '
                : ''}
            tool activity in this session.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Success rate</TableHead>
                  <TableHead className="text-right">Failures</TableHead>
                  <TableHead className="text-right">Unresolved</TableHead>
                  <TableHead className="text-right">
                    <Tooltip>
                      <TooltipTrigger className="underline decoration-dotted">
                        Median
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[320px]">
                        Exact median over this session's timed calls — the
                        repository-scope table shows an approximate (≈) median
                        interpolated from duration buckets.
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
                              concurrently — their durations overlap and must
                              not be added up.
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
                      {formatToolDuration(row.durationP50Ms, false)}
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

        {usage.mcpServers.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>MCP server</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Failures</TableHead>
                  <TableHead className="text-right">Unresolved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.mcpServers.map((server) => (
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
      </div>
    </TooltipProvider>
  );
}
