/**
 * Detector CS-3: `change-surface-single-file-folders`.
 *
 * The "long tail" shape: a focused change surrounded by drive-by edits, each alone in its own
 * folder. Guarded by a folder floor so a 3-folder session cannot trip it. Whole-session
 * finding — no `turnIndex`.
 */
import {
  CHANGE_SURFACE_SINGLE_FILE_FOLDER_SHARE,
  CHANGE_SURFACE_SINGLE_FILE_MIN_FOLDERS,
} from './thresholds';
import {
  CHANGE_SURFACE_GROUP,
  CHANGE_SURFACE_TAB_ACTION,
} from './change-surface-shared';
import type { Detector, Finding } from './types';

export function TITLE(singleFileFolders: number): string {
  return `Long tail: ${singleFileFolders} folders with a single changed file each`;
}

export const EXPLANATION =
  'Drive-by edits scattered around a focused change widen the review and conflict surface for little benefit.';

export const changeSurfaceSingleFileFoldersDetector: Detector = {
  id: 'change-surface-single-file-folders',
  run(ctx): Finding | null {
    const {
      changeSurfaceComputed,
      changeSurfaceConcentration,
      changeSurfaceSingleFileFolders,
      changeSurfaceFoldersTouched,
    } = ctx.summary;

    if (!changeSurfaceComputed) return null;
    if (changeSurfaceConcentration === null) return null;
    if (
      changeSurfaceSingleFileFolders === null ||
      changeSurfaceFoldersTouched === null ||
      changeSurfaceFoldersTouched < CHANGE_SURFACE_SINGLE_FILE_MIN_FOLDERS
    ) {
      return null;
    }

    const share = changeSurfaceSingleFileFolders / changeSurfaceFoldersTouched;
    if (share <= CHANGE_SURFACE_SINGLE_FILE_FOLDER_SHARE) return null;

    return {
      id: 'change-surface-single-file-folders',
      severity: 'info',
      title: TITLE(changeSurfaceSingleFileFolders),
      explanation: EXPLANATION,
      evidence: [
        `${changeSurfaceSingleFileFolders} of ${changeSurfaceFoldersTouched} folders = 1 file`,
        `threshold: > ${Math.round(CHANGE_SURFACE_SINGLE_FILE_FOLDER_SHARE * 100)}% of folders`,
      ],
      group: CHANGE_SURFACE_GROUP,
      action: CHANGE_SURFACE_TAB_ACTION,
    };
  },
};
