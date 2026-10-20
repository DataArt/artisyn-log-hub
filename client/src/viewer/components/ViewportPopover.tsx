import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type * as React from 'react';
import { cn } from '../lib/cn';

/**
 * The one floating layer every popup/tooltip in the app should render through.
 *
 * Every hand-rolled variant before this one positioned itself at `cursor + 12` and either
 * ignored the viewport entirely or guessed its own width (`x + 360 > innerWidth`) to decide
 * whether to flip — so a popup wider than the guess still ran off the right edge, and none
 * of them ever handled the bottom edge. Here the box is *measured* after mount
 * (`getBoundingClientRect` + a `ResizeObserver` for later content changes) and the measured
 * size is what the clamp works with, so the box is guaranteed to stay inside the viewport
 * whenever the viewport is big enough to hold it at all.
 */

/** Gap kept between the anchor point (usually the cursor) and the popover box. */
const DEFAULT_OFFSET = 14;
/** Minimum distance kept between the popover and every viewport edge. */
const EDGE_MARGIN = 8;

interface ClampInput {
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  offset?: number;
  margin?: number;
}

/**
 * Places `size` next to `anchor` on one axis: after the anchor when it fits, flipped to
 * before it when it doesn't, and pinned inside the viewport when neither side fits.
 */
function clampAxis(
  anchor: number,
  size: number,
  viewport: number,
  offset: number,
  margin: number,
): number {
  const after = anchor + offset;
  if (after + size <= viewport - margin) return after;

  const before = anchor - offset - size;
  if (before >= margin) return before;

  // Neither side fits — pin to the end edge, then to the start edge if the box is larger
  // than the viewport itself (nothing can keep it fully visible at that point; showing its
  // beginning is more useful than showing its end).
  return Math.max(margin, viewport - margin - size);
}

/** Exported for unit tests — the whole edge-avoidance rule, with no DOM involved. */
export function clampToViewport({
  anchorX,
  anchorY,
  width,
  height,
  viewportWidth,
  viewportHeight,
  offset = DEFAULT_OFFSET,
  margin = EDGE_MARGIN,
}: ClampInput): { left: number; top: number } {
  return {
    left: clampAxis(anchorX, width, viewportWidth, offset, margin),
    top: clampAxis(anchorY, height, viewportHeight, offset, margin),
  };
}

function getViewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1024, height: 768 };
  return {
    width: window.innerWidth || 1024,
    height: window.innerHeight || 768,
  };
}

export interface ViewportPopoverProps {
  /** Anchor point in viewport (client) coordinates — normally the cursor position. */
  x: number;
  y: number;
  /** Gap between the anchor point and the box. */
  offset?: number;
  /** Preferred max width in px; the box is capped to the viewport width regardless. */
  maxWidth?: number;
  /** When true the box accepts pointer events (clickable popup); default is tooltip-style. */
  interactive?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function ViewportPopover({
  x,
  y,
  offset = DEFAULT_OFFSET,
  maxWidth,
  interactive = false,
  className,
  children,
}: ViewportPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [viewport, setViewport] = useState(getViewportSize);

  // Measurement runs in a layout effect, so the clamped position is applied in the same
  // frame the box first appears — there is no visible jump from the unclamped position.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize((prev) =>
        prev && prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onResize = () => setViewport(getViewportSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const { left, top } = size
    ? clampToViewport({
        anchorX: x,
        anchorY: y,
        width: size.width,
        height: size.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        offset,
      })
    : { left: 0, top: 0 };

  // Capping the box to the space between the viewport edges is what makes the clamp above
  // always solvable: a box that cannot be wider than the viewport always has a fitting spot.
  const widthCap = Math.max(
    0,
    Math.min(
      maxWidth ?? Number.POSITIVE_INFINITY,
      viewport.width - EDGE_MARGIN * 2,
    ),
  );
  const heightCap = Math.max(0, viewport.height - EDGE_MARGIN * 2);

  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 9999,
        pointerEvents: interactive ? 'auto' : 'none',
        maxWidth: widthCap,
        maxHeight: heightCap,
        overflow: interactive ? 'auto' : 'hidden',
        // Hidden for the single pre-measurement render only (see the layout effect above).
        visibility: size ? 'visible' : 'hidden',
      }}
      className={cn(
        'rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface HoverPopoverProps {
  /** The trigger element; its own mouse handlers are preserved. */
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  /** Popover body — only rendered while the trigger is hovered. */
  content: React.ReactNode;
  maxWidth?: number;
  className?: string;
}

/**
 * Cursor-following variant: tracks the pointer over `children` and renders `content` in a
 * `ViewportPopover` anchored to it. This is the shape all the `*Tooltip` components use.
 */
export function HoverPopover({
  children,
  content,
  maxWidth,
  className,
}: HoverPopoverProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const child = cloneElement(children, {
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      setPos({ x: e.clientX, y: e.clientY });
      children.props.onMouseMove?.(e);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      setPos(null);
      children.props.onMouseLeave?.(e);
    },
    // onPointerLeave fires more reliably than onMouseLeave (scroll, fast movement, re-renders)
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
      setPos(null);
      children.props.onPointerLeave?.(e);
    },
  });

  return (
    <>
      {child}
      {pos && (
        <ViewportPopover
          x={pos.x}
          y={pos.y}
          maxWidth={maxWidth}
          className={className}
        >
          {content}
        </ViewportPopover>
      )}
    </>
  );
}
