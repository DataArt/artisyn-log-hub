/**
 * Summary tab, Section 3's fifth block: the per-prompt cost table.
 *
 * One row per `PromptCostRow` (already in turn order — not re-sorted). A system-only turn
 * (`hasPrompt: false`) renders the `(no user prompt)` placeholder and is not clickable — the
 * Logs tab never renders that turn, so a deep link would silently land on the following one.
 * The footer sums only the priced rows, `n/a` when none were priced.
 * Each row's cost is the prompt's FULL impact — main thread plus that turn's own sub-agents and
 * workflow-agent share (see `PromptCostRow.cost`'s doc comment) — not just its main-thread
 * sliver, so a prompt that triggered heavy delegation shows that cost here.
 */
import { cn } from '@/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { formatCost } from '../../../../lib/format';
import { formatInt } from '../log-parser';
import { PROMPT_COST_TABLE_MAX_HEIGHT_PX } from './constants';
import type { PromptCostRow } from './session-summary-derive';

interface Props {
  promptCosts: PromptCostRow[];
  onGoToTurn: (turnIndex: number) => void;
}

export function SummaryPromptCostTable({ promptCosts, onGoToTurn }: Props) {
  if (promptCosts.length === 0) return null;

  const pricedRows = promptCosts.filter((r) => r.cost != null);
  const totalCost =
    pricedRows.length > 0
      ? pricedRows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
      : null;

  return (
    <div data-testid="summary-prompt-costs" className="rounded-md border">
      <div
        className="overflow-y-auto"
        style={{ maxHeight: PROMPT_COST_TABLE_MAX_HEIGHT_PX }}
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="sticky top-0 bg-card px-2 py-1.5 text-left font-medium">
                #
              </th>
              <th className="sticky top-0 bg-card px-2 py-1.5 text-left font-medium">
                Prompt
              </th>
              <th className="sticky top-0 bg-card px-2 py-1.5 text-right font-medium">
                Tokens
              </th>
              <th className="sticky top-0 bg-card px-2 py-1.5 text-right font-medium">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {promptCosts.map((row) => (
              <tr
                key={row.turnIndex}
                data-testid="summary-prompt-cost-row"
                onClick={
                  row.hasPrompt ? () => onGoToTurn(row.turnIndex) : undefined
                }
                className={cn(
                  'border-b border-border/50',
                  row.hasPrompt && 'cursor-pointer hover:bg-muted/30',
                )}
              >
                <td className="px-2 py-1.5 align-top font-mono text-xs text-muted-foreground">
                  {row.turnIndex}
                </td>
                <td
                  className="max-w-0 truncate px-2 py-1.5 align-top"
                  title={row.promptText || undefined}
                >
                  {row.hasPrompt ? (
                    row.promptText
                  ) : (
                    <span className="text-muted-foreground italic">
                      (no user prompt)
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right align-top font-mono">
                  {row.totalTokens != null ? formatInt(row.totalTokens) : 'n/a'}
                </td>
                <td className="px-2 py-1.5 text-right align-top font-mono">
                  {row.cost != null ? formatCost(row.cost) : 'n/a'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-baseline justify-end gap-4 border-t border-border bg-card px-2 py-1.5 text-sm">
        <Tooltip>
          <TooltipTrigger className="text-muted-foreground underline decoration-dotted">
            Total
          </TooltipTrigger>
          <TooltipContent className="max-w-[320px]">
            Sum of this table&apos;s priced rows, each row being that
            prompt&apos;s full impact — main-thread tokens plus its own
            sub-agents and workflow-agent share. Workflow cost is a rate-based
            estimate, so this can still differ slightly from the Cost tile at
            the top of the page (the telemetry-reported total) — hover that tile
            for its own breakdown. The Extended details &quot;Tokens &amp;
            cost&quot; block above shows the smaller main-thread-only subtotal.
          </TooltipContent>
        </Tooltip>
        <span className="font-mono">
          {totalCost != null ? formatCost(totalCost) : 'n/a'}
        </span>
      </div>
    </div>
  );
}
