import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, X } from 'lucide-react';
import type { SessionAttributionAttributeDef } from '../../../../models/repositories';
import { fetchSessionAttributionValues } from '../../../api';
import { Button } from '../../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../../ui/popover';
import { cn } from '../../../lib/cn';
import type { AttributeFilterSelection } from './session-list-helpers';

export interface AttributeFilterPopoverProps {
  repoId: number;
  teamId?: number;
  /** Resolved attribute definitions — the popover renders nothing when
   * this is empty (no team, or the team has declared no attributes). */
  definitions: SessionAttributionAttributeDef[];
  value: AttributeFilterSelection | null;
  onChange: (next: AttributeFilterSelection | null) => void;
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
 */
export function AttributeFilterPopover({
  repoId,
  teamId,
  definitions,
  value,
  onChange,
}: AttributeFilterPopoverProps) {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['session-attribution-values', repoId, teamId ?? null],
    queryFn: () => fetchSessionAttributionValues(repoId, teamId),
    enabled: open && definitions.length > 0,
    staleTime: 30_000,
  });

  if (definitions.length === 0) return null;

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
          variant={value ? 'default' : 'outline'}
          size="sm"
          className="h-7 gap-1.5 text-xs"
        >
          <Filter className="size-3.5" />
          {value ? 'Attribute filter active' : 'Filter by attribute'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-96 w-80 overflow-y-auto" align="start">
        <div className="flex flex-col gap-3">
          {value && (
            <button
              onClick={() => onChange(null)}
              className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
              Clear filter
            </button>
          )}

          {isLoading && (
            <p className="text-xs text-muted-foreground">Loading values…</p>
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

          <div className="flex flex-col gap-1 border-t border-border pt-2">
            {bucketButton(
              { kind: 'unattributed' },
              'Unattributed (no evaluation yet)',
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
