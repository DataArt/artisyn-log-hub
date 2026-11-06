/**
 * OKF usage — shared fixed limits (impl-plan DD-0 of 2026-11-03-okf-view-kb-value).
 *
 * These are not settings: the extractor, the writer, the read side and the value-signals module
 * import them from here, and the settings response reports some of them as `okfFixedLimits`.
 */

/**
 * Version of the OKF extraction; a node with a lower `sessions.okf_extract_version` needs recompute (DD-11).
 * 2: events, pointers and `search_hits`; 3: the stricter pointer rule (no `(`/`)`, no bare
 * version numbers, a span without `/` only with a {@link OKF_POINTER_FILE_EXTENSIONS} extension).
 */
export const OKF_EXTRACT_VERSION = 3;

/**
 * Lowest `okf_extract_version` whose `session_okf_access.search_hits` is filled (DD-6). Separate
 * from {@link OKF_EXTRACT_VERSION} so a later bump does not discard the hit data of older nodes.
 */
export const OKF_SEARCH_HITS_MIN_VERSION = 2;

/**
 * A back-ticked span without `/` is a pointer only when its extension (lower-cased, after the last
 * `.`) is one of these (DD-8), so identifiers like `Logger.error` or `process.env` are not.
 */
export const OKF_POINTER_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    // source
    'ts tsx mts cts js jsx mjs cjs vue svelte java kt kts scala groovy gradle cs csproj sln vb',
    'go rs rb php swift c h cpp hpp cc dart lua pl sql prisma graphql gql proto',
    // scripts
    'sh bash zsh ps1 psm1 cmd bat',
    // config / data
    'json jsonc json5 jsonl yml yaml toml ini cfg conf xml lock csv tsv dockerfile tf hcl',
    // docs / web
    'md mdx txt rst adoc html htm css scss sass less svg',
  ].flatMap((group) => group.split(' ')),
);

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

/**
 * A folder search counts towards FR-2 "searched after" of an article when the folder holds one of
 * the article's area files and has at least this many path segments (`server/src/logs`), so a
 * repo-wide grep (`server/`, `server/src/`) never does (DD-13).
 */
export const OKF_SEARCH_FOLDER_MIN_DEPTH = 3;

/** Top search patterns shown per finding (FR-14). */
export const OKF_TOP_PATTERNS = 5;

/** Longest back-ticked span taken as a pointer (DD-8); also the `pointer` column width. */
export const OKF_POINTER_MAX_CHARS = 512;

/** Most `codeRoots` entries a threshold section may hold (DD-19). */
export const OKF_CODE_ROOTS_MAX = 50;

/** An event path or article path longer than this is dropped, not truncated. */
export const OKF_PATH_MAX_CHARS = 1024;

/** Items one agent trail returns (`GET …/okf-usage/trail`); beyond it the response says `truncated`. */
export const OKF_TRAIL_MAX_ITEMS = 2000;
