import { AlertTriangle } from 'lucide-react';
import type { SessionTagValues } from '../../../../models/repositories';
import { cn } from '../../../lib/cn';
import { noisyKeyHint, type TagFilter } from '../../../lib/session-tags';

/** Applies one click on a key's "(any value)" bucket (FR-6): any ↔ off. */
export function toggleAnyValue(
  filters: readonly TagFilter[],
  key: string,
): TagFilter[] {
  const current = filters.find((f) => f.key === key);
  if (current && current.values === null) {
    return filters.filter((f) => f.key !== key);
  }
  return current
    ? filters.map((f) => (f.key === key ? { key, values: null } : f))
    : [...filters, { key, values: null }];
}

/** Applies one click on a value bucket: values of one key combine with OR. */
export function toggleTagValue(
  filters: readonly TagFilter[],
  key: string,
  value: string,
): TagFilter[] {
  const current = filters.find((f) => f.key === key);
  if (!current) return [...filters, { key, values: [value] }];
  const prev = current.values ?? [];
  const nextValues = prev.includes(value)
    ? prev.filter((v) => v !== value)
    : current.values === null
      ? [value]
      : [...prev, value];
  if (nextValues.length === 0) return filters.filter((f) => f.key !== key);
  return filters.map((f) => (f.key === key ? { key, values: nextValues } : f));
}

/**
 * The TAGS section of the session-list filter popover (2026-11-24 otel-session-tags, FR-6):
 * per discovered key an "(any value)" bucket and one bucket per value with its session count;
 * filters on different keys combine with AND, several values of one key with OR. Noisy keys
 * (FR-10) carry a warning icon with the fix in its tooltip.
 */
export function TagFilterSection({
  tagValues,
  value,
  onChange,
}: {
  tagValues: SessionTagValues | undefined;
  value: readonly TagFilter[];
  onChange: (next: TagFilter[]) => void;
}) {
  const keys = Object.keys(tagValues?.tags ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  // A filtered key no longer in scope stays visible, so it can be cleared.
  for (const f of value) if (!keys.includes(f.key)) keys.push(f.key);
  if (keys.length === 0) return null;
  const noisy = new Set(tagValues?.noisyKeys ?? []);

  function bucket(
    active: boolean,
    label: string,
    onClick: () => void,
    testId: string,
  ) {
    return (
      <button
        key={`${testId}\u0000${label}`}
        data-testid={testId}
        onClick={onClick}
        title={label}
        className={cn(
          'max-w-full truncate rounded px-1.5 py-0.5 font-mono text-xs transition-colors',
          active
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-accent',
        )}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="session-tag-filter">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        Tags
      </p>
      {keys.map((key) => {
        const current = value.find((f) => f.key === key);
        const buckets = tagValues?.tags[key] ?? [];
        return (
          <div key={key} className="flex flex-col gap-1">
            <p className="flex items-center gap-1 text-xs font-medium">
              <span className="min-w-0 truncate font-mono" title={key}>
                {key}
              </span>
              {noisy.has(key) && (
                <span title={noisyKeyHint(key)} className="cursor-help">
                  <AlertTriangle
                    className="size-3.5 shrink-0 text-amber-500"
                    aria-label={noisyKeyHint(key)}
                  />
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-1">
              {bucket(
                current?.values === null,
                '(any value)',
                () => onChange(toggleAnyValue(value, key)),
                'session-tag-filter-any',
              )}
              {buckets.map((b) =>
                bucket(
                  current?.values?.includes(b.value) === true,
                  `${b.value} (${b.sessionCount})`,
                  () => onChange(toggleTagValue(value, key, b.value)),
                  'session-tag-filter-value',
                ),
              )}
              {/* A filtered value no longer in scope (e.g. from a pasted link) stays clearable. */}
              {(current?.values ?? [])
                .filter((v) => !buckets.some((b) => b.value === v))
                .map((v) =>
                  bucket(
                    true,
                    v,
                    () => onChange(toggleTagValue(value, key, v)),
                    'session-tag-filter-value',
                  ),
                )}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground">
        Counts = sessions you can see. Pick again to clear.
      </p>
    </div>
  );
}
