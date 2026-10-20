/**
 * The two literals every change-surface detector shares.
 *
 * Declared once so the three detectors, `SummaryDetectedIssues`' grouping and the unit tests
 * all name the same section and the same action, and so a rename cannot leave one detector
 * stranded in a section of its own.
 */
import type { FindingTabAction } from './types';

/** The `Detected issues` section every change-surface finding lands in. */
export const CHANGE_SURFACE_GROUP = 'Change surface';

/**
 * The one action all three carry. The antipattern wireframe's
 * `Go to turn #83 →` on CS-2 is a wireframe deviation and is deliberately not implemented —
 * a whole-session aggregate has no originating turn to jump to.
 */
export const CHANGE_SURFACE_TAB_ACTION: FindingTabAction = {
  kind: 'tab',
  tab: 'change-surface',
  label: 'Open Change surface tab →',
};
