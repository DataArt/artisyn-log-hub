/**
 * One row of the agent trail (package 3): `#N`, the op, the path, then what a reader needs to
 * judge it — the full search pattern, `found` / `nothing found`, the line range, the "in area of"
 * mark of an article read earlier, and under a KB read the new code paths it showed
 * (`OkfTrailPointers`).
 */
import type { OkfTrailItem } from '../../../../../models/repositories';
import { isIndexPath, isKbItem, opWord, rangeText } from './okf-trail';
import { OkfTrailPointers } from './OkfTrailPointers';

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path;
}

export function OkfTrailRow({
  item,
  showOrd,
  byOrd,
}: {
  item: OkfTrailItem;
  /** False for the second and later items of one call. */
  showOrd: boolean;
  byOrd: ReadonlyMap<number, OkfTrailItem>;
}) {
  const kb = isKbItem(item);
  const range = rangeText(item);
  const inArea = item.inArea ?? [];
  return (
    <li
      data-testid="okf-trail-item"
      data-ord={item.ord}
      data-op={item.op}
      data-in-area={inArea.length > 0 ? 'true' : undefined}
      className={`space-y-0.5 rounded px-1 py-0.5 ${
        inArea.length > 0 ? 'bg-amber-50 dark:bg-amber-950/40' : ''
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
          {showOrd ? `#${item.ord}` : ''}
        </span>
        <span
          className={`w-12 shrink-0 text-[11px] ${kb ? 'font-medium text-primary' : 'text-muted-foreground'}`}
        >
          {opWord(item)}
        </span>
        <span
          className={`min-w-0 break-all font-mono ${kb ? 'font-medium' : ''}`}
          data-testid="okf-trail-path"
        >
          {item.path}
        </span>
        {kb ? (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {item.op === 'kb_read' && isIndexPath(item.path)
              ? 'KB index'
              : 'KB'}
          </span>
        ) : null}
        {item.pattern !== undefined ? (
          <span
            className="break-all font-mono text-[11px]"
            data-testid="okf-trail-pattern"
          >
            &quot;{item.pattern}&quot;
          </span>
        ) : null}
        {range ? (
          <span className="text-[11px] text-muted-foreground">{range}</span>
        ) : null}
        {item.hit !== undefined ? (
          <span
            data-testid="okf-trail-hit"
            className={`text-[11px] ${item.hit ? 'text-foreground' : 'text-muted-foreground italic'}`}
          >
            {item.hit ? 'found' : 'nothing found'}
          </span>
        ) : null}
        {inArea.length > 0 ? (
          <span
            data-testid="okf-trail-in-area"
            className="rounded bg-amber-100 px-1 text-[10px] text-amber-900 dark:bg-amber-900/50 dark:text-amber-200"
            title={inArea.join(', ')}
          >
            in area of {inArea.map(baseName).join(', ')}
          </span>
        ) : null}
      </div>
      {item.op === 'kb_read' ? (
        <OkfTrailPointers item={item} byOrd={byOrd} />
      ) : null}
    </li>
  );
}
