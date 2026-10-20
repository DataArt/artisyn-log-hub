/**
 * Change surface — the shared contracts.
 *
 * Two families live here and they must not be confused:
 *
 * - **Wire shapes** (`ChangeSurfaceAggregate`, `ChangeSurfaceFileRow`,
 *   `ChangeSurfaceBucket`, `ChangeSurfaceTimeline`, `ChangeSurfaceReportData`) are
 *   what the four HTTP routes return. The client mirrors them in its own api module.
 * - **Internal shapes** (`ChangedPathFact`, `RawChangedPath`) never go on the wire.
 *   `RawChangedPath` is what the transcript extractor can produce before a repo root
 *   is known; `ChangedPathFact` is the normalised, per-`pathKey`-aggregated row that
 *   the writer stores and the loader reads back, so a single `computeChangeSurface()`
 *   serves ingest, one session, a report period and a chart bucket alike.
 *
 * Concentration is never stored — it is recomputed from the facts for every scope,
 * which is what keeps all five surfaces in agreement.
 */

/**
 * Fixed, cross-repository file taxonomy.
 *
 * Deliberately *not* the per-repo `fileCategories`/`classifyFile()` pair in
 * `claude-extractor.ts` — this axis has to be comparable between repositories, so it
 * is a closed set in code and lives server-side only.
 */
export type FileKind = 'source' | 'test' | 'config' | 'docs' | 'other';

/** Concentration bands, from the chart wireframe: `>= 60` / `40-59` / `< 40`. */
export type ChangeBand = 'focused' | 'mixed' | 'scattered';

/**
 * How a path came to be touched.
 *
 * `deleted` is never emitted today (deletions happen through `Bash rm`, not through
 * `EDIT_WRITE_TOOL_NAMES`); it exists for forward compatibility so the column and the
 * breakdown do not need a migration when that changes.
 */
export type ChangeKind = 'added' | 'modified' | 'deleted';

/** Bucket granularity accepted by the aggregate service; `none` = one fold only. */
export type ChangeSurfaceBucketSize = 'none' | 'hour' | 'day' | 'week';

/** The bucket sizes a *timeline* can be rendered at (`none` is not one of them). */
export type ChangeSurfaceTimelineBucket = Exclude<
  ChangeSurfaceBucketSize,
  'none'
>;

/**
 * Range span -> default bucket, in evaluation order: the first row whose
 * `maxSpanDays` is not exceeded wins. An explicit `bucket` query
 * param overrides this table; an unrecognised value is a `BadRequestException`.
 */
export const CHANGE_SURFACE_BUCKET_THRESHOLDS = [
  { maxSpanDays: 3, bucket: 'hour' },
  { maxSpanDays: 60, bucket: 'day' },
  { maxSpanDays: Infinity, bucket: 'week' },
] as const satisfies readonly {
  maxSpanDays: number;
  bucket: ChangeSurfaceTimelineBucket;
}[];

/**
 * Cap on the per-file rows returned by `GET .../change-surface/files`.
 * The *aggregate* endpoint is never capped, so no headline
 * number and no `sum(leaf +) === root +` identity can be affected by this limit — only the tree listing,
 * which says so explicitly when it trips.
 */
export const CHANGE_SURFACE_MAX_FILE_ROWS = 5000;

/**
 * Cap on the raw path rows a report/analytics scope may stream into TypeScript.
 * The loader selects one row more than this; if the extra row
 * comes back the result is flagged `truncated` and the surface renders a
 * "narrow the date range" notice instead of a silently partial union.
 */
export const CHANGE_SURFACE_MAX_SCOPE_ROWS = 400_000;

/**
 * Everything one scope's change surface is rendered from — a session, a session
 * tree, a report period, a chart bucket or a group inside one.
 *
 * `computed: false` is the "never recomputed / repo root unknown" state and must
 * render as *no data* on every surface, never as `0`.
 */
export interface ChangeSurfaceAggregate {
  /** `cs_computed_at IS NOT NULL` for the root, `BOOL_OR` over a tree/scope. */
  computed: boolean;
  /** `false` when no repo root was ever learned, so nothing could be normalised. */
  repoRootKnown: boolean;
  /** Distinct in-repo changed paths (union across the scope, never a `SUM`). */
  changedFiles: number;
  /** Distinct in-repo folders touched. */
  foldersTouched: number;
  /** Display names of the distinct top-level modules, sorted. */
  topLevelModules: string[];
  /** 0-100; `null` when `changedFiles === 0`. */
  concentration: number | null;
  band: ChangeBand | null;
  /** `F / K`. */
  filesPerFolder: number | null;
  /** `max(n_i) / F`, in `[0, 1]`. */
  largestFolderShare: number | null;
  /** Raw normalised entropy `H / ln(K)`, in `[0, 1]`; `0` when `K === 1`. */
  folderEntropyNorm: number | null;
  /** Mean *raw* hop distance between touched folders, one decimal. */
  meanPathDistanceHops: number | null;
  /** `count(n_i === 1)`. */
  singleFileFolders: number;
  /** Segment count of the common ancestor of every in-repo changed path. */
  commonAncestorDepth: number | null;
  /** In-repo only; the outside-repo rows are reported separately below. */
  linesAdded: number;
  linesRemoved: number;
  /** In-repo files with at least one diff-covered edit call. */
  diffCoveredFiles: number;
  outsideRepoFiles: number;
  outsideRepoLinesAdded: number;
  outsideRepoLinesRemoved: number;
  byExtension: ChangeSurfaceExtensionRow[];
  byFileKind: ChangeSurfaceFileKindRow[];
  byChangeKind: { added: number; modified: number; deleted: number };
  folderDistribution: ChangeSurfaceFolderRow[];
}

/** One row of the display-only raw-extension axis. */
export interface ChangeSurfaceExtensionRow {
  /** Lowercased, no dot; `''` for a file with no extension. */
  extension: string;
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

/** One row of the fixed file-kind axis. */
export interface ChangeSurfaceFileKindRow {
  kind: FileKind;
  files: number;
  /** `files / changedFiles`, in `[0, 1]`. */
  share: number;
  linesAdded: number;
  linesRemoved: number;
}

/** One row of the touched-folder distribution. */
export interface ChangeSurfaceFolderRow {
  /** Display folder path; `'.'` for the repo root. */
  folder: string;
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * One path in the per-file listing behind the tab's file tree.
 *
 * `relPath === null` means the row could not be normalised — it is either outside
 * the repo or was recorded before any repo root was known; the tab groups those under
 * an explicit "Outside repo / unnormalised" node rather than dropping them.
 */
export interface ChangeSurfaceFileRow {
  rawPath: string;
  relPath: string | null;
  /** `'.'` for a file that sits directly at the repo root. */
  folder: string | null;
  fileKind: FileKind | null;
  extension: string | null;
  changeKind: ChangeKind;
  editCalls: number;
  diffCoveredCalls: number;
  linesAdded: number;
  linesRemoved: number;
  outsideRepo: boolean;
}

/** One point of the analytics timeline / the report's weekly series. */
export interface ChangeSurfaceBucket {
  /** ISO timestamp of the bucket's `date_trunc` boundary. */
  bucketStart: string;
  sessions: number;
  /** Drives the bar -> `SessionModal` click-through. */
  sessionIds: string[];
  concentration: number | null;
  changedFiles: number;
  foldersTouched: number;
  topLevelModules: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Response of `GET /api/v1/repositories/:repoId/analytics/change-surface`. */
export interface ChangeSurfaceTimeline {
  bucket: ChangeSurfaceTimelineBucket;
  buckets: ChangeSurfaceBucket[];
  groups:
    | { key: string; label: string; buckets: ChangeSurfaceBucket[] }[]
    | null;
}

/** The exact (lower) medians, over change-having sessions. */
export interface ChangeSurfaceMedians {
  changedFiles: number;
  foldersTouched: number;
  concentration: number | null;
  filesPerFolder: number;
  topLevelModules: number;
  folderEntropyNorm: number;
  singleFileFolderShare: number;
}

/** The `repo_code_inventory` snapshot a report's `%` indicators divide by. */
export interface ChangeSurfaceInventory {
  capturedAt: string;
  branch: string | null;
  trackedFiles: number;
  trackedLines: number;
  trackedBinaryFiles: number;
}

/** Response of `GET /api/v1/repositories/:repoId/reports/change-surface`. */
export interface ChangeSurfaceReportData {
  repo: ChangeSurfaceAggregate;
  sessionsWithChanges: number;
  noChangeSessions: number;
  perSessionMedian: ChangeSurfaceMedians | null;
  inventory: ChangeSurfaceInventory | null;
  /** `null` -> render "n/a - denominator unavailable", never `0%`. */
  shareOfTrackedFiles: number | null;
  shareOfTrackedLines: number | null;
  groups:
    | {
        key: string;
        label: string;
        sessions: number;
        aggregate: ChangeSurfaceAggregate;
        shareOfTrackedFiles: number | null;
      }[]
    | null;
  buckets: {
    bucketStart: string;
    sessions: number;
    concentration: number | null;
  }[];
  /**
   * `true` when the period hit {@link CHANGE_SURFACE_MAX_SCOPE_ROWS} and the union above is
   * a prefix of it rather than all of it. The report then says "period too large — narrow
   * the date range" instead of presenting a silently partial union as a whole one.
   */
  truncated: boolean;
}

/**
 * One logical changed path, already normalised and aggregated by `pathKey`.
 * This is the row `session_changed_paths` stores and the row
 * `loadScopedChangedPaths()` reads back, so the DB round-trip is shape-preserving.
 */
export interface ChangedPathFact {
  /** `NOT NULL` row identity — one row per logical path per session. */
  pathKey: string;
  /** First raw spelling seen for this key, truncated to 1024 chars. */
  rawPath: string;
  /** Display, original case; `null` when outside the repo or the root is unknown. */
  relPath: string | null;
  /** Case-folded `relPath` — the distinctness key across sessions. */
  relPathKey: string | null;
  /** Display folder; `'.'` for a repo-root file. */
  folder: string | null;
  /** Case-folded `folder` — the `GROUP BY` key. */
  folderKey: string | null;
  /** Case-folded first segment; `'.'` for a repo-root file. */
  topModuleKey: string | null;
  /** Segment count of `folder` (`0` for `'.'`). */
  depth: number | null;
  fileKind: FileKind | null;
  /** Lowercased, no dot; `''` when the file has none. */
  extension: string | null;
  outsideRepo: boolean;
  changeKind: ChangeKind;
  editCalls: number;
  /** Edit calls whose `+`/`-` are backed by a real diff, never a fabricated `0/0`. */
  diffCoveredCalls: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * What `claude-extractor.ts` emits, before a repo root is known.
 * The writer maps `RawChangedPath[] + roots ->
 * ChangedPathFact[]`.
 */
export interface RawChangedPath {
  rawPath: string;
  editCalls: number;
  diffCoveredCalls: number;
  linesAdded: number;
  linesRemoved: number;
  /** Drives `changeKind`. */
  createdByAnyCall: boolean;
}
