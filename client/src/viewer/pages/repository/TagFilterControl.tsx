import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import type { SessionTagValues } from '../../../models/repositories';
import { describeTagFilters, type TagFilter } from '../../lib/session-tags';
import { TagFilterSection } from './session-list/TagFilterSection';

interface Props {
  /** Discovery over the screen's scope; `undefined` while loading. */
  tagValues: SessionTagValues | undefined;
  value: readonly TagFilter[];
  onChange: (next: TagFilter[]) => void;
  /**
   * The key grouped by (`groupBy=tag:<key>`): left out of the picker, because the server
   * rejects a key that is both grouped and filtered.
   */
  excludeKey?: string | null;
  /** A small caption above the button (the Reports parameter strip style). */
  label?: string;
}

/**
 * The shared tag filter of the Analytics and Reports filter bars (2026-11-24 otel-session-tags):
 * a "Tags" button opening the same TAGS picker as the session list (per key "(any value)" and
 * one bucket per value; AND across keys, OR within a key; noisy keys marked). The caller keeps
 * the value in the URL `tag=` param and forwards it as `tag=` on every request. Renders nothing
 * when the scope has no tags and no filter is set.
 */
export function TagFilterControl({
  tagValues,
  value,
  onChange,
  excludeKey,
  label,
}: Props) {
  const scoped = useMemo<SessionTagValues | undefined>(() => {
    if (!tagValues || excludeKey == null) return tagValues;
    const tags = { ...tagValues.tags };
    delete tags[excludeKey];
    return {
      tags,
      noisyKeys: tagValues.noisyKeys.filter((k) => k !== excludeKey),
    };
  }, [tagValues, excludeKey]);

  const hasKeys = Object.keys(scoped?.tags ?? {}).length > 0;
  if (!hasKeys && value.length === 0) return null;
  const summary = describeTagFilters(value);

  const control = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 max-w-72 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/50"
          title={summary === '' ? 'Filter by session tags' : summary}
          data-testid="tag-filter-trigger"
        >
          <span className="truncate">
            {value.length > 0 ? `Tags: ${summary}` : 'Tags'}
          </span>
          {value.length > 0 && (
            <span className="ml-1 rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
              {value.length}
            </span>
          )}
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-96 w-80 overflow-y-auto p-3"
        data-testid="tag-filter-popover"
      >
        <TagFilterSection
          tagValues={scoped}
          value={value}
          onChange={onChange}
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-2 text-xs text-blue-600 hover:underline"
            data-testid="tag-filter-clear"
          >
            Clear tag filter
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
  if (label === undefined) return control;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {control}
    </div>
  );
}
