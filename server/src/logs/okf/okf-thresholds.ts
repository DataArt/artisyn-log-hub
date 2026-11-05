/**
 * OKF View thresholds (impl-plan DD-19 of 2026-11-03-okf-view-kb-value).
 *
 * The thresholds live in `RepoConfigJson.okf` (team or personal row); every field is optional
 * and defaults to `DEFAULT_OKF_THRESHOLDS`. They are applied at read time, so saving them never
 * needs a recompute.
 *
 * - `validateOkfThresholds(raw)` is the write-side check (settings PUTs): it throws a
 *   `BadRequestException('okf.<field> …')` on the first invalid field and returns the section
 *   with `codeRoots` normalised (forward slashes, no leading `./`, trailing `/`).
 * - `resolveOkfThresholds(raw)` is the read-side merge: field by field over the defaults; a
 *   stored field that is invalid (a row written by an older or broken client) falls back to its
 *   default instead of failing the read.
 */
import { BadRequestException } from '@nestjs/common';
import type { OkfThresholds } from '../../database/schema/index';
import { OKF_CODE_ROOTS_MAX } from './okf-constants';

/** Every threshold field resolved to a value. */
export type ResolvedOkfThresholds = Required<OkfThresholds>;

export const DEFAULT_OKF_THRESHOLDS: Readonly<ResolvedOkfThresholds> =
  Object.freeze({
    shareMinBundleFiles: 10,
    sessionShareFix: 0.25,
    sessionShareMess: 0.5,
    repoMinKbSessions: 5,
    alwaysReadShare: 0.8,
    floodShare: 0.25,
    floodMessSessionShare: 0.2,
    floodMinSessions: 3,
    coarseMinSizeBytes: 51200,
    coarseMinSessions: 5,
    coarseMaxReadRatio: 0.1,
    exploredMinSearches: 2,
    routingMinSearches: 3,
    routingMinAgents: 3,
    pointerMaxArticles: 3,
    areaMaxFiles: 30,
    deadPointerMinShown: 4,
    codeRoots: [
      'server/',
      'client/',
      'hook/',
      'scripts/',
      'packages/',
      'tests/',
    ],
  });

/** Share fields: numbers in (0, 1]. */
const SHARE_FIELDS = [
  'sessionShareFix',
  'sessionShareMess',
  'alwaysReadShare',
  'floodShare',
  'floodMessSessionShare',
  'coarseMaxReadRatio',
] as const;

/** Count / size fields: integers >= 1. */
const INTEGER_FIELDS = [
  'shareMinBundleFiles',
  'repoMinKbSessions',
  'floodMinSessions',
  'coarseMinSizeBytes',
  'coarseMinSessions',
  'exploredMinSearches',
  'routingMinSearches',
  'routingMinAgents',
  'pointerMaxArticles',
  'areaMaxFiles',
  'deadPointerMinShown',
] as const;

/** All threshold field names, in the Settings block order (verdict group, then value signals). */
export const OKF_THRESHOLD_FIELDS: readonly (keyof OkfThresholds)[] = [
  'shareMinBundleFiles',
  'sessionShareFix',
  'sessionShareMess',
  'repoMinKbSessions',
  'alwaysReadShare',
  'floodShare',
  'floodMessSessionShare',
  'floodMinSessions',
  'coarseMinSizeBytes',
  'coarseMinSessions',
  'coarseMaxReadRatio',
  'exploredMinSearches',
  'routingMinSearches',
  'routingMinAgents',
  'pointerMaxArticles',
  'areaMaxFiles',
  'deadPointerMinShown',
  'codeRoots',
];

const KNOWN_FIELDS = new Set<string>(OKF_THRESHOLD_FIELDS);

function isShare(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalises one `codeRoots` entry to a repo-relative folder ending in `/`, or returns an
 * error text when it is not one: empty, absolute (`/…`, `\…`, `C:…`) or containing `..`.
 */
function normaliseCodeRoot(
  value: unknown,
): { root: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'must be a string' };
  let root = value.trim().replace(/\\/g, '/');
  if (root.startsWith('/') || /^[A-Za-z]:/.test(root)) {
    return { error: 'must be a relative path' };
  }
  if (root.split('/').includes('..')) {
    return { error: 'must not contain ".."' };
  }
  while (root.startsWith('./')) root = root.slice(2);
  if (root === '' || root === '.') return { error: 'must not be empty' };
  if (!root.endsWith('/')) root += '/';
  return { root };
}

/** The normalised `codeRoots` list, or an error text for the first invalid entry. */
function normaliseCodeRoots(
  value: unknown,
): { roots: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'must be an array' };
  if (value.length === 0) return { error: 'must not be empty' };
  if (value.length > OKF_CODE_ROOTS_MAX) {
    return { error: `must have at most ${OKF_CODE_ROOTS_MAX} entries` };
  }
  const roots: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const result = normaliseCodeRoot(value[i]);
    if ('error' in result) return { error: `[${i}] ${result.error}` };
    roots.push(result.root);
  }
  return { roots };
}

/**
 * Validates an `okf` section from a settings PUT body. Throws `BadRequestException` naming the
 * first invalid field (`okf.<field> …`); returns the section with `codeRoots` normalised and
 * only the fields that were sent.
 */
export function validateOkfThresholds(raw: unknown): OkfThresholds {
  if (!isPlainObject(raw)) {
    throw new BadRequestException('okf must be an object');
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new BadRequestException(`okf.${key} is not a known threshold`);
    }
  }

  const result: OkfThresholds = {};

  for (const field of SHARE_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!isShare(value)) {
      throw new BadRequestException(
        `okf.${field} must be a number greater than 0 and at most 1`,
      );
    }
    result[field] = value;
  }

  for (const field of INTEGER_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!isPositiveInteger(value)) {
      throw new BadRequestException(`okf.${field} must be an integer >= 1`);
    }
    result[field] = value;
  }

  if (raw.codeRoots !== undefined) {
    const roots = normaliseCodeRoots(raw.codeRoots);
    if ('error' in roots) {
      throw new BadRequestException(`okf.codeRoots ${roots.error}`);
    }
    result.codeRoots = roots.roots;
  }

  return result;
}

/**
 * Merges a stored `okf` section over `DEFAULT_OKF_THRESHOLDS` field by field. Anything that is
 * not a valid value for its field (including a non-object section) is replaced by the default,
 * so a read never fails on a bad stored row.
 */
export function resolveOkfThresholds(raw: unknown): ResolvedOkfThresholds {
  const values: ResolvedOkfThresholds = {
    ...DEFAULT_OKF_THRESHOLDS,
    codeRoots: [...DEFAULT_OKF_THRESHOLDS.codeRoots],
  };
  if (!isPlainObject(raw)) return values;

  for (const field of SHARE_FIELDS) {
    const value = raw[field];
    if (isShare(value)) values[field] = value;
  }
  for (const field of INTEGER_FIELDS) {
    const value = raw[field];
    if (isPositiveInteger(value)) values[field] = value;
  }
  const roots = normaliseCodeRoots(raw.codeRoots);
  if ('roots' in roots) values.codeRoots = roots.roots;

  return values;
}

/** The fields of `values` that differ from `DEFAULT_OKF_THRESHOLDS`, in field order. */
export function customOkfThresholdFields(
  values: ResolvedOkfThresholds,
): string[] {
  const custom: string[] = [];
  for (const field of OKF_THRESHOLD_FIELDS) {
    if (field === 'codeRoots') {
      const defaults = DEFAULT_OKF_THRESHOLDS.codeRoots;
      const same =
        values.codeRoots.length === defaults.length &&
        values.codeRoots.every((root, i) => root === defaults[i]);
      if (!same) custom.push(field);
    } else if (values[field] !== DEFAULT_OKF_THRESHOLDS[field]) {
      custom.push(field);
    }
  }
  return custom;
}
