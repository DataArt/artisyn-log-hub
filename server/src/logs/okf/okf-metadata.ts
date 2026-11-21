/**
 * OKF usage — front-matter metadata derivation (OKF v0.3 support, FR-6..FR-9; impl-plan DD-S2,
 * DD-S3 of `docs/tasks/todo/2026-11-19-okf-v03-support`).
 *
 * Pure, no DB, no I/O. Input is the normalised snapshot (`normaliseSnapshot`): the bundle fields
 * `okfVersion` / `title` / `description` and each file's `meta` sent by hook 3.1.0+. Older hooks
 * send none of them — then {@link hasHookMeta} is false and nothing here produces output (FR-9),
 * so old-hook data renders exactly as before.
 *
 * - FR-6 content flags per article: `deprecated` (`status: deprecated`, any case) with its
 *   resolved `superseded_by`, and `pastStaleAfter` (`stale_after` before the reference time, or
 *   unparseable).
 * - FR-7 format hints per article (advice only): no front matter, no `type`, v0.1 `timestamp`.
 * - FR-8 bundle hint: the bundle declares a format older than {@link OKF_CURRENT_FORMAT_VERSION}.
 */
import { collapseRepoRelative } from '../change-surface/path-normalise';
import type { OkfSnapshotBundle, OkfSnapshotFile } from './okf-snapshot';
import type { OkfArticleHint } from './okf-usage.types';
import { bundleArticles } from './okf-verdict';

/** The newest OKF format version Log Hub knows (FR-8). */
export const OKF_CURRENT_FORMAT_VERSION = '0.3';

const CURRENT_MAJOR = 0;
const CURRENT_MINOR = 3;

/** Every hint in its fixed display order. */
const HINT_ORDER: readonly OkfArticleHint[] = [
  'no_front_matter',
  'no_type',
  'v01_timestamp',
];

/** FR-6 / FR-7 flags of one article. */
export interface OkfArticleMetaFlags {
  deprecated: boolean;
  /** Resolved `superseded_by` (DD-S3); only set when `deprecated`. */
  supersededBy: string | null;
  pastStaleAfter: boolean;
  formatHints: OkfArticleHint[];
}

/** The bundle-level metadata of an OKF summary (FR-7, FR-8). */
export interface OkfBundleMetaSummary {
  title?: string;
  description?: string;
  okfVersion?: string;
  newerFormatHint: boolean;
  articlesWithHints: number;
  hintReasons: OkfArticleHint[];
}

/**
 * FR-9: the bundle came from a hook that sends metadata — some file carries `meta` (hook 3.1.0+
 * always sends it, at least for the bundle's own `index.md`).
 */
export function hasHookMeta(bundle: OkfSnapshotBundle): boolean {
  return bundle.files.some((f) => f.meta !== undefined);
}

/**
 * FR-8: true when the bundle should be told a newer format exists. One pair of surrounding quotes
 * is stripped; a value not matching `major.minor[.patch]` (or absent) → `true`; otherwise `true`
 * when `(major, minor)` is numerically below `(0, 3)`. So `0.3`, `0.3.1`, `0.10`, `1.0` → false;
 * absent, `0.1`, `0.2`, `1`, `foo` → true.
 */
export function okfVersionHint(okfVersion: string | undefined): boolean {
  if (okfVersion === undefined) return true;
  let v = okfVersion.trim();
  if (
    v.length >= 2 &&
    (v[0] === '"' || v[0] === "'") &&
    v[v.length - 1] === v[0]
  ) {
    v = v.slice(1, -1).trim();
  }
  const m = /^(\d+)\.(\d+)(\.\d+)?$/.exec(v);
  if (m === null) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== CURRENT_MAJOR) return major < CURRENT_MAJOR;
  return minor < CURRENT_MINOR;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * FR-6: a `stale_after` value as epoch ms, or `null`. `YYYY-MM-DD` → that day 00:00 UTC; an
 * RFC 3339 date-time with `Z` or an offset → its instant; an invalid date or any other format
 * (no zone, free text) → `null`.
 */
export function parseStaleAfter(v: string): number | null {
  const s = v.trim();
  const d = DATE_ONLY_RE.exec(s);
  if (d !== null) {
    const year = Number(d[1]);
    const month = Number(d[2]);
    const day = Number(d[3]);
    const ms = Date.UTC(year, month - 1, day);
    const check = new Date(ms);
    // Reject rolled-over dates such as 2026-02-30.
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return null;
    }
    return ms;
  }
  if (DATE_TIME_RE.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Bundle root without trailing slash; `.` → `''` (repo root). */
function normaliseRoot(root: string): string {
  const r = root.replace(/\/+$/, '');
  return r === '.' ? '' : r;
}

function joinPath(dir: string, rest: string): string {
  return dir === '' ? rest : `${dir}/${rest}`;
}

/**
 * DD-S3: a `superseded_by` value as a repo-relative path. A value starting with `/` is relative
 * to the bundle root, anything else to the article's folder; `.` / `..` are collapsed
 * ({@link collapseRepoRelative}). When that escapes the repo (or is empty) the raw value is kept.
 */
export function resolveSupersededBy(
  value: string,
  articlePath: string,
  bundleRoot: string,
): string {
  const slash = articlePath.lastIndexOf('/');
  const articleDir = slash < 0 ? '' : articlePath.slice(0, slash);
  const joined = value.startsWith('/')
    ? joinPath(normaliseRoot(bundleRoot), value.replace(/^\/+/, ''))
    : joinPath(articleDir, value);
  const collapsed = collapseRepoRelative(joined);
  return collapsed === null || collapsed === '' ? value : collapsed;
}

const NO_FLAGS: OkfArticleMetaFlags = {
  deprecated: false,
  supersededBy: null,
  pastStaleAfter: false,
  formatHints: [],
};

/**
 * FR-6 / FR-7 flags of one article at reference time `refMs` (DD-S6: the session start, or now on
 * the repo route). A file without `meta` (old hook) → all false / `[]`.
 */
export function articleMetaFlags(
  file: OkfSnapshotFile,
  bundle: OkfSnapshotBundle,
  refMs: number,
): OkfArticleMetaFlags {
  const meta = file.meta;
  if (meta === undefined) return { ...NO_FLAGS, formatHints: [] };
  const deprecated = meta.status?.trim().toLowerCase() === 'deprecated';
  const supersededBy =
    deprecated && meta.supersededBy !== undefined
      ? resolveSupersededBy(meta.supersededBy, file.path, bundle.root)
      : null;
  let pastStaleAfter = false;
  if (meta.staleAfter !== undefined) {
    const at = parseStaleAfter(meta.staleAfter);
    pastStaleAfter = at === null || at < refMs;
  }
  const formatHints: OkfArticleHint[] = [];
  if (!meta.frontMatter) formatHints.push('no_front_matter');
  if (meta.frontMatter && meta.type === undefined) formatHints.push('no_type');
  if (meta.hasTimestamp && !meta.hasGenerated) {
    formatHints.push('v01_timestamp');
  }
  return { deprecated, supersededBy, pastStaleAfter, formatHints };
}

/**
 * FR-7 / FR-8 bundle summary over the bundle's articles (`bundleArticles`, FR-2 — the index,
 * nested `index.md` / `log.md` and dot-paths do not count). `null` without hook metadata (FR-9).
 */
export function bundleMetaSummary(
  bundle: OkfSnapshotBundle,
  refMs: number,
): OkfBundleMetaSummary | null {
  if (!hasHookMeta(bundle)) return null;
  let articlesWithHints = 0;
  const reasons = new Set<OkfArticleHint>();
  for (const file of bundleArticles(bundle)) {
    const { formatHints } = articleMetaFlags(file, bundle, refMs);
    if (formatHints.length === 0) continue;
    articlesWithHints += 1;
    for (const h of formatHints) reasons.add(h);
  }
  const out: OkfBundleMetaSummary = {
    newerFormatHint: okfVersionHint(bundle.okfVersion),
    articlesWithHints,
    hintReasons: HINT_ORDER.filter((h) => reasons.has(h)),
  };
  if (bundle.title !== undefined) out.title = bundle.title;
  if (bundle.description !== undefined) out.description = bundle.description;
  if (bundle.okfVersion !== undefined) out.okfVersion = bundle.okfVersion;
  return out;
}
