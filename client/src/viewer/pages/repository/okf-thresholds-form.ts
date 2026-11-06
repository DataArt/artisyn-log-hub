/**
 * Form model of the Settings → Analysis "OKF thresholds" card (impl-plan DD-19 / DD-22 of
 * 2026-11-03-okf-view-kb-value): field labels and groups, the inline validation that mirrors the
 * server's `validateOkfThresholds`, and the diff-only section the card saves.
 *
 * The defaults are never kept here: they come from `RepoSettingsResponse.okfDefaults`.
 */
import type { OkfThresholds, RepoConfig } from '../../../models/repositories';

/** Numeric threshold fields (every field but `codeRoots`). */
export type OkfNumericField = Exclude<keyof OkfThresholds, 'codeRoots'>;

/** Fields whose value is a share in (0, 1]; every other numeric field is an integer >= 1. */
const SHARE_FIELDS = new Set<OkfNumericField>([
  'sessionShareFix',
  'sessionShareMess',
  'alwaysReadShare',
  'floodShare',
  'floodMessSessionShare',
  'coarseMaxReadRatio',
]);

/** Same as the server's `OKF_CODE_ROOTS_MAX`. */
export const OKF_CODE_ROOTS_MAX = 50;

export interface OkfFieldDef {
  field: OkfNumericField;
  /** "What it affects" text (DD-19). */
  affects: string;
}

export const OKF_VERDICT_FIELDS: readonly OkfFieldDef[] = [
  {
    field: 'shareMinBundleFiles',
    affects:
      'bundles smaller than this are skipped by share rules and the histogram',
  },
  { field: 'sessionShareFix', affects: 'session verdict levels' },
  { field: 'sessionShareMess', affects: 'session verdict levels' },
  { field: 'repoMinKbSessions', affects: 'minimum KB sessions for repo rules' },
  { field: 'alwaysReadShare', affects: 'always_read' },
  { field: 'floodShare', affects: 'kb_flood' },
  { field: 'floodMessSessionShare', affects: 'kb_flood' },
  {
    field: 'floodMinSessions',
    affects: 'flooded sessions needed before kb_flood changes the verdict',
  },
  { field: 'coarseMinSizeBytes', affects: 'coarse_article' },
  { field: 'coarseMinSessions', affects: 'coarse_article' },
  { field: 'coarseMaxReadRatio', affects: 'coarse_article' },
];

export const OKF_VALUE_SIGNAL_FIELDS: readonly OkfFieldDef[] = [
  { field: 'exploredMinSearches', affects: 'searched after reading' },
  { field: 'routingMinSearches', affects: 'routing miss' },
  { field: 'routingMinAgents', affects: 'routing miss' },
  {
    field: 'pointerMaxArticles',
    affects: 'article area (shared pointers dropped)',
  },
  { field: 'areaMaxFiles', affects: 'catalog' },
  { field: 'deadPointerMinShown', affects: 'dead pointers' },
];

export const OKF_CODE_ROOTS_AFFECTS =
  "article area — set to this repo's code folders";

const NUMERIC_FIELDS: readonly OkfNumericField[] = [
  ...OKF_VERDICT_FIELDS,
  ...OKF_VALUE_SIGNAL_FIELDS,
].map((d) => d.field);

/** Editable state: numbers as typed text, `codeRoots` as a tag list. */
export interface OkfThresholdsFormState {
  numbers: Record<OkfNumericField, string>;
  codeRoots: string[];
}

/** A record with one entry per numeric field. */
function numericRecord(
  value: (field: OkfNumericField) => string,
): Record<OkfNumericField, string> {
  return {
    shareMinBundleFiles: value('shareMinBundleFiles'),
    sessionShareFix: value('sessionShareFix'),
    sessionShareMess: value('sessionShareMess'),
    repoMinKbSessions: value('repoMinKbSessions'),
    alwaysReadShare: value('alwaysReadShare'),
    floodShare: value('floodShare'),
    floodMessSessionShare: value('floodMessSessionShare'),
    floodMinSessions: value('floodMinSessions'),
    coarseMinSizeBytes: value('coarseMinSizeBytes'),
    coarseMinSessions: value('coarseMinSessions'),
    coarseMaxReadRatio: value('coarseMaxReadRatio'),
    exploredMinSearches: value('exploredMinSearches'),
    routingMinSearches: value('routingMinSearches'),
    routingMinAgents: value('routingMinAgents'),
    pointerMaxArticles: value('pointerMaxArticles'),
    areaMaxFiles: value('areaMaxFiles'),
    deadPointerMinShown: value('deadPointerMinShown'),
  };
}

/** The form filled from `section` merged field by field over `defaults`. */
export function okfFormFromSection(
  defaults: OkfThresholds,
  section: OkfThresholds | undefined,
): OkfThresholdsFormState {
  return {
    numbers: numericRecord((field) => {
      const value = section?.[field] ?? defaults[field];
      return value === undefined ? '' : String(value);
    }),
    codeRoots: [...(section?.codeRoots ?? defaults.codeRoots ?? [])],
  };
}

/** The inline error of one numeric field, or `null` when its text is valid (DD-19). */
export function okfNumericFieldError(
  field: OkfNumericField,
  text: string,
): string | null {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (SHARE_FIELDS.has(field)) {
    return trimmed !== '' && Number.isFinite(value) && value > 0 && value <= 1
      ? null
      : 'a number greater than 0 and at most 1';
  }
  return trimmed !== '' && Number.isSafeInteger(value) && value >= 1
    ? null
    : 'a whole number ≥ 1';
}

/**
 * One `codeRoots` entry normalised to a repo-relative folder ending in `/` (forward slashes,
 * no leading `./`), or an error text — the server's `normaliseCodeRoot` rules.
 */
export function normaliseOkfCodeRoot(
  value: string,
): { root: string } | { error: string } {
  let root = value.trim().replace(/\\/g, '/');
  if (root.startsWith('/') || /^[A-Za-z]:/.test(root)) {
    return { error: 'must be a relative path' };
  }
  if (root.split('/').includes('..')) return { error: 'must not contain ".."' };
  while (root.startsWith('./')) root = root.slice(2);
  if (root === '' || root === '.') return { error: 'must not be empty' };
  if (!root.endsWith('/')) root += '/';
  return { root };
}

/** The `codeRoots` list error, or `null` (non-empty, at most 50 entries). */
export function okfCodeRootsError(roots: string[]): string | null {
  if (roots.length === 0) return 'add at least one folder';
  if (roots.length > OKF_CODE_ROOTS_MAX) {
    return `at most ${OKF_CODE_ROOTS_MAX} folders`;
  }
  return null;
}

/** True when every field of the form passes the inline validation. */
export function isOkfFormValid(form: OkfThresholdsFormState): boolean {
  return (
    NUMERIC_FIELDS.every(
      (f) => okfNumericFieldError(f, form.numbers[f]) === null,
    ) && okfCodeRootsError(form.codeRoots) === null
  );
}

function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

/**
 * The diff-only `okf` section of a valid form (DD-22): only the fields that differ from
 * `defaults`, or `undefined` when none differ (the section is dropped).
 */
export function okfSectionFromForm(
  defaults: OkfThresholds,
  form: OkfThresholdsFormState,
): OkfThresholds | undefined {
  const section: OkfThresholds = {};
  for (const field of NUMERIC_FIELDS) {
    const value = Number(form.numbers[field].trim());
    if (value !== defaults[field]) section[field] = value;
  }
  if (!sameRoots(form.codeRoots, defaults.codeRoots ?? [])) {
    section.codeRoots = [...form.codeRoots];
  }
  return Object.keys(section).length > 0 ? section : undefined;
}

/** True when two forms hold the same values (the Save button stays off without a change). */
export function sameOkfForm(
  a: OkfThresholdsFormState,
  b: OkfThresholdsFormState,
): boolean {
  return (
    NUMERIC_FIELDS.every((f) => a.numbers[f].trim() === b.numbers[f].trim()) &&
    sameRoots(a.codeRoots, b.codeRoots)
  );
}

/**
 * Read-modify-write of the scope's whole config with only `okf` replaced; `undefined` drops the
 * section ("Reset to defaults"). `JSON.stringify` leaves an `undefined` key out of the body.
 */
export function withOkfSection(
  base: RepoConfig,
  okf: OkfThresholds | undefined,
): RepoConfig {
  return { ...base, okf };
}
