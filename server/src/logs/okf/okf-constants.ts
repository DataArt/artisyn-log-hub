/**
 * OKF usage — shared fixed limits (impl-plan DD-0 of 2026-11-03-okf-view-kb-value).
 *
 * These are not settings: the extractor, the writer, the read side and the value-signals module
 * import them from here, and the settings response reports some of them as `okfFixedLimits`.
 */

/** Version of the OKF extraction; a node with a lower `sessions.okf_extract_version` needs recompute (DD-11). */
export const OKF_EXTRACT_VERSION = 2;

/** A code event whose path has one of these segments is dropped (DD-5). */
export const OKF_EVENT_SKIP_SEGMENTS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'target',
  'tmp',
];

/** A search pattern is cut to this many characters (DD-5). */
export const OKF_PATTERN_MAX_CHARS = 200;

/** At most this many code events per node; beyond it the node is marked truncated (DD-5). */
export const OKF_EVENT_CAP_PER_NODE = 3000;

/** At most this many pointer rows per node; beyond it the node is marked truncated (DD-9). */
export const OKF_POINTER_CAP_PER_NODE = 5000;

/** Top search patterns shown per finding (FR-14). */
export const OKF_TOP_PATTERNS = 5;

/** Longest back-ticked span taken as a pointer (DD-8); also the `pointer` column width. */
export const OKF_POINTER_MAX_CHARS = 512;

/** Most `codeRoots` entries a threshold section may hold (DD-19). */
export const OKF_CODE_ROOTS_MAX = 50;

/** An event path or article path longer than this is dropped, not truncated. */
export const OKF_PATH_MAX_CHARS = 1024;
