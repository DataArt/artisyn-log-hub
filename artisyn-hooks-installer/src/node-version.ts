/**
 * Node.js version advisory for the installer (FR-16, DD-15).
 *
 * Twin of the hook's `hook/.claude/telemetry_tool/node-version-check.js`: the same patched-minimum
 * table, classification, warning text and test-only override env var
 * (`ARTISYN_NODE_VERSION_OVERRIDE`, replaces `process.versions.node`). The installer has no
 * throttle — it warns on every run. Keep both copies identical.
 */

/** Patched minimum per supported even line. */
export const NODE_PATCHED_MINIMUMS: Readonly<Record<number, string>> = Object.freeze({
  22: '22.23.5',
  24: '24.22.3',
  26: '26.13.1',
});

/** The security release the minimums come from. */
export const NODE_ADVISORY = 'November 2026';

/** Test-only env var that replaces `process.versions.node`. */
export const NODE_VERSION_OVERRIDE_ENV = 'ARTISYN_NODE_VERSION_OVERRIDE';

const HIGHEST_KNOWN_MAJOR = 26;

export type NodeVersionStatus = 'ok' | 'unpatched' | 'eol' | 'unknown';

export interface NodeVersionClass {
  status: NodeVersionStatus;
  line: number | null;
  target: string | null;
}

type VersionParts = [number, number, number];

/** The Node version to judge: the override env var when set, else `process.versions.node`. */
export function effectiveNodeVersion(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[NODE_VERSION_OVERRIDE_ENV] ?? '').trim();
  return (override || process.versions.node).replace(/^v/i, '');
}

function parseVersion(v: string): VersionParts | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareParts(a: VersionParts, b: VersionParts): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * - major < 22, or an odd major ≤ 26 → `eol`;
 * - a major in `NODE_PATCHED_MINIMUMS` below its minimum → `unpatched`;
 * - major > 26 (or an unparsable version) → `unknown`;
 * - otherwise `ok`.
 */
export function classifyNodeVersion(v: string): NodeVersionClass {
  const parts = parseVersion(v);
  if (!parts) return { status: 'unknown', line: null, target: null };
  const major = parts[0];
  const target = Object.prototype.hasOwnProperty.call(NODE_PATCHED_MINIMUMS, major)
    ? NODE_PATCHED_MINIMUMS[major] ?? null
    : null;
  if (major < 22 || (major % 2 === 1 && major <= HIGHEST_KNOWN_MAJOR)) {
    return { status: 'eol', line: major, target: null };
  }
  if (major > HIGHEST_KNOWN_MAJOR) return { status: 'unknown', line: major, target: null };
  const targetParts = target ? parseVersion(target) : null;
  if (target && targetParts && compareParts(parts, targetParts) < 0) {
    return { status: 'unpatched', line: major, target };
  }
  return { status: 'ok', line: major, target };
}

/** `22.23.5, 24.22.3 or 26.13.1` */
export function targetVersionsText(): string {
  const list = Object.keys(NODE_PATCHED_MINIMUMS)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => NODE_PATCHED_MINIMUMS[k] ?? '');
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

/** The warning text for a version, or null when its status is `ok` or `unknown`. */
export function nodeWarningText(v: string): string | null {
  const { status } = classifyNodeVersion(v);
  let problem: string;
  if (status === 'eol') problem = 'is end-of-life';
  else if (status === 'unpatched') problem = `misses the ${NODE_ADVISORY} security fixes`;
  else return null;
  return `Log Hub: Node.js ${v} ${problem} — upgrade to Node.js ${targetVersionsText()} or newer.`
    + ' Log Hub hooks keep working.';
}
