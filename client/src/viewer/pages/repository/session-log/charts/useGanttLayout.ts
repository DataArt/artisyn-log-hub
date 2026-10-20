import { useMemo } from 'react';
import type { TimelineBlock, TimelineData, UserMarker } from './chart-data';

export type GanttMode = 'time' | 'turns';

export const VIEWBOX_WIDTH = 1000;

/** Minimum bar width in turns mode, in rem. */
export const MIN_TURN_WIDTH_REM = 0.325;

/** Convert layout coordinate (0–1000) to CSS percentage string. */
export function pct(value: number): string {
  return `${(value / VIEWBOX_WIDTH) * 100}%`;
}

/** Convert pixel value to CSS px string. */
export function px(value: number): string {
  return `${value}px`;
}

let cachedRootFontSize: number | null = null;
function getRootFontSize(): number {
  if (cachedRootFontSize === null) {
    cachedRootFontSize =
      typeof document !== 'undefined'
        ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
        : 16;
  }
  return cachedRootFontSize;
}

/**
 * First block index whose startOffset > offset (the column boundary right of
 * the marker). `blocks.length` means the marker is past the last block.
 */
function binarySearchMarkerEndIndex(
  blocks: TimelineBlock[],
  offset: number,
): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (blocks[mid].startOffset > offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface TimeLayoutResult {
  blockX(block: TimelineBlock): number;
  blockWidth(block: TimelineBlock): number;
  markerX(marker: UserMarker): number;
  contentWidth: null;
  isScrollable: false;
  unit: 'pct';
}

export function timeLayout(totalDurationMs: number): TimeLayoutResult {
  return {
    blockX(block) {
      if (totalDurationMs === 0) return 0;
      return (block.startOffset / totalDurationMs) * VIEWBOX_WIDTH;
    },
    blockWidth(block) {
      if (totalDurationMs === 0) return 0;
      return Math.max((block.durationMs / totalDurationMs) * VIEWBOX_WIDTH, 2);
    },
    markerX(marker) {
      if (totalDurationMs === 0) return 0;
      return (marker.offset / totalDurationMs) * VIEWBOX_WIDTH;
    },
    contentWidth: null,
    isScrollable: false,
    unit: 'pct',
  };
}

export interface TurnsLayoutMeasured {
  blockX(block: TimelineBlock): number;
  blockWidth(block: TimelineBlock): number;
  markerX(marker: UserMarker): number;
  contentWidth: number;
  isScrollable: boolean;
  unit: 'px';
}

export interface TurnsLayoutFallback {
  blockX(block: TimelineBlock): number;
  blockWidth(block: TimelineBlock): number;
  markerX(marker: UserMarker): number;
  contentWidth: null;
  isScrollable: false;
  unit: 'pct';
}

export type TurnsLayoutResult = TurnsLayoutMeasured | TurnsLayoutFallback;

/**
 * Turns mode lays the main-lane blocks out as equal-width columns. Sub-agent
 * blocks (which don't correspond to a column) are positioned by sharing the
 * column of the main block at the same startOffset.
 */
export function turnsLayout(
  data: TimelineData,
  containerWidth: number | null = null,
): TurnsLayoutResult {
  const columns = data.blocks.filter((b) => b.laneIndex === 0);
  const columnIndex = new Map<string, number>();
  columns.forEach((b, i) => columnIndex.set(b.turnId, i));

  // For non-main blocks, find the main column at or before their startOffset.
  function offsetToColumn(offset: number): number {
    let col = 0;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i].startOffset <= offset) col = i;
      else break;
    }
    return col;
  }

  function columnOf(block: TimelineBlock): number {
    return columnIndex.get(block.turnId) ?? offsetToColumn(block.startOffset);
  }

  const count = columns.length;

  if (containerWidth === null) {
    return {
      blockX(block) {
        if (count === 0) return 0;
        return (columnOf(block) / count) * VIEWBOX_WIDTH;
      },
      blockWidth() {
        if (count === 0) return 0;
        return VIEWBOX_WIDTH / count;
      },
      markerX(marker) {
        if (count === 0) return 0;
        const idx = binarySearchMarkerEndIndex(columns, marker.offset);
        if (idx >= count) return VIEWBOX_WIDTH;
        return (idx / count) * VIEWBOX_WIDTH;
      },
      contentWidth: null,
      isScrollable: false,
      unit: 'pct',
    };
  }

  const minTurnWidthPx = MIN_TURN_WIDTH_REM * getRootFontSize();
  const perTurnPx =
    count === 0 ? 0 : Math.max(containerWidth / count, minTurnWidthPx);
  const contentWidth = perTurnPx * count;
  const isScrollable = contentWidth > containerWidth;

  return {
    blockX(block) {
      if (count === 0) return 0;
      return columnOf(block) * perTurnPx;
    },
    blockWidth() {
      return perTurnPx;
    },
    markerX(marker) {
      if (count === 0) return 0;
      const idx = binarySearchMarkerEndIndex(columns, marker.offset);
      if (idx >= count) return contentWidth;
      return idx * perTurnPx;
    },
    contentWidth,
    isScrollable,
    unit: 'px',
  };
}

export type GanttLayoutResult = TimeLayoutResult | TurnsLayoutResult;

export function useGanttLayout(
  mode: GanttMode,
  data: TimelineData,
  containerWidth: number | null = null,
): GanttLayoutResult {
  return useMemo(
    () =>
      mode === 'turns'
        ? turnsLayout(data, containerWidth)
        : timeLayout(data.totalDurationMs),
    [mode, data, containerWidth],
  );
}
