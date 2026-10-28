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
  | 'coarse_article';

export type OkfFindingSeverity = 'fix' | 'mess';

export interface OkfFinding {
  rule: OkfFindingRule;
  severity: OkfFindingSeverity;
  /** Rule parameters (DD-24 / DD-25); the client renders the text from rule id + params. */
  params: Record<string, string | number>;
  /** `bundle: null` = the "No longer in KB" group. */
  node: { bundle: string | null; path?: string };
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
  | 'hot';

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
  };
  shareBins: { bin: OkfShareBin; sessions: number }[];
  hotFiles: {
    bundle: string | null;
    path: string;
    readBytes: number;
    sessions: number;
  }[];
  notRead: { bundle: string; path: string; size: number }[];
  bundles: OkfBundleSummary[];
  tree: OkfTreeNode[];
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
  }[];
  tree: { changes: string[]; reads: string[]; runs: string[] };
}
