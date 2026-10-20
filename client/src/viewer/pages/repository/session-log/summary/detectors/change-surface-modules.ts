/**
 * Detector CS-2: `change-surface-modules`.
 *
 * A session spanning more than `CHANGE_SURFACE_MAX_TOP_MODULES` distinct top-level modules is
 * usually mixing unrelated concerns. Whole-session finding — no `turnIndex`.
 */
import { formatAncestorDepth } from '../../../../../lib/change-surface-ui';
import { CHANGE_SURFACE_MAX_TOP_MODULES } from './thresholds';
import {
  CHANGE_SURFACE_GROUP,
  CHANGE_SURFACE_TAB_ACTION,
} from './change-surface-shared';
import type { Detector, Finding } from './types';

export function TITLE(moduleCount: number): string {
  return `${moduleCount} unrelated top-level modules touched in one session`;
}

export const EXPLANATION =
  'A single session spanning several top-level modules usually mixes unrelated concerns.';

export const changeSurfaceModulesDetector: Detector = {
  id: 'change-surface-modules',
  run(ctx): Finding | null {
    const {
      changeSurfaceComputed,
      changeSurfaceConcentration,
      changeSurfaceTopLevelModules,
      changeSurfaceCommonAncestorDepth,
    } = ctx.summary;

    if (!changeSurfaceComputed) return null;
    if (changeSurfaceConcentration === null) return null;
    if (changeSurfaceTopLevelModules === null) return null;
    if (changeSurfaceTopLevelModules.length <= CHANGE_SURFACE_MAX_TOP_MODULES) {
      return null;
    }

    return {
      id: 'change-surface-modules',
      severity: 'warning',
      title: TITLE(changeSurfaceTopLevelModules.length),
      explanation: EXPLANATION,
      evidence: [
        ...changeSurfaceTopLevelModules,
        `common ancestor: ${formatAncestorDepth(changeSurfaceCommonAncestorDepth)}`,
        `threshold: > ${CHANGE_SURFACE_MAX_TOP_MODULES}`,
      ],
      group: CHANGE_SURFACE_GROUP,
      action: CHANGE_SURFACE_TAB_ACTION,
    };
  },
};
