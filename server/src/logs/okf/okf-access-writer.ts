/**
 * The `session_okf_access` writer — the ONLY code that writes that table (FR-3, impl-plan DD-9).
 *
 * Called from every place `writeSessionFileStats` is called, with the same repo roots:
 * ingest (`LogsService.upsert()` Step 3b), import (`LogsService.writeImportedLog()`), the
 * claude-before-artisyn heal (`rewriteSessionTreeFileStats`) and the scope-independent backfill
 * (`RepositoriesService.recomputeAllSessionStats()` → `recomputeOkfAccess`). It is NOT called from
 * the per-file-category-scope recompute: OKF rows have no scope, one row set per node.
 *
 * Writer contract: per node, `DELETE` its rows, then insert the new set. The insert keeps
 * `ON CONFLICT … DO UPDATE` on the `(session_id, path_key, op, after_own_edit)` unique key,
 * because the heal touches descendant nodes it never locks and the backfill runs outside a
 * transaction — a concurrent writer for the same node must not hit a unique violation.
 */
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { sessionOkfAccess } from '../../database/schema/index';
import { extractOkfAccess, type OkfAccessRow } from './okf-access-extractor';
import { getServerBashParser } from './server-bash-parser';

/** Rows per INSERT statement (7 parameters each, far below the Postgres parameter cap). */
const INSERT_CHUNK = 1000;

/** Replaces the `session_okf_access` rows of one tree node with `rows`. */
export async function writeSessionOkfAccess(
  db: DrizzleDb,
  sessionDbId: number,
  rows: readonly OkfAccessRow[],
): Promise<void> {
  await db
    .delete(sessionOkfAccess)
    .where(eq(sessionOkfAccess.sessionId, sessionDbId));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    await db
      .insert(sessionOkfAccess)
      .values(
        chunk.map((r) => ({
          sessionId: sessionDbId,
          pathKey: r.pathKey,
          op: r.op,
          afterOwnEdit: r.afterOwnEdit,
          bytes: r.bytes,
          calls: r.calls,
          seq: r.seq,
        })),
      )
      .onConflictDoUpdate({
        target: [
          sessionOkfAccess.sessionId,
          sessionOkfAccess.pathKey,
          sessionOkfAccess.op,
          sessionOkfAccess.afterOwnEdit,
        ],
        set: {
          bytes: sql`excluded.bytes`,
          calls: sql`excluded.calls`,
          seq: sql`excluded.seq`,
        },
      });
  }
}

/**
 * Extracts and writes the OKF access rows of one node from its transcript lines.
 * `isSubagentLog` is `true` for a `claude-subagent` log (see `extractOkfAccess`).
 */
export async function rebuildSessionOkfAccess(
  db: DrizzleDb,
  sessionDbId: number,
  lines: readonly object[],
  repoRoots: readonly string[],
  isSubagentLog: boolean,
): Promise<void> {
  const rows = extractOkfAccess(lines, repoRoots, await getServerBashParser(), {
    isSubagentLog,
  });
  await writeSessionOkfAccess(db, sessionDbId, rows);
}

/** One stored `claude` / `claude-subagent` log body of a tree node. */
export interface OkfNodeLogBody {
  sessionId: number;
  logType: string;
  body: unknown;
}

/**
 * Rebuilds the OKF rows of several nodes from their stored log bodies. A node normally has
 * exactly one `claude` / `claude-subagent` log; bodies are grouped per node defensively so a
 * node is written once from all of its lines rather than once per log (the last write winning).
 * `rootsOf` gives the repo roots of a node (the tree root's artisyn roots, one root rule).
 */
export async function rebuildOkfAccessForNodes(
  db: DrizzleDb,
  bodyRows: readonly OkfNodeLogBody[],
  rootsOf: (sessionDbId: number) => readonly string[],
): Promise<void> {
  const byNode = new Map<number, { lines: object[]; isSubagent: boolean }>();
  for (const row of bodyRows) {
    if (!Array.isArray(row.body)) continue;
    const node = byNode.get(row.sessionId) ?? {
      lines: [],
      isSubagent: row.logType === 'claude-subagent',
    };
    for (const line of row.body as unknown[]) {
      if (typeof line === 'object' && line !== null) node.lines.push(line);
    }
    byNode.set(row.sessionId, node);
  }
  for (const [sessionDbId, node] of byNode) {
    await rebuildSessionOkfAccess(
      db,
      sessionDbId,
      node.lines,
      rootsOf(sessionDbId),
      node.isSubagent,
    );
  }
}
