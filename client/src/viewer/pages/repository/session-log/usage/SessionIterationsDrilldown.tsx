/**
 * Per-API-call `usage.iterations[]` drill-down. Session scope only.
 *
 * This is a **decomposition of one assistant API call, never an addition to any total.** Session
 * and repository totals stay pinned to top-level `message.usage`
 * (`docs/knowledgebase/llm-call-math.md`), and the banner below says so on screen so nobody reads
 * these rows as extra tokens.
 *
 * Verified on every assistant event in the DB carrying `iterations` (24,866 events across 1,398
 * logs): the array always holds exactly one element whose every field equals the top-level
 * usage. The `matchesTopLevel` column therefore reads ✓ on all real data today, and would flag
 * the first genuine multi-iteration response that ever appears.
 */
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
import { formatTokens } from '@/lib/format';
import { formatTime } from '@/lib/format';
import { NO_VALUE } from '@/lib/usage-analytics-format';
import type { SessionUsage } from './session-usage-derive';

export function SessionIterationsDrilldown({ usage }: { usage: SessionUsage }) {
  if (usage.iterations.length === 0) {
    return (
      <div className="flex items-center justify-center h-28 text-sm text-muted-foreground border border-dashed rounded-md">
        No API call in this session reported an iterations breakdown.
      </div>
    );
  }

  const anyMismatch = usage.iterations.some((it) => !it.matchesTopLevel);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground max-w-[80ch]">
          A breakdown of individual API calls, not additional usage — these rows
          decompose each call's own{' '}
          <span className="font-mono">message.usage</span> and are never added
          into this session's or the repository's totals.
        </p>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Iterations</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cache read</TableHead>
                <TableHead className="text-right">Cache creation</TableHead>
                <TableHead className="text-right">
                  <Tooltip>
                    <TooltipTrigger className="underline decoration-dotted">
                      Sum matches
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[360px]">
                      Whether the sum of this call's iterations equals its
                      top-level message.usage for all four token counters. It
                      has held on every real transcript measured.
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.iterations.map((detail, index) => (
                <TableRow key={`${detail.messageId}-${index}`}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {detail.timestamp ? formatTime(detail.timestamp) : NO_VALUE}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {detail.model ?? NO_VALUE}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {detail.serviceTier}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {detail.iterationCount}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatTokens(detail.iterationsSum.input)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatTokens(detail.iterationsSum.output)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatTokens(detail.iterationsSum.cacheRead)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatTokens(detail.iterationsSum.cacheCreation)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {detail.matchesTopLevel ? (
                      '✓'
                    ) : (
                      <Tooltip>
                        <TooltipTrigger className="underline decoration-dotted text-amber-600">
                          differs
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[360px]">
                          This call's iterations sum to input{' '}
                          {formatTokens(detail.iterationsSum.input)} / output{' '}
                          {formatTokens(detail.iterationsSum.output)}, while its
                          top-level usage reports input{' '}
                          {formatTokens(detail.topLevel.input)} / output{' '}
                          {formatTokens(detail.topLevel.output)}. Totals follow
                          the top-level figures.
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {anyMismatch && (
          <p className="text-xs text-amber-700">
            At least one call's iterations do not sum to its top-level usage.
            The session and repository totals continue to follow the top-level
            figures.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
