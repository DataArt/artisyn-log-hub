/**
 * Repository-scope productivity counters.
 *
 * Every line figure here is **diff-based**: parsed from `toolUseResult.structuredPatch` at
 * ingest, so it has a real added/removed split. It is a different measure from the existing
 * "Lines changed (written)" metric in the Files & Tools view / ProductivityChart, which counts
 * lines *written* by Edit/Write with no delta and no removals — measured at ~3.1x the
 * diff-based added count. The requirement forbids showing both on one view, so this view never
 * mentions the written-lines figure and that metric never appears here.
 *
 * Coverage is published rather than guessed: sub-agent transcripts omit `toolUseResult` on most
 * of their Edit/Write calls, so the footnote always states "over N of M Edit/Write calls".
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
import {
  formatCount,
  formatDiffCoverageNote,
} from '@/lib/usage-analytics-format';
import type { ProductivityAnalyticsResponse } from '../../../../models/repositories';

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
    <div className="rounded-md border px-4 py-3 min-w-[160px]">
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

export function ProductivityCountersView({
  data,
}: {
  data: ProductivityAnalyticsResponse;
}) {
  const { totals, buckets } = data;
  const nothingAtAll =
    totals.linesAdded === 0 &&
    totals.linesRemoved === 0 &&
    totals.commits === 0 &&
    totals.pullRequests === 0 &&
    totals.diffTotalCalls === 0;

  if (nothingAtAll) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground border border-dashed rounded-md">
        No productivity activity in the selected range.
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div
        className="flex flex-col gap-4"
        data-testid="productivity-counters-view"
      >
        <div className="flex flex-wrap gap-3">
          <StatTile
            label="Lines added (diff-based)"
            value={formatCount(totals.linesAdded)}
            hint="Lines prefixed + in the structured diff of each Edit/Write result. A different measure from the written-lines metric in the Files & Tools view, which counts lines written with no delta and no removals."
          />
          <StatTile
            label="Lines removed (diff-based)"
            value={formatCount(totals.linesRemoved)}
            hint="Lines prefixed - in the structured diff of each Edit/Write result. The written-lines metric has no removal counterpart at all."
          />
          <StatTile
            label="Commits"
            value={formatCount(totals.commits)}
            hint="git commit invocations inside Bash commands, counted per invocation — a chained `git add . && git commit` is one commit."
          />
          <StatTile
            label="Pull requests"
            value={formatCount(totals.pullRequests)}
            hint="gh pr create invocations inside Bash commands, counted per invocation."
          />
        </div>

        <p className="text-xs text-muted-foreground max-w-[70ch]">
          {formatDiffCoverageNote(
            totals.diffCoveredCalls,
            totals.diffTotalCalls,
          )}
        </p>

        {buckets.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-sm text-muted-foreground border border-dashed rounded-md">
            No per-day productivity data in the selected range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day (UTC)</TableHead>
                  <TableHead className="text-right">
                    Lines added (diff-based)
                  </TableHead>
                  <TableHead className="text-right">
                    Lines removed (diff-based)
                  </TableHead>
                  <TableHead className="text-right">Commits</TableHead>
                  <TableHead className="text-right">Pull requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map((bucket) => (
                  <TableRow key={bucket.bucket}>
                    <TableCell className="font-mono text-xs">
                      {bucket.bucket}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(bucket.linesAdded)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(bucket.linesRemoved)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(bucket.commits)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(bucket.pullRequests)}
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
