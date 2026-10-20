import type { ColumnDef, SortingFn } from '@tanstack/react-table';
import type {
  AdminModelPricingRow,
  ModelPricingRates,
} from '../../../../../models/pricing';
import { Button } from '../../../../ui/button';
import { formatUsdPerMillion, formatUsdPerRequest } from './format';
import { PricingSourceBadge } from './PricingSourceBadge';

/** A row action on the model-pricing table. */
export type ModelPricingAction = 'set' | 'edit' | 'override' | 'clear';

type RateKey = Exclude<
  keyof ModelPricingRates,
  'charsPerToken' | 'contextLength'
>;

/**
 * The actions allowed for a row's resolved state: a fetched/imported model can only
 * be overridden, a manual one edited, an unpriced one priced.
 */
export function actionsFor(row: AdminModelPricingRow): ModelPricingAction[] {
  if (row.source === 'unpriced') return ['set'];
  if (row.source === 'manual') return ['edit'];
  return row.overrideActive ? ['override', 'clear'] : ['override'];
}

const ACTION_LABELS: Record<
  ModelPricingAction,
  (row: AdminModelPricingRow) => string
> = {
  set: () => 'Set price',
  edit: () => 'Edit',
  override: (row) => (row.overrideActive ? 'Edit' : 'Override'),
  clear: () => 'Clear',
};

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Unpriced models first (they need attention), then by model id. */
const unpricedFirst: SortingFn<AdminModelPricingRow> = (a, b) => {
  const aUnpriced = a.original.effective === null ? 0 : 1;
  const bUnpriced = b.original.effective === null ? 0 : 1;
  if (aUnpriced !== bUnpriced) return aUnpriced - bUnpriced;
  return a.original.modelId.localeCompare(b.original.modelId);
};

function rateColumn(
  key: RateKey,
  header: string,
  format: (v: number) => string,
): ColumnDef<AdminModelPricingRow, unknown> {
  return {
    id: key,
    accessorFn: (row) => row.effective?.[key] ?? null,
    header,
    enableGlobalFilter: false,
    cell: ({ row }) => {
      const { effective, base, overrideActive } = row.original;
      if (!effective) return <span className="text-muted-foreground">—</span>;
      const showBase =
        overrideActive && base !== null && base[key] !== effective[key];
      return (
        <div className="flex flex-col">
          <span>{format(effective[key])}</span>
          {showBase && (
            <span
              className="line-through text-muted-foreground text-xs"
              data-testid="pricing-base-value"
            >
              {format(base[key])}
            </span>
          )}
        </div>
      );
    },
  };
}

/**
 * Column definitions for the admin model-pricing table. `onAction` receives the clicked row
 * action; the tab decides whether it opens the price dialog or clears an override.
 */
export function buildModelPricingColumns(
  onAction: (action: ModelPricingAction, row: AdminModelPricingRow) => void,
): ColumnDef<AdminModelPricingRow, unknown>[] {
  return [
    {
      id: 'modelId',
      accessorKey: 'modelId',
      header: 'Model ID',
      enableGlobalFilter: true,
      sortingFn: unpricedFirst,
      cell: ({ row }) => {
        const { modelId, firstSeenAt, effective } = row.original;
        return (
          <div className="flex flex-col">
            <span className="font-mono text-xs">{modelId}</span>
            {firstSeenAt && effective === null && (
              <span className="text-xs text-muted-foreground">
                auto-added · first seen {formatDate(firstSeenAt)}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'source',
      accessorKey: 'source',
      header: 'Source',
      enableGlobalFilter: false,
      cell: ({ row }) => (
        <PricingSourceBadge
          source={row.original.source}
          overrideActive={row.original.overrideActive}
        />
      ),
    },
    rateColumn('priceIn', 'Price In', formatUsdPerMillion),
    rateColumn('priceOut', 'Price Out', formatUsdPerMillion),
    rateColumn('priceCacheR', 'Cache Read', formatUsdPerMillion),
    rateColumn('priceCacheW5m', 'Cache W 5m', formatUsdPerMillion),
    rateColumn('priceCacheW1h', 'Cache W 1h', formatUsdPerMillion),
    rateColumn('priceWebSearch', 'Web search', formatUsdPerRequest),
    {
      id: 'charsPerToken',
      accessorFn: (row) => row.effective?.charsPerToken ?? null,
      header: 'Chars/Token',
      enableGlobalFilter: false,
      cell: ({ getValue }) => {
        const v = getValue() as number | null;
        return v !== null ? v.toFixed(1) : '—';
      },
    },
    {
      id: 'contextLength',
      accessorFn: (row) => row.effective?.contextLength ?? null,
      header: 'Context Length',
      enableGlobalFilter: false,
      cell: ({ getValue }) => {
        const v = getValue() as number | null;
        return v !== null ? v.toLocaleString() : '—';
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      enableGlobalFilter: false,
      cell: ({ row }) => (
        <div className="flex gap-1">
          {actionsFor(row.original).map((action) => (
            <Button
              key={action}
              size="xs"
              variant={action === 'clear' ? 'ghost' : 'outline'}
              data-testid={`model-pricing-action-${action}`}
              onClick={() => onAction(action, row.original)}
            >
              {ACTION_LABELS[action](row.original)}
            </Button>
          ))}
        </div>
      ),
    },
  ];
}
