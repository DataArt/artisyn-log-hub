import type { ColumnDef, SortingFn } from '@tanstack/react-table';
import type {
  AdminModelPricingRow,
  ModelPricingRates,
  PricingTier,
} from '../../../../../models/pricing';
import { Button } from '../../../../ui/button';
import { formatUsdPerMillion, formatUsdPerRequest } from './format';
import { PricingSourceBadge } from './PricingSourceBadge';

/** A row action on the model-pricing table. */
export type ModelPricingAction = 'set' | 'edit' | 'override' | 'clear';

type RateKey = Exclude<
  keyof ModelPricingRates,
  'charsPerToken' | 'contextLength' | 'tiers'
>;

/** The rate columns a long-context tier carries (it has no web-search price). */
type TierRateKey = Exclude<RateKey, 'priceWebSearch'>;

/**
 * One line of a model's row. A model with long-context tiers gets one full line per prompt
 * range under its id ("0 – 100k tokens", "> 100k tokens"), each with every column filled, and
 * no divider between them; the fixed height keeps the lines of all cells aligned.
 */
const ROW_LINE = 'h-5 leading-5 whitespace-nowrap';

/**
 * A cell's lines: just `baseText` for an untiered model; otherwise an empty line level with the
 * model id, the base value on the first range line and `tierText(tier)` on each tier's line.
 */
function TieredLines({
  tiers,
  baseText,
  tierText,
  testId,
}: {
  tiers: PricingTier[] | null;
  baseText: string;
  tierText: (tier: PricingTier) => string;
  testId?: string;
}) {
  if (!tiers || tiers.length === 0) {
    return <span className={ROW_LINE}>{baseText}</span>;
  }
  return (
    <>
      <span className={ROW_LINE} aria-hidden />
      <span className={ROW_LINE}>{baseText}</span>
      {tiers.map((t) => (
        <span key={t.aboveTokens} className={ROW_LINE} data-testid={testId}>
          {tierText(t)}
        </span>
      ))}
    </>
  );
}

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

/** Compact token count for a tier threshold: 200000 → "200k", 1000000 → "1M". */
function formatThreshold(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0)
    return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 100 === 0) return `${tokens / 1_000}k`;
  return tokens.toLocaleString('en-US');
}

/** The prompt-range labels under the model id: "0 – 100k tokens", then one per tier. */
function TierRangeLabels({ tiers }: { tiers: PricingTier[] }) {
  const label = `${ROW_LINE} text-xs text-muted-foreground`;
  return (
    <>
      <span className={label} data-testid="pricing-base-range">
        0 – {formatThreshold(tiers[0].aboveTokens)} tokens
      </span>
      {tiers.map((t, i) => {
        const next = tiers[i + 1];
        return (
          <span
            key={t.aboveTokens}
            className={label}
            title={`Prompt above ${t.aboveTokens.toLocaleString('en-US')} tokens`}
            data-testid="pricing-tier-label"
          >
            {next
              ? `${formatThreshold(t.aboveTokens)} – ${formatThreshold(next.aboveTokens)} tokens`
              : `> ${formatThreshold(t.aboveTokens)} tokens`}
          </span>
        );
      })}
    </>
  );
}

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
      // Web search is never tiered: every range line repeats the base price.
      const tierKey: TierRateKey | null = key === 'priceWebSearch' ? null : key;
      return (
        <div className="flex flex-col">
          <TieredLines
            tiers={effective.tiers}
            baseText={format(effective[key])}
            tierText={(t) => format(tierKey ? t[tierKey] : effective[key])}
            testId={`pricing-tier-${key}`}
          />
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
            <span className={`${ROW_LINE} font-mono text-xs`}>{modelId}</span>
            {effective?.tiers && effective.tiers.length > 0 && (
              <TierRangeLabels tiers={effective.tiers} />
            )}
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
      cell: ({ row }) => {
        const v = row.original.effective?.charsPerToken ?? null;
        const text = v !== null ? v.toFixed(1) : '—';
        return (
          <div className="flex flex-col">
            <TieredLines
              tiers={row.original.effective?.tiers ?? null}
              baseText={text}
              tierText={() => text}
            />
          </div>
        );
      },
    },
    {
      id: 'contextLength',
      accessorFn: (row) => row.effective?.contextLength ?? null,
      header: 'Context Length',
      enableGlobalFilter: false,
      cell: ({ row }) => {
        const v = row.original.effective?.contextLength ?? null;
        const text = v !== null ? v.toLocaleString() : '—';
        return (
          <div className="flex flex-col">
            <TieredLines
              tiers={row.original.effective?.tiers ?? null}
              baseText={text}
              tierText={() => text}
            />
          </div>
        );
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
