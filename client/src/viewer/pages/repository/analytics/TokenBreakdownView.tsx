/**
 * Repository-scope token breakdown.
 *
 * `ephemeral_5m` and `ephemeral_1h` cache-creation tokens are shown as separate rows and are
 * never summed into one "cache creation" figure — the whole point of surfacing the TTL split.
 * The two do reconcile against the flat cache-creation total, which is stated explicitly so a
 * reader can check rather than guess.
 *
 * Totals stay pinned to top-level `message.usage` (see `docs/knowledgebase/llm-call-math.md`);
 * the per-`iterations` decomposition is session-scope only and never contributes here.
 */
import { useState } from 'react';
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
import { formatTokens } from '@/lib/format';
import type {
  TokenAnalyticsResponse,
  TokenTotals,
} from '../../../../models/repositories';

type Grouping = 'none' | 'service_tier' | 'day';

const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'none', label: 'Totals' },
  { value: 'service_tier', label: 'By service tier' },
  { value: 'day', label: 'By day' },
];

const TOKEN_ROWS: { key: keyof TokenTotals; label: string; hint?: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheCreation', label: 'Cache creation' },
  {
    key: 'cacheWrite5m',
    label: 'Cache creation — 5m TTL',
    hint: 'usage.cache_creation.ephemeral_5m_input_tokens. Reported separately from the 1h bucket and never summed with it.',
  },
  {
    key: 'cacheWrite1h',
    label: 'Cache creation — 1h TTL',
    hint: 'usage.cache_creation.ephemeral_1h_input_tokens. Reported separately from the 5m bucket and never summed with it.',
  },
];

function hasAnyTokens(totals: TokenTotals): boolean {
  return (
    totals.input > 0 ||
    totals.output > 0 ||
    totals.cacheRead > 0 ||
    totals.cacheCreation > 0
  );
}

function NoTokenActivity() {
  return (
    <div className="flex items-center justify-center h-40 text-sm text-muted-foreground border border-dashed rounded-md">
      No token activity in the selected range.
    </div>
  );
}

export function TokenBreakdownView({ data }: { data: TokenAnalyticsResponse }) {
  const [grouping, setGrouping] = useState<Grouping>('none');

  if (!hasAnyTokens(data.totals)) {
    return <NoTokenActivity />;
  }

  const ttlReconciles =
    data.totals.cacheWrite5m + data.totals.cacheWrite1h ===
    data.totals.cacheCreation;

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4" data-testid="token-breakdown-view">
        <ToggleGroup
          type="single"
          value={grouping}
          onValueChange={(v) => {
            if (v) setGrouping(v as Grouping);
          }}
          className="shrink-0 self-start"
        >
          {GROUPINGS.map((opt) => (
            <ToggleGroupItem
              key={opt.value}
              value={opt.value}
              className="text-xs px-3"
            >
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {grouping === 'none' && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Token type</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TOKEN_ROWS.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell
                      className={
                        row.key === 'cacheWrite5m' || row.key === 'cacheWrite1h'
                          ? 'pl-8 text-muted-foreground'
                          : ''
                      }
                    >
                      {row.hint ? (
                        <Tooltip>
                          <TooltipTrigger className="underline decoration-dotted">
                            {row.label}
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[360px]">
                            {row.hint}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        row.label
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatTokens(data.totals[row.key])}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {grouping === 'service_tier' && (
          <TokenGroupTable
            firstColumn="Service tier"
            rows={data.byServiceTier.map((t) => ({ key: t.tier, totals: t }))}
            emptyLabel="No service-tier data in the selected range."
          />
        )}

        {grouping === 'day' && (
          <TokenGroupTable
            firstColumn="Day (UTC)"
            rows={data.buckets.map((b) => ({ key: b.bucket, totals: b }))}
            emptyLabel="No daily token data in the selected range."
          />
        )}

        <p className="text-xs text-muted-foreground">
          {ttlReconciles
            ? 'The two TTL rows reconcile against the flat cache-creation total; they are reported separately and never added together as one figure.'
            : 'The TTL rows do not currently reconcile against the flat cache-creation total — older transcripts carry only the flat field, which is attributed to the 5m bucket.'}
          {' Grouping by service tier includes an '}
          <span className="font-mono">unknown</span>
          {' bucket for messages whose usage object carried no '}
          <span className="font-mono">service_tier</span>.
        </p>
      </div>
    </TooltipProvider>
  );
}

/** Shared table for the two grouped modes — same six token columns in the same order. */
function TokenGroupTable({
  firstColumn,
  rows,
  emptyLabel,
}: {
  firstColumn: string;
  rows: { key: string; totals: TokenTotals }[];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-sm text-muted-foreground border border-dashed rounded-md">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstColumn}</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
            <TableHead className="text-right">Cache read</TableHead>
            <TableHead className="text-right">Cache creation</TableHead>
            <TableHead className="text-right">5m TTL</TableHead>
            <TableHead className="text-right">1h TTL</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="font-mono text-xs">{row.key}</TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(row.totals.input)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(row.totals.output)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(row.totals.cacheRead)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(row.totals.cacheCreation)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(row.totals.cacheWrite5m)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(row.totals.cacheWrite1h)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
