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
import {
  resolveRootOkfSnapshotId,
  resolveRootSessionDbId,
  type OkfSnapshotBody,
  type OkfSnapshotBundle,
} from './okf-snapshot';
import { cleanTaskText } from './okf-task-context';
import {
  applyOkfTeamFilter,
  buildOkfTree,
  isFolderKey,
  isUnderPrefix,
  rootFolderKey,
  rootPrefix,
  treeFiles,
  type OkfTreeContribution,
  type OkfTreeGroupSpec,
} from './okf-usage-tree';
import type {
  OkfAgent,
  OkfBundleSummary,
  OkfOp,
  OkfReadTopItem,
  OkfShareBin,
  OkfTreeNode,
  RepoOkfUsageResponse,
  SessionOkfUsageResponse,
} from './okf-usage.types';
import {
  HOT_FILES_TOP_N,
  READ_TOP_N,
  TASK_HEAD_MAX_CHARS,
  agentEntry,
  bundleOfPath,
  computeRepoVerdict,
  computeSessionVerdict,
  fileShare,
  median,
  shareBin,
  startedFromIndex,
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

export interface SessionOkfUsageOptions {
  /** `true` in a team view (`teamId` given): DD-30 fail-closed filter. */
  teamFilter: boolean;
  /**
   * Prompt masking for a `team-no-prompts` caller (`maskFirstPrompt`): another member's task
   * heads come back empty. Omitted in the personal view.
   */
  promptMask?: { scope: TeamScope; requesterUserId: number };
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
}

interface AccessSqlRow {
  session_id: string | number;
  path_key: string;
  op: OkfOp;
  after_own_edit: boolean;
  bytes: string | number;
  calls: string | number;
  seq: string | number;
}

function toRow(r: AccessSqlRow): OkfVerdictRow {
  return {
    pathKey: r.path_key,
    op: r.op,
    afterOwnEdit: r.after_own_edit === true,
    bytes: num(r.bytes),
    calls: num(r.calls),
    seq: num(r.seq),
  };
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Defensive shape check of a stored body (it is the hook's JSON, stored verbatim). */
function normaliseSnapshot(body: unknown): OkfSnapshotBody | null {
  if (body === null || typeof body !== 'object') return null;
  const rec = body as Partial<OkfSnapshotBody>;
  if (typeof rec.okfSnapshotId !== 'string' || !Array.isArray(rec.bundles)) {
    return null;
  }
  const bundles: OkfSnapshotBundle[] = rec.bundles
    .filter(
      (b): b is OkfSnapshotBundle =>
        b !== null &&
        typeof b === 'object' &&
        typeof b.root === 'string' &&
        typeof b.index === 'string',
    )
    .map((b) => ({
      root: b.root,
      index: b.index,
      ignored: b.ignored === true,
      files: (Array.isArray(b.files) ? b.files : [])
        .filter(
          (f) =>
            f !== null && typeof f === 'object' && typeof f.path === 'string',
        )
        .map((f) => ({
          path: f.path,
          ignored: f.ignored === true,
          size: typeof f.size === 'number' ? f.size : 0,
          hash: typeof f.hash === 'string' ? f.hash : '',
        })),
    }));
  return {
    okfSnapshotId: rec.okfSnapshotId,
    schemaVersion:
      typeof rec.schemaVersion === 'number' ? rec.schemaVersion : 1,
    bundles,
  };
}

function isKbFileRow(row: OkfVerdictRow): boolean {
  return !isFolderKey(row.pathKey) && row.pathKey.toLowerCase().endsWith('.md');
}

function isReadLike(op: OkfOp): boolean {
  return op === 'read' || op === 'grep';
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

/** Distinct snapshot-listed files of the bundle with a read/grep row in `rows`. */
function listedFilesRead(
  rows: readonly OkfVerdictRow[],
  bundle: OkfSnapshotBundle,
): Set<string> {
  const listed = new Set(bundle.files.map((f) => f.path));
  const out = new Set<string>();
  for (const r of rows) {
    if (isReadLike(r.op) && listed.has(r.pathKey)) out.add(r.pathKey);
  }
  return out;
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

/** One filtered root tree on the repo route. */
interface RepoTree {
  root: ScopedRootSession;
  snapshot: OkfSnapshotBody | null;
  nodes: { startTime: number | null; rows: OkfVerdictRow[] }[];
}

/**
 * The tree's first non-write access to any of the bundles (earliest node `startTime`, then
 * `seq`), and whether it was that bundle's `index.md`. `null` when none.
 */
function firstAccessWasIndex(
  nodes: RepoTree['nodes'],
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
    const [nodes, snapshot] = await Promise.all([
      this.loadTreeNodes(sessionDbId),
      this.loadRootSnapshot(sessionDbId),
    ]);

    // DD-30 first, then everything else.
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

    const verdict = computeSessionVerdict({
      nodes: kbNodes.map((n) => ({ agentId: n.sessionId, rows: n.rows })),
      bundles,
    });

    // Bundle summaries + entry points.
    const entryPoints = new Set<string>();
    const summaries: OkfBundleSummary[] = (bundles ?? []).map((b) => {
      const allRows = kbNodes.flatMap((n) =>
        n.rows.filter((r) => bundleOfPath(r.pathKey, bundles) === b),
      );
      const filesRead = listedFilesRead(allRows, b).size;
      const fromIndex = startedFromIndex(kbNodes, b, bundles ?? [b]);
      if (fromIndex === true) entryPoints.add(b.index);
      return {
        root: b.root,
        index: b.index,
        ignored: b.ignored,
        files: b.files.length,
        filesRead,
        share: fileShare(filesRead, b.files.length),
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
        });
      }
    }
    const tree = buildOkfTree(groups, contributions, { entryPoints }).filter(
      (n) => n.bundle !== null || (n.children?.length ?? 0) > 0,
    );

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

    // Agents: every node with a KB row; the opened (root) node always.
    const agents: OkfAgent[] = [];
    for (const n of kbNodes) {
      if (n.rows.length === 0 && n.id !== sessionDbId) continue;
      const totals = fileReadTotals(n.rows);
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
      agents.push({
        id: n.sessionId,
        taskHead: cutTaskHead(prompt),
        entry: agentEntry(n.rows, bundles),
        kbReads,
        kbReadBytes,
        files,
      });
    }

    return {
      verdict,
      hasSnapshot: snapshot !== null,
      readTop,
      bundles: summaries,
      tree,
      agents,
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
  ): Promise<RepoOkfUsageResponse> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    const teamFilter = scope.teamId !== undefined;

    const [nodesByRoot, snapshotByRoot] = await Promise.all([
      this.loadRepoTreeRows(roots),
      this.loadRootSnapshots(roots),
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

    let trees: RepoTree[] = roots.map((root) => ({
      root,
      snapshot: snapshotByRoot.get(root.sessionRowId)?.body ?? null,
      nodes: nodesByRoot.get(root.sessionRowId) ?? [],
    }));
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
    interface Classified {
      tree: RepoTree;
      /** Rows in a visible bundle (listed or not) — the verdict input. */
      kbRows: OkfVerdictRow[];
      contributions: OkfTreeContribution[];
      isKb: boolean;
      kbNodes: RepoTree['nodes'];
    }
    const classified: Classified[] = trees.map((tree) => {
      const contributions: OkfTreeContribution[] = [];
      const kbNodes: RepoTree['nodes'] = [];
      const kbRows: OkfVerdictRow[] = [];
      for (const node of tree.nodes) {
        const nodeKb: OkfVerdictRow[] = [];
        const rows =
          bundles === null ? snapshotLessKbRows(node.rows) : node.rows;
        for (const row of rows) {
          if (bundles === null) {
            nodeKb.push(row);
            contributions.push({
              groupKey: NULL_GROUP_KEY,
              unit: tree.root.sessionRowId,
              row,
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
          contributions.push({ groupKey: NULL_GROUP_KEY, unit, row });
        }
        kbNodes.push({ startTime: node.startTime, rows: nodeKb });
        kbRows.push(...nodeKb);
      }
      const isKb = kbRows.some(
        (r) =>
          isReadLike(r.op) &&
          (bundles === null || bundleOfPath(r.pathKey, bundles) !== null),
      );
      return { tree, kbRows, contributions, isKb, kbNodes };
    });

    const kb = classified.filter((c) => c.isKb);

    const verdict = computeRepoVerdict({
      sessions: classified.map((c) => ({
        sessionId: c.tree.root.sessionRowId,
        hasSnapshot: c.tree.snapshot !== null,
        rows: c.kbRows,
      })),
      bundles,
    });

    // Per-session share (DD-39), snapshot-bound KB sessions only.
    const shares: number[] = [];
    for (const c of kb) {
      if (c.tree.snapshot === null || bundles === null) continue;
      let best: number | null = null;
      for (const b of bundles) {
        const s = fileShare(listedFilesRead(c.kbRows, b).size, b.files.length);
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

    // Hot files: read + grep bytes per file over KB sessions (gone files included).
    const hot = new Map<
      string,
      { bundle: string | null; readBytes: number; sessions: Set<number> }
    >();
    for (const c of kb) {
      for (const contrib of c.contributions) {
        const row = contrib.row;
        if (!isReadLike(row.op) || isFolderKey(row.pathKey)) continue;
        const entry = hot.get(row.pathKey) ?? {
          bundle: contrib.groupKey === NULL_GROUP_KEY ? null : contrib.groupKey,
          readBytes: 0,
          sessions: new Set<number>(),
        };
        entry.readBytes += row.bytes;
        entry.sessions.add(c.tree.root.sessionRowId);
        hot.set(row.pathKey, entry);
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
      }));
    const hotRank = new Map(hotFiles.map((h, i) => [h.path, i + 1]));

    // Not read: snapshot files with no read/grep row in any KB session.
    const readPaths = new Set<string>();
    for (const c of kb) {
      for (const r of c.kbRows) if (isReadLike(r.op)) readPaths.add(r.pathKey);
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
        c.kbRows.filter((r) => bundleOfPath(r.pathKey, bundles) === b),
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
        files: b.files.length,
        filesRead,
        share: fileShare(filesRead, b.files.length),
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
      kb.flatMap((c) => c.contributions),
      { coarse, hotRank },
    ).filter((n) => n.bundle !== null || (n.children?.length ?? 0) > 0);

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
      },
      shareBins: ALL_SHARE_BINS.map((bin) => ({
        bin,
        sessions: binCounts.get(bin) ?? 0,
      })),
      hotFiles,
      notRead,
      bundles: summaries,
      tree,
    };
  }

  // ── Loaders ──────────────────────────────────────────────────────────────────────────────────

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
      });
    }
    if (nodes.length === 0) return [];

    const rowResult = await this.db.execute(sql`
      SELECT session_id, path_key, op, after_own_edit, bytes, calls, seq
      FROM session_okf_access
      WHERE session_id = ANY(${sessionIdsArray(nodes.map((n) => n.id))})
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

  /** Per root: its tree nodes (start time + rows), rows of all depths. */
  private async loadRepoTreeRows(
    roots: ScopedRootSession[],
  ): Promise<Map<number, RepoTree['nodes']>> {
    const out = new Map<number, RepoTree['nodes']>();
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
        a.path_key, a.op, a.after_own_edit, a.bytes, a.calls, a.seq
      FROM tree_nodes tn
      JOIN session_okf_access a ON a.session_id = tn.id
      LEFT JOIN node_start ns ON ns.id = tn.id
    `);
    type RepoNode = { startTime: number | null; rows: OkfVerdictRow[] };
    const nodeMaps = new Map<number, Map<number, RepoNode>>();
    for (const r of result.rows as unknown as (AccessSqlRow & {
      root_id: string | number;
      start_time: string | Date | null;
    })[]) {
      const rootId = Number(r.root_id);
      const nodeId = Number(r.session_id);
      const nodes = nodeMaps.get(rootId) ?? new Map<number, RepoNode>();
      const node: RepoNode = nodes.get(nodeId) ?? {
        startTime: toMs(r.start_time),
        rows: [],
      };
      node.rows.push(toRow(r));
      nodes.set(nodeId, node);
      nodeMaps.set(rootId, nodes);
    }
    for (const [rootId, nodes] of nodeMaps)
      out.set(rootId, [...nodes.values()]);
    return out;
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
