/**
 * OKF usage — pure verdict rules (FR-14a, FR-17a; impl-plan DD-23..DD-27, DD-38).
 *
 * No DB, no I/O: callers (`okf-usage.service.ts`) hand in per-node / per-session aggregates of
 * `session_okf_access` rows plus the snapshot bundles visible in the view (already team-filtered,
 * DD-30). Pinned by `docs/knowledgebase/algorithms/okf-verdict.md`.
 *
 * Bundle membership of a path is by bundle root (the deepest root containing it); the share of a
 * bundle and the per-file rules only count files listed in the bundle's snapshot file list.
 */
import type {
  OkfAgentEntry,
  OkfFinding,
  OkfOp,
  OkfShareBin,
  OkfVerdict,
} from './okf-usage.types';
import {
  DEFAULT_OKF_THRESHOLDS,
  type ResolvedOkfThresholds,
} from './okf-thresholds';

// ── DD-23 constants ────────────────────────────────────────────────────────────────────────────
//
// The rule thresholds (bundle size, shares, flood, coarse, minimum KB sessions) are per-repo
// settings since 2026-11-03 (DD-19): `OkfThresholds`, passed into `computeSessionVerdict` /
// `computeRepoVerdict` and defaulting to `DEFAULT_OKF_THRESHOLDS`. Only the fixed list sizes stay.

/** The verdict-group thresholds the rules read (every field resolved). */
export type OkfVerdictThresholds = Pick<
  ResolvedOkfThresholds,
  | 'shareMinBundleFiles'
  | 'sessionShareFix'
  | 'sessionShareMess'
  | 'repoMinKbSessions'
  | 'alwaysReadShare'
  | 'floodShare'
  | 'floodMessSessionShare'
  | 'floodMinSessions'
  | 'coarseMinSizeBytes'
  | 'coarseMinSessions'
  | 'coarseMaxReadRatio'
>;

export const READ_TOP_N = 5;
export const HOT_FILES_TOP_N = 10;
/** Lower bounds (inclusive) of the share histogram bins. */
export const SHARE_BINS: readonly number[] = [0, 0.1, 0.25, 0.5];
const SHARE_BIN_LABELS: readonly OkfShareBin[] = [
  '0-10',
  '10-25',
  '25-50',
  '50+',
];
export const TASK_HEAD_MAX_CHARS = 200;

// ── Inputs ─────────────────────────────────────────────────────────────────────────────────────

/** A bundle as the verdict sees it — structurally a subset of `OkfSnapshotBundle`. */
export interface OkfVerdictBundle {
  root: string;
  index: string;
  files: { path: string; size: number }[];
}

/** One aggregated access row (a `session_okf_access` row, or a sum of them). */
export interface OkfVerdictRow {
  pathKey: string;
  op: OkfOp;
  afterOwnEdit?: boolean;
  bytes: number;
  calls: number;
  /** DD-27 first-access rank within the node; only needed by `agentEntry` / `startedFromIndex`. */
  seq?: number;
  /** DD-16: read calls with a line range (included in `calls`); absent = 0. */
  rangedCalls?: number;
  /** DD-16: bytes of those calls (included in `bytes`); absent = 0. */
  rangedBytes?: number;
  /**
   * DD-15: the tree node the row belongs to (repo verdict, tree-wide rows). Upkeep is a
   * (node, article) pair, so a write on an article only makes the same node's reads upkeep.
   * Rows without it count as one node.
   */
  nodeId?: string | number;
  /**
   * DD-6: grep / list calls of the row whose result was a hit. Set only for rows of a node
   * extracted at `OKF_EXTRACT_VERSION` ≥ 2; when any row of a node carries it, `agentEntry`
   * applies the DD-6 search-entry rule.
   */
  searchHits?: number;
}

/** Hash and size of a snapshot file (DD-18a). */
export interface OkfVerdictFileHash {
  hash: string | null;
  size: number | null;
}

export interface SessionVerdictNode {
  /** `sessions.session_id` string of the tree node. */
  agentId: string;
  rows: OkfVerdictRow[];
}

export interface SessionVerdictInput {
  nodes: SessionVerdictNode[];
  /** Bundles of the root's snapshot visible in the view; `null` = the tree has no snapshot. */
  bundles: OkfVerdictBundle[] | null;
}

export interface RepoVerdictSession {
  /** Root session id (string or DB id) — only used for identity. */
  sessionId: string | number;
  /** Whether the root tree is bound to a snapshot. */
  hasSnapshot: boolean;
  /** Tree-wide rows (all nodes); rows of the same path / op may repeat and are summed. */
  rows: OkfVerdictRow[];
}

export interface RepoVerdictInput {
  /** Filtered root trees of the view (DD-30 team filter already applied). */
  sessions: RepoVerdictSession[];
  /** Bundles of the latest snapshot visible in the view; `null` = no snapshot anywhere (DD-25). */
  bundles: OkfVerdictBundle[] | null;
  /**
   * FR-10 (DD-18a): file path → hash / size per root session (keyed by `sessionId`), from each
   * root's bound snapshot. With `latestFiles`, enables the stale / removed handling.
   */
  sessionFiles?: ReadonlyMap<
    string | number,
    ReadonlyMap<string, OkfVerdictFileHash>
  >;
  /** FR-10 (DD-18a): file path → hash / size of the latest snapshot. */
  latestFiles?: ReadonlyMap<string, OkfVerdictFileHash>;
}

/** `computeRepoVerdict` result: the verdict plus the FR-5 upkeep-only tree count (DD-15). */
export interface RepoVerdictResult extends OkfVerdict {
  /**
   * Root trees whose only KB rows are upkeep — not KB sessions. Set only when > 0; the caller
   * moves it into `tiles.upkeepOnlySessions` rather than the verdict.
   */
  upkeepOnlySessions?: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────────────────────

/** `read ÷ total`, or `null` when `total` is not positive. */
export function fileShare(read: number, total: number): number | null {
  return total > 0 ? read / total : null;
}

/** DD-23 `SHARE_BINS`: the histogram bin of a share (lower bound inclusive). */
export function shareBin(share: number): OkfShareBin {
  let idx = 0;
  for (let i = 0; i < SHARE_BINS.length; i += 1) {
    if (share >= SHARE_BINS[i]) idx = i;
  }
  return SHARE_BIN_LABELS[idx];
}

/** Median of the values (mean of the two middle ones for an even count); `null` when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normaliseRoot(root: string): string {
  const r = root.replace(/\/+$/, '');
  return r === '.' ? '' : r;
}

/** True when a path key (file, or folder ending in `/`) lies inside the bundle root. */
function isUnderRoot(pathKey: string, root: string): boolean {
  const r = normaliseRoot(root);
  if (r === '') return true;
  const p = pathKey === '/' ? '' : pathKey.replace(/\/+$/, '');
  return p === r || p.startsWith(`${r}/`);
}

/** The deepest bundle whose root contains the path key, or `null`. */
export function bundleOfPath<B extends { root: string }>(
  pathKey: string,
  bundles: readonly B[] | null,
): B | null {
  if (bundles === null) return null;
  let best: B | null = null;
  let bestLen = -1;
  for (const b of bundles) {
    const len = normaliseRoot(b.root).length;
    if (len > bestLen && isUnderRoot(pathKey, b.root)) {
      best = b;
      bestLen = len;
    }
  }
  return best;
}

function isReadLike(op: OkfOp): boolean {
  return op === 'read' || op === 'grep';
}

/** KB access (DD-38): a read/grep row in a visible bundle, or any read/grep row without bundles. */
function isKbRead(
  row: OkfVerdictRow,
  bundles: OkfVerdictBundle[] | null,
): boolean {
  if (!isReadLike(row.op)) return false;
  return bundles === null || bundleOfPath(row.pathKey, bundles) !== null;
}

/** Min seq of the rows (rows without a seq sort last, in input order). */
function firstBySeq(rows: readonly OkfVerdictRow[]): OkfVerdictRow | null {
  let best: OkfVerdictRow | null = null;
  for (const r of rows) {
    if (best === null) best = r;
    else if ((r.seq ?? Infinity) < (best.seq ?? Infinity)) best = r;
  }
  return best;
}

/**
 * DD-26: how an agent (one tree node) reached the KB. Looks at its first non-write access to any
 * bundle: `index` when it targets that bundle's `index.md`; `search` when a `grep` / `list` row on
 * that bundle comes no later than its first non-index `read`; otherwise `given`. `null` when the
 * node never touched a bundle (or there are no bundles).
 *
 * DD-6 (2026-11-03), when the rows carry `searchHits` (extractor version ≥ 2): `search` only when
 * the first bundle access is a `grep` / `list` row on a folder key with `searchHits > 0`, and the
 * node later has a `read` row in that bundle; otherwise `given`. Rows without `searchHits` (older
 * extraction) keep the rule above.
 */
export function agentEntry(
  rows: readonly OkfVerdictRow[],
  bundles: readonly OkfVerdictBundle[] | null,
): OkfAgentEntry | null {
  if (bundles === null || bundles.length === 0) return null;
  const inKb = rows.filter(
    (r) => r.op !== 'write' && bundleOfPath(r.pathKey, bundles) !== null,
  );
  const first = firstBySeq(inKb);
  if (first === null) return null;
  const bundle = bundleOfPath(first.pathKey, bundles)!;
  if (first.pathKey === bundle.index) return 'index';
  const inBundle = inKb.filter(
    (r) => bundleOfPath(r.pathKey, bundles) === bundle,
  );
  if (rows.some((r) => r.searchHits !== undefined)) {
    const isSearch =
      (first.op === 'grep' || first.op === 'list') &&
      first.pathKey.endsWith('/') &&
      (first.searchHits ?? 0) > 0 &&
      inBundle.some(
        (r) =>
          r.op === 'read' && (r.seq ?? Infinity) > (first.seq ?? -Infinity),
      );
    return isSearch ? 'search' : 'given';
  }
  const firstRead = firstBySeq(
    inBundle.filter((r) => r.op === 'read' && r.pathKey !== bundle.index),
  );
  const readSeq = firstRead?.seq ?? Infinity;
  const searched = inBundle.some(
    (r) =>
      (r.op === 'grep' || r.op === 'list') && (r.seq ?? Infinity) <= readSeq,
  );
  return searched ? 'search' : 'given';
}

export interface StartedFromIndexNode {
  /** Node start time in ms (null sorts last). */
  startTime: number | null;
  rows: readonly OkfVerdictRow[];
}

/**
 * FR-12 per DD-27: the tree's first non-write access to the bundle — earliest node `startTime`,
 * then `seq` within the node — is the bundle's `index.md`. `null` when the tree never touched it.
 */
export function startedFromIndex(
  nodes: readonly StartedFromIndexNode[],
  bundle: OkfVerdictBundle,
  bundles: readonly OkfVerdictBundle[] = [bundle],
): boolean | null {
  const ordered = [...nodes].sort(
    (a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity),
  );
  for (const node of ordered) {
    const first = firstBySeq(
      node.rows.filter(
        (r) => r.op !== 'write' && bundleOfPath(r.pathKey, bundles) === bundle,
      ),
    );
    if (first !== null) return first.pathKey === bundle.index;
  }
  return null;
}

function upkeepKey(nodeId: string | number | undefined, path: string): string {
  return `${nodeId === undefined ? '' : String(nodeId)}\u0000${path}`;
}

/** True for a `read` / `grep` row of an upkeep pair (DD-15): the same node wrote that path. */
export function upkeepPredicate(
  rows: readonly OkfVerdictRow[],
): (row: OkfVerdictRow) => boolean {
  const written = new Set<string>();
  for (const r of rows) {
    if (r.op === 'write') written.add(upkeepKey(r.nodeId, r.pathKey));
  }
  return (row) =>
    isReadLike(row.op) && written.has(upkeepKey(row.nodeId, row.pathKey));
}

/**
 * FR-5 (DD-15): the rows without the `read` / `grep` rows of upkeep pairs — a node reading an
 * article it also edits is maintaining the KB, not using it. Writes and `list` rows stay.
 */
export function withoutUpkeep(rows: readonly OkfVerdictRow[]): OkfVerdictRow[] {
  const isUpkeep = upkeepPredicate(rows);
  return rows.filter((r) => !isUpkeep(r));
}

const SEVERITY_RANK: Record<OkfFinding['severity'], number> = {
  mess: 0,
  fix: 1,
  info: 2,
};

function sortFindings(findings: OkfFinding[]): OkfFinding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i,
    )
    .map((x) => x.f);
}

/** Worst severity; `info` findings and findings on removed files never count (DD-17). */
function worstLevel(findings: readonly OkfFinding[]): 'ok' | 'fix' | 'mess' {
  const counted = findings.filter(
    (f) => f.severity !== 'info' && f.removed !== true,
  );
  if (counted.some((f) => f.severity === 'mess')) return 'mess';
  if (counted.length > 0) return 'fix';
  return 'ok';
}

/**
 * The bundle's articles: its snapshot-listed files without its `index.md`. The index is the entry
 * point and read by design, so no analysis counts it — not in shares, floods, hot files or the
 * per-file rules.
 */
export function bundleArticles<F extends { path: string }>(bundle: {
  index: string;
  files: readonly F[];
}): F[] {
  return bundle.files.filter((f) => f.path !== bundle.index);
}

/** Distinct articles of the bundle (`bundleArticles`) with a read/grep row, minus `exclude`. */
export function readFilesOfBundle(
  rows: readonly OkfVerdictRow[],
  bundle: OkfVerdictBundle,
  exclude: ReadonlySet<string> = new Set(),
): Set<string> {
  const listed = new Set(bundleArticles(bundle).map((f) => f.path));
  const out = new Set<string>();
  for (const r of rows) {
    if (isReadLike(r.op) && listed.has(r.pathKey) && !exclude.has(r.pathKey)) {
      out.add(r.pathKey);
    }
  }
  return out;
}

// ── DD-24 session verdict ──────────────────────────────────────────────────────────────────────

/**
 * Session verdict (DD-24). Per agent and per bundle with ≥ `shareMinBundleFiles` files:
 * share = distinct bundle files the agent read/grepped ÷ bundle files, both without the files the
 * agent itself wrote; > `sessionShareMess` → `mess`, > `sessionShareFix` → `fix`.
 * No bundle and no KB access → `null`; no KB access → `kb_not_used`; no snapshot → the share rule
 * is skipped and the verdict carries `partial_data`. Upkeep reads (FR-5, DD-15: the node also
 * wrote the article) are not KB access, so an upkeep-only session is `kb_not_used`.
 */
export function computeSessionVerdict(
  input: SessionVerdictInput,
  thresholds: OkfVerdictThresholds = DEFAULT_OKF_THRESHOLDS,
): OkfVerdict | null {
  const { bundles } = input;
  const nodes = input.nodes.map((n) => ({
    ...n,
    rows: withoutUpkeep(n.rows),
  }));
  const hasAccess = nodes.some((n) => n.rows.some((r) => isKbRead(r, bundles)));
  const hasBundle = bundles !== null && bundles.length > 0;
  if (!hasAccess) {
    if (!hasBundle) return null;
    return { level: 'kb_not_used', qualifiers: [], findings: [] };
  }
  if (bundles === null) {
    return { level: 'ok', qualifiers: ['partial_data'], findings: [] };
  }

  const findings: { finding: OkfFinding; share: number }[] = [];
  for (const node of nodes) {
    for (const bundle of bundles) {
      const articles = bundleArticles(bundle);
      if (articles.length < thresholds.shareMinBundleFiles) continue;
      const listed = new Set(articles.map((f) => f.path));
      const written = new Set(
        node.rows
          .filter((r) => r.op === 'write' && listed.has(r.pathKey))
          .map((r) => r.pathKey),
      );
      const total = listed.size - written.size;
      const read = readFilesOfBundle(node.rows, bundle, written).size;
      const share = fileShare(read, total);
      if (share === null) continue;
      let severity: OkfFinding['severity'] | null = null;
      if (share > thresholds.sessionShareMess) severity = 'mess';
      else if (share > thresholds.sessionShareFix) severity = 'fix';
      if (severity === null) continue;
      findings.push({
        share,
        finding: {
          rule: 'session_share',
          severity,
          params: {
            agentId: node.agentId,
            bundle: bundle.root,
            read,
            total,
            share,
          },
          node: { bundle: bundle.root },
        },
      });
    }
  }
  const ordered = sortFindings(
    findings.sort((a, b) => b.share - a.share).map((x) => x.finding),
  );
  return { level: worstLevel(ordered), qualifiers: [], findings: ordered };
}

// ── DD-25 / DD-38 repo verdict ─────────────────────────────────────────────────────────────────

/** A per-file rule's session set after the FR-10 split (DD-17). */
interface FileSessionSet<S> {
  sessions: S[];
  stale?: { sessions: number; total: number; oldSize: number | null };
}

/**
 * FR-10 (DD-17): the sessions a per-file rule is computed over. Base = the sessions whose bound
 * hash of the file equals the latest snapshot's hash. When the base is below the rule's
 * `minimum` but all `sessions` reach it, the rule runs over all of them and the finding is
 * marked stale. Without hash maps, or without a latest hash for the file, all sessions are used.
 */
function fileSessionSet<S extends RepoVerdictSession>(
  path: string,
  sessions: readonly S[],
  minimum: number,
  input: RepoVerdictInput,
): FileSessionSet<S> {
  const latestHash = input.latestFiles?.get(path)?.hash ?? null;
  if (input.sessionFiles === undefined || latestHash === null) {
    return { sessions: [...sessions] };
  }
  const current = sessions.filter(
    (s) => input.sessionFiles!.get(s.sessionId)?.get(path)?.hash === latestHash,
  );
  if (current.length >= minimum || sessions.length < minimum) {
    return current.length >= minimum
      ? { sessions: current }
      : { sessions: [...sessions] };
  }
  return {
    sessions: [...sessions],
    stale: {
      sessions: current.length,
      total: sessions.length,
      oldSize: oldSizeOf(path, sessions, latestHash, input),
    },
  };
}

/** The most common size of the file among sessions bound to another version; null if unknown. */
function oldSizeOf(
  path: string,
  sessions: readonly RepoVerdictSession[],
  latestHash: string,
  input: RepoVerdictInput,
): number | null {
  const counts = new Map<number, number>();
  for (const s of sessions) {
    const file = input.sessionFiles?.get(s.sessionId)?.get(path);
    if (file === undefined || file.hash === latestHash || file.size === null) {
      continue;
    }
    counts.set(file.size, (counts.get(file.size) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Files a per-file rule looks at for one bundle: the latest snapshot's articles, plus — when
 * `latestFiles` is given (FR-10) — read files under the bundle root that the latest snapshot no
 * longer lists but some session's bound snapshot did. Those carry `removed` and their size from
 * that older snapshot.
 */
function ruleFiles(
  bundle: OkfVerdictBundle,
  bundles: readonly OkfVerdictBundle[],
  kbSessions: readonly RepoVerdictSession[],
  input: RepoVerdictInput,
): { path: string; size: number; removed: boolean }[] {
  const out = bundleArticles(bundle).map((f) => ({
    path: f.path,
    size: f.size,
    removed: false,
  }));
  const latest = input.latestFiles;
  if (latest === undefined || input.sessionFiles === undefined) return out;
  const listed = new Set(bundle.files.map((f) => f.path));
  const removed = new Map<string, number>();
  for (const s of kbSessions) {
    const own = input.sessionFiles.get(s.sessionId);
    if (own === undefined) continue;
    for (const r of s.rows) {
      if (
        !isReadLike(r.op) ||
        listed.has(r.pathKey) ||
        removed.has(r.pathKey)
      ) {
        continue;
      }
      if (
        latest.has(r.pathKey) ||
        bundleOfPath(r.pathKey, bundles) !== bundle
      ) {
        continue;
      }
      const file = own.get(r.pathKey);
      if (file === undefined) continue;
      removed.set(r.pathKey, file.size ?? 0);
    }
  }
  for (const [path, size] of [...removed].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    out.push({ path, size, removed: true });
  }
  return out;
}

/** True when the tree has KB rows and every one of them is an upkeep pair (DD-15). */
function isUpkeepOnly(
  rows: readonly OkfVerdictRow[],
  kbRows: readonly OkfVerdictRow[],
  bundles: OkfVerdictBundle[] | null,
): boolean {
  if (kbRows.some((r) => isKbRead(r, bundles))) return false;
  const inKb = (r: OkfVerdictRow): boolean =>
    bundles === null || bundleOfPath(r.pathKey, bundles) !== null;
  return rows.some((r) => r.op === 'write' && inKb(r));
}

/**
 * Repo verdict (DD-25, DD-38) over KB sessions — filtered root trees with ≥ 1 non-upkeep
 * read/grep row in a visible bundle (any read/grep row when `bundles` is `null`). Upkeep rows
 * (FR-5, DD-15) are dropped first; a tree whose only KB rows are upkeep is counted in
 * `upkeepOnlySessions` instead.
 * - `always_read` (fix): a non-index file read/grepped in ≥ `alwaysReadShare` of KB sessions.
 * - `kb_flood`: per bundle with ≥ `shareMinBundleFiles` files, over snapshot-bound bundle
 *   sessions; a tree reading > `floodShare` of the files is flooded. With ≥ `floodMinSessions`
 *   flooded → fix, flooded ÷ bundle sessions ≥ `floodMessSessionShare` → mess; with fewer it is
 *   an `info` finding (FR-7, DD-17).
 * - `coarse_article` (fix): a non-index file of ≥ `coarseMinSizeBytes`, read whole (calls without
 *   a range, DD-16) in ≥ `coarseMinSessions` KB sessions, average whole-read bytes per call ÷
 *   size < `coarseMaxReadRatio`.
 * - FR-10 (DD-17): the per-file rules run over the sessions on the file's current version, or
 *   over all with `stale` set; files gone from the latest snapshot carry `removed`.
 * Level: 0 KB sessions → `kb_not_used`; fewer than `repoMinKbSessions` → `not_enough_data`
 * (findings still listed); otherwise the worst severity, ignoring `info` and `removed`, `ok` when
 * none. Any snapshot-less KB session adds `partial_data` with `{ withoutSnapshot, total }`.
 */
export function computeRepoVerdict(
  input: RepoVerdictInput,
  thresholds: OkfVerdictThresholds = DEFAULT_OKF_THRESHOLDS,
): RepoVerdictResult {
  const { bundles } = input;
  let upkeepOnlySessions = 0;
  const kbSessions: RepoVerdictSession[] = [];
  for (const s of input.sessions) {
    const rows = withoutUpkeep(s.rows);
    if (rows.some((r) => isKbRead(r, bundles))) {
      kbSessions.push({ ...s, rows });
    } else if (isUpkeepOnly(s.rows, rows, bundles)) {
      upkeepOnlySessions += 1;
    }
  }
  const upkeep = upkeepOnlySessions > 0 ? { upkeepOnlySessions } : {};
  const total = kbSessions.length;
  if (total === 0) {
    return { level: 'kb_not_used', qualifiers: [], findings: [], ...upkeep };
  }
  const withoutSnapshot = kbSessions.filter((s) => !s.hasSnapshot).length;
  const qualifiers: 'partial_data'[] =
    withoutSnapshot > 0 ? ['partial_data'] : [];
  const partialData =
    withoutSnapshot > 0 ? { withoutSnapshot, total } : undefined;

  const fileMarks = (
    set: FileSessionSet<RepoVerdictSession>,
    removed: boolean,
  ): Pick<OkfFinding, 'stale' | 'removed'> => ({
    ...(set.stale ? { stale: set.stale } : {}),
    ...(removed ? { removed: true } : {}),
  });

  const findings: OkfFinding[] = [];
  for (const bundle of bundles ?? []) {
    const nonIndex = bundleArticles(bundle);
    const files = ruleFiles(bundle, bundles ?? [], kbSessions, input);

    // always_read
    for (const file of files) {
      const set = fileSessionSet(
        file.path,
        kbSessions,
        thresholds.repoMinKbSessions,
        input,
      );
      const base = set.sessions.length;
      const sessions = set.sessions.filter((s) =>
        s.rows.some((r) => isReadLike(r.op) && r.pathKey === file.path),
      ).length;
      const share = base > 0 ? sessions / base : 0;
      if (sessions > 0 && share >= thresholds.alwaysReadShare) {
        findings.push({
          rule: 'always_read',
          severity: 'fix',
          params: {
            bundle: bundle.root,
            path: file.path,
            sessions,
            kbSessions: base,
            share,
          },
          node: { bundle: bundle.root, path: file.path },
          ...fileMarks(set, file.removed),
        });
      }
    }

    // kb_flood
    if (nonIndex.length >= thresholds.shareMinBundleFiles) {
      const bundleSessions = kbSessions.filter(
        (s) =>
          s.hasSnapshot &&
          s.rows.some(
            (r) =>
              isReadLike(r.op) && bundleOfPath(r.pathKey, bundles) === bundle,
          ),
      );
      const flooded = bundleSessions.filter((s) => {
        const share = fileShare(
          readFilesOfBundle(s.rows, bundle).size,
          nonIndex.length,
        );
        return share !== null && share > thresholds.floodShare;
      }).length;
      if (flooded > 0) {
        const share = flooded / bundleSessions.length;
        let severity: OkfFinding['severity'] = 'info';
        if (flooded >= thresholds.floodMinSessions) {
          severity = share >= thresholds.floodMessSessionShare ? 'mess' : 'fix';
        }
        findings.push({
          rule: 'kb_flood',
          severity,
          params: {
            bundle: bundle.root,
            sessions: flooded,
            bundleSessions: bundleSessions.length,
            share,
            flooded,
            kbSessions: total,
          },
          node: { bundle: bundle.root },
        });
      }
    }

    // coarse_article
    for (const file of files) {
      if (file.size < thresholds.coarseMinSizeBytes) continue;
      const readers = kbSessions.filter((s) =>
        s.rows.some(
          (r) =>
            r.op === 'read' &&
            r.pathKey === file.path &&
            r.calls - (r.rangedCalls ?? 0) > 0,
        ),
      );
      const set = fileSessionSet(
        file.path,
        readers,
        thresholds.coarseMinSessions,
        input,
      );
      let bytes = 0;
      let calls = 0;
      for (const s of set.sessions) {
        for (const r of s.rows) {
          if (r.op !== 'read' || r.pathKey !== file.path) continue;
          bytes += r.bytes - (r.rangedBytes ?? 0);
          calls += r.calls - (r.rangedCalls ?? 0);
        }
      }
      const sessions = set.sessions.length;
      if (sessions < thresholds.coarseMinSessions || calls <= 0) continue;
      const avgReadBytes = bytes / calls;
      const ratio = avgReadBytes / file.size;
      if (ratio < thresholds.coarseMaxReadRatio) {
        findings.push({
          rule: 'coarse_article',
          severity: 'fix',
          params: {
            bundle: bundle.root,
            path: file.path,
            size: file.size,
            sessions,
            avgReadBytes: Math.round(avgReadBytes),
            ratio,
          },
          node: { bundle: bundle.root, path: file.path },
          ...fileMarks(set, file.removed),
        });
      }
    }
  }

  const ordered = sortFindings(findings);
  const level =
    total < thresholds.repoMinKbSessions
      ? 'not_enough_data'
      : worstLevel(ordered);
  return {
    level,
    qualifiers,
    ...(partialData ? { partialData } : {}),
    findings: ordered,
    ...upkeep,
  };
}
