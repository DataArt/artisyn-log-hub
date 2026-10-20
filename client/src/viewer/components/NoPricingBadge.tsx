import { cn } from '@/lib/cn';
import { Badge } from '../ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';

interface Props {
  /**
   * The model id that has no `model_pricing` row. Already normalised (the `-YYYYMMDD`
   * snapshot suffix is stripped upstream), so it is the exact id an admin would have to
   * add a pricing row for. May be absent on surfaces whose payload does not carry the
   * model (the sessions-list row); the tooltip then drops the id rather than printing a
   * placeholder that looks like a real model name.
   */
  modelId?: string | null;
  className?: string;
}

/**
 * The "no pricing" marker: shown wherever a cost would otherwise be rendered for a
 * session/turn whose model has no `model_pricing` row.
 *
 * It exists because `totalCost = null` alone is ambiguous — before this marker the client simply
 * omitted the figure (or printed `—` / `$0.0000`), making "we don't know this model's rates"
 * indistinguishable from "this session was free". A genuinely zero-cost session (all rates
 * `0`, e.g. a self-hosted model row) must keep showing `$0.0000` and must NOT render this
 * badge; the badge is only for the unknown-model case
 * (`costUnavailableReason === 'unknown-model'` server-side, or a missing `pricing[model]`
 * entry on surfaces that price from the transcript).
 */
export function NoPricingBadge({ modelId, className }: Props) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="warning"
            data-testid="no-pricing-badge"
            className={cn('cursor-help gap-1 font-normal', className)}
          >
            <span aria-hidden="true">⚠</span> no pricing
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {modelId
            ? `No pricing configured for model ${modelId} — cost cannot be computed`
            : "No pricing configured for this session's model — cost cannot be computed"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
