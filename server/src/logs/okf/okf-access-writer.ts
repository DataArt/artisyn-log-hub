/**
 * The OKF writer — the ONLY code that writes `session_okf_access` and the
 * `sessions.okf_extract_version` / `okf_events_truncated` marker (FR-3, impl-plan DD-9 of the
 * OKF tab; DD-11 of the OKF value-signals task). `session_okf_event` and `session_okf_pointer`
 * are no longer written since 2026-11-21: rows already there are left alone (the session delete
 * still removes them) until a follow-up task drops both tables.
 *
 * Called from every place `writeSessionFileStats` is called, with the same repo roots:
 * ingest (`LogsService.upsert()` Step 3b), import (`LogsService.writeImportedLog()`), the
 * claude-before-artisyn heal (`rewriteSessionTreeFileStats`) and the scope-independent backfill
 * (`RepositoriesService.recomputeAllSessionStats()` → `recomputeOkfAccess`). It is NOT called from
 * the per-file-category-scope recompute: OKF rows have no scope, one row set per node. Each caller
 * passes its own db / tx handle, which also reads the root's bound snapshot
 * (`loadSnapshotForNode`), so an import sees the snapshot its own transaction bound.
 *
 * Writer contract: per node, `DELETE` its rows, then insert the new set. The insert keeps
 * `ON CONFLICT … DO UPDATE` on the table's unique key, because the heal touches descendant
 * nodes it never locks and the backfill runs outside a transaction — a concurrent writer for the
 * same node must not hit a unique violation.
 */
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { sessionOkfAccess, sessions } from '../../database/schema/index';
import { topAncestorIdsSql } from '../session-tree.sql';
import {
  extractOkfDetail,
  type OkfAccessRow,
  type OkfSnapshotFileInfo,
} from './okf-access-extractor';
import { OKF_EXTRACT_VERSION } from './okf-constants';
import { normaliseSnapshot } from './okf-snapshot';
import { getServerBashParser } from './server-bash-parser';

/** Rows per INSERT statement (at most 10 parameters each, far below the Postgres parameter cap). */
const INSERT_CHUNK = 1000;

/** What the extractor needs from the node's bound snapshot (DD-P6). */
export interface OkfNodeSnapshot {
  /** Files keyed by repo-relative path → `{ size, hash }`. */
  files: ReadonlyMap<string, OkfSnapshotFileInfo>;
  /** `root` of every bundle (pointer resolution against the article's bundle root). */
  bundleRoots: string[];
}

/**
 * Files and bundle roots of the snapshot bound to the node's tree ROOT (DD-21 of the OKF tab;
 * DD-P6). The body is the one stored for the root's uploader. `undefined` when the root has no
 * bound or stored snapshot — the extractor then uses the even byte split, treats every `.md`
 * file as a KB article and resolves rooted pointers against the repo root (DD-5, DD-7, DD-P4).
 */
export async function loadSnapshotForNode(
  db: DrizzleDb,
  sessionDbId: number,
): Promise<OkfNodeSnapshot | undefined> {
  const result = await db.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(sql`${`{${sessionDbId}}`}::bigint[]`)}
    SELECT os.body
    FROM top_ancestors t
    JOIN sessions s ON s.id = t.top_id
    JOIN okf_snapshots os ON os.snapshot_id = s.okf_snapshot_id
    WHERE s.okf_snapshot_id IS NOT NULL
      AND os.user_id IN (SELECT l.user_id FROM logs l WHERE l.session_id = s.id)
    LIMIT 1
  `);
  const row = result.rows[0] as { body: unknown } | undefined;
  const body = row === undefined ? null : normaliseSnapshot(row.body);
  if (body === null) return undefined;
  const files = new Map<string, OkfSnapshotFileInfo>();
  for (const bundle of body.bundles) {
    for (const f of bundle.files) {
      if (files.has(f.path)) continue;
      files.set(f.path, {
        size: Number.isFinite(f.size) && f.size >= 0 ? f.size : null,
        hash: f.hash === '' ? null : f.hash,
      });
    }
  }
  return { files, bundleRoots: body.bundles.map((b) => b.root) };
}

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
          rangedCalls: r.rangedCalls,
          rangedBytes: r.rangedBytes,
          searchHits: r.searchHits,
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
          rangedCalls: sql`excluded.ranged_calls`,
          rangedBytes: sql`excluded.ranged_bytes`,
          searchHits: sql`excluded.search_hits`,
        },
      });
  }
}

/** DD-11: marks the node as extracted at {@link OKF_EXTRACT_VERSION}, even with zero rows. */
async function writeOkfExtractMarker(
  db: DrizzleDb,
  sessionDbId: number,
  truncated: boolean,
): Promise<void> {
  await db
    .update(sessions)
    .set({
      okfExtractVersion: OKF_EXTRACT_VERSION,
      okfEventsTruncated: truncated,
    })
    .where(eq(sessions.id, sessionDbId));
}

/**
 * Extracts and writes the OKF rows of one node from its transcript lines: the access rows and
 * the extraction marker (with the extractor's `truncated` flag). `isSubagentLog` is `true` for
 * a `claude-subagent` log (see `extractOkfDetail`). The root's bound snapshot is read through
 * `db`.
 */
export async function rebuildSessionOkfAccess(
  db: DrizzleDb,
  sessionDbId: number,
  lines: readonly object[],
  repoRoots: readonly string[],
  isSubagentLog: boolean,
): Promise<void> {
  const snapshot = await loadSnapshotForNode(db, sessionDbId);
  const detail = extractOkfDetail(
    lines,
    repoRoots,
    await getServerBashParser(),
    {
      isSubagentLog,
      snapshotFiles: snapshot?.files,
      bundleRoots: snapshot?.bundleRoots,
    },
  );
  await writeSessionOkfAccess(db, sessionDbId, detail.access);
  await writeOkfExtractMarker(db, sessionDbId, detail.truncated);
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
