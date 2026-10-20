import type { PricingSource } from '../../../../../models/pricing';
import { Badge } from '../../../../ui/badge';

const SOURCE_LABELS: Record<PricingSource, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  manual: 'Manual',
  unpriced: 'No price',
};

interface Props {
  source: PricingSource;
  /** Shows the `OVR` chip beside the badge: an admin override hides the source's price. */
  overrideActive?: boolean;
}

/**
 * Resolved pricing source of a model on the admin model-pricing tab. An overridden model shows
 * its base source (where the hidden price came from) plus the `OVR` chip.
 */
export function PricingSourceBadge({ source, overrideActive = false }: Props) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge
        variant={source === 'unpriced' ? 'warning' : 'outline'}
        data-testid="pricing-source-badge"
        data-source={source}
        className="font-normal"
      >
        {SOURCE_LABELS[source]}
      </Badge>
      {overrideActive && (
        <Badge
          variant="secondary"
          data-testid="pricing-override-chip"
          title="An admin override is active; the fetched price is kept underneath"
        >
          OVR
        </Badge>
      )}
    </span>
  );
}
