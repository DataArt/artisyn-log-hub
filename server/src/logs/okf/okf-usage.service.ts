/**
 * OKF usage — the read side of the session OKF tab and the repo OKF tab (FR-11..FR-17;
 * impl-plan DD-24..DD-32, DD-35, DD-38..DD-40).
 *
 * Both routes read `session_okf_access` rows (one row set per tree node, written by
 * `okf-access-writer.ts`) and the stored `okf_snapshots` bodies, apply the team fail-closed
 * filter (DD-30, `applyOkfTeamFilter`) first when the caller looks through a team, and only then
 * build the verdict (`okf-verdict.ts`) and the tree (`okf-usage-tree.ts`).
 *
 * KB paths: with a snapshot, a row counts when its path lies under a bundle root of the snapshot
 * (a file the snapshot does not list stays visible with `inSnapshot: false`); without any snapshot
 * every `.md` file row counts (one `bundle: null` group), plus the folder rows on the folders of
 * those files.
 *
 * 2026-11-03 value signals (okf-view-kb-value): both routes also load the nodes'
 * `session_okf_pointer` / `session_okf_event` rows (team-filtered by DD-24), plus the all-time
 * (period-free, same scope) pointer aggregates and touched paths for the article area (DD-12,
 * DD-28), and compute the value signals with `okf-value-signals.ts` under the thresholds the
 * controller resolved (DD-20). Upkeep pairs (FR-5, DD-15) leave every read total.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import {
  loadScopedRootSessions,
  num,
  sessionIdsArray,
  type AnalyticsScope,
  type ScopedRootSession,
} from '../analytics/scoped-sessions.sql';
import { descendantSessionsCte } from '../session-tree.sql';
import { maskFirstPrompt, type TeamScope } from '../team-scope';
import { OKF_EXTRACT_VERSION } from './okf-constants';
import {
  normaliseSnapshot,
  resolveRootOkfSnapshotId,
  resolveRootSessionDbId,
  type OkfSnapshotBody,
  type OkfSnapshotBundle,
} from './okf-snapshot';
import { cleanTaskText } from './okf-task-context';
import {
  DEFAULT_OKF_THRESHOLDS,
  type ResolvedOkfThresholds,
} from './okf-thresholds';
import {
  applyOkfTeamFilter,
  buildOkfTree,
  isFolderKey,
  isUnderPrefix,
  rootFolderKey,
  rootPrefix,
  treeFiles,
  type OkfTreeArticleSignals,
  type OkfTreeContribution,
  type OkfTreeFileFlags,
  type OkfTreeGroupSpec,
} from './okf-usage-tree';
import type {
  OkfAgent,
  OkfBundleSummary,
  OkfFinding,
  OkfFindingRule,
  OkfOp,
  OkfReadTopItem,
  OkfRepoUpkeepItem,
  OkfSessionUpkeepItem,
  OkfShareBin,
  OkfTreeNode,
  OkfVerdict,
  RepoOkfArticleResponse,
  RepoOkfUsageResponse,
  SessionOkfUsageResponse,
} from './okf-usage.types';
import {
  computeArticleSignals,
  type OkfSignalAllTimePointerRow,
  type OkfSignalEventRow,
  type OkfSignalNodeRead,
  type OkfSignalPointerRow,
  type OkfSignalUpkeepPair,
  type OkfValueSignalsResult,
} from './okf-value-signals';
import {
  HOT_FILES_TOP_N,
  READ_TOP_N,
  TASK_HEAD_MAX_CHARS,
  agentEntry,
  bundleArticles,
  bundleOfPath,
  computeRepoVerdict,
  computeSessionVerdict,
  fileShare,
  median,
  readFilesOfBundle,
  shareBin,
  startedFromIndex,
  upkeepPredicate,
  withoutUpkeep,
  type OkfVerdictFileHash,
  type OkfVerdictRow,
} from './okf-verdict';

/** Key of the synthetic group: "No longer in KB" (repo) / "no snapshot" (both routes). */
const NULL_GROUP_KEY = '\0none';

const ALL_SHARE_BINS: readonly OkfShareBin[] = [
  '0-10',
  '10-25',
  '25-50',
  '50+',
];

/** The period-free bounds of the all-time scope (DD-28). */
const ALL_TIME_START = new Date('1970-01-01T00:00:00.000Z');
const ALL_TIME_END = new Date('9999-12-31T23:59:59.999Z');

/** The thresholds the controller resolved for the view (DD-20). */
export interface OkfUsageThresholds {
  values: ResolvedOkfThresholds;
  /** Fields that differ from the defaults. */
  custom: string[];
}

export interface SessionOkfUsageOptions {
  /** `true` in a team view (`teamId` given): DD-30 fail-closed filter. */
  teamFilter: boolean;
  /**
   * Prompt masking for a `team-no-prompts` caller (`maskFirstPrompt`): another member's task
   * heads come back empty. Omitted in the personal view.
   */
  promptMask?: { scope: TeamScope; requesterUserId: number };
  /** Thresholds in force (DD-20); omitted = defaults, no custom fields. */
  thresholds?: OkfUsageThresholds;
  /**
   * The all-time scope of the article area (DD-12, DD-28): the repo ids and scope whose root
   * trees, without the period, feed the area and the FR-13 `notFound` test. Omitted = this tree
   * only.
   */
  areaScope?: { repoIds: number[]; scope: AnalyticsScope };
}

export interface RepoOkfUsageOptions {
  /** Thresholds in force (DD-20); omitted = defaults, no custom fields. */
  thresholds?: OkfUsageThresholds;
  /** Same authority as `recompute-all-sessions` (FR-11 banner link). */
  canRecompute?: boolean;
}

/** The pointer / event rows of one tree node, plus its extraction marker (DD-11). */
export interface OkfNodeSignalRows {
  pointers: OkfSignalPointerRow[];
  events: OkfSignalEventRow[];
  /** `sessions.okf_extract_version`. */
  extractVersion: number | null;
  /** `sessions.okf_events_truncated`. */
  truncated: boolean;
}

/** All-time (period-free) rows of a scope (DD-12, DD-28). */
export interface OkfAllTimeSignalRows {
  pointers: OkfSignalAllTimePointerRow[];
  touched: Set<string>;
}

/** One tree node with its stored rows. */
interface NodeRows {
  /** `sessions.id`. */
  id: number;
  /** `sessions.session_id`. */
  sessionId: string;
  startTime: number | null;
  firstPrompt: string | null;
  userId: number | null;
  rows: OkfVerdictRow[];
  pointers: OkfSignalPointerRow[];
  events: OkfSignalEventRow[];
}

/** A tree node as the value signals see it (KB rows only). */
interface SignalNode {
  id: number;
  rows: readonly OkfVerdictRow[];
  pointers: readonly OkfSignalPointerRow[];
  events: readonly OkfSignalEventRow[];
}

interface AccessSqlRow {
  session_id: string | number;
  path_key: string;
  op: OkfOp;
  after_own_edit: boolean;
  bytes: string | number;
  calls: string | number;
  seq: string | number;
  ranged_calls?: string | number | null;
  ranged_bytes?: string | number | null;
  /** NULL for a node extracted before `OKF_EXTRACT_VERSION` (DD-6 needs the hit data). */
  search_hits?: string | number | null;
}

function toRow(r: AccessSqlRow): OkfVerdictRow {
  const row: OkfVerdictRow = {
    pathKey: r.path_key,
    op: r.op,
    afterOwnEdit: r.after_own_edit === true,
    bytes: num(r.bytes),
    calls: num(r.calls),
    seq: num(r.seq),
    nodeId: Number(r.session_id),
  };
  const rangedCalls = num(r.ranged_calls);
  if (rangedCalls > 0) {
    row.rangedCalls = rangedCalls;
    row.rangedBytes = num(r.ranged_bytes);
  }
  if (r.search_hits !== null && r.search_hits !== undefined) {
    row.searchHits = num(r.search_hits);
  }
  return row;
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isKbFileRow(row: OkfVerdictRow): boolean {
  return !isFolderKey(row.pathKey) && row.pathKey.toLowerCase().endsWith('.md');
}

function isReadLike(op: OkfOp): boolean {
  return op === 'read' || op === 'grep';
}

function isMarkdown(path: string): boolean {
  return !isFolderKey(path) && path.toLowerCase().endsWith('.md');
}

/**
 * Snapshot-less KB rows: every `.md` file row, plus the folder rows on a folder of one of
 * those files (so a bare `ls` elsewhere in the repo stays out).
 */
function snapshotLessKbRows(rows: readonly OkfVerdictRow[]): OkfVerdictRow[] {
  const files = rows.filter(isKbFileRow);
  return rows.filter((r) => {
    if (!isFolderKey(r.pathKey)) return isKbFileRow(r);
    const prefix = r.pathKey === '/' ? '' : r.pathKey;
    return files.some((f) => isUnderPrefix(f.pathKey, prefix));
  });
}

/** Rows under a bundle root of `bundles` (files, listed or not, and folders). */
function bundleRows(
  rows: readonly OkfVerdictRow[],
  bundles: readonly OkfSnapshotBundle[],
): OkfVerdictRow[] {
  return rows.filter((r) => bundleOfPath(r.pathKey, bundles) !== null);
}

function groupSpecOfBundle(b: OkfSnapshotBundle): OkfTreeGroupSpec {
  return {
    key: b.root,
    bundle: b.root,
    prefix: rootPrefix(b.root),
    path: rootFolderKey(b.root),
    inSnapshot: true,
    files: b.files,
  };
}

const NULL_GROUP_SPEC: OkfTreeGroupSpec = {
  key: NULL_GROUP_KEY,
  bundle: null,
  prefix: '',
  path: '',
  inSnapshot: false,
  files: [],
};

/** Distinct articles of the bundle (index excluded, `bundleArticles`) read/grepped in `rows`. */
function listedFilesRead(
  rows: readonly OkfVerdictRow[],
  bundle: OkfSnapshotBundle,
): Set<string> {
  return readFilesOfBundle(rows, bundle);
}

/** Share denominator: the bundle's articles, its `index.md` not counted. */
function articleCount(bundle: OkfSnapshotBundle): number {
  return bundleArticles(bundle).length;
}

function readBytesOf(rows: readonly OkfVerdictRow[]): number {
  let total = 0;
  for (const r of rows) if (isReadLike(r.op)) total += r.bytes;
  return total;
}

function cutTaskHead(text: string | null): string {
  if (text === null) return '';
  const cleaned = cleanTaskText(text);
  if (cleaned === null) return '';
  return cleaned.length > TASK_HEAD_MAX_CHARS
    ? `${cleaned.slice(0, TASK_HEAD_MAX_CHARS)}…`
    : cleaned;
}

/** Per path: summed read/grep bytes and calls. */
function fileReadTotals(
  rows: readonly OkfVerdictRow[],
): Map<string, { bytes: number; calls: number; ownEditBytes: number }> {
  const out = new Map<
    string,
    { bytes: number; calls: number; ownEditBytes: number }
  >();
  for (const r of rows) {
    if (!isReadLike(r.op) || isFolderKey(r.pathKey)) continue;
    const t = out.get(r.pathKey) ?? { bytes: 0, calls: 0, ownEditBytes: 0 };
    t.bytes += r.bytes;
    t.calls += r.calls;
    if (r.afterOwnEdit) t.ownEditBytes += r.bytes;
    out.set(r.pathKey, t);
  }
  return out;
}

/** File path → hash / size of a snapshot body (DD-18a). */
function snapshotFileMap(
  body: OkfSnapshotBody | null,
): Map<string, OkfVerdictFileHash> {
  const out = new Map<string, OkfVerdictFileHash>();
  if (body === null) return out;
  for (const b of body.bundles) {
    for (const f of b.files) {
      out.set(f.path, { hash: f.hash === '' ? null : f.hash, size: f.size });
    }
  }
  return out;
}

/** The DD-24 article filter of the all-time rows in a team view: the visible bundle files. */
function visibleArticleSet(
  bundles: readonly OkfSnapshotBundle[] | null,
): Set<string> {
  return new Set((bundles ?? []).flatMap((b) => b.files.map((f) => f.path)));
}

/** A KB article path of the view (DD-10): a `.md` file under a visible bundle, or any `.md`. */
function isViewArticle(
  path: string,
  bundles: readonly OkfSnapshotBundle[] | null,
): boolean {
  if (!isMarkdown(path)) return false;
  return bundles === null || bundleOfPath(path, bundles) !== null;
}

/**
 * Value signals of the view (DD-12..DD-15) over the KB nodes. Reads are the `read` rows of
 * articles; upkeep pairs are the articles a node wrote.
 */
function computeViewSignals(
  nodes: readonly SignalNode[],
  allTime: OkfAllTimeSignalRows,
  latestFiles: ReadonlyMap<string, OkfVerdictFileHash> | undefined,
  thresholds: ResolvedOkfThresholds,
  bundles: readonly OkfSnapshotBundle[] | null,
): OkfValueSignalsResult {
  const reads: OkfSignalNodeRead[] = [];
  const upkeep: OkfSignalUpkeepPair[] = [];
  const pointers: OkfSignalPointerRow[] = [];
  const events: OkfSignalEventRow[] = [];
  for (const n of nodes) {
    const readSeen = new Set<string>();
    const writeSeen = new Set<string>();
    for (const r of n.rows) {
      if (!isViewArticle(r.pathKey, bundles)) continue;
      if (r.op === 'read' && !readSeen.has(r.pathKey)) {
        readSeen.add(r.pathKey);
        reads.push({ nodeId: n.id, articlePath: r.pathKey });
      } else if (r.op === 'write' && !writeSeen.has(r.pathKey)) {
        writeSeen.add(r.pathKey);
        upkeep.push({ nodeId: n.id, articlePath: r.pathKey });
      }
    }
    for (const p of n.pointers) {
      if (isViewArticle(p.articlePath, bundles)) pointers.push(p);
    }
    events.push(...n.events);
  }
  return computeArticleSignals({
    pointers,
    allTimePointers: allTime.pointers.filter((p) =>
      isViewArticle(p.articlePath, bundles),
    ),
    events,
    allTimeTouchedPaths: allTime.touched,
    reads,
    upkeep,
    latestFiles,
    thresholds,
    bundleOf: (path) => bundleOfPath(path, bundles)?.root ?? null,
  });
}

/** All-time rows built from the view's own nodes (no `areaScope`). */
function allTimeFromNodes(nodes: readonly SignalNode[]): OkfAllTimeSignalRows {
  const pointers = new Map<string, OkfSignalAllTimePointerRow>();
  const touched = new Set<string>();
  for (const n of nodes) {
    for (const p of n.pointers) {
      const key = [
        p.articlePath,
        p.articleHash ?? '\0',
        p.pointer,
        p.isNew,
        p.partial,
      ].join('\0');
      if (!pointers.has(key)) {
        pointers.set(key, {
          articlePath: p.articlePath,
          articleHash: p.articleHash,
          pointer: p.pointer,
          isNew: p.isNew,
          partial: p.partial,
          lastReadAt: null,
        });
      }
    }
    for (const e of n.events) touched.add(e.path);
    for (const r of n.rows) touched.add(r.pathKey);
  }
  return { pointers: [...pointers.values()], touched };
}

/** The per-article signal fields of the tree's file nodes. */
function treeArticleSignals(
  signals: OkfValueSignalsResult,
): Map<string, OkfTreeArticleSignals> {
  const out = new Map<string, OkfTreeArticleSignals>();
  for (const [path, a] of signals.articles) {
    out.set(path, {
      yield: a.yield,
      searchedAfter:
        a.searchedAfter === null
          ? null
          : {
              agents: a.searchedAfter.agents,
              searches: a.searchedAfter.searches,
            },
      routingMiss:
        a.routingMiss === null
          ? null
          : {
              agents: a.routingMiss.agents,
              areaAgents: a.routingMiss.areaAgents,
            },
      routingMissFinding: a.findings.some((f) => f.rule === 'routing_miss'),
      deadPointers: a.deadPointers,
      catalogFiles: a.catalog?.files ?? null,
    });
  }
  return out;
}

const SEVERITY_RANK: Record<OkfFinding['severity'], number> = {
  mess: 0,
  fix: 1,
  info: 2,
};

/**
 * The repo verdict with the value-signal findings merged in: worst first (stable), and an
 * `ok` / `fix` / `mess` level re-judged over all findings (`info` and `removed` never count).
 */
function mergeSignalFindings(
  verdict: OkfVerdict,
  signalFindings: readonly OkfFinding[],
): OkfVerdict {
  if (signalFindings.length === 0) return verdict;
  const findings = [...verdict.findings, ...signalFindings]
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i,
    )
    .map((x) => x.f);
  let level = verdict.level;
  if (level === 'ok' || level === 'fix' || level === 'mess') {
    const counted = findings.filter(
      (f) => f.severity !== 'info' && f.removed !== true,
    );
    level = counted.some((f) => f.severity === 'mess')
      ? 'mess'
      : counted.length > 0
        ? 'fix'
        : 'ok';
  }
  return { ...verdict, level, findings };
}

/** FR-10 per-file tree flags from the findings (DD-17). */
function fileFlagsOf(
  findings: readonly OkfFinding[],
  latestFiles: ReadonlyMap<string, OkfVerdictFileHash> | undefined,
): Map<string, OkfTreeFileFlags> {
  const out = new Map<string, OkfTreeFileFlags>();
  for (const f of findings) {
    const path = f.node.path;
    if (path === undefined) continue;
    if (f.stale === undefined && f.removed !== true) continue;
    const flags = out.get(path) ?? {};
    if (f.stale !== undefined && flags.stale === undefined) {
      flags.stale = {
        size: latestFiles?.get(path)?.size ?? null,
        oldSize: f.stale.oldSize,
      };
    }
    if (f.removed === true) flags.removed = true;
    out.set(path, flags);
  }
  return out;
}

/** One filtered root tree on the repo route. */
interface RepoTreeNode {
  /** `sessions.id` of the tree node. */
  id: number;
  startTime: number | null;
  rows: OkfVerdictRow[];
  pointers: OkfSignalPointerRow[];
  events: OkfSignalEventRow[];
}

interface RepoTree {
  root: ScopedRootSession;
  snapshot: OkfSnapshotBody | null;
  nodes: RepoTreeNode[];
}

/**
 * The tree's first non-write access to any of the bundles (earliest node `startTime`, then
 * `seq`), and whether it was that bundle's `index.md`. `null` when none.
 */
function firstAccessWasIndex(
  nodes: readonly { startTime: number | null; rows: OkfVerdictRow[] }[],
  bundles: readonly OkfSnapshotBundle[],
): boolean | null {
  const ordered = [...nodes].sort(
    (a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity),
  );
  for (const node of ordered) {
    let first: OkfVerdictRow | null = null;
    for (const r of node.rows) {
      if (r.op === 'write' || bundleOfPath(r.pathKey, bundles) === null) {
        continue;
      }
      if (first === null || (r.seq ?? Infinity) < (first.seq ?? Infinity)) {
        first = r;
      }
    }
    if (first !== null) {
      return first.pathKey === bundleOfPath(first.pathKey, bundles)!.index;
    }
  }
  return null;
}

/** Article drill-down: how many "same finding elsewhere" rows are listed. */
const SAME_FINDING_TOP_N = 5;

/** The headline numeric param of a per-file finding (sorts "same finding elsewhere"). */
const FINDING_VALUE_PARAM: Partial<Record<OkfFindingRule, string>> = {
  always_read: 'sessions',
  coarse_article: 'size',
  routing_miss: 'agents',
  searched_after: 'searches',
  dead_pointers: 'dead',
  catalog: 'files',
};

function findingValue(f: OkfFinding): number {
  const key = FINDING_VALUE_PARAM[f.rule];
  const v = key === undefined ? undefined : f.params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const first = Object.values(f.params).find(
    (p): p is number => typeof p === 'number' && Number.isFinite(p),
  );
  return first ?? 0;
}

/** The `found: false` article response (DD-23). */
function emptyArticle(path: string): RepoOkfArticleResponse {
  return {
    found: false,
    path,
    bundle: null,
    size: null,
    oldSize: null,
    hashStatus: 'unknown',
    areaFromOlderVersion: false,
    reads: { whole: 0, section: 0, upkeep: 0, partial: 0 },
    yield: null,
    pointers: [],
    area: [],
    catalog: null,
    routingMiss: null,
    searchedAfter: null,
    findings: [],
    sameFindingElsewhere: [],
  };
}

function defaultThresholds(): OkfUsageThresholds {
  return {
    values: {
      ...DEFAULT_OKF_THRESHOLDS,
      codeRoots: [...DEFAULT_OKF_THRESHOLDS.codeRoots],
    },
    custom: [],
  };
}

/** A root tree with its rows classified for the repo view. */
interface Classified {
  tree: RepoTree;
  /** Rows in a visible bundle (listed or not) — the verdict input. */
  kbRows: OkfVerdictRow[];
  /** `kbRows` without the FR-5 upkeep reads. */
  usedRows: OkfVerdictRow[];
  contributions: OkfTreeContribution[];
  isKb: boolean;
  kbNodes: RepoTreeNode[];
}

/** What `buildRepoView` hands the repo tab and the article drill-down. */
interface RepoView {
  roots: ScopedRootSession[];
  signalByRoot: Map<number, Map<number, OkfNodeSignalRows>>;
  latest: { body: OkfSnapshotBody; createdAt: string } | null;
  latestRoot: ScopedRootSession | undefined;
  allBundles: OkfSnapshotBundle[] | null;
  bundles: OkfSnapshotBundle[] | null;
  classified: Classified[];
  kb: Classified[];
  latestFiles: Map<string, OkfVerdictFileHash> | undefined;
  sessionFiles: Map<number, Map<string, OkfVerdictFileHash>>;
  verdict: OkfVerdict;
  signals: OkfValueSignalsResult;
  upkeepOnlySessions: number;
}

@Injectable()
export class OkfUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * `sessions.id` of a non-deleted session the caller may see through `repoIds`, or `null`
   * (same lookup as the change-surface session routes).
   */
  async findSessionDbId(
    repoIds: number[],
    sessionId: string,
    visibleUserIds: number[] | null,
  ): Promise<number | null> {
    if (repoIds.length === 0) return null;
    const repoIdsLiteral = `{${repoIds.join(',')}}`;
    const ownerFilter =
      visibleUserIds === null
        ? sql``
        : sql`AND l.user_id = ANY(${`{${visibleUserIds.join(',')}}`}::int[])`;
    const result = await this.db.execute(sql`
      SELECT s.id
      FROM sessions s
      JOIN logs l ON l.session_id = s.id
      JOIN log_repositories lr ON lr.log_id = l.id
      WHERE s.session_id = ${sessionId}
        AND s.deleted = false
        AND lr.repo_id = ANY(${repoIdsLiteral}::int[])
        ${ownerFilter}
      LIMIT 1
    `);
    const row = result.rows[0] as { id: string | number } | undefined;
    return row === undefined ? null : Number(row.id);
  }

  /** The empty session response (unknown / invisible session). */
  emptySessionUsage(): SessionOkfUsageResponse {
    return {
      verdict: null,
      hasSnapshot: false,
      readTop: [],
      bundles: [],
      tree: [],
      agents: [],
    };
  }

  /**
   * One session tree's OKF usage (the session tab): the session plus all its sub-agent nodes,
   * judged against the tree root's snapshot.
   */
  async getSessionOkfUsage(
    sessionDbId: number,
    options: SessionOkfUsageOptions,
  ): Promise<SessionOkfUsageResponse> {
    const thresholds = options.thresholds ?? defaultThresholds();
    const [nodes, snapshot] = await Promise.all([
      this.loadTreeNodes(sessionDbId),
      this.loadRootSnapshot(sessionDbId),
    ]);
    const signalRows = await this.loadSignalRowsForNodes(
      nodes.map((n) => n.id),
    );
    for (const n of nodes) {
      const s = signalRows.get(n.id);
      if (s === undefined) continue;
      n.pointers = s.pointers;
      n.events = s.events;
    }

    // DD-30 / DD-24 first, then everything else.
    let visibleNodes = nodes;
    let bundles: OkfSnapshotBundle[] | null = snapshot?.bundles ?? null;
    if (options.teamFilter) {
      const filtered = applyOkfTeamFilter([{ snapshot, nodes }], bundles);
      visibleNodes = filtered.trees[0].nodes;
      bundles = filtered.bundles;
    }

    // KB rows per node.
    const kbNodes = visibleNodes.map((n) => ({
      ...n,
      rows:
        bundles === null
          ? snapshotLessKbRows(n.rows)
          : bundleRows(n.rows, bundles),
    }));
    // FR-5 (DD-15): per node, its upkeep read rows (the node also wrote the article).
    const upkeepOf = new Map(
      kbNodes.map((n) => [n.id, upkeepPredicate(n.rows)] as const),
    );
    const isUpkeepRow = (nodeId: number, row: OkfVerdictRow): boolean =>
      upkeepOf.get(nodeId)?.(row) ?? false;

    const verdict = computeSessionVerdict(
      {
        nodes: kbNodes.map((n) => ({ agentId: n.sessionId, rows: n.rows })),
        bundles,
      },
      thresholds.values,
    );

    // Value signals (DD-12..DD-15).
    const latestFiles =
      snapshot === null ? undefined : snapshotFileMap(snapshot);
    const signalNodes: SignalNode[] = kbNodes.map((n) => ({
      id: n.id,
      rows: n.rows,
      pointers: n.pointers,
      events: n.events,
    }));
    const allTime =
      options.areaScope === undefined
        ? allTimeFromNodes(signalNodes)
        : await this.loadAllTimeSignalRows(
            options.areaScope.repoIds,
            options.areaScope.scope,
            options.teamFilter ? visibleArticleSet(bundles) : null,
          );
    const signals = computeViewSignals(
      signalNodes,
      allTime,
      latestFiles,
      thresholds.values,
      bundles,
    );

    // Bundle summaries + entry points (upkeep reads excluded).
    const usedNodes = kbNodes.map((n) => ({
      ...n,
      rows: withoutUpkeep(n.rows),
    }));
    const entryPoints = new Set<string>();
    const summaries: OkfBundleSummary[] = (bundles ?? []).map((b) => {
      const allRows = usedNodes.flatMap((n) =>
        n.rows.filter((r) => bundleOfPath(r.pathKey, bundles) === b),
      );
      const filesRead = listedFilesRead(allRows, b).size;
      const fromIndex = startedFromIndex(usedNodes, b, bundles ?? [b]);
      if (fromIndex === true) entryPoints.add(b.index);
      return {
        root: b.root,
        index: b.index,
        ignored: b.ignored,
        files: articleCount(b),
        filesRead,
        share: fileShare(filesRead, articleCount(b)),
        readBytes: readBytesOf(allRows),
        startedFromIndex: fromIndex,
        sessionsStartedFromIndex: null,
      };
    });

    // Tree.
    const groups: OkfTreeGroupSpec[] =
      bundles === null ? [NULL_GROUP_SPEC] : bundles.map(groupSpecOfBundle);
    const contributions: OkfTreeContribution[] = [];
    for (const n of kbNodes) {
      for (const row of n.rows) {
        const b = bundles === null ? null : bundleOfPath(row.pathKey, bundles);
        contributions.push({
          groupKey: b === null ? NULL_GROUP_KEY : b.root,
          unit: n.id,
          row,
          upkeep: isUpkeepRow(n.id, row),
        });
      }
    }
    const tree = buildOkfTree(groups, contributions, {
      entryPoints,
      articleSignals: treeArticleSignals(signals),
    }).filter((n) => n.bundle !== null || (n.children?.length ?? 0) > 0);

    // Read top.
    const readTop: OkfReadTopItem[] = treeFiles(tree)
      .filter((f) => f.readCalls > 0)
      .sort((a, b) => b.readBytes - a.readBytes || a.path.localeCompare(b.path))
      .slice(0, READ_TOP_N)
      .map((f) => ({
        bundle: f.bundle,
        path: f.path,
        readBytes: f.readBytes,
        ownEdit: f.ownEditReadBytes > 0,
      }));

    // FR-5 upkeep line.
    const upkeepTotals = new Map<string, OkfSessionUpkeepItem>();
    for (const n of kbNodes) {
      for (const row of n.rows) {
        if (isFolderKey(row.pathKey) || !isUpkeepRow(n.id, row)) continue;
        const item = upkeepTotals.get(row.pathKey) ?? {
          path: row.pathKey,
          bundle:
            bundles === null
              ? null
              : (bundleOfPath(row.pathKey, bundles)?.root ?? null),
          readBytes: 0,
          readCalls: 0,
        };
        item.readBytes += row.bytes;
        item.readCalls += row.calls;
        upkeepTotals.set(row.pathKey, item);
      }
    }
    const upkeep = [...upkeepTotals.values()].sort(
      (a, b) => b.readBytes - a.readBytes || a.path.localeCompare(b.path),
    );

    // Agents: every node with a KB row or a routing miss; the opened (root) node always.
    const agents: OkfAgent[] = [];
    for (const n of kbNodes) {
      const ns = signals.nodes.get(n.id);
      const routingMisses = ns?.routingMisses ?? [];
      if (
        n.rows.length === 0 &&
        n.id !== sessionDbId &&
        routingMisses.length === 0
      ) {
        continue;
      }
      const isUpkeep = upkeepOf.get(n.id);
      const totals = fileReadTotals(
        n.rows.filter((r) => !(isUpkeep?.(r) ?? false)),
      );
      let kbReads = 0;
      let kbReadBytes = 0;
      for (const t of totals.values()) {
        kbReads += t.calls;
        kbReadBytes += t.bytes;
      }
      const files = [...totals.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
        .map(([path]) => path);
      const prompt = options.promptMask
        ? maskFirstPrompt(
            options.promptMask.scope,
            options.promptMask.requesterUserId,
            n.userId,
            n.firstPrompt,
          )
        : n.firstPrompt;
      const upkeepArticles = [
        ...new Set(
          n.rows
            .filter((r) => !isFolderKey(r.pathKey) && (isUpkeep?.(r) ?? false))
            .map((r) => r.pathKey),
        ),
      ].sort();
      const promptNamedPaths = new Set(
        n.pointers
          .filter((p) => !p.isNew && !p.partial && p.pointer !== '')
          .map((p) => p.pointer),
      ).size;
      agents.push({
        id: n.sessionId,
        taskHead: cutTaskHead(prompt),
        entry: agentEntry(n.rows, bundles),
        kbReads,
        kbReadBytes,
        files,
        pointers: ns?.pointers.map((p) => ({ ...p })) ?? [],
        promptNamedPaths,
        routingMisses: routingMisses.map((m) => ({
          article: m.article,
          searches: m.searches,
          patterns: [...m.patterns],
        })),
        upkeepArticles,
        searches: ns?.searches ?? 0,
        yield: ns?.yield ?? null,
      });
    }

    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const eventsTruncated = [...signalRows.entries()].some(
      ([id, s]) => visibleIds.has(id) && s.truncated,
    );

    return {
      verdict,
      hasSnapshot: snapshot !== null,
      readTop,
      bundles: summaries,
      tree,
      agents,
      thresholds: { custom: [...thresholds.custom] },
      upkeep,
      signals: {
        readsWithNewPointers: signals.summary.readsWithNewPointers,
        readsFollowed: signals.summary.readsFollowed,
        routingMissArticles: signals.summary.routingMissArticles,
        searchedAfterPairs: signals.summary.searchedAfterPairs,
        deadPointers: signals.summary.deadPointers,
      },
      eventsTruncated,
    };
  }

  /**
   * The repo view shared by the repo tab and the article drill-down: the scoped roots, their
   * team-filtered trees classified into KB rows, the verdict with the value-signal findings
   * merged in, and the value signals themselves.
   */
  private async buildRepoView(
    repoIds: number[],
    scope: AnalyticsScope,
    bundle: string | undefined,
    thresholds: OkfUsageThresholds,
  ): Promise<RepoView> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    const teamFilter = scope.teamId !== undefined;

    const [nodesByRoot, snapshotByRoot, signalByRoot] = await Promise.all([
      this.loadRepoTreeRows(roots),
      this.loadRootSnapshots(roots),
      this.loadRepoSignalRows(roots),
    ]);

    // DD-29: latest snapshot = bound snapshot of the newest root in the filtered set.
    const newestFirst = [...roots].sort(
      (a, b) => (toMs(b.startTime) ?? 0) - (toMs(a.startTime) ?? 0),
    );
    const latestRoot = newestFirst.find((r) =>
      snapshotByRoot.has(r.sessionRowId),
    );
    const latest =
      latestRoot === undefined
        ? null
        : snapshotByRoot.get(latestRoot.sessionRowId)!;

    let trees: RepoTree[] = roots.map((root) => {
      const accessNodes =
        nodesByRoot.get(root.sessionRowId) ??
        new Map<number, { startTime: number | null; rows: OkfVerdictRow[] }>();
      const signalNodes =
        signalByRoot.get(root.sessionRowId) ??
        new Map<number, OkfNodeSignalRows>();
      const ids = new Set([...accessNodes.keys(), ...signalNodes.keys()]);
      const nodes: RepoTreeNode[] = [];
      for (const id of ids) {
        const a = accessNodes.get(id);
        const s = signalNodes.get(id);
        if (
          a === undefined &&
          (s === undefined ||
            (s.pointers.length === 0 && s.events.length === 0))
        ) {
          continue;
        }
        nodes.push({
          id,
          startTime: a?.startTime ?? null,
          rows: a?.rows ?? [],
          pointers: s?.pointers ?? [],
          events: s?.events ?? [],
        });
      }
      return {
        root,
        snapshot: snapshotByRoot.get(root.sessionRowId)?.body ?? null,
        nodes,
      };
    });
    let allBundles: OkfSnapshotBundle[] | null = latest?.body.bundles ?? null;

    if (teamFilter) {
      const filtered = applyOkfTeamFilter(trees, allBundles);
      trees = filtered.trees;
      allBundles = filtered.bundles;
    }

    const selected =
      allBundles !== null && bundle !== undefined
        ? allBundles.find((b) => b.root === bundle)
        : undefined;
    const bundles: OkfSnapshotBundle[] | null =
      allBundles === null
        ? null
        : selected !== undefined
          ? [selected]
          : allBundles;

    // Classify each tree's rows: bundle group, gone group, or not KB.
    const classified: Classified[] = trees.map((tree) => {
      const contributions: OkfTreeContribution[] = [];
      const kbNodes: RepoTreeNode[] = [];
      const kbRows: OkfVerdictRow[] = [];
      // FR-5 (DD-15): rows carry their node id, so the predicate is per (node, path).
      const isUpkeep = upkeepPredicate(tree.nodes.flatMap((n) => n.rows));
      for (const node of tree.nodes) {
        const nodeKb: OkfVerdictRow[] = [];
        const rows =
          bundles === null ? snapshotLessKbRows(node.rows) : node.rows;
        for (const row of rows) {
          const upkeep = isUpkeep(row);
          if (bundles === null) {
            nodeKb.push(row);
            contributions.push({
              groupKey: NULL_GROUP_KEY,
              unit: tree.root.sessionRowId,
              row,
              upkeep,
            });
            continue;
          }
          const unit = tree.root.sessionRowId;
          const b = bundleOfPath(row.pathKey, bundles);
          if (b !== null) {
            // Under a visible bundle root: KB. A file the latest snapshot no longer lists goes
            // to the "No longer in KB" group.
            nodeKb.push(row);
            const listed =
              isFolderKey(row.pathKey) ||
              b.files.some((f) => f.path === row.pathKey);
            contributions.push({
              groupKey: listed ? b.root : NULL_GROUP_KEY,
              unit,
              row,
              upkeep,
            });
            continue;
          }
          if (isFolderKey(row.pathKey) || tree.snapshot === null) continue;
          // Outside every latest bundle: "No longer in KB" only when the tree's own snapshot
          // listed it in a bundle the latest snapshot no longer has (and, with a bundle
          // filter, only for that bundle's root).
          if (
            allBundles !== null &&
            bundleOfPath(row.pathKey, allBundles) !== null
          ) {
            continue;
          }
          const own = tree.snapshot.bundles.find((ob) =>
            ob.files.some((f) => f.path === row.pathKey),
          );
          if (own === undefined) continue;
          if (selected !== undefined && own.root !== selected.root) continue;
          contributions.push({ groupKey: NULL_GROUP_KEY, unit, row, upkeep });
        }
        kbNodes.push({ ...node, rows: nodeKb });
        kbRows.push(...nodeKb);
      }
      const usedRows = kbRows.filter((r) => !isUpkeep(r));
      const isKb = usedRows.some(
        (r) =>
          isReadLike(r.op) &&
          (bundles === null || bundleOfPath(r.pathKey, bundles) !== null),
      );
      return { tree, kbRows, usedRows, contributions, isKb, kbNodes };
    });

    const kb = classified.filter((c) => c.isKb);

    // FR-10 (DD-18a): per-root and latest file hashes.
    const latestFiles =
      latest === null ? undefined : snapshotFileMap(latest.body);
    const sessionFiles = new Map<number, Map<string, OkfVerdictFileHash>>();
    for (const c of classified) {
      if (c.tree.snapshot !== null) {
        sessionFiles.set(
          c.tree.root.sessionRowId,
          snapshotFileMap(c.tree.snapshot),
        );
      }
    }

    const { upkeepOnlySessions, ...baseVerdict } = computeRepoVerdict(
      {
        sessions: classified.map((c) => ({
          sessionId: c.tree.root.sessionRowId,
          hasSnapshot: c.tree.snapshot !== null,
          rows: c.kbRows,
        })),
        bundles,
        ...(latestFiles !== undefined ? { sessionFiles, latestFiles } : {}),
      },
      thresholds.values,
    );

    // Value signals (DD-12..DD-15) over the period trees.
    const signalNodes: SignalNode[] = classified.flatMap((c) =>
      c.kbNodes.map((n) => ({
        id: n.id,
        rows: n.rows,
        pointers: n.pointers,
        events: n.events,
      })),
    );
    const allTime = await this.loadAllTimeSignalRows(
      repoIds,
      scope,
      teamFilter ? visibleArticleSet(bundles) : null,
    );
    const signals = computeViewSignals(
      signalNodes,
      allTime,
      latestFiles,
      thresholds.values,
      bundles,
    );
    const verdict = mergeSignalFindings(baseVerdict, signals.findings);

    return {
      roots,
      signalByRoot,
      latest,
      latestRoot,
      allBundles,
      bundles,
      classified,
      kb,
      latestFiles,
      sessionFiles,
      verdict,
      signals,
      upkeepOnlySessions: upkeepOnlySessions ?? 0,
    };
  }

  /**
   * The repo OKF tab over the root sessions of `scope` in `repoIds` (DD-29, DD-38, DD-39).
   * `bundle` narrows to one bundle root of the latest snapshot; an unknown one means all.
   */
  async getRepoOkfUsage(
    repoIds: number[],
    scope: AnalyticsScope,
    bundle?: string,
    options: RepoOkfUsageOptions = {},
  ): Promise<RepoOkfUsageResponse> {
    const thresholds = options.thresholds ?? defaultThresholds();
    const {
      roots,
      signalByRoot,
      latest,
      latestRoot,
      allBundles,
      bundles,
      classified,
      kb,
      latestFiles,
      verdict,
      signals,
      upkeepOnlySessions,
    } = await this.buildRepoView(repoIds, scope, bundle, thresholds);

    // Per-session share (DD-39), snapshot-bound KB sessions only; FR-6 skips small bundles.
    const shares: number[] = [];
    for (const c of kb) {
      if (c.tree.snapshot === null || bundles === null) continue;
      let best: number | null = null;
      for (const b of bundles) {
        if (articleCount(b) < thresholds.values.shareMinBundleFiles) continue;
        const s = fileShare(
          listedFilesRead(c.usedRows, b).size,
          articleCount(b),
        );
        if (s !== null && (best === null || s > best)) best = s;
      }
      if (best !== null) shares.push(best);
    }
    const binCounts = new Map<OkfShareBin, number>(
      ALL_SHARE_BINS.map((b) => [b, 0]),
    );
    for (const s of shares) {
      const bin = shareBin(s);
      binCounts.set(bin, (binCounts.get(bin) ?? 0) + 1);
    }

    // Hot files: read + grep bytes per file over KB sessions (gone files included), upkeep
    // reads excluded (FR-5). A bundle's `index.md` is read by design (it is the entry point), so
    // it is never a hot file; without a snapshot any `index.md` counts as one.
    const indexPaths = new Set((allBundles ?? []).map((b) => b.index));
    const isIndexPath = (path: string): boolean =>
      indexPaths.has(path) ||
      (allBundles === null &&
        (path === 'index.md' || path.endsWith('/index.md')));
    const hot = new Map<
      string,
      { bundle: string | null; readBytes: number; sessions: Set<number> }
    >();
    const upkeepPanel = new Map<
      string,
      { bundle: string | null; readBytes: number; sessions: Set<number> }
    >();
    for (const c of classified) {
      for (const contrib of c.contributions) {
        const row = contrib.row;
        if (!isReadLike(row.op) || isFolderKey(row.pathKey)) continue;
        const target =
          contrib.upkeep === true ? upkeepPanel : c.isKb ? hot : null;
        if (target === null) continue;
        if (target === hot && isIndexPath(row.pathKey)) continue;
        const entry = target.get(row.pathKey) ?? {
          bundle: contrib.groupKey === NULL_GROUP_KEY ? null : contrib.groupKey,
          readBytes: 0,
          sessions: new Set<number>(),
        };
        entry.readBytes += row.bytes;
        entry.sessions.add(c.tree.root.sessionRowId);
        target.set(row.pathKey, entry);
      }
    }
    const hotFiles = [...hot.entries()]
      .sort(
        (a, b) => b[1].readBytes - a[1].readBytes || a[0].localeCompare(b[0]),
      )
      .slice(0, HOT_FILES_TOP_N)
      .map(([path, e]) => ({
        bundle: e.bundle,
        path,
        readBytes: e.readBytes,
        sessions: e.sessions.size,
        yield: signals.articles.get(path)?.yield ?? null,
      }));
    const hotRank = new Map(hotFiles.map((h, i) => [h.path, i + 1]));
    const upkeep: OkfRepoUpkeepItem[] = [...upkeepPanel.entries()]
      .sort(
        (a, b) => b[1].readBytes - a[1].readBytes || a[0].localeCompare(b[0]),
      )
      .map(([path, e]) => ({
        path,
        bundle: e.bundle,
        sessions: e.sessions.size,
        readBytes: e.readBytes,
      }));

    // Not read: snapshot files with no non-upkeep read/grep row in any KB session.
    const readPaths = new Set<string>();
    for (const c of kb) {
      for (const r of c.usedRows)
        if (isReadLike(r.op)) readPaths.add(r.pathKey);
    }
    const kbFiles = (bundles ?? []).flatMap((b) =>
      b.files.map((f) => ({ bundle: b.root, path: f.path, size: f.size })),
    );
    const notRead = kbFiles
      .filter((f) => !readPaths.has(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    // Started from index (tile + per bundle).
    let startedFromIndexTile = 0;
    for (const c of kb) {
      if (
        bundles !== null &&
        firstAccessWasIndex(c.kbNodes, bundles) === true
      ) {
        startedFromIndexTile += 1;
      }
    }

    const summaries: OkfBundleSummary[] = (bundles ?? []).map((b) => {
      const rowsInB = kb.flatMap((c) =>
        c.usedRows.filter((r) => bundleOfPath(r.pathKey, bundles) === b),
      );
      const filesRead = listedFilesRead(rowsInB, b).size;
      let fromIndex = 0;
      for (const c of kb) {
        if (startedFromIndex(c.kbNodes, b, bundles ?? [b]) === true)
          fromIndex += 1;
      }
      return {
        root: b.root,
        index: b.index,
        ignored: b.ignored,
        files: articleCount(b),
        filesRead,
        share: fileShare(filesRead, articleCount(b)),
        readBytes: readBytesOf(rowsInB),
        startedFromIndex: null,
        sessionsStartedFromIndex: fromIndex,
      };
    });

    // Tree.
    const coarse = new Set(
      verdict.findings
        .filter((f) => f.rule === 'coarse_article' && f.node.path !== undefined)
        .map((f) => f.node.path!),
    );
    const groups: OkfTreeGroupSpec[] = [
      ...(bundles ?? []).map(groupSpecOfBundle),
      NULL_GROUP_SPEC,
    ];
    const tree: OkfTreeNode[] = buildOkfTree(
      groups,
      classified.flatMap((c) =>
        c.isKb ? c.contributions : c.contributions.filter((x) => x.upkeep),
      ),
      {
        coarse,
        hotRank,
        articleSignals: treeArticleSignals(signals),
        fileFlags: fileFlagsOf(verdict.findings, latestFiles),
        notRead: true,
      },
    ).filter((n) => n.bundle !== null || (n.children?.length ?? 0) > 0);

    // FR-11 (DD-11): period roots with no current OKF analysis.
    let sessionsWithoutAnalysis = 0;
    for (const root of roots) {
      const version =
        signalByRoot.get(root.sessionRowId)?.get(root.sessionRowId)
          ?.extractVersion ?? null;
      if (version === null || version < OKF_EXTRACT_VERSION) {
        sessionsWithoutAnalysis += 1;
      }
    }

    const snapshotInfo =
      latest === null || latestRoot === undefined
        ? null
        : {
            okfSnapshotId: latest.body.okfSnapshotId,
            takenAt: latest.createdAt,
            branch: latestRoot.branch,
          };

    return {
      verdict,
      snapshot: snapshotInfo,
      tiles: {
        kbFiles: kbFiles.length,
        notRead: notRead.length,
        kbSessions: kb.length,
        totalSessions: roots.length,
        startedFromIndex: startedFromIndexTile,
        medianShare: median(shares),
        maxShare: shares.length === 0 ? null : Math.max(...shares),
        upkeepOnlySessions: upkeepOnlySessions ?? 0,
        pointerYield: signals.yield,
        routingMissArticles: signals.summary.routingMissArticles,
        routingMissPairs: signals.summary.routingMissPairs,
        sessionsWithoutAnalysis,
        sessionsInPeriod: roots.length,
      },
      shareBins: ALL_SHARE_BINS.map((bin) => ({
        bin,
        sessions: binCounts.get(bin) ?? 0,
      })),
      hotFiles,
      notRead,
      bundles: summaries,
      tree,
      thresholds: { custom: [...thresholds.custom] },
      upkeep,
      canRecompute: options.canRecompute === true,
    };
  }

  /**
   * The per-article drill-down of the repo OKF tab (DD-23, DD-29): the same scope, team filter
   * and thresholds as `getRepoOkfUsage` (no bundle narrowing), reduced to one article. A `path`
   * that is not a stored KB article of the view → `found: false`. Routing-miss task heads are
   * masked like the session route (`maskFirstPrompt`, team view only); patterns never are.
   */
  async getRepoOkfArticle(
    repoIds: number[],
    scope: AnalyticsScope,
    path: string,
    thresholds: OkfUsageThresholds = defaultThresholds(),
  ): Promise<RepoOkfArticleResponse> {
    const view = await this.buildRepoView(
      repoIds,
      scope,
      undefined,
      thresholds,
    );
    const { allBundles, bundles, classified, latestFiles, sessionFiles } = view;

    // Found: a `.md` file of a visible bundle, or one the view's rows read / wrote.
    const contributions = classified.flatMap((c) =>
      c.contributions
        .filter((x) => x.row.pathKey === path)
        .map((x) => ({ c, x })),
    );
    const listed =
      bundles !== null &&
      bundles.some((b) => b.files.some((f) => f.path === path));
    if (!isMarkdown(path) || (!listed && contributions.length === 0)) {
      return emptyArticle(path);
    }

    const article = view.signals.articles.get(path);
    const findings = view.verdict.findings.filter((f) => f.node.path === path);

    // Reads in the period: whole-file / ranged / upkeep calls (upkeep leaves the other two).
    const reads = {
      whole: 0,
      section: 0,
      upkeep: 0,
      partial: article?.reads.partial ?? 0,
    };
    for (const { x } of contributions) {
      if (x.row.op !== 'read') continue;
      if (x.upkeep === true) {
        reads.upkeep += x.row.calls;
        continue;
      }
      const ranged = x.row.rangedCalls ?? 0;
      reads.section += ranged;
      reads.whole += x.row.calls - ranged;
    }

    // FR-10 hash status.
    const current = latestFiles?.get(path);
    let hashStatus: RepoOkfArticleResponse['hashStatus'] = 'unknown';
    let oldSize: number | null = null;
    if (latestFiles !== undefined && current === undefined) {
      hashStatus = 'removed';
    } else if (current !== undefined && current.hash !== null) {
      hashStatus = 'current';
      const staleFinding = findings.find((f) => f.stale !== undefined);
      if (staleFinding?.stale !== undefined) {
        hashStatus = 'stale';
        oldSize = staleFinding.stale.oldSize;
      } else {
        // Newest reading session on another version of the file.
        const readers = [
          ...new Set(
            contributions
              .filter(({ x }) => isReadLike(x.row.op) && x.upkeep !== true)
              .map(({ c }) => c.tree.root),
          ),
        ].sort((a, b) => (toMs(b.startTime) ?? 0) - (toMs(a.startTime) ?? 0));
        for (const root of readers) {
          const own = sessionFiles.get(root.sessionRowId)?.get(path);
          if (
            own !== undefined &&
            own.hash !== null &&
            own.hash !== current.hash
          ) {
            hashStatus = 'stale';
            oldSize = own.size;
            break;
          }
        }
      }
    }

    // Routing-miss agents: node → its root tree, session ids and (masked) task head.
    let routingMiss: RepoOkfArticleResponse['routingMiss'] = null;
    if (article?.routingMiss) {
      const rootOfNode = new Map<number, ScopedRootSession>();
      for (const c of classified) {
        for (const n of c.tree.nodes) rootOfNode.set(n.id, c.tree.root);
      }
      const missNodeIds = article.routingMiss.missing.map((m) =>
        Number(m.nodeId),
      );
      const identity = await this.loadNodeIdentity(missNodeIds);
      const teamView = scope.teamId !== undefined;
      routingMiss = {
        agents: article.routingMiss.agents,
        areaAgents: article.routingMiss.areaAgents,
        patterns: article.routingMiss.patterns.map((p) => ({ ...p })),
        missing: article.routingMiss.missing.map((m) => {
          const nodeId = Number(m.nodeId);
          const node = identity.get(nodeId);
          const prompt = node?.firstPrompt ?? null;
          const masked = teamView
            ? maskFirstPrompt(
                scope.scope,
                scope.requesterUserId,
                node?.userId ?? null,
                prompt,
              )
            : prompt;
          return {
            sessionId:
              rootOfNode.get(nodeId)?.sessionId ?? node?.sessionId ?? '',
            agentId: node?.sessionId ?? '',
            taskHead: cutTaskHead(masked),
            searches: m.searches,
          };
        }),
      };
    }

    // Same rule on other files: top 5 by the rule's headline value.
    const rules = new Set(findings.map((f) => f.rule));
    const sameFindingElsewhere = view.verdict.findings
      .filter(
        (f) =>
          rules.has(f.rule) &&
          f.node.path !== undefined &&
          f.node.path !== path,
      )
      .map((f) => ({
        path: f.node.path!,
        rule: f.rule,
        value: findingValue(f),
      }))
      .sort(
        (a, b) =>
          b.value - a.value ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
          (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
      )
      .slice(0, SAME_FINDING_TOP_N);

    return {
      found: true,
      path,
      bundle: bundleOfPath(path, allBundles)?.root ?? null,
      size: current?.size ?? null,
      oldSize,
      hashStatus,
      areaFromOlderVersion: article?.area.areaFromOlderVersion ?? false,
      reads,
      yield: article?.yield ?? null,
      pointers: (article?.pointers ?? []).map((p) => ({ ...p })),
      area: [...(article?.area.files ?? [])],
      catalog: article?.catalog ? { files: article.catalog.files } : null,
      routingMiss,
      searchedAfter: article?.searchedAfter
        ? {
            agents: article.searchedAfter.agents,
            searches: article.searchedAfter.searches,
            patterns: article.searchedAfter.patterns.map((p) => ({ ...p })),
          }
        : null,
      findings,
      sameFindingElsewhere,
    };
  }

  // ── Loaders ──────────────────────────────────────────────────────────────────────────────────

  /** Per node: its `sessions.session_id`, first prompt and uploader (task heads, masking). */
  private async loadNodeIdentity(
    nodeIds: number[],
  ): Promise<
    Map<
      number,
      { sessionId: string; firstPrompt: string | null; userId: number | null }
    >
  > {
    const out = new Map<
      number,
      { sessionId: string; firstPrompt: string | null; userId: number | null }
    >();
    if (nodeIds.length === 0) return out;
    const result = await this.db.execute(sql`
      SELECT
        s.id,
        s.session_id,
        (SELECT l.first_prompt FROM logs l
          WHERE l.session_id = s.id
            AND l.log_type IN ('claude', 'claude-subagent', 'artisyn')
            AND l.first_prompt IS NOT NULL
          ORDER BY (l.log_type = 'artisyn'), l.id
          LIMIT 1) AS first_prompt,
        (SELECT l.user_id FROM logs l
          WHERE l.session_id = s.id
          ORDER BY l.id
          LIMIT 1) AS user_id
      FROM sessions s
      WHERE s.id = ANY(${sessionIdsArray(nodeIds)})
    `);
    for (const r of result.rows as unknown as {
      id: string | number;
      session_id: string;
      first_prompt: string | null;
      user_id: string | number | null;
    }[]) {
      out.set(Number(r.id), {
        sessionId: r.session_id,
        firstPrompt: r.first_prompt,
        userId: r.user_id === null ? null : Number(r.user_id),
      });
    }
    return out;
  }

  /** The opened node plus every descendant, each with its rows; the opened node first. */
  private async loadTreeNodes(sessionDbId: number): Promise<NodeRows[]> {
    const idsArray = sessionIdsArray([sessionDbId]);
    const nodeResult = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)}
      SELECT
        ds.id,
        ds.session_id,
        ds.depth,
        (SELECT MIN(l.start_time) FROM logs l WHERE l.session_id = ds.id) AS start_time,
        (SELECT l.first_prompt FROM logs l
          WHERE l.session_id = ds.id
            AND l.log_type IN ('claude', 'claude-subagent', 'artisyn')
            AND l.first_prompt IS NOT NULL
          ORDER BY (l.log_type = 'artisyn'), l.id
          LIMIT 1) AS first_prompt,
        (SELECT l.user_id FROM logs l
          WHERE l.session_id = ds.id
          ORDER BY l.id
          LIMIT 1) AS user_id
      FROM descendant_sessions ds
    `);
    const seen = new Set<number>();
    const nodes: (NodeRows & { depth: number })[] = [];
    for (const r of nodeResult.rows as unknown as {
      id: string | number;
      session_id: string;
      depth: string | number;
      start_time: string | Date | null;
      first_prompt: string | null;
      user_id: string | number | null;
    }[]) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        sessionId: r.session_id,
        depth: num(r.depth),
        startTime: toMs(r.start_time),
        firstPrompt: r.first_prompt,
        userId: r.user_id === null ? null : Number(r.user_id),
        rows: [],
        pointers: [],
        events: [],
      });
    }
    if (nodes.length === 0) return [];

    const rowResult = await this.db.execute(sql`
      SELECT
        a.session_id, a.path_key, a.op, a.after_own_edit, a.bytes, a.calls, a.seq,
        a.ranged_calls, a.ranged_bytes,
        CASE WHEN s.okf_extract_version >= ${OKF_EXTRACT_VERSION}
          THEN a.search_hits END AS search_hits
      FROM session_okf_access a
      JOIN sessions s ON s.id = a.session_id
      WHERE a.session_id = ANY(${sessionIdsArray(nodes.map((n) => n.id))})
    `);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const r of rowResult.rows as unknown as AccessSqlRow[]) {
      byId.get(Number(r.session_id))?.rows.push(toRow(r));
    }
    return nodes
      .sort(
        (a, b) =>
          a.depth - b.depth ||
          (a.startTime ?? Infinity) - (b.startTime ?? Infinity) ||
          a.id - b.id,
      )
      .map(({ depth: _depth, ...n }) => n);
  }

  /** The tree root's bound snapshot body (owned by the root's uploader), or `null`. */
  private async loadRootSnapshot(
    sessionDbId: number,
  ): Promise<OkfSnapshotBody | null> {
    const snapshotId = await resolveRootOkfSnapshotId(this.db, sessionDbId);
    if (snapshotId === null) return null;
    const rootId = await resolveRootSessionDbId(this.db, sessionDbId);
    const result = await this.db.execute(sql`
      SELECT os.body
      FROM okf_snapshots os
      WHERE os.snapshot_id = ${snapshotId}
        AND os.user_id IN (SELECT l.user_id FROM logs l WHERE l.session_id = ${rootId})
      LIMIT 1
    `);
    const row = result.rows[0] as { body: unknown } | undefined;
    return row === undefined ? null : normaliseSnapshot(row.body);
  }

  /** Per root: its tree nodes (by `sessions.id`) with start time and rows, rows of all depths. */
  private async loadRepoTreeRows(
    roots: ScopedRootSession[],
  ): Promise<
    Map<
      number,
      Map<number, { startTime: number | null; rows: OkfVerdictRow[] }>
    >
  > {
    type RepoNode = { startTime: number | null; rows: OkfVerdictRow[] };
    const out = new Map<number, Map<number, RepoNode>>();
    if (roots.length === 0) return out;
    const idsArray = sessionIdsArray(roots.map((r) => r.sessionRowId));
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)},
      tree_nodes AS (
        SELECT DISTINCT root_id, id FROM descendant_sessions
      ),
      node_start AS (
        SELECT tn.id, MIN(l.start_time) AS start_time
        FROM tree_nodes tn
        JOIN logs l ON l.session_id = tn.id
        GROUP BY tn.id
      )
      SELECT
        tn.root_id,
        a.session_id,
        ns.start_time,
        a.path_key, a.op, a.after_own_edit, a.bytes, a.calls, a.seq,
        a.ranged_calls, a.ranged_bytes,
        CASE WHEN s.okf_extract_version >= ${OKF_EXTRACT_VERSION}
          THEN a.search_hits END AS search_hits
      FROM tree_nodes tn
      JOIN session_okf_access a ON a.session_id = tn.id
      JOIN sessions s ON s.id = tn.id
      LEFT JOIN node_start ns ON ns.id = tn.id
    `);
    for (const r of result.rows as unknown as (AccessSqlRow & {
      root_id: string | number;
      start_time: string | Date | null;
    })[]) {
      const rootId = Number(r.root_id);
      const nodeId = Number(r.session_id);
      const nodes = out.get(rootId) ?? new Map<number, RepoNode>();
      const node: RepoNode = nodes.get(nodeId) ?? {
        startTime: toMs(r.start_time),
        rows: [],
      };
      node.rows.push(toRow(r));
      nodes.set(nodeId, node);
      out.set(rootId, nodes);
    }
    return out;
  }

  /** Per root: its tree node ids (the root included), via the descendant walk. */
  private async loadTreeNodeIds(
    rootIds: number[],
  ): Promise<Map<number, number[]>> {
    const out = new Map<number, number[]>();
    if (rootIds.length === 0) return out;
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))}
      SELECT DISTINCT root_id, id FROM descendant_sessions
    `);
    for (const r of result.rows as unknown as {
      root_id: string | number;
      id: string | number;
    }[]) {
      const rootId = Number(r.root_id);
      const list = out.get(rootId) ?? [];
      list.push(Number(r.id));
      out.set(rootId, list);
    }
    return out;
  }

  /** Per root: per tree node, its pointer / event rows and extraction marker. */
  async loadRepoSignalRows(
    roots: ScopedRootSession[],
  ): Promise<Map<number, Map<number, OkfNodeSignalRows>>> {
    const out = new Map<number, Map<number, OkfNodeSignalRows>>();
    const idsByRoot = await this.loadTreeNodeIds(
      roots.map((r) => r.sessionRowId),
    );
    const allIds = [...new Set([...idsByRoot.values()].flat())];
    const rows = await this.loadSignalRowsForNodes(allIds);
    for (const [rootId, ids] of idsByRoot) {
      const nodes = new Map<number, OkfNodeSignalRows>();
      for (const id of ids) {
        const s = rows.get(id);
        if (s !== undefined) nodes.set(id, s);
      }
      out.set(rootId, nodes);
    }
    return out;
  }

  /**
   * The `session_okf_pointer` / `session_okf_event` rows and the DD-11 marker of the given tree
   * nodes, keyed by `sessions.id`. Every existing node gets an entry (empty rows when none).
   */
  async loadSignalRowsForNodes(
    nodeIds: number[],
  ): Promise<Map<number, OkfNodeSignalRows>> {
    const out = new Map<number, OkfNodeSignalRows>();
    if (nodeIds.length === 0) return out;
    const ids = sessionIdsArray(nodeIds);
    const [meta, pointers, events] = await Promise.all([
      this.db.execute(sql`
        SELECT id, okf_extract_version, okf_events_truncated
        FROM sessions
        WHERE id = ANY(${ids})
      `),
      this.db.execute(sql`
        SELECT session_id, article_path, article_hash, read_ord, pointer, is_new, followed, partial
        FROM session_okf_pointer
        WHERE session_id = ANY(${ids})
      `),
      this.db.execute(sql`
        SELECT session_id, ord, op, path, pattern
        FROM session_okf_event
        WHERE session_id = ANY(${ids})
      `),
    ]);
    for (const r of meta.rows as unknown as {
      id: string | number;
      okf_extract_version: string | number | null;
      okf_events_truncated: boolean | null;
    }[]) {
      out.set(Number(r.id), {
        pointers: [],
        events: [],
        extractVersion:
          r.okf_extract_version === null ? null : num(r.okf_extract_version),
        truncated: r.okf_events_truncated === true,
      });
    }
    for (const r of pointers.rows as unknown as {
      session_id: string | number;
      article_path: string;
      article_hash: string | null;
      read_ord: string | number;
      pointer: string;
      is_new: boolean;
      followed: boolean;
      partial: boolean;
    }[]) {
      const nodeId = Number(r.session_id);
      out.get(nodeId)?.pointers.push({
        nodeId,
        articlePath: r.article_path,
        articleHash: r.article_hash,
        readOrd: num(r.read_ord),
        pointer: r.pointer,
        isNew: r.is_new === true,
        followed: r.followed === true,
        partial: r.partial === true,
      });
    }
    for (const r of events.rows as unknown as {
      session_id: string | number;
      ord: string | number;
      op: 'read' | 'search' | 'write';
      path: string;
      pattern: string | null;
    }[]) {
      const nodeId = Number(r.session_id);
      out.get(nodeId)?.events.push({
        nodeId,
        ord: num(r.ord),
        op: r.op,
        path: r.path,
        pattern: r.pattern,
      });
    }
    return out;
  }

  /**
   * DD-12 / DD-28: the all-time (period-free) pointer aggregates and touched paths of the
   * scope's root trees — same repos, team / user / branch / attribute filters, no period. One
   * `GROUP BY` aggregate for the pointers, one `DISTINCT` union for the touched paths (event
   * paths and access keys), both joined through the in-scope node ids.
   *
   * `visibleArticles` (team view, DD-24 fail closed): non-null keeps only snapshot-bound trees
   * and pointer rows of those articles.
   */
  async loadAllTimeSignalRows(
    repoIds: number[],
    scope: AnalyticsScope,
    visibleArticles: ReadonlySet<string> | null,
  ): Promise<OkfAllTimeSignalRows> {
    const roots = await loadScopedRootSessions(this.db, repoIds, {
      ...scope,
      startDate: ALL_TIME_START,
      endDate: ALL_TIME_END,
    });
    if (roots.length === 0) return { pointers: [], touched: new Set() };
    const idsArray = sessionIdsArray(roots.map((r) => r.sessionRowId));
    const snapshotJoin =
      visibleArticles === null
        ? sql``
        : sql`JOIN sessions rs ON rs.id = tn.root_id AND rs.okf_snapshot_id IS NOT NULL`;

    const [pointerResult, touchedResult] = await Promise.all([
      this.db.execute(sql`
        WITH RECURSIVE ${descendantSessionsCte(idsArray)},
        tree_nodes AS (
          SELECT DISTINCT root_id, id FROM descendant_sessions
        ),
        root_start AS (
          SELECT l.session_id AS id, MIN(l.start_time) AS start_time
          FROM logs l
          WHERE l.session_id = ANY(${idsArray})
          GROUP BY l.session_id
        )
        SELECT
          p.article_path, p.article_hash, p.pointer, p.is_new, p.partial,
          MAX(rst.start_time) AS last_read_at
        FROM tree_nodes tn
        ${snapshotJoin}
        JOIN session_okf_pointer p ON p.session_id = tn.id
        LEFT JOIN root_start rst ON rst.id = tn.root_id
        GROUP BY p.article_path, p.article_hash, p.pointer, p.is_new, p.partial
      `),
      this.db.execute(sql`
        WITH RECURSIVE ${descendantSessionsCte(idsArray)},
        tree_nodes AS (
          SELECT DISTINCT root_id, id FROM descendant_sessions
        )
        SELECT e.path AS path
        FROM tree_nodes tn
        ${snapshotJoin}
        JOIN session_okf_event e ON e.session_id = tn.id
        UNION
        SELECT a.path_key AS path
        FROM tree_nodes tn
        ${snapshotJoin}
        JOIN session_okf_access a ON a.session_id = tn.id
      `),
    ]);

    const pointers: OkfSignalAllTimePointerRow[] = [];
    for (const r of pointerResult.rows as unknown as {
      article_path: string;
      article_hash: string | null;
      pointer: string;
      is_new: boolean;
      partial: boolean;
      last_read_at: string | Date | null;
    }[]) {
      if (visibleArticles !== null && !visibleArticles.has(r.article_path)) {
        continue;
      }
      pointers.push({
        articlePath: r.article_path,
        articleHash: r.article_hash,
        pointer: r.pointer,
        isNew: r.is_new === true,
        partial: r.partial === true,
        lastReadAt: toMs(r.last_read_at),
      });
    }
    const touched = new Set<string>();
    for (const r of touchedResult.rows as unknown as { path: string }[]) {
      touched.add(r.path);
    }
    return { pointers, touched };
  }

  /** Per root with a bound, stored snapshot: the body and its `created_at`. */
  private async loadRootSnapshots(
    roots: ScopedRootSession[],
  ): Promise<Map<number, { body: OkfSnapshotBody; createdAt: string }>> {
    const out = new Map<number, { body: OkfSnapshotBody; createdAt: string }>();
    if (roots.length === 0) return out;
    const idResult = await this.db.execute(sql`
      SELECT s.id, s.okf_snapshot_id
      FROM sessions s
      WHERE s.id = ANY(${sessionIdsArray(roots.map((r) => r.sessionRowId))})
        AND s.okf_snapshot_id IS NOT NULL
    `);
    const snapshotIdByRoot = new Map<number, string>();
    for (const r of idResult.rows as unknown as {
      id: string | number;
      okf_snapshot_id: string;
    }[]) {
      snapshotIdByRoot.set(Number(r.id), r.okf_snapshot_id);
    }
    if (snapshotIdByRoot.size === 0) return out;

    const pairs = new Map<string, { userId: number; snapshotId: string }>();
    for (const root of roots) {
      const snapshotId = snapshotIdByRoot.get(root.sessionRowId);
      if (snapshotId === undefined) continue;
      pairs.set(`${root.userId}\0${snapshotId}`, {
        userId: root.userId,
        snapshotId,
      });
    }
    const pairSql = sql.join(
      [...pairs.values()].map(
        (p) => sql`(${p.userId}::int, ${p.snapshotId}::text)`,
      ),
      sql`, `,
    );
    const bodyResult = await this.db.execute(sql`
      SELECT user_id, snapshot_id, body, created_at
      FROM okf_snapshots
      WHERE (user_id, snapshot_id) IN (${pairSql})
    `);
    const bodies = new Map<
      string,
      { body: OkfSnapshotBody; createdAt: string }
    >();
    for (const r of bodyResult.rows as unknown as {
      user_id: string | number;
      snapshot_id: string;
      body: unknown;
      created_at: string | Date;
    }[]) {
      const body = normaliseSnapshot(r.body);
      if (body === null) continue;
      const created =
        r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
      bodies.set(`${Number(r.user_id)}\0${r.snapshot_id}`, {
        body,
        createdAt: created.toISOString(),
      });
    }
    for (const root of roots) {
      const snapshotId = snapshotIdByRoot.get(root.sessionRowId);
      if (snapshotId === undefined) continue;
      const entry = bodies.get(`${root.userId}\0${snapshotId}`);
      if (entry !== undefined) out.set(root.sessionRowId, entry);
    }
    return out;
  }
}
