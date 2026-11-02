import { ChevronDown } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';

import { cn } from '@/lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/**
 * Where an item is being rendered:
 * - `row`: visible in the row;
 * - `menu`: inside the open "More" menu (carries the same test id as its row trigger, DD-4);
 * - `measure`: in the hidden measuring copy — must not carry test ids or handlers.
 */
export type OverflowPlacement = 'row' | 'menu' | 'measure';

export interface OverflowItem {
  id: string;
  /** Section id for the "More" menu, used only when `sections` is set. */
  section?: string;
  render: (placement: OverflowPlacement) => React.ReactNode;
}

export interface OverflowSection {
  id: string;
  label: string;
}

interface OverflowRowProps {
  items: readonly OverflowItem[];
  /** The active item: it is never moved into "More" — the item before it goes instead. */
  activeId?: string | null;
  /** `data-testid` of the "More ▾" trigger. */
  moreTestId: string;
  moreLabel?: string;
  /** When set, the "More" menu lists its items under these headers, in this order. */
  sections?: readonly OverflowSection[];
  /**
   * Changes when item widths may have changed without the item ids changing (e.g. a count
   * loaded), so the hidden measuring copy runs once more.
   */
  measureKey?: string;
  /**
   * Items listed only in the "More" menu, never in the row (lens mode: the tabs a lens does not
   * promote). With any of them "More" is always shown; row items that do not fit join them.
   */
  menuItems?: readonly OverflowItem[];
  /** Rendered after the items, inside the row (e.g. an out-of-lens active tab). */
  trailing?: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}

/** Gap between items in px; must match the `gap-1` class of the row. */
const ITEM_GAP = 4;

const EMPTY_ITEMS: readonly OverflowItem[] = [];

/**
 * Which item indexes fit in `available` px. Pure, exported for reuse. All items fit → all of
 * them. Otherwise the leading items that fit next to the "More" button, with the active item
 * forced in (dropping the items just before it until it fits).
 */
export function fitOverflow(
  widths: readonly number[],
  moreWidth: number,
  available: number,
  activeIndex: number,
  /** "More" is shown anyway (menu-only items exist), so its width is always reserved. */
  alwaysMore = false,
): number[] {
  const all = widths.map((_, i) => i);
  const sum = (idx: readonly number[]): number =>
    idx.reduce((s, i) => s + (widths[i] ?? 0), 0) +
    Math.max(0, idx.length - 1) * ITEM_GAP;
  if (!alwaysMore && sum(all) <= available) return all;
  const budget = available - moreWidth - ITEM_GAP;
  const shown: number[] = [];
  for (const i of all) {
    if (sum([...shown, i]) > budget) break;
    shown.push(i);
  }
  if (activeIndex >= 0 && !shown.includes(activeIndex)) {
    while (shown.length > 0 && sum([...shown, activeIndex]) > budget) {
      shown.pop();
    }
    shown.push(activeIndex);
  }
  return shown;
}

/**
 * One row of items that never wraps: items that do not fit go into a "More ▾" popover. The row
 * has a fixed `h-9` height so it does not jump while counts load. Item widths are measured once
 * per `items`/`measureKey` change through a hidden copy; a `ResizeObserver` on the container
 * re-fits on resize without re-measuring.
 */
export function OverflowRow({
  items,
  activeId,
  moreTestId,
  moreLabel = 'More',
  sections,
  measureKey = '',
  menuItems = EMPTY_ITEMS,
  trailing,
  className,
  'aria-label': ariaLabel,
}: OverflowRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [measured, setMeasured] = useState<{
    key: string;
    widths: number[];
    more: number;
  } | null>(null);
  const [open, setOpen] = useState(false);

  const key = `${items.map((i) => i.id).join('|')}#${measureKey}`;
  const needsMeasure = measured?.key !== key;

  useLayoutEffect(() => {
    if (!needsMeasure) return;
    const host = measureRef.current;
    if (!host) return;
    const nodes = Array.from(host.children) as HTMLElement[];
    const more = nodes[nodes.length - 1]?.getBoundingClientRect().width ?? 0;
    const widths = nodes
      .slice(0, -1)
      .map((n) => Math.ceil(n.getBoundingClientRect().width));
    setMeasured({ key, widths, more: Math.ceil(more) });
  }, [needsMeasure, key]);

  const hasTrailing = trailing != null;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (): void => {
      const trailingWidth = trailingRef.current
        ? trailingRef.current.getBoundingClientRect().width + ITEM_GAP
        : 0;
      setAvailable(Math.max(0, el.clientWidth - trailingWidth));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // The trailing slot changes width when a different tab lands in it.
    if (trailingRef.current) ro.observe(trailingRef.current);
    return () => ro.disconnect();
  }, [hasTrailing]);

  const activeIndex = items.findIndex((i) => i.id === activeId);
  const alwaysMore = menuItems.length > 0;
  const shownIdx = useMemo(() => {
    if (measured === null || needsMeasure || available === null) {
      return items.map((_, i) => i);
    }
    return fitOverflow(
      measured.widths,
      measured.more,
      available,
      activeIndex,
      alwaysMore,
    );
  }, [measured, needsMeasure, available, items, activeIndex, alwaysMore]);

  const shownSet = new Set(shownIdx);
  const shown = items.filter((_, i) => shownSet.has(i));
  const hidden = [...items.filter((_, i) => !shownSet.has(i)), ...menuItems];

  const menuGroups: {
    id: string;
    label: string | null;
    items: OverflowItem[];
  }[] =
    sections == null
      ? [{ id: '', label: null, items: hidden }]
      : [
          // Row items that did not fit carry no section: listed first, without a header.
          {
            id: '',
            label: null,
            items: hidden.filter(
              (i) => !sections.some((s) => s.id === i.section),
            ),
          },
          ...sections.map((s) => ({
            id: s.id,
            label: s.label,
            items: hidden.filter((i) => i.section === s.id),
          })),
        ].filter((g) => g.items.length > 0);

  const moreButton = (testId: string | undefined) => (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {moreLabel}
      <ChevronDown aria-hidden="true" className="size-3.5" />
    </button>
  );

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'relative flex h-9 min-w-0 items-center gap-1 overflow-hidden',
        className,
      )}
    >
      {shown.map((item) => (
        <div key={item.id} className="flex shrink-0 items-center">
          {item.render('row')}
        </div>
      ))}
      {hidden.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{moreButton(moreTestId)}</PopoverTrigger>
          <PopoverContent
            ref={menuRef}
            align="end"
            collisionPadding={8}
            // Focus the menu itself, not its first entry: a focused entry would pop its tooltip
            // over the menu the moment it opens. Tab still moves into the entries.
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              menuRef.current?.focus({ preventScroll: true });
            }}
            className="max-h-[var(--radix-popover-content-available-height)] w-auto max-w-[min(20rem,calc(100vw-1rem))] min-w-44 overflow-y-auto p-1"
          >
            <div
              className="flex flex-col"
              // Bubble, not capture: the entry's own onClick must run before the menu closes —
              // closing in the capture phase can unmount the entry before its handler fires.
              onClick={() => setOpen(false)}
            >
              {menuGroups.map((g) => (
                <div key={g.id} className="flex flex-col py-0.5">
                  {g.label !== null && (
                    <div className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground uppercase">
                      {g.label}
                    </div>
                  )}
                  {g.items.map((item) => (
                    <div key={item.id} className="flex">
                      {item.render('menu')}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
      {trailing != null && (
        <div ref={trailingRef} className="flex shrink-0 items-center">
          {trailing}
        </div>
      )}
      {needsMeasure && (
        <div
          ref={measureRef}
          aria-hidden="true"
          inert
          className="pointer-events-none invisible absolute top-0 left-0 flex h-9 items-center gap-1 whitespace-nowrap"
        >
          {items.map((item) => (
            <div key={item.id} className="flex shrink-0 items-center">
              {item.render('measure')}
            </div>
          ))}
          {moreButton(undefined)}
        </div>
      )}
    </div>
  );
}
