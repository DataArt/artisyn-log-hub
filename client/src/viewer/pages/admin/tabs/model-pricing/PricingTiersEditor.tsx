import { Plus, X } from 'lucide-react';
import { Button } from '../../../../ui/button';
import {
  MAX_PRICING_TIERS,
  TIER_FIELDS,
  emptyTierRow,
  type TierRow,
} from './priceForm';

interface Props {
  rows: TierRow[];
  onChange: (rows: TierRow[]) => void;
  /** Tier validation error, shown inline under the section. */
  error?: string;
}

const INPUT_CLASS =
  'w-full min-w-0 border border-border rounded px-2 py-1 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring';

/**
 * "Long-context tiers" section of the price dialog: a controlled table of prompt-length
 * tiers (threshold plus the five token rates), with add/remove buttons. A call whose prompt
 * exceeds a row's threshold is priced at that row's rates instead of the base rates.
 */
export function PricingTiersEditor({ rows, onChange, error }: Props) {
  function updateCell(index: number, key: keyof TierRow, value: string) {
    onChange(rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }

  return (
    <section className="flex flex-col gap-2" data-testid="pricing-tiers-editor">
      <span className="text-xs font-medium text-muted-foreground">
        Long-context tiers
      </span>
      {rows.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="pricing-tiers-empty"
        >
          No tiers — base rates apply to every request.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              {TIER_FIELDS.map((field) => (
                <th key={field.key} className="pr-1 pb-1 font-normal">
                  {field.label}
                </th>
              ))}
              <th className="pb-1" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} data-testid="pricing-tier-row">
                {TIER_FIELDS.map((field) => (
                  <td key={field.key} className="pr-1 pb-1">
                    <input
                      className={INPUT_CLASS}
                      name={`tier-${index}-${field.key}`}
                      aria-label={`Tier ${index + 1} ${field.label}`}
                      inputMode={
                        field.key === 'aboveTokens' ? 'numeric' : 'decimal'
                      }
                      value={row[field.key]}
                      onChange={(e) =>
                        updateCell(index, field.key, e.target.value)
                      }
                    />
                  </td>
                ))}
                <td className="pb-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove tier ${index + 1}`}
                    data-testid="pricing-tier-remove"
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                  >
                    <X />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-testid="pricing-tier-add"
          disabled={rows.length >= MAX_PRICING_TIERS}
          onClick={() => onChange([...rows, emptyTierRow()])}
        >
          <Plus />
          Add tier
        </Button>
      </div>
      {error && (
        <p
          className="text-xs text-destructive"
          role="alert"
          data-testid="pricing-tiers-error"
        >
          {error}
        </p>
      )}
    </section>
  );
}
