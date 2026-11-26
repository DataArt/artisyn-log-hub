import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, X } from 'lucide-react';
import type {
  SessionAttributionAttributeDef,
  SessionTagValues,
} from '../../../../models/repositories';
import { fetchSessionAttributionValues } from '../../../api';
import { Button } from '../../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../../ui/popover';
import { cn } from '../../../lib/cn';
import { describeTagFilters, type TagFilter } from '../../../lib/session-tags';
import type { AttributeFilterSelection } from './session-list-helpers';
import { TagFilterSection } from './TagFilterSection';

export interface AttributeFilterPopoverProps {
  repoId: number;
  teamId?: number;
  /** Resolved attribute definitions — the popover renders nothing when
   * this is empty (no team, or the team has declared no attributes). */
  definitions: SessionAttributionAttributeDef[];
  value: AttributeFilterSelection | null;
  onChange: (next: AttributeFilterSelection | null) => void;
  /** FR-8 tag discovery of the view; the TAGS section lists its keys (otel-session-tags). */
  tagValues?: SessionTagValues;
  /** Active session tag filters (URL `tag=`). */
  tagFilters?: readonly TagFilter[];
  onTagFiltersChange?: (next: TagFilter[]) => void;
}

function formatBucketValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function selectionsEqual(
  a: AttributeFilterSelection,
  b: AttributeFilterSelection,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'unattributed') return true;
  if (a.kind === 'isnull') return a.key === (b as typeof a).key;
  return a.key === (b as typeof a).key && a.value === (b as typeof a).value;
}

/**
 * Session-list "filter by attribute" popover. Fetches its value
 * lists from `GET :repoId/session-attribution/values` (independent of the — possibly already
 * attribute-filtered — session list itself, per that endpoint's own doc comment) only once
 * opened. The filter it produces is applied client-side by the caller via
 * `sessionMatchesAttributeFilter()` over each session's already-embedded `attribution` field
 * — there is no server round-trip for the browsable list (unlike the `attr=` query
 * param the reports/analytics endpoints accept).
 *
 * Exactly one selection is active at a time (mirrors the existing single-value
 * `filterByUserEmail` filter) — picking a new bucket replaces the previous one; picking the
 * active bucket again clears it. `isnull`/`unattributed` render as their own always-present
 * buckets per attribute (`isnull`) or once at the bottom (`unattributed`, session-wide),
 * independent of whether the values endpoint returned any concrete buckets at all.
 *
 * Under the attributes, a TAGS section (2026-11-24 otel-session-tags, FR-6) filters by session
 * tag; it combines with the attribute selection (AND). The popover renders when either the team
 * declares attributes or the view has tagged sessions (or an active tag filter).
 */
export function AttributeFilterPopover({
  repoId,
  teamId,
  definitions,
  value,
  onChange,
  tagValues,
  tagFilters = [],
  onTagFiltersChange,
}: AttributeFilterPopoverProps) {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['session-attribution-values', repoId, teamId ?? null],
    queryFn: () => fetchSessionAttributionValues(repoId, teamId),
    enabled: open && definitions.length > 0,
    staleTime: 30_000,
  });

  const hasTagSection =
    onTagFiltersChange !== undefined &&
    (Object.keys(tagValues?.tags ?? {}).length > 0 || tagFilters.length > 0);
  if (definitions.length === 0 && !hasTagSection) return null;

  const activeParts: string[] = [];
  if (value) activeParts.push('attribute');
  if (tagFilters.length > 0) activeParts.push(describeTagFilters(tagFilters));
  const anyActive = activeParts.length > 0;

  function isActive(next: AttributeFilterSelection): boolean {
    return value !== null && selectionsEqual(value, next);
  }

  function toggle(next: AttributeFilterSelection) {
    onChange(isActive(next) ? null : next);
  }

  function bucketButton(sel: AttributeFilterSelection, label: string) {
    return (
      <button
        key={label}
        onClick={() => toggle(sel)}
        className={cn(
          'rounded px-1.5 py-0.5 font-mono text-xs transition-colors',
          isActive(sel)
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-accent',
        )}
      >
        {label}
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid="session-list-filter"
          variant={anyActive ? 'default' : 'outline'}
          size="sm"
          className="h-7 max-w-full gap-1.5 text-xs"
          title={anyActive ? `Filter: ${activeParts.join(', ')}` : undefined}
        >
          <Filter className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {anyActive
              ? `Filter: ${activeParts.join(', ')}`
              : 'Filter: all sessions'}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-96 w-80 overflow-y-auto" align="start">
        <div className="flex flex-col gap-3">
          {anyActive && (
            <button
              onClick={() => {
                onChange(null);
                onTagFiltersChange?.([]);
              }}
              className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
              Clear filter
            </button>
          )}

          {isLoading && (
            <p className="text-xs text-muted-foreground">Loading values…</p>
          )}

          {definitions.length > 0 && (
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Session attributes
            </p>
          )}
          {definitions.map((def) => {
            const buckets = data?.[def.key] ?? [];
            return (
              <div key={def.key} className="flex flex-col gap-1">
                <p className="text-xs font-medium">{def.label}</p>
                <div className="flex flex-wrap gap-1">
                  {buckets.map((bucket) =>
                    bucketButton(
                      { kind: 'value', key: def.key, value: bucket.value },
                      `${formatBucketValue(bucket.value)} (${bucket.sessionCount})`,
                    ),
                  )}
                  {bucketButton(
                    { kind: 'isnull', key: def.key },
                    'Not determined',
                  )}
                </div>
              </div>
            );
          })}

          {definitions.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-border pt-2">
              {bucketButton(
                { kind: 'unattributed' },
                'Unattributed (no evaluation yet)',
              )}
            </div>
          )}

          {hasTagSection && onTagFiltersChange && (
            <div className="border-t border-border pt-2">
              <TagFilterSection
                tagValues={tagValues}
                value={tagFilters}
                onChange={onTagFiltersChange}
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
