import { Select } from 'radix-ui';
import { AlertTriangle } from 'lucide-react';
import type { SessionTagValues } from '../../../models/repositories';
import { groupByTagKey, noisyKeyHint } from '../../lib/session-tags';

interface Props {
  /** Discovery over the screen's scope; `undefined` while loading. */
  tagValues: SessionTagValues | undefined;
  /** The current group-by value, so a `tag:<key>` from the URL keeps its item. */
  groupBy: string;
  /** Item text prefix — Analytics says "Group by <key>", Reports just "<key>". */
  labelPrefix?: string;
}

/**
 * The TAGS section of a Group-by `Select` (2026-11-24 otel-session-tags): one `tag:<key>` item
 * per discovered key, set apart like the ATTRIBUTES section; noisy keys (FR-10) carry a warning
 * icon with the fix in its tooltip. Renders nothing when the scope has no tag keys. Must sit
 * inside a `Select.Viewport`.
 */
export function TagGroupByItems({ tagValues, groupBy, labelPrefix }: Props) {
  const keys = Object.keys(tagValues?.tags ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  const current = groupByTagKey(groupBy);
  if (current !== null && !keys.includes(current)) keys.push(current);
  if (keys.length === 0) return null;
  const noisy = new Set(tagValues?.noisyKeys ?? []);

  return (
    <div
      className="mt-1 border-t border-dashed border-input pt-1"
      data-testid="groupby-tags-section"
    >
      <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
        TAGS
      </div>
      {keys.map((key) => (
        <Select.Item
          key={key}
          value={`tag:${key}`}
          title={noisy.has(key) ? noisyKeyHint(key) : undefined}
          className="flex max-w-80 cursor-default select-none items-center gap-1 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
          data-testid="groupby-tag-item"
        >
          <span className="min-w-0 truncate">
            <Select.ItemText>
              {labelPrefix ? `${labelPrefix} ${key}` : key}
            </Select.ItemText>
          </span>
          {noisy.has(key) && (
            <AlertTriangle
              className="size-3.5 shrink-0 text-amber-500"
              aria-label={noisyKeyHint(key)}
            />
          )}
        </Select.Item>
      ))}
    </div>
  );
}
