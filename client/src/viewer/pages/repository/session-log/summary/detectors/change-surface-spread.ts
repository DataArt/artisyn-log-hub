/**
 * Detector CS-1: `change-surface-spread`.
 *
 * Fires on the server-computed `band === 'scattered'` — **never** on a client-side `< 40`
 * comparison, so the band boundary exists in exactly one place. The
 * server's small-change floor already bands any change of up to 5 files `focused`, so trivially
 * small sessions never reach this detector; the additional folder floor guards scattered-band
 * sessions (6+ files) that touch only a few folders. A scattered surface is worth flagging — a rebase/merge is
 * more likely to conflict — but is not by itself a `critical`: touching several unrelated
 * folders is routine in normal cross-cutting work, not a sign of an emergency.
 *
 * Whole-session finding: no `turnIndex` is emitted (the metric is an aggregate over the entire
 * session tree, with no single originating turn), so the row's link is the `Change surface`
 * tab action instead of a "Go to turn" jump.
 */
import {
  bandLabel,
  formatConcentration,
  formatSurfaceDecimal,
} from '../../../../../lib/change-surface-ui';
import { CHANGE_SURFACE_SCATTERED_MIN_FOLDERS } from './thresholds';
import {
  CHANGE_SURFACE_GROUP,
  CHANGE_SURFACE_TAB_ACTION,
} from './change-surface-shared';
import type { Detector, Finding } from './types';

export function TITLE(foldersTouched: number): string {
  return `Change spread across ${foldersTouched} folders — large merge-conflict surface`;
}

export const EXPLANATION =
  'Scattered changes touch many independent folders, so a rebase or merge is likely to conflict in several places at once.';

export const changeSurfaceSpreadDetector: Detector = {
  id: 'change-surface-spread',
  run(ctx): Finding | null {
    const {
      changeSurfaceComputed,
      changeSurfaceConcentration,
      changeSurfaceBand,
      changeSurfaceFoldersTouched,
      changeSurfaceFilesPerFolder,
    } = ctx.summary;

    if (!changeSurfaceComputed) return null;
    if (changeSurfaceConcentration === null) return null;
    if (changeSurfaceBand !== 'scattered') return null;
    if (
      changeSurfaceFoldersTouched === null ||
      changeSurfaceFoldersTouched < CHANGE_SURFACE_SCATTERED_MIN_FOLDERS
    ) {
      return null;
    }

    return {
      id: 'change-surface-spread',
      severity: 'warning',
      title: TITLE(changeSurfaceFoldersTouched),
      explanation: EXPLANATION,
      evidence: [
        `concentration ${formatConcentration(changeSurfaceConcentration)}`,
        `${formatSurfaceDecimal(changeSurfaceFilesPerFolder)} files / folder`,
        `band: ${bandLabel(changeSurfaceBand)}`,
      ],
      group: CHANGE_SURFACE_GROUP,
      action: CHANGE_SURFACE_TAB_ACTION,
    };
  },
};
