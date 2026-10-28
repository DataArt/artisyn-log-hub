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

// ── DD-23 constants ────────────────────────────────────────────────────────────────────────────

/** A bundle with fewer files is skipped by the share rules (session share, kb_flood). */
export const SHARE_MIN_BUNDLE_FILES = 10;
/** Session share strictly greater than this → `fix`. */
export const SESSION_SHARE_FIX = 0.25;
/** Session share strictly greater than this → `mess`. */
export const SESSION_SHARE_MESS = 0.5;
/** Fewer KB sessions than this → `not_enough_data`. */
export const REPO_MIN_KB_SESSIONS = 5;
/** A non-index file read in at least this share of KB sessions → `always_read`. */
export const ALWAYS_READ_SHARE = 0.8;
/** A tree reading strictly more than this share of a bundle's files is flooded. */
export const FLOOD_SHARE = 0.25;
/** Flooded ÷ bundle sessions at least this → `kb_flood` is `mess`. */
export const FLOOD_MESS_SESSION_SHARE = 0.2;
/** `coarse_article` only for files at least this big (UTF-8 bytes). */
export const COARSE_MIN_SIZE_BYTES = 51200;
/** `coarse_article` only for files read in at least this many KB sessions. */
export const COARSE_MIN_SESSIONS = 5;
/** Average bytes per read ÷ size strictly below this → `coarse_article`. */
export const COARSE_MAX_READ_RATIO = 0.1;
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

const SEVERITY_RANK: Record<OkfFinding['severity'], number> = {
  mess: 0,
  fix: 1,
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

function worstLevel(findings: readonly OkfFinding[]): 'ok' | 'fix' | 'mess' {
  if (findings.some((f) => f.severity === 'mess')) return 'mess';
  if (findings.length > 0) return 'fix';
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
 * Session verdict (DD-24). Per agent and per bundle with ≥ `SHARE_MIN_BUNDLE_FILES` files:
 * share = distinct bundle files the agent read/grepped ÷ bundle files, both without the files the
 * agent itself wrote; > `SESSION_SHARE_MESS` → `mess`, > `SESSION_SHARE_FIX` → `fix`.
 * No bundle and no KB access → `null`; no KB access → `kb_not_used`; no snapshot → the share rule
 * is skipped and the verdict carries `partial_data`.
 */
export function computeSessionVerdict(
  input: SessionVerdictInput,
): OkfVerdict | null {
  const { nodes, bundles } = input;
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
      if (articles.length < SHARE_MIN_BUNDLE_FILES) continue;
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
      if (share > SESSION_SHARE_MESS) severity = 'mess';
      else if (share > SESSION_SHARE_FIX) severity = 'fix';
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

/**
 * Repo verdict (DD-25, DD-38) over KB sessions — filtered root trees with ≥ 1 read/grep row in a
 * visible bundle (any read/grep row when `bundles` is `null`):
 * - `always_read` (fix): a non-index file read/grepped in ≥ `ALWAYS_READ_SHARE` of KB sessions.
 * - `kb_flood`: per bundle with ≥ `SHARE_MIN_BUNDLE_FILES` files, over snapshot-bound bundle
 *   sessions; a tree reading > `FLOOD_SHARE` of the files is flooded; any → fix, flooded ÷ bundle
 *   sessions ≥ `FLOOD_MESS_SESSION_SHARE` → mess.
 * - `coarse_article` (fix): a non-index file of ≥ `COARSE_MIN_SIZE_BYTES`, `read` in ≥
 *   `COARSE_MIN_SESSIONS` KB sessions, average bytes per read call ÷ size < `COARSE_MAX_READ_RATIO`.
 * Level: 0 KB sessions → `kb_not_used`; fewer than `REPO_MIN_KB_SESSIONS` → `not_enough_data`
 * (findings still listed); otherwise the worst severity, `ok` when none. Any snapshot-less KB
 * session adds `partial_data` with `{ withoutSnapshot, total }`.
 */
export function computeRepoVerdict(input: RepoVerdictInput): OkfVerdict {
  const { bundles } = input;
  const kbSessions = input.sessions.filter((s) =>
    s.rows.some((r) => isKbRead(r, bundles)),
  );
  const total = kbSessions.length;
  if (total === 0) {
    return { level: 'kb_not_used', qualifiers: [], findings: [] };
  }
  const withoutSnapshot = kbSessions.filter((s) => !s.hasSnapshot).length;
  const qualifiers: 'partial_data'[] =
    withoutSnapshot > 0 ? ['partial_data'] : [];
  const partialData =
    withoutSnapshot > 0 ? { withoutSnapshot, total } : undefined;

  const findings: OkfFinding[] = [];
  for (const bundle of bundles ?? []) {
    const nonIndex = bundleArticles(bundle);

    // always_read
    for (const file of nonIndex) {
      const sessions = kbSessions.filter((s) =>
        s.rows.some((r) => isReadLike(r.op) && r.pathKey === file.path),
      ).length;
      const share = sessions / total;
      if (sessions > 0 && share >= ALWAYS_READ_SHARE) {
        findings.push({
          rule: 'always_read',
          severity: 'fix',
          params: {
            bundle: bundle.root,
            path: file.path,
            sessions,
            kbSessions: total,
            share,
          },
          node: { bundle: bundle.root, path: file.path },
        });
      }
    }

    // kb_flood
    if (nonIndex.length >= SHARE_MIN_BUNDLE_FILES) {
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
        return share !== null && share > FLOOD_SHARE;
      }).length;
      if (flooded > 0) {
        const share = flooded / bundleSessions.length;
        findings.push({
          rule: 'kb_flood',
          severity: share >= FLOOD_MESS_SESSION_SHARE ? 'mess' : 'fix',
          params: {
            bundle: bundle.root,
            sessions: flooded,
            bundleSessions: bundleSessions.length,
            share,
          },
          node: { bundle: bundle.root },
        });
      }
    }

    // coarse_article
    for (const file of nonIndex) {
      if (file.size < COARSE_MIN_SIZE_BYTES) continue;
      let sessions = 0;
      let bytes = 0;
      let calls = 0;
      for (const s of kbSessions) {
        const readRows = s.rows.filter(
          (r) => r.op === 'read' && r.pathKey === file.path,
        );
        if (readRows.length === 0) continue;
        sessions += 1;
        for (const r of readRows) {
          bytes += r.bytes;
          calls += r.calls;
        }
      }
      if (sessions < COARSE_MIN_SESSIONS || calls === 0) continue;
      const avgReadBytes = bytes / calls;
      const ratio = avgReadBytes / file.size;
      if (ratio < COARSE_MAX_READ_RATIO) {
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
        });
      }
    }
  }

  const ordered = sortFindings(findings);
  const level =
    total < REPO_MIN_KB_SESSIONS ? 'not_enough_data' : worstLevel(ordered);
  return {
    level,
    qualifiers,
    ...(partialData ? { partialData } : {}),
    findings: ordered,
  };
}
