/**
 * Tools/MCP monitoring — the `session_tool_usage` writer and the stale marking (impl-plan DD-7,
 * DD-8). The only code that writes `session_tool_usage` rows; `sessions.service.ts` purges them.
 *
 * - {@link markTreeStale} / {@link markTreesStale}: ingest, import and the stats recompute set
 *   `sessions.tool_usage_version = NULL` on the touched node and its top ancestor. The background
 *   drain (`ToolUsageRebuildService`) picks them up.
 * - {@link rewriteTreeToolUsage}: rebuilds one tree — loads every node's transcript, the tree's
 *   `tool-calls` log(s) and the repository rows linked to the root's `artisyn` log, builds the
 *   rows (`buildTreeToolUsage`), replaces the rows of every tree node (delete-then-insert) and
 *   merges the wrapper status into the linked repository rows (`writeToolWrapStatus`).
 */
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  sessionToolUsage,
  type ToolCallAgentKind,
} from '../../database/schema/index';
import { getServerBashParser } from '../okf/server-bash-parser';
import { descendantSessionsCte, topAncestorIdsSql } from '../session-tree.sql';
import type { ResolvedMonitoredTools } from './tool-monitoring.types';
import { parseToolCallsLog, type ParsedToolCallsLog } from './tool-calls-log';
import {
  buildTreeToolUsage,
  type ToolUsageRow,
  type ToolUsageTreeNode,
} from './tool-usage-builder';
import { writeToolWrapStatus } from './tool-wrap-status';

/** Rows per INSERT statement (10 parameters each, far below the Postgres parameter cap). */
const INSERT_CHUNK = 200;

/** Resolves an owner's merged monitored set (`ToolMonitorConfigService.resolveMonitoredTools`). */
export type MonitoredToolsResolver = (
  userId: number,
  repoUrl: string,
) => Promise<ResolvedMonitoredTools>;

/** `{…}::int[]` literal of database ids (integers from the DB, so no quoting is needed). */
function idsLiteral(ids: readonly number[]): string {
  return `{${ids.map((id) => Math.trunc(id)).join(',')}}`;
}

/**
 * Marks the given nodes and their top ancestors stale (`tool_usage_version = NULL`) so the drain
 * rebuilds their trees (DD-7).
 */
export async function markTreesStale(
  tx: DrizzleDb,
  sessionRowIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(sessionRowIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return;
  const arr = sql`${idsLiteral(ids)}::bigint[]`;
  await tx.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(arr)}
    UPDATE sessions SET tool_usage_version = NULL
    WHERE tool_usage_version IS NOT NULL
      AND id IN (SELECT id FROM top_ancestors UNION SELECT top_id FROM top_ancestors)
  `);
}

/** Marks one node and its top ancestor stale (DD-7). */
export function markTreeStale(
  tx: DrizzleDb,
  sessionRowId: number,
): Promise<void> {
  return markTreesStale(tx, [sessionRowId]);
}

interface TreeNodeRow {
  id: number | string;
  session_id: string;
  depth: number | string;
  workflow_run_id: string | null;
  deleted: boolean;
}

interface TreeLogRow {
  session_id: number | string;
  log_type: string;
  body: unknown;
}

interface LinkedRepoRow {
  id: number | string;
  user_id: number | string;
  repo_url: string;
}

function linesOf(body: unknown): object[] {
  if (!Array.isArray(body)) return [];
  return (body as unknown[]).filter(
    (line): line is object => typeof line === 'object' && line !== null,
  );
}

function agentKindOf(node: TreeNodeRow, isRoot: boolean): ToolCallAgentKind {
  if (isRoot) return 'root';
  return node.workflow_run_id !== null && node.workflow_run_id !== ''
    ? 'workflow'
    : 'subagent';
}

/** Every `tool-calls` body of the tree as one parsed log (a repeated `callId` keeps one line). */
function parseTreeToolCalls(bodies: readonly unknown[]): ParsedToolCallsLog {
  const items: unknown[] = [];
  for (const body of bodies) {
    if (Array.isArray(body)) items.push(...(body as unknown[]));
  }
  return parseToolCallsLog(items);
}

async function insertRows(
  tx: DrizzleDb,
  rows: readonly ToolUsageRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await tx.insert(sessionToolUsage).values(
      rows.slice(i, i + INSERT_CHUNK).map((r) => ({
        sessionId: r.sessionId,
        channel: r.channel,
        tool: r.tool,
        callCount: r.callCount,
        firstCallAt: r.firstCallAt,
        lastCallAt: r.lastCallAt,
        hasWrapperData: r.hasWrapperData,
        aggregates: r.aggregates,
        calls: r.calls,
        outputs: r.outputs,
      })),
    );
  }
}

/**
 * Rebuilds the `session_tool_usage` rows of the tree rooted at `rootId` (DD-8). Returns the
 * number of rows written. Run inside a transaction; the caller serialises rebuilds of the same
 * tree.
 */
export async function rewriteTreeToolUsage(
  tx: DrizzleDb,
  rootId: number,
  resolveMonitored: MonitoredToolsResolver,
): Promise<number> {
  const rootArr = sql`${idsLiteral([rootId])}::bigint[]`;
  const nodeResult = await tx.execute(sql`
    WITH RECURSIVE ${descendantSessionsCte(rootArr)}
    SELECT DISTINCT ON (d.id) d.id, d.session_id, d.depth, s.workflow_run_id, s.deleted
    FROM descendant_sessions d
    JOIN sessions s ON s.id = d.id
    ORDER BY d.id, d.depth
  `);
  const nodeRows = nodeResult.rows as unknown as TreeNodeRow[];
  const allIds = nodeRows.map((n) => Number(n.id));
  if (allIds.length === 0) return 0;
  const liveNodes = nodeRows.filter((n) => !n.deleted);
  const liveIds = liveNodes.map((n) => Number(n.id));

  const logRows =
    liveIds.length === 0
      ? []
      : ((
          await tx.execute(sql`
            SELECT session_id, log_type, body
            FROM logs
            WHERE session_id = ANY(${idsLiteral(liveIds)}::int[])
              AND log_type IN ('claude', 'claude-subagent', 'tool-calls')
          `)
        ).rows as unknown as TreeLogRow[]);

  const transcripts = new Map<
    number,
    { lines: object[]; isSubagent: boolean }
  >();
  const toolCallBodies: unknown[] = [];
  for (const row of logRows) {
    if (row.log_type === 'tool-calls') {
      toolCallBodies.push(row.body);
      continue;
    }
    const id = Number(row.session_id);
    const entry = transcripts.get(id) ?? {
      lines: [],
      isSubagent: row.log_type === 'claude-subagent',
    };
    entry.lines.push(...linesOf(row.body));
    transcripts.set(id, entry);
  }
  const hasToolCallsLog = toolCallBodies.length > 0;
  const toolCallsLog = hasToolCallsLog
    ? parseTreeToolCalls(toolCallBodies)
    : null;

  const repoRows = (
    await tx.execute(sql`
      SELECT DISTINCT r.id, r.user_id, r.repo_url
      FROM logs l
      JOIN log_repositories lr ON lr.log_id = l.id
      JOIN repositories r ON r.id = lr.repo_id
      WHERE l.session_id = ${rootId} AND l.log_type = 'artisyn'
      ORDER BY r.id
    `)
  ).rows as unknown as LinkedRepoRow[];

  const monitored = new Set<string>();
  for (const repo of repoRows) {
    const resolved = await resolveMonitored(
      Number(repo.user_id),
      repo.repo_url,
    );
    for (const tool of resolved.tools) monitored.add(tool.name);
  }

  const nodes: ToolUsageTreeNode[] = liveNodes.map((n) => {
    const id = Number(n.id);
    const isRoot = id === rootId;
    const transcript = transcripts.get(id);
    return {
      sessionRowId: id,
      isRoot,
      agentId: isRoot ? null : n.session_id,
      agentKind: agentKindOf(n, isRoot),
      isSubagentLog: transcript?.isSubagent ?? !isRoot,
      entries: transcript?.lines ?? [],
    };
  });

  const rows =
    nodes.length === 0
      ? []
      : buildTreeToolUsage(nodes, toolCallsLog, [...monitored], {
          parser: await getServerBashParser(),
        });

  await tx.execute(
    sql`DELETE FROM session_tool_usage WHERE session_id = ANY(${idsLiteral(allIds)}::int[])`,
  );
  await insertRows(tx, rows);

  if (toolCallsLog !== null) {
    for (const repo of repoRows) {
      await writeToolWrapStatus(
        tx,
        Number(repo.id),
        toolCallsLog.status,
        toolCallsLog.calls,
      );
    }
  }
  return rows.length;
}
