/**
 * Pre-release-aware SemVer helpers — an identical copy of the `parseVersion`,
 * `compareVersions` and `maxVersion` exports in server/src/common/semver.ts
 * (client and server share no code). Keep both files in sync; the client and server
 * test suites use the same case table.
 */

/**
 * A SemVer 2.0 version split into its comparable parts. Numeric parts are kept as
 * digit strings (leading zeros stripped) so arbitrarily large numbers compare exactly.
 * Build metadata is dropped because it never affects precedence.
 */
export interface ParsedVersion {
  major: string;
  minor: string;
  patch: string;
  /** Dot-separated pre-release identifiers; empty when the version has no pre-release. */
  prerelease: string[];
}

const VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

const NUMERIC_RE = /^\d+$/;

function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** Compares two non-negative decimal digit strings numerically. */
function compareNumericStrings(a: string, b: string): -1 | 0 | 1 {
  const na = stripLeadingZeros(a);
  const nb = stripLeadingZeros(b);
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

/**
 * Lenient-but-safe version parser: accepts `x.y.z` with an optional SemVer pre-release
 * (`-beta.1`) and optional build metadata (`+build.5`), after trimming whitespace.
 * Returns `null` for anything that is not a string or does not match.
 */
export function parseVersion(v: unknown): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const match = VERSION_RE.exec(v.trim());
  if (!match) return null;
  return {
    major: stripLeadingZeros(match[1]),
    minor: stripLeadingZeros(match[2]),
    patch: stripLeadingZeros(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aNum = NUMERIC_RE.test(a);
  const bNum = NUMERIC_RE.test(b);
  if (aNum && bNum) return compareNumericStrings(a, b);
  if (aNum) return -1; // numeric identifiers rank below alphanumeric ones
  if (bNum) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1; // ASCII order
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  const core =
    compareNumericStrings(a.major, b.major) ||
    compareNumericStrings(a.minor, b.minor) ||
    compareNumericStrings(a.patch, b.patch);
  if (core !== 0) return core;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1; // release ranks above its pre-releases
  if (bPre.length === 0) return -1;

  const shared = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < shared; i++) {
    const cmp = comparePrereleaseIdentifiers(aPre[i], bPre[i]);
    if (cmp !== 0) return cmp;
  }
  if (aPre.length === bPre.length) return 0;
  return aPre.length < bPre.length ? -1 : 1;
}

/**
 * SemVer 2.0 §11 precedence comparison. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Build metadata is ignored. Callers must pass versions already accepted by `parseVersion`;
 * as a defensive fallback an unparseable value ranks below any parseable one, and two
 * unparseable values compare equal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return compareParsed(pa, pb);
}

/**
 * Returns the highest version among `values` (as its trimmed original string), ignoring
 * anything `parseVersion` rejects. Returns `null` when no value parses.
 */
export function maxVersion(values: Iterable<unknown>): string | null {
  let best: string | null = null;
  let bestParsed: ParsedVersion | null = null;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const parsed = parseVersion(value);
    if (!parsed) continue;
    if (bestParsed === null || compareParsed(parsed, bestParsed) > 0) {
      bestParsed = parsed;
      best = value.trim();
    }
  }
  return best;
}
