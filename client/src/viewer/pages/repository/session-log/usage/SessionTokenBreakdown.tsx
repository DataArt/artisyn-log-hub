/**
 * One session's token breakdown: the TTL split and the `service_tier` split.
 *
 * Deliberately does NOT duplicate the Info tab's "Tokens & Cost" section, which stays the single
 * source for the plain input/output/cache totals and cost. What this adds is the finer-grained
 * fields the transcripts already carry: `ephemeral_5m` vs `ephemeral_1h` cache creation (never
 * summed into one figure) and the per-`service_tier` split with its `unknown` bucket.
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
import type { SessionUsage } from './session-usage-derive';

export function SessionTokenBreakdown({ usage }: { usage: SessionUsage }) {
  const { tokens, byServiceTier } = usage;
  const nothing =
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.cacheRead === 0 &&
    tokens.cacheCreation === 0;

  if (nothing) {
    return (
      <div className="flex items-center justify-center h-28 text-sm text-muted-foreground border border-dashed rounded-md">
        No token activity in this session.
      </div>
    );
  }

  const ttlReconciles =
    tokens.cacheWrite5m + tokens.cacheWrite1h === tokens.cacheCreation;

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cache creation TTL</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger className="underline decoration-dotted">
                      5-minute TTL
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[360px]">
                      usage.cache_creation.ephemeral_5m_input_tokens. Older
                      transcripts carry only the flat cache-creation field;
                      those tokens are attributed here.
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatTokens(tokens.cacheWrite5m)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger className="underline decoration-dotted">
                      1-hour TTL
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[360px]">
                      usage.cache_creation.ephemeral_1h_input_tokens. Reported
                      separately from the 5-minute bucket and never summed with
                      it.
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatTokens(tokens.cacheWrite1h)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">By service tier</h4>
          {byServiceTier.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-sm text-muted-foreground border border-dashed rounded-md">
              No service-tier data in this session.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tier</TableHead>
                    <TableHead className="text-right">Input</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                    <TableHead className="text-right">Cache read</TableHead>
                    <TableHead className="text-right">Cache creation</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byServiceTier.map((tier) => (
                    <TableRow key={tier.tier}>
                      <TableCell className="font-mono text-xs">
                        {tier.tier === 'unknown' ? (
                          <Tooltip>
                            <TooltipTrigger className="underline decoration-dotted">
                              unknown
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[320px]">
                              These assistant messages carried no service_tier
                              field in their usage object.
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          tier.tier
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatTokens(tier.input)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatTokens(tier.output)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatTokens(tier.cacheRead)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatTokens(tier.cacheCreation)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {!ttlReconciles && (
          <p className="text-xs text-muted-foreground">
            The TTL rows do not add up to this session's flat cache-creation
            total — the transcript carries only the flat field for some
            messages, which is attributed to the 5-minute bucket.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
