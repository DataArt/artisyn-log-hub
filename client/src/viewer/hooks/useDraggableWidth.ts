import { useCallback, useEffect, useRef, useState } from 'react';

interface UseDraggableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  getMaxWidth?: () => number;
}

export function useDraggableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  getMaxWidth,
}: UseDraggableWidthOptions): {
  width: number;
  onMouseDown: React.MouseEventHandler;
} {
  const [width, setWidth] = useState<number>(() => {
    const stored = parseFloat(localStorage.getItem(storageKey) ?? '');
    return Number.isFinite(stored) && stored >= minWidth
      ? stored
      : defaultWidth;
  });

  const draggingRef = useRef(false);

  const onMouseDown: React.MouseEventHandler = useCallback(
    (e) => {
      const startX = e.clientX;
      const startWidth = width;
      draggingRef.current = true;
      document.body.style.userSelect = 'none';

      function onMouseMove(ev: MouseEvent) {
        const maxWidth = getMaxWidth?.() ?? Infinity;
        const newWidth = Math.max(
          minWidth,
          Math.min(maxWidth, startWidth + ev.clientX - startX),
        );
        setWidth(newWidth);
        localStorage.setItem(storageKey, String(newWidth));
      }

      function onMouseUp() {
        draggingRef.current = false;
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width, minWidth, getMaxWidth, storageKey],
  );

  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        document.body.style.userSelect = '';
      }
    };
  }, []);

  return { width, onMouseDown };
}
