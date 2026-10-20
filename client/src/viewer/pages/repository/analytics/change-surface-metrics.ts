/**
 * Sub-metric definitions for the Analytics "Change Surface" view.
 *
 * Same shape as the other selectors in `analytics/metrics.ts` (`key` / `label` /
 * `shortLabel` / `description` / `format` / `yLabel`), plus one extra flag: `bounded`.
 * `concentration` is a bounded 0-100 score and therefore renders on a **fixed** axis with
 * the fixed band legend, while the three volume metrics are
 * open-ended counts that keep the usual data-scaled axis and `zoneColor` treatment.
 *
 * Values come straight off a `ChangeSurfaceBucket` — every bucket is a fresh union
 * recomputation on the server, never a sum of the sessions in it, so nothing here
 * aggregates.
 */
import type { ChangeSurfaceBucket } from '../../../../models/repositories';
import {
  CHANGE_SURFACE_NA,
  formatConcentration,
} from '../../../lib/change-surface-ui';

export type ChangeSurfaceMetricKey =
  | 'concentration'
  | 'files'
  | 'folders'
  | 'modules';

export interface ChangeSurfaceMetricDef {
  key: ChangeSurfaceMetricKey;
  label: string;
  shortLabel: string;
  description: string;
  format: (v: number) => string;
  yLabel: string;
  /**
   * `true` -> fixed 0-100 axis and the three-band legend; `false` -> data-scaled axis
   * with the shared zone colours.
   */
  bounded: boolean;
}

export const CHANGE_SURFACE_METRICS: ChangeSurfaceMetricDef[] = [
  {
    key: 'concentration',
    label: 'Concentration (spread)',
    shortLabel: 'Concentration',
    description:
      'How tightly the changed files of the bucket sit together — 100 is one folder, 0 is everywhere at once',
    format: (v) => formatConcentration(v),
    yLabel: 'score',
    bounded: true,
  },
  {
    key: 'files',
    label: 'Changed files',
    shortLabel: 'Files',
    description:
      'Distinct in-repo files changed in the bucket — a file two sessions both touched counts once',
    format: (v) => v.toLocaleString(),
    yLabel: 'files',
    bounded: false,
  },
  {
    key: 'folders',
    label: 'Folders touched',
    shortLabel: 'Folders',
    description:
      'Distinct folders holding at least one changed file in the bucket',
    format: (v) => v.toLocaleString(),
    yLabel: 'folders',
    bounded: false,
  },
  {
    key: 'modules',
    label: 'Top-level modules touched',
    shortLabel: 'Modules',
    description:
      'Distinct first path segments (top-level modules) the changed files fall under',
    format: (v) => v.toLocaleString(),
    yLabel: 'modules',
    bounded: false,
  },
];

export const DEFAULT_CHANGE_SURFACE_METRIC: ChangeSurfaceMetricKey =
  'concentration';

/**
 * The bucket's value for a metric. `null` only ever means "genuinely absent": a bucket
 * that changed no file has no concentration at all and must render as `n/a` with no bar,
 * never as a `0` score. A real `0` count stays `0`.
 */
export function resolveChangeSurfaceValue(
  bucket: ChangeSurfaceBucket,
  key: ChangeSurfaceMetricKey,
): number | null {
  switch (key) {
    case 'concentration':
      return bucket.concentration;
    case 'files':
      return bucket.changedFiles;
    case 'folders':
      return bucket.foldersTouched;
    case 'modules':
      return bucket.topLevelModules;
  }
}

/** The metric's own formatting, with the shared `n/a` for an absent value. */
export function formatChangeSurfaceValue(
  value: number | null,
  metric: ChangeSurfaceMetricDef,
): string {
  return value === null ? CHANGE_SURFACE_NA : metric.format(value);
}

export function resolveChangeSurfaceMetric(
  key: ChangeSurfaceMetricKey,
): ChangeSurfaceMetricDef {
  return (
    CHANGE_SURFACE_METRICS.find((m) => m.key === key) ??
    CHANGE_SURFACE_METRICS[0]
  );
}
