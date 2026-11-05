/**
 * Moves an element onto a whole device pixel with a sub-pixel `translateX` (2026-11-05). The
 * top nav lays its items out after text of fractional width (the brand name), so the `Live`
 * button lands on e.g. x = 349.69 and its thin icon strokes and frame border smear over two
 * pixels. A transform does not affect layout, so measuring without it and re-applying cannot
 * feed back into the position. Re-runs when fonts finish loading, on window resize (which also
 * covers a browser-zoom / devicePixelRatio change) and when an item before it resizes.
 */
import { useLayoutEffect, type RefObject } from 'react';

export function usePixelSnap(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const apply = () => {
      el.style.transform = '';
      const dpr = window.devicePixelRatio || 1;
      const left = el.getBoundingClientRect().left * dpr;
      const shift = (Math.round(left) - left) / dpr;
      el.style.transform =
        Math.abs(shift) < 0.01 ? '' : `translateX(${shift.toFixed(3)}px)`;
    };
    apply();
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) apply();
    });
    window.addEventListener('resize', apply);
    // The items before it decide its x, so watch them, not only the row.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    for (
      let sib = el.previousElementSibling;
      observer !== null && sib !== null;
      sib = sib.previousElementSibling
    ) {
      observer.observe(sib);
    }
    return () => {
      alive = false;
      window.removeEventListener('resize', apply);
      observer?.disconnect();
    };
  }, [ref]);
}
