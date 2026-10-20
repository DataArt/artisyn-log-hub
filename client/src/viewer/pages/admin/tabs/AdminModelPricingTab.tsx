import { useMemo, useState } from 'react';
import type {
  AdminModelPricingRow,
  PricingSource,
} from '../../../../models/pricing';
import {
  useAdminModelPricing,
  useModelPricingMutations,
} from '../../../hooks/useAdminModelPricing';
import { useDebounce } from '../../../hooks/useDebounce';
import { PageState } from '../../../components/PageState';
import { Button } from '../../../ui/button';
import { ConfirmDialog } from '../../../ui/confirm-dialog';
import { Switch } from '../../../ui/switch';
import { AdminDataTable } from '../AdminDataTable';
import {
  buildModelPricingColumns,
  type ModelPricingAction,
} from './model-pricing/modelPricingColumns';
import {
  ModelPriceDialog,
  type ModelPriceDialogMode,
} from './model-pricing/ModelPriceDialog';
import { ModelPricingStatusLine } from './model-pricing/ModelPricingStatusLine';
import {
  OpenRouterImportResultBanner,
  type OpenRouterImportOutcome,
} from './model-pricing/OpenRouterImportResultBanner';

type SourceFilter = 'all' | PricingSource;

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'manual', label: 'Manual' },
  { value: 'unpriced', label: 'No price' },
];

const IMPORT_CONFIRM_MESSAGE =
  'Fetches the OpenRouter model catalog and updates prices for non-Anthropic models only. ' +
  'Anthropic models are never changed by this import — they come from the daily Anthropic ' +
  'fetch. Admin overrides on OpenRouter models are kept.';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function rowClassName(row: AdminModelPricingRow): string {
  return row.effective === null ? 'bg-amber-50 dark:bg-amber-950/30' : '';
}

export function AdminModelPricingTab() {
  const [filterText, setFilterText] = useState('');
  const debouncedFilter = useDebounce(filterText, 300);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [onlyUnpriced, setOnlyUnpriced] = useState(false);
  const [dialog, setDialog] = useState<{
    row: AdminModelPricingRow;
    mode: ModelPriceDialogMode;
  } | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [importOutcome, setImportOutcome] =
    useState<OpenRouterImportOutcome | null>(null);
  const [actionError, setActionError] = useState('');

  const query = useAdminModelPricing();
  const { clearOverride, importOpenRouter } = useModelPricingMutations();
  // `mutate` is referentially stable; the column factory needs only it, not the mutation state.
  const clearOverrideMutate = clearOverride.mutate;

  const columns = useMemo(
    () =>
      buildModelPricingColumns(
        (action: ModelPricingAction, row: AdminModelPricingRow) => {
          setActionError('');
          if (action === 'clear') {
            clearOverrideMutate(row.modelId, {
              onError: (err) =>
                setActionError(
                  `Could not clear the override on ${row.modelId}: ${errorMessage(err, 'request failed')}`,
                ),
            });
            return;
          }
          setDialog({ row, mode: action });
        },
      ),
    [clearOverrideMutate],
  );

  const models = query.data?.models;
  const rows = useMemo(
    () =>
      (models ?? []).filter((row) => {
        if (onlyUnpriced && row.effective !== null) return false;
        return sourceFilter === 'all' || row.source === sourceFilter;
      }),
    [models, onlyUnpriced, sourceFilter],
  );

  if (query.isPending) return <PageState message="Loading…" />;
  if (query.isError) {
    return (
      <PageState
        message={`Failed to load model pricing: ${errorMessage(query.error, 'request failed')}`}
      />
    );
  }

  const data = query.data;

  function runImport() {
    setConfirmImport(false);
    setImportOutcome(null);
    importOpenRouter.mutate(undefined, {
      onSuccess: (result) => setImportOutcome({ kind: 'success', result }),
      onError: (err) =>
        setImportOutcome({
          kind: 'error',
          message: errorMessage(err, 'request failed'),
        }),
    });
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="w-64 border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Filter by model ID…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <select
          aria-label="Source"
          data-testid="model-pricing-source-filter"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {SOURCE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={onlyUnpriced}
            onCheckedChange={setOnlyUnpriced}
            data-testid="model-pricing-unpriced-toggle"
          />
          Show only unpriced
        </label>
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={importOpenRouter.isPending}
          onClick={() => setConfirmImport(true)}
          data-testid="model-pricing-import-openrouter"
        >
          {importOpenRouter.isPending ? 'Importing…' : 'Import from OpenRouter'}
        </Button>
      </div>

      <ModelPricingStatusLine
        anthropic={data.anthropic}
        openrouter={data.openrouter}
      />

      {data.unpricedCount > 0 && (
        <div
          role="status"
          data-testid="model-pricing-unpriced-warning"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          ⚠ {data.unpricedCount} {data.unpricedCount === 1 ? 'model' : 'models'}{' '}
          seen in telemetry have no price — their cost is shown as &quot;no
          pricing&quot;, not $0.
        </div>
      )}

      {importOutcome && (
        <OpenRouterImportResultBanner
          outcome={importOutcome}
          onDismiss={() => setImportOutcome(null)}
        />
      )}

      {actionError && (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      )}

      <AdminDataTable
        columns={columns}
        data={rows}
        globalFilter={debouncedFilter}
        getRowClassName={rowClassName}
      />

      {dialog && (
        <ModelPriceDialog
          key={`${dialog.row.modelId}:${dialog.mode}`}
          row={dialog.row}
          mode={dialog.mode}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmImport}
        header="Import prices from OpenRouter?"
        message={IMPORT_CONFIRM_MESSAGE}
        confirmLabel="Import"
        onConfirm={runImport}
        onCancel={() => setConfirmImport(false)}
      />
    </div>
  );
}
