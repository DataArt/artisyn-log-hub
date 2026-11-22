/**
 * OKF usage — the read side of the session OKF tab and the repo OKF tab.
 *
 * Both routes load `session_okf_access` rows (one row set per tree node, written by
 * `okf-access-writer.ts`), the stored `okf_snapshots` bodies and the per-node cost figures
 * (`session_stats` / `session_costs`), apply the team fail-closed filter (`okf-team-filter.ts`)
 * when the caller looks through a team, and hand everything to `buildOkfUsageView`
 * (`okf-usage-counting.ts`). No counting rule lives here — see
 * `docs/knowledgebase/algorithms/okf-usage-counting.md`.
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
import type { OkfUsageRow } from './okf-paths';
import {
  normaliseSnapshot,
  resolveRootOkfSnapshotId,
  resolveRootSessionDbId,
  type OkfSnapshotBody,
  type OkfSnapshotBundle,
} from './okf-snapshot';
import { applyOkfTeamFilter } from './okf-team-filter';
import {
  buildOkfUsageView,
  pickReferenceRoot,
  type OkfCountingNode,
} from './okf-usage-counting';
import type { OkfOp, OkfUsageResponse, OkfUsageUnit } from './okf-usage.types';

export interface SessionOkfUsageOptions {
  /** Team view: apply the fail-closed team filter before counting. */
  teamFilter: boolean;
}

/** One tree node of the opened session with its access rows. */
interface NodeRows {
  /** `sessions.id`. */
  id: number;
  startTime: number | null;
  /** The node has a `claude` / `claude-subagent` log, i.e. it is an agent. */
  hasAgentLog: boolean;
  rows: OkfUsageRow[];
}

/** One root tree as the service keeps it before counting. */
interface OkfTree {
  rootId: number;
  /** The tree's own bound snapshot; null = none. */
  snapshot: OkfSnapshotBody | null;
  nodes: { id: number; rows: OkfUsageRow[] }[];
}

/** A stored snapshot with what the view shows about it. */
interface StoredSnapshot {
  body: OkfSnapshotBody;
  createdAt: string;
}

/** Cost figures of one tree node. */
interface NodeCost {
  /** `input_tokens + cache_write_tokens` of `session_stats`; 0 without a stats row. */
  ctxTokens: number;
  /** Context-side cost; null when the node has no computed cost. */
  ctxCost: number | null;
  /** `session_costs.cost`; null = not computed / no row. */
  cost: number | null;
}

interface AccessSqlRow {
  session_id: string | number;
  path_key: string;
  op: OkfOp;
  after_own_edit: boolean;
  bytes: string | number;
  calls: string | number;
}

function toRow(r: AccessSqlRow): OkfUsageRow {
  return {
    pathKey: r.path_key,
    op: r.op,
    afterOwnEdit: r.after_own_edit === true,
    bytes: num(r.bytes),
    calls: num(r.calls),
  };
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Σ `cost` over the nodes; `null` when no node has a non-null cost. */
function spendOf(costs: ReadonlyMap<number, NodeCost>): number | null {
  let total = 0;
  let priced = false;
  for (const c of costs.values()) {
    if (c.cost === null) continue;
    total += c.cost;
    priced = true;
  }
  return priced ? total : null;
}

/** Flattens the trees into counting nodes, joining the cost figures by node id. */
function countingNodes(
  trees: readonly OkfTree[],
  costs: ReadonlyMap<number, NodeCost>,
  unitOf: (tree: OkfTree, nodeId: number) => number,
): OkfCountingNode[] {
  const out: OkfCountingNode[] = [];
  for (const tree of trees) {
    for (const node of tree.nodes) {
      const cost = costs.get(node.id);
      out.push({
        unit: unitOf(tree, node.id),
        rows: node.rows,
        ctxTokens: cost?.ctxTokens ?? 0,
        ctxCost: cost?.ctxCost ?? null,
      });
    }
  }
  return out;
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

  /**
   * The response without a KB snapshot: every array empty, every number zero. Also the answer
   * for a session the scope cannot see.
   */
  emptyUsage(unit: OkfUsageUnit): OkfUsageResponse {
    return buildOkfUsageView({
      unit,
      bundles: null,
      snapshot: null,
      nodes: [],
      unitsTotal: 0,
      spend: null,
      refMs: Date.now(),
    });
  }

  /**
   * The repo OKF tab: how the root sessions of the scope read the knowledge base, counted
   * against the reference snapshot (the newest root on a default branch that has one, else the
   * newest of all). The unit is a root session.
   */
  async getRepoOkfUsage(
    repoIds: number[],
    scope: AnalyticsScope,
    bundle: string | undefined,
  ): Promise<OkfUsageResponse> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    const [nodesByRoot, snapshotByRoot, costs] = await Promise.all([
      this.loadRepoTreeRows(roots),
      this.loadRootSnapshots(roots),
      this.loadNodeCosts(roots.map((r) => r.sessionRowId)),
    ]);

    const reference = pickReferenceRoot(
      roots.filter((r) => snapshotByRoot.has(r.sessionRowId)),
    );
    const referenceSnapshot =
      reference === null
        ? undefined
        : snapshotByRoot.get(reference.sessionRowId);
    if (reference === null || referenceSnapshot === undefined) {
      return this.emptyUsage('sessions');
    }

    let trees: OkfTree[] = roots.map((root) => ({
      rootId: root.sessionRowId,
      snapshot: snapshotByRoot.get(root.sessionRowId)?.body ?? null,
      nodes: [...(nodesByRoot.get(root.sessionRowId) ?? new Map())].map(
        ([id, rows]: [number, OkfUsageRow[]]) => ({ id, rows }),
      ),
    }));
    let bundles: OkfSnapshotBundle[] | null = referenceSnapshot.body.bundles;
    if (scope.teamId !== undefined) {
      const filtered = applyOkfTeamFilter(trees, bundles);
      trees = filtered.trees;
      bundles = filtered.bundles;
    }

    return buildOkfUsageView({
      unit: 'sessions',
      bundles,
      snapshot: {
        branch: reference.branch,
        takenAt: referenceSnapshot.createdAt,
      },
      bundle,
      nodes: countingNodes(trees, costs, (tree) => tree.rootId),
      unitsTotal: roots.length,
      spend: spendOf(costs),
      refMs: Date.now(),
      teamView: scope.teamId !== undefined,
    });
  }

  /**
   * The session OKF tab: the opened session plus all its sub-agent nodes, counted against the
   * tree root's snapshot. The unit is a tree node (an agent).
   */
  async getSessionOkfUsage(
    sessionDbId: number,
    options: SessionOkfUsageOptions,
  ): Promise<OkfUsageResponse> {
    const [nodes, stored, costs] = await Promise.all([
      this.loadTreeNodes(sessionDbId),
      this.loadRootSnapshot(sessionDbId),
      this.loadNodeCosts([sessionDbId]),
    ]);
    if (stored === null) return this.emptyUsage('agents');

    let trees: OkfTree[] = [
      {
        rootId: sessionDbId,
        snapshot: stored.body,
        nodes: nodes.map((n) => ({ id: n.id, rows: n.rows })),
      },
    ];
    let bundles: OkfSnapshotBundle[] | null = stored.body.bundles;
    if (options.teamFilter) {
      const filtered = applyOkfTeamFilter(trees, bundles);
      trees = filtered.trees;
      bundles = filtered.bundles;
    }

    const opened = nodes.find((n) => n.id === sessionDbId);
    return buildOkfUsageView({
      unit: 'agents',
      bundles,
      snapshot: { branch: stored.branch, takenAt: stored.createdAt },
      nodes: countingNodes(trees, costs, (_tree, nodeId) => nodeId),
      // The opened node always counts; a descendant counts when it has an agent log.
      unitsTotal: nodes.filter((n) => n.id === sessionDbId || n.hasAgentLog)
        .length,
      spend: spendOf(costs),
      refMs: opened?.startTime ?? Date.now(),
      teamView: options.teamFilter,
    });
  }

  /** The opened node plus every descendant, each with its rows; the opened node first. */
  private async loadTreeNodes(sessionDbId: number): Promise<NodeRows[]> {
    const idsArray = sessionIdsArray([sessionDbId]);
    const nodeResult = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)}
      SELECT
        ds.id,
        ds.depth,
        (SELECT MIN(l.start_time) FROM logs l WHERE l.session_id = ds.id) AS start_time,
        EXISTS (
          SELECT 1 FROM logs l
          WHERE l.session_id = ds.id
            AND l.log_type IN ('claude', 'claude-subagent')
        ) AS has_agent_log
      FROM descendant_sessions ds
    `);
    const seen = new Set<number>();
    const nodes: (NodeRows & { depth: number })[] = [];
    for (const r of nodeResult.rows as unknown as {
      id: string | number;
      depth: string | number;
      start_time: string | Date | null;
      has_agent_log: boolean;
    }[]) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        depth: num(r.depth),
        startTime: toMs(r.start_time),
        hasAgentLog: r.has_agent_log === true,
        rows: [],
      });
    }
    if (nodes.length === 0) return [];

    const rowResult = await this.db.execute(sql`
      SELECT a.session_id, a.path_key, a.op, a.after_own_edit, a.bytes, a.calls
      FROM session_okf_access a
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

  /**
   * The tree root's bound snapshot (owned by the root's uploader) with its `created_at` and the
   * root's branch (`logs.git_branch`, may be null), or `null` when the root has none stored.
   */
  private async loadRootSnapshot(
    sessionDbId: number,
  ): Promise<(StoredSnapshot & { branch: string | null }) | null> {
    const snapshotId = await resolveRootOkfSnapshotId(this.db, sessionDbId);
    if (snapshotId === null) return null;
    const rootId = await resolveRootSessionDbId(this.db, sessionDbId);
    const result = await this.db.execute(sql`
      SELECT
        os.body,
        os.created_at,
        (SELECT l.git_branch FROM logs l
          WHERE l.session_id = ${rootId}
          ORDER BY (l.log_type = 'artisyn') DESC, l.id
          LIMIT 1) AS branch
      FROM okf_snapshots os
      WHERE os.snapshot_id = ${snapshotId}
        AND os.user_id IN (SELECT l.user_id FROM logs l WHERE l.session_id = ${rootId})
      LIMIT 1
    `);
    const row = result.rows[0] as
      | { body: unknown; created_at: string | Date; branch: string | null }
      | undefined;
    if (row === undefined) return null;
    const body = normaliseSnapshot(row.body);
    if (body === null) return null;
    return {
      body,
      createdAt: toIso(row.created_at),
      branch: row.branch ?? null,
    };
  }

  /** Per root: its tree nodes (by `sessions.id`) that have access rows, rows of all depths. */
  private async loadRepoTreeRows(
    roots: ScopedRootSession[],
  ): Promise<Map<number, Map<number, OkfUsageRow[]>>> {
    const out = new Map<number, Map<number, OkfUsageRow[]>>();
    if (roots.length === 0) return out;
    const idsArray = sessionIdsArray(roots.map((r) => r.sessionRowId));
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)},
      tree_nodes AS (
        SELECT DISTINCT root_id, id FROM descendant_sessions
      )
      SELECT
        tn.root_id,
        a.session_id,
        a.path_key, a.op, a.after_own_edit, a.bytes, a.calls
      FROM tree_nodes tn
      JOIN session_okf_access a ON a.session_id = tn.id
    `);
    for (const r of result.rows as unknown as (AccessSqlRow & {
      root_id: string | number;
    })[]) {
      const rootId = Number(r.root_id);
      const nodeId = Number(r.session_id);
      const nodes = out.get(rootId) ?? new Map<number, OkfUsageRow[]>();
      const rows = nodes.get(nodeId) ?? [];
      rows.push(toRow(r));
      nodes.set(nodeId, rows);
      out.set(rootId, nodes);
    }
    return out;
  }

  /**
   * Per tree node id (the given roots and all their descendants): the tokens the node put into
   * its context, the context-side cost and the whole cost. `ctxCost` is the input, cache-write
   * and cache-read parts of `session_costs` (a NULL part counts as 0) and is `null` when the
   * node has no computed cost. Stale cost rows are used as they are.
   */
  private async loadNodeCosts(
    rootIds: number[],
  ): Promise<Map<number, NodeCost>> {
    const out = new Map<number, NodeCost>();
    if (rootIds.length === 0) return out;
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))},
      tree_nodes AS (
        SELECT DISTINCT id FROM descendant_sessions
      )
      SELECT
        tn.id,
        COALESCE(ss.input_tokens, 0) + COALESCE(ss.cache_write_tokens, 0) AS ctx_tokens,
        CASE WHEN sc.cost IS NULL THEN NULL ELSE
          COALESCE(sc.cost_input, 0) + COALESCE(sc.cost_cache_write_5m, 0)
          + COALESCE(sc.cost_cache_write_1h, 0) + COALESCE(sc.cost_cache_read, 0)
        END AS ctx_cost,
        sc.cost
      FROM tree_nodes tn
      LEFT JOIN session_stats ss ON ss.session_id = tn.id
      LEFT JOIN session_costs sc ON sc.session_id = tn.id
    `);
    for (const r of result.rows as unknown as {
      id: string | number;
      ctx_tokens: string | number | null;
      ctx_cost: string | number | null;
      cost: string | number | null;
    }[]) {
      out.set(Number(r.id), {
        ctxTokens: num(r.ctx_tokens),
        ctxCost: r.ctx_cost === null ? null : Number(r.ctx_cost),
        cost: r.cost === null ? null : Number(r.cost),
      });
    }
    return out;
  }

  /** Per root with a bound, stored snapshot: the body and its `created_at`. */
  private async loadRootSnapshots(
    roots: ScopedRootSession[],
  ): Promise<Map<number, StoredSnapshot>> {
    const out = new Map<number, StoredSnapshot>();
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
    const bodies = new Map<string, StoredSnapshot>();
    for (const r of bodyResult.rows as unknown as {
      user_id: string | number;
      snapshot_id: string;
      body: unknown;
      created_at: string | Date;
    }[]) {
      const body = normaliseSnapshot(r.body);
      if (body === null) continue;
      bodies.set(`${Number(r.user_id)}\0${r.snapshot_id}`, {
        body,
        createdAt: toIso(r.created_at),
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
