import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Click-and-drag panning for a horizontally (and/or vertically) scrollable
 * element. Returns a ref to attach to the scroll container, the drag handlers,
 * and whether a drag is currently in progress (useful for cursor styling).
 *
 * Dragging only kicks in after a small movement threshold so that ordinary
 * clicks on children (e.g. selecting a tree node) are not swallowed.
 */
export function useDragScroll<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefObject<T | null>;
  isDragging: boolean;
  onMouseDown: React.MouseEventHandler<T>;
} {
  const ref = useRef<T>(null);
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);

  const onMouseDown: React.MouseEventHandler<T> = useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    // Only react to the primary (left) button.
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startScrollLeft = el.scrollLeft;
    const startScrollTop = el.scrollTop;
    let moved = false;

    function onMouseMove(ev: MouseEvent) {
      if (!el) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        draggingRef.current = true;
        setIsDragging(true);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      el.scrollLeft = startScrollLeft - dx;
      el.scrollTop = startScrollTop - dy;
    }

    function onMouseUp() {
      if (draggingRef.current) {
        draggingRef.current = false;
        setIsDragging(false);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    };
  }, []);

  return { ref, isDragging, onMouseDown };
}
