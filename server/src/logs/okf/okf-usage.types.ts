/**
 * OKF usage — response shapes of the session tab, the repo tab and the facts route
 * (impl-plan "API changes", units per DD-35). Mirrored in `client/src/models/repositories.ts`;
 * keep the two in sync. Every addition must stay optional-friendly for older clients.
 */

/** Kind of access stored in `session_okf_access.op`. */
export type OkfOp = 'read' | 'grep' | 'list' | 'write';

export type OkfVerdictLevel =
  | 'ok'
  | 'fix'
  | 'mess'
  | 'kb_not_used'
  | 'not_enough_data';

export type OkfFindingRule =
  | 'session_share'
  | 'always_read'
  | 'kb_flood'
  | 'coarse_article'
  // 2026-11-03 OKF value signals (DD-18): value-signal rules, emitted by `okf-value-signals.ts`.
  | 'routing_miss'
  | 'searched_after'
  | 'dead_pointers'
  | 'catalog';

/** `info` (DD-17/DD-18) is listed but never changes the verdict level. */
export type OkfFindingSeverity = 'fix' | 'mess' | 'info';

export interface OkfFinding {
  rule: OkfFindingRule;
  severity: OkfFindingSeverity;
  /** Rule parameters (DD-24 / DD-25); the client renders the text from rule id + params. */
  params: Record<string, string | number>;
  /** `bundle: null` = the "No longer in KB" group. */
  node: { bundle: string | null; path?: string };
  /**
   * FR-10 (DD-17): too few sessions read the file's current version, so the finding was
   * computed over all sessions. `sessions` = sessions on the current version, `total` = all,
   * `oldSize` = the file's size in the older version (null when unknown).
   */
  stale?: { sessions: number; total: number; oldSize: number | null };
  /** FR-10 (DD-17): the file is missing from the latest snapshot; it never changes the level. */
  removed?: boolean;
}

export interface OkfVerdict {
  level: OkfVerdictLevel;
  qualifiers: 'partial_data'[];
  /** Repo route only: how many KB sessions had no snapshot. */
  partialData?: { withoutSnapshot: number; total: number };
  /** Worst first. */
  findings: OkfFinding[];
}

export interface OkfBundleSummary {
  root: string;
  index: string;
  ignored: boolean;
  /** Null without a snapshot. */
  files: number | null;
  filesRead: number;
  /** Fraction 0–1; null when `files` is null. */
  share: number | null;
  /** KB read bytes (read + grep, own-edit included). */
  readBytes: number;
  /** Session route: FR-12 marker; repo route: null. */
  startedFromIndex: boolean | null;
  /** Repo route: KB sessions whose first access to this bundle was its index.md; session route: null. */
  sessionsStartedFromIndex: number | null;
}

export type OkfTreeMarker =
  | 'folder_scan'
  | 'entry_point'
  | 'own_edit'
  | 'coarse'
  | 'hot'
  // 2026-11-03 OKF value signals (DD-18).
  | 'routing_miss'
  | 'catalog'
  | 'dead'
  | 'upkeep'
  | 'stale'
  | 'section'
  | 'not_read';

/** Pointer yield (FR-1): `k` of `n` non-partial reads with a new pointer had one followed. */
export interface OkfYield {
  k: number;
  n: number;
}

/** Value-signal totals of the session route (DD-14). */
export interface OkfSignalSummary {
  readsWithNewPointers: number;
  readsFollowed: number;
  routingMissArticles: number;
  searchedAfterPairs: number;
  deadPointers: number;
}

/** Which OKF thresholds the view used differ from the defaults (DD-20). */
export interface OkfThresholdsInfo {
  custom: string[];
}

export interface OkfTreeNode {
  /** Null = "no longer in KB" / unknown bundle (no snapshot). */
  bundle: string | null;
  /** File path, or folder path ending in `/`. */
  path: string;
  kind: 'bundle' | 'folder' | 'file';
  /** False = "not in the KB at session start" / gone. */
  inSnapshot: boolean;
  size: number | null;
  readBytes: number;
  readCalls: number;
  ownEditReadBytes: number;
  grepCalls: number;
  listCalls: number;
  writeCalls: number;
  /** Distinct nodes (session route) / distinct sessions (repo route). */
  agents: number;
  markers: OkfTreeMarker[];
  /** Repo route: rank in `hotFiles` (1-based) when the `hot` marker is set. */
  hotRank?: number;
  children?: OkfTreeNode[];
  // 2026-11-03 OKF value signals — all optional for older clients.
  /** FR-4: read calls with a line range (also counted in `readCalls`). */
  rangedCalls?: number;
  /** FR-5: read calls of upkeep pairs (excluded from `readCalls`). */
  upkeepReadCalls?: number;
  /** FR-1 pointer yield; null when no read showed a new pointer. */
  yield?: OkfYield | null;
  /** FR-2: agents that searched the article's area after reading it, and their searches. */
  searchedAfter?: { agents: number; searches: number };
  /** FR-3: agents that searched the area without reading the article, of all area agents. */
  routingMiss?: { agents: number; areaAgents: number };
  /** FR-13: dead pointers of the article. */
  deadPointers?: number;
  /** FR-15: area file count when the article is a catalog. */
  catalogFiles?: number;
  /** FR-10: the current size and the size read by older sessions. */
  stale?: { size: number | null; oldSize: number | null };
  /** FR-10: missing from the latest snapshot. */
  removed?: boolean;
}

export type OkfAgentEntry = 'index' | 'search' | 'given';

/** One element of the session route's `agents[]`. */
export interface OkfAgent {
  /** `sessions.session_id` string. */
  id: string;
  taskHead: string;
  entry: OkfAgentEntry | null;
  /** This agent's `read` + `grep` calls on bundle files. */
  kbReads: number;
  /** Their bytes. */
  kbReadBytes: number;
  /** Those bundle file paths, sorted by read bytes desc, then path. */
  files: string[];
  // 2026-11-03 OKF value signals — all optional for older clients.
  /** New pointers this agent was shown (DD-9). */
  pointers?: { article: string; pointer: string; followed: boolean }[];
  /** Paths the agent's prompt already named. */
  promptNamedPaths?: number;
  /** FR-3 misses of this agent. */
  routingMisses?: { article: string; searches: number; patterns: string[] }[];
  /** FR-5: articles this agent edited (upkeep pairs). */
  upkeepArticles?: string[];
  /** Code search events of this agent. */
  searches?: number;
  /** FR-1 pointer yield of this agent. */
  yield?: OkfYield | null;
}

/** FR-5 upkeep line of the session route. */
export interface OkfSessionUpkeepItem {
  path: string;
  bundle: string | null;
  readBytes: number;
  readCalls: number;
}

/** FR-5 upkeep panel row of the repo route. */
export interface OkfRepoUpkeepItem {
  path: string;
  bundle: string | null;
  sessions: number;
  readBytes: number;
}

export interface OkfReadTopItem {
  bundle: string | null;
  path: string;
  readBytes: number;
  ownEdit: boolean;
}

/** `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage`. */
export interface SessionOkfUsageResponse {
  verdict: OkfVerdict | null;
  hasSnapshot: boolean;
  readTop: OkfReadTopItem[];
  bundles: OkfBundleSummary[];
  tree: OkfTreeNode[];
  agents: OkfAgent[];
  // 2026-11-03 OKF value signals — all optional for older clients.
  thresholds?: OkfThresholdsInfo;
  upkeep?: OkfSessionUpkeepItem[];
  signals?: OkfSignalSummary;
  /** A node hit the per-node event / pointer cap (DD-5, DD-9). */
  eventsTruncated?: boolean;
}

export type OkfShareBin = '0-10' | '10-25' | '25-50' | '50+';

/** `GET /api/v1/repositories/:repoId/reports/okf-usage`. */
export interface RepoOkfUsageResponse {
  verdict: OkfVerdict;
  snapshot: {
    okfSnapshotId: string;
    /** ISO timestamp — `okf_snapshots.created_at`. */
    takenAt: string;
    branch: string | null;
  } | null;
  tiles: {
    kbFiles: number;
    notRead: number;
    kbSessions: number;
    totalSessions: number;
    /** Count of KB sessions. */
    startedFromIndex: number;
    /** Fractions 0–1; null when no snapshot-bound KB session. */
    medianShare: number | null;
    maxShare: number | null;
    // 2026-11-03 OKF value signals — all optional for older clients.
    /** FR-5: root trees whose only KB rows are upkeep (not KB sessions). */
    upkeepOnlySessions?: number;
    /** FR-1 pointer yield over the period. */
    pointerYield?: OkfYield | null;
    /** FR-3: articles with a routing-miss finding, and their (node, article) misses. */
    routingMissArticles?: number;
    routingMissPairs?: number;
    /** FR-11: root sessions of the period with no current OKF analysis, of all of them. */
    sessionsWithoutAnalysis?: number;
    sessionsInPeriod?: number;
  };
  /** FR-6: bundles with fewer than `shareMinBundleFiles` files are skipped. */
  shareBins: { bin: OkfShareBin; sessions: number }[];
  hotFiles: {
    bundle: string | null;
    path: string;
    readBytes: number;
    sessions: number;
    /** FR-1 pointer yield of the file. */
    yield?: OkfYield | null;
  }[];
  notRead: { bundle: string; path: string; size: number }[];
  bundles: OkfBundleSummary[];
  tree: OkfTreeNode[];
  // 2026-11-03 OKF value signals — all optional for older clients.
  thresholds?: OkfThresholdsInfo;
  upkeep?: OkfRepoUpkeepItem[];
  /** Same authority as `recompute-all-sessions` (FR-11 banner link). */
  canRecompute?: boolean;
}

/** `GET /api/v2/okf-usage/facts` (API key, owner only). */
export interface OkfFactsResponse {
  sessionId: string;
  startedAt: string | null;
  prompts: string[];
  agents: {
    id: string;
    parentId: string | null;
    prompt: string;
    kbReads: {
      path: string;
      bytes: number;
      calls: number;
      ownEditBytes: number;
      size: number | null;
    }[];
    kbSeq: string[];
    otherReadsTop: { path: string; bytes: number }[];
    changes: string[];
    /**
     * 2026-11-03 OKF value signals: the agent's KB and code accesses in call order, rebuilt on
     * demand from `extractOkfDetail(...).seq`. Server-only field; optional for older consumers.
     */
    accessSeq?: OkfFactsSeqItem[];
  }[];
  tree: { changes: string[]; reads: string[]; runs: string[] };
}

/** One element of `OkfFactsResponse.agents[].accessSeq` (DD-1a `OkfSeqItem`). */
export interface OkfFactsSeqItem {
  /** 1-based call ordinal within the agent (DD-2). */
  ord: number;
  op: 'kb_read' | 'kb_search' | 'kb_write' | 'read' | 'search' | 'write';
  path: string;
  offset?: number;
  limit?: number;
  pattern?: string;
  /** New pointers of a single-article KB read (DD-9). */
  newPointers?: string[];
}

/** A pattern with its count (FR-14). */
export interface OkfPatternCountItem {
  pattern: string;
  count: number;
}

/** `GET /api/v1/repositories/:repoId/reports/okf-usage/article` (DD-23). */
export interface RepoOkfArticleResponse {
  /** False when `path` is not a stored KB article in scope; every other field is then empty. */
  found: boolean;
  path: string;
  bundle: string | null;
  /** Size in the latest snapshot; null when unknown. */
  size: number | null;
  /** FR-10: the size older sessions read, when the article changed since. */
  oldSize: number | null;
  hashStatus: 'current' | 'stale' | 'removed' | 'unknown';
  /** DD-12: the area was built from an older version's pointers. */
  areaFromOlderVersion: boolean;
  /** Read calls in the period: whole-file, ranged, upkeep and partial reads. */
  reads: { whole: number; section: number; upkeep: number; partial: number };
  yield: OkfYield | null;
  /** FR-13: dead first, then `shown` desc. */
  pointers: {
    pointer: string;
    shown: number;
    followed: number;
    dead: boolean;
    notFound: boolean;
  }[];
  /** DD-12 area files. */
  area: string[];
  catalog: { files: number } | null;
  routingMiss: {
    agents: number;
    areaAgents: number;
    patterns: OkfPatternCountItem[];
    /** `taskHead` masked like `okf-usage` for a `team-no-prompts` caller. */
    missing: {
      sessionId: string;
      agentId: string;
      taskHead: string;
      searches: number;
    }[];
  } | null;
  searchedAfter: {
    agents: number;
    searches: number;
    patterns: OkfPatternCountItem[];
  } | null;
  /** This article's findings, value-signal rules included. */
  findings: OkfFinding[];
  /** Top 5 other files with a finding of the same rule. */
  sameFindingElsewhere: { path: string; rule: OkfFindingRule; value: number }[];
}
