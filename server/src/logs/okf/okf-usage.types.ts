/**
 * OKF usage — response shapes of the OKF tab (session and repo routes, one `OkfUsageResponse`)
 * and of the facts route. The tab types are mirrored in `client/src/models/repositories.ts`;
 * keep the two in sync.
 */

/** Kind of access stored in `session_okf_access.op`. */
export type OkfOp = 'read' | 'grep' | 'list' | 'write';

/**
 * FR-7 per-article format hints (advice, never a warning): `no_front_matter` — the article has
 * no front-matter block; `no_type` — it has one without a `type` key; `v01_timestamp` — it uses
 * the OKF v0.1 `timestamp` key and no `generated` key.
 */
export type OkfArticleHint = 'no_front_matter' | 'no_type' | 'v01_timestamp';

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
  /** Search items: the call's result was a hit (package 3, additive). */
  hit?: boolean;
}

// ── OKF tab: summary line and four views ───────────────────────────────────────────────────────

export type OkfUsageUnit = 'sessions' | 'agents';

export type OkfFormatProblem =
  | 'no_front_matter'
  | 'no_type'
  | 'v01_timestamp'
  | 'deprecated'
  | 'past_stale_after';

export interface OkfUsageFile {
  /** Deepest bundle root above the file. */
  bundle: string;
  /** Repo-relative path. */
  path: string;
  inSnapshot: boolean;
  /** `index.md` / `log.md`: left out of hot files and of the format checks. */
  index: boolean;
  /** Distinct sessions (repo route) / agents (session route) with a read; 0 = never opened. */
  units: number;
  reads: number;
  /** Bytes returned / 4, not rounded. */
  tokens: number;
  /** USD; null = it has reads and none has a cost. */
  cost: number | null;
}

export interface OkfUsageFolder {
  bundle: string;
  /** Folder key ending in `/`; a bundle root is listed too. */
  path: string;
  units: number;
  /** Folder-level searches on exactly this folder. */
  search: {
    units: number;
    reads: number;
    tokens: number;
    cost: number | null;
  } | null;
}

export interface OkfUsageVersionRow {
  root: string;
  files: number;
  /** Declared `okf_version`; null = not declared. */
  okfVersion: string | null;
  older: boolean;
  /** Gitignored bundle (owner-only; never present in a team view). */
  ignored: boolean;
}

export interface OkfUsageFormat {
  articles: number;
  indexFiles: number;
  /** Distinct articles with at least one problem. */
  withProblems: number;
  groups: {
    problem: OkfFormatProblem;
    files: { path: string; supersededBy?: string }[];
  }[];
}

export interface OkfUsageResponse {
  unit: OkfUsageUnit;
  /** null = no KB snapshot: the tab is one line and every other field is empty / zero. */
  snapshot: {
    branch: string | null;
    takenAt: string;
    hasMeta: boolean;
  } | null;
  /** Every visible bundle root, also with a `bundle` filter. */
  bundleRoots: string[];
  /** `OKF_CURRENT_FORMAT_VERSION`. */
  currentFormat: string;
  summary: {
    unitsRead: number;
    unitsTotal: number;
    reads: number;
    tokens: number;
    cost: number | null;
    readsWithoutCost: number;
    /** Σ `session_costs.cost` over every node of the same trees; null = unknown. */
    spend: number | null;
  };
  /** [] when `snapshot.hasMeta` is false. */
  versions: OkfUsageVersionRow[];
  /** null when `snapshot.hasMeta` is false. */
  format: OkfUsageFormat | null;
  files: OkfUsageFile[];
  folders: OkfUsageFolder[];
  notInSnapshotUnits: number;
}
