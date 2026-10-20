/**
 * Detector #3: `low-cache-read-ratio`.
 *
 * Session-scope finding — no `turnIndex` is emitted, so `SummaryFindingRow` renders it as
 * plain text. Returns `null` when there is no cache-read ratio at all
 * (no cache traffic) or when the session has fewer prompt turns than
 * `LOW_CACHE_READ_MIN_TURNS`.
 */
import { formatCacheReadRatio } from '../../../../../lib/format';
import {
  LOW_CACHE_READ_MIN_TURNS,
  LOW_CACHE_READ_RATIO_FLOOR,
} from './thresholds';
import type { Detector, Finding } from './types';

export const TITLE = 'Low cache reuse';

export function EXPLANATION(ratio: number, promptCount: number): string {
  return `Cache-read ratio was ${formatCacheReadRatio(ratio)} across ${promptCount} prompts — more of the context was re-written than re-read.`;
}

export const lowCacheReadRatioDetector: Detector = {
  id: 'low-cache-read-ratio',
  run(ctx): Finding | null {
    const ratio = ctx.info.derived?.cacheReadRatio;
    if (ratio == null) return null;

    const { promptCount } = ctx.summary;
    if (promptCount < LOW_CACHE_READ_MIN_TURNS) return null;

    if (ratio >= LOW_CACHE_READ_RATIO_FLOOR) return null;

    return {
      id: 'low-cache-read-ratio',
      severity: 'info',
      title: TITLE,
      explanation: EXPLANATION(ratio, promptCount),
      evidence: [`floor ${formatCacheReadRatio(LOW_CACHE_READ_RATIO_FLOOR)}`],
    };
  },
};
