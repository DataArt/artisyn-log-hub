import { cn } from '@/lib/cn';
import { noPriceHint, UNKNOWN_COST_TEXT } from '../lib/cost-hints';
import { Badge } from '../ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';

interface Props {
  /**
   * The model ids with no `model_pricing` row (the server's `unpricedModels`, or the
   * surface's own main model). Already normalised (the `-YYYYMMDD` snapshot suffix is
   * stripped), so they are the exact ids an admin would have to add a price for. May be
   * empty; the hint then says "this session's model" rather than printing a placeholder
   * that looks like a real model name.
   */
  modelIds?: readonly string[];
  /** Single-id shorthand for {@link modelIds}. */
  modelId?: string | null;
  className?: string;
}

/**
 * The unknown-cost marker `$???`: shown wherever a cost would otherwise be rendered for a
 * session/turn whose cost Log Hub cannot compute because a model has no price in its table
 * (the main thread, a sub-agent or a utility call). Its hint names the models and says how
 * to fix it (`noPriceHint`).
 *
 * It exists because `totalCost = null` alone is ambiguous — "we don't know this model's rates"
 * must never read as "this session was free" (`$0.0000`) or "no data" (`—`). A genuinely
 * zero-cost session (all rates `0`) keeps showing `$0.0000` and must NOT render this marker;
 * it is only for the unknown-model case (`costUnavailableReason === 'unknown-model'`
 * server-side, or a missing `pricing[model]` entry on surfaces that price from the
 * transcript).
 */
export function NoPricingBadge({ modelIds, modelId, className }: Props) {
  const ids = modelIds ?? (modelId ? [modelId] : []);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="warning"
            data-testid="no-pricing-badge"
            className={cn('cursor-help font-mono font-normal', className)}
          >
            {UNKNOWN_COST_TEXT}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm" data-testid="no-pricing-hint">
          {noPriceHint(ids)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
