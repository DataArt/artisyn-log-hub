import { ArrowBigUp } from 'lucide-react';
import type { PricingTier } from '@loghub/pricing';
import type { ModelPricingEntry } from '../../../../../../models/pricing';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';

/** Width the Context Growth bars leave free on the right for this marker. */
export const TIER_MARKER_RESERVE_PX = 96;

const usd = (v: number): string => `$${v.toFixed(2)}`;

interface Props {
  /** Tiers entered at this row, ascending. */
  tiers: PricingTier[];
  /** The model's base rates, for the "instead of" part of the hint. */
  base: ModelPricingEntry;
}

/**
 * Bold red up arrow plus "+cost tier", drawn right of a Context Growth bar where a call's
 * prompt passes a long-context price threshold; the hint names the tier and its rates.
 */
export function TierJumpMarker({ tiers, base }: Props) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="ml-1 inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs font-semibold text-red-600 dark:text-red-400"
            data-testid="growth-tier-jump"
            onClick={(e) => e.stopPropagation()}
          >
            <ArrowBigUp className="h-4 w-4 fill-current" aria-hidden />
            +cost tier
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-xs">
          {tiers.map((t) => (
            <div key={t.aboveTokens}>
              Moved to the next price tier: prompts above{' '}
              {t.aboveTokens.toLocaleString('en-US')} tokens are billed at input{' '}
              {usd(t.priceIn)}/M · output {usd(t.priceOut)}/M (base{' '}
              {usd(base.priceIn)}/M · {usd(base.priceOut)}/M).
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
