/**
 * The new code paths a KB read showed, under its trail row (package 3). The paths the agent went
 * on to use ("opened at #N" / "searched at #N") are listed in full; the never-opened rest is
 * folded behind a "N more not opened · show" toggle ("N code paths, none opened · show" when no
 * path was used), so an index article that names dozens of paths does not flood the trail.
 */
import { useState } from 'react';
import type { OkfTrailItem } from '../../../../../models/repositories';
import { pointerFate } from './okf-trail';

type Fate = ReturnType<typeof pointerFate>;

function PointerLine({ pointer, fate }: { pointer: string; fate: Fate }) {
  return (
    <li data-testid="okf-trail-pointer" className="font-mono">
      {fate ? '✓' : '·'} {pointer}{' '}
      <span
        className={`font-sans ${fate ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}`}
        data-testid="okf-trail-pointer-fate"
      >
        ({fate ? `${fate.verb} at #${fate.ord}` : 'never opened'})
      </span>
    </li>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function OkfTrailPointers({
  item,
  byOrd,
}: {
  item: OkfTrailItem;
  byOrd: ReadonlyMap<number, OkfTrailItem>;
}) {
  const [open, setOpen] = useState(false);
  const pointers = item.newPointers ?? [];
  if (pointers.length === 0) return null;
  const withFate = pointers.map((pointer) => ({
    pointer,
    fate: pointerFate(item, pointer, byOrd),
  }));
  const used = withFate.filter((p) => p.fate !== null);
  const rest = withFate.filter((p) => p.fate === null);
  const label =
    used.length > 0
      ? `${rest.length} more not opened`
      : `${plural(pointers.length, 'code path', 'code paths')}, none opened`;
  return (
    <div className="pl-14 text-[11px]" data-testid="okf-trail-pointers">
      <span className="text-muted-foreground">
        showed {plural(pointers.length, 'new code path', 'new code paths')}:
      </span>
      <ul className="pl-3">
        {used.map((p) => (
          <PointerLine key={p.pointer} pointer={p.pointer} fate={p.fate} />
        ))}
        {open
          ? rest.map((p) => (
              <PointerLine key={p.pointer} pointer={p.pointer} fate={p.fate} />
            ))
          : null}
      </ul>
      {rest.length > 0 ? (
        <button
          type="button"
          data-testid="okf-trail-pointers-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-3 text-muted-foreground hover:text-foreground hover:underline"
        >
          {label} · {open ? 'hide' : 'show'}
        </button>
      ) : null}
    </div>
  );
}
