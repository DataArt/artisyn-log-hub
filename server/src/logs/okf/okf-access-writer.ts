/**
 * The OKF writer — the ONLY code that writes `session_okf_access`, `session_okf_event`,
 * `session_okf_pointer` and the `sessions.okf_extract_version` / `okf_events_truncated` marker
 * (FR-3, impl-plan DD-9 of the OKF tab; DD-1, DD-11 of the OKF value-signals task).
 *
 * Called from every place `writeSessionFileStats` is called, with the same repo roots:
 * ingest (`LogsService.upsert()` Step 3b), import (`LogsService.writeImportedLog()`), the
 * claude-before-artisyn heal (`rewriteSessionTreeFileStats`) and the scope-independent backfill
 * (`RepositoriesService.recomputeAllSessionStats()` → `recomputeOkfAccess`). It is NOT called from
 * the per-file-category-scope recompute: OKF rows have no scope, one row set per node. Each caller
 * passes its own db / tx handle, which also reads the root's bound snapshot
 * (`loadSnapshotFilesForNode`), so an import sees the snapshot its own transaction bound.
 *
 * Writer contract: per node, `DELETE` its rows, then insert the new set. The insert keeps
 * `ON CONFLICT … DO UPDATE` on each table's unique key, because the heal touches descendant
 * nodes it never locks and the backfill runs outside a transaction — a concurrent writer for the
 * same node must not hit a unique violation.
 */
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  sessionOkfAccess,
  sessionOkfEvent,
  sessionOkfPointer,
  sessions,
} from '../../database/schema/index';
import { topAncestorIdsSql } from '../session-tree.sql';
import {
  extractOkfDetail,
  type OkfAccessRow,
  type OkfEventRow,
  type OkfPointerRow,
  type OkfSnapshotFileInfo,
} from './okf-access-extractor';
import {
  OKF_EXTRACT_VERSION,
  OKF_PATH_MAX_CHARS,
  OKF_PATTERN_MAX_CHARS,
  OKF_POINTER_MAX_CHARS,
} from './okf-constants';
import { normaliseSnapshot } from './okf-snapshot';
import { getServerBashParser } from './server-bash-parser';

/** Rows per INSERT statement (at most 10 parameters each, far below the Postgres parameter cap). */
const INSERT_CHUNK = 1000;

/** Width of `session_okf_pointer.article_hash`. */
const ARTICLE_HASH_MAX_CHARS = 128;

/**
 * Defensive: keeps the last row per unique key, so one INSERT never touches the same conflict
 * row twice (Postgres rejects that even with `ON CONFLICT DO UPDATE`). The extractor already
 * de-duplicates; this only guards the ingest transaction against a future extractor slip.
 */
function lastPerKey<T>(rows: readonly T[], keyOf: (r: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) byKey.set(keyOf(r), r);
  return [...byKey.values()];
}

/**
 * Files of the snapshot bound to the node's tree ROOT (DD-21 of the OKF tab), keyed by
 * repo-relative path → `{ size, hash }`. The body is the one stored for the root's uploader.
 * `undefined` when the root has no bound or stored snapshot — the extractor then uses the even
 * byte split and treats every `.md` file as a KB article (DD-5, DD-7).
 */
export async function loadSnapshotFilesForNode(
  db: DrizzleDb,
  sessionDbId: number,
): Promise<ReadonlyMap<string, OkfSnapshotFileInfo> | undefined> {
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
  return files;
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

/** Replaces the `session_okf_event` rows of one tree node with `rows` (DD-5). */
export async function writeSessionOkfEvents(
  db: DrizzleDb,
  sessionDbId: number,
  eventRows: readonly OkfEventRow[],
): Promise<void> {
  await db
    .delete(sessionOkfEvent)
    .where(eq(sessionOkfEvent.sessionId, sessionDbId));
  // Column widths: an over-long path is dropped (DD-0), a pattern is cut (DD-5).
  const rows = lastPerKey(
    eventRows.filter((r) => r.path.length <= OKF_PATH_MAX_CHARS),
    (r) => `${r.ord}\0${r.op}\0${r.path}`,
  ).map((r) => ({
    ...r,
    pattern:
      r.pattern === null ? null : r.pattern.slice(0, OKF_PATTERN_MAX_CHARS),
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    await db
      .insert(sessionOkfEvent)
      .values(
        chunk.map((r) => ({
          sessionId: sessionDbId,
          ord: r.ord,
          op: r.op,
          path: r.path,
          rangeFrom: r.rangeFrom,
          rangeTo: r.rangeTo,
          pattern: r.pattern,
        })),
      )
      .onConflictDoUpdate({
        target: [
          sessionOkfEvent.sessionId,
          sessionOkfEvent.ord,
          sessionOkfEvent.op,
          sessionOkfEvent.path,
        ],
        set: {
          rangeFrom: sql`excluded.range_from`,
          rangeTo: sql`excluded.range_to`,
          pattern: sql`excluded.pattern`,
        },
      });
  }
}

/** Replaces the `session_okf_pointer` rows of one tree node with `rows` (DD-8..DD-10). */
export async function writeSessionOkfPointers(
  db: DrizzleDb,
  sessionDbId: number,
  pointerRows: readonly OkfPointerRow[],
): Promise<void> {
  await db
    .delete(sessionOkfPointer)
    .where(eq(sessionOkfPointer.sessionId, sessionDbId));
  // Column widths: over-long paths are dropped (DD-0), an unexpected hash is stored as unknown.
  const rows = lastPerKey(
    pointerRows.filter(
      (r) =>
        r.articlePath.length <= OKF_PATH_MAX_CHARS &&
        r.pointer.length <= OKF_POINTER_MAX_CHARS,
    ),
    (r) => `${r.readOrd}\0${r.articlePath}\0${r.pointer}`,
  ).map((r) => ({
    ...r,
    articleHash:
      r.articleHash !== null && r.articleHash.length <= ARTICLE_HASH_MAX_CHARS
        ? r.articleHash
        : null,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    await db
      .insert(sessionOkfPointer)
      .values(
        chunk.map((r) => ({
          sessionId: sessionDbId,
          articlePath: r.articlePath,
          articleHash: r.articleHash,
          readOrd: r.readOrd,
          pointer: r.pointer,
          isNew: r.isNew,
          followed: r.followed,
          partial: r.partial,
        })),
      )
      .onConflictDoUpdate({
        target: [
          sessionOkfPointer.sessionId,
          sessionOkfPointer.readOrd,
          sessionOkfPointer.articlePath,
          sessionOkfPointer.pointer,
        ],
        set: {
          articleHash: sql`excluded.article_hash`,
          isNew: sql`excluded.is_new`,
          followed: sql`excluded.followed`,
          partial: sql`excluded.partial`,
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
 * Extracts and writes the OKF rows of one node from its transcript lines: access rows, code
 * events, pointers and the extraction marker. `isSubagentLog` is `true` for a `claude-subagent`
 * log (see `extractOkfDetail`). The root's bound snapshot is read through `db`.
 */
export async function rebuildSessionOkfAccess(
  db: DrizzleDb,
  sessionDbId: number,
  lines: readonly object[],
  repoRoots: readonly string[],
  isSubagentLog: boolean,
): Promise<void> {
  const snapshotFiles = await loadSnapshotFilesForNode(db, sessionDbId);
  const detail = extractOkfDetail(
    lines,
    repoRoots,
    await getServerBashParser(),
    { isSubagentLog, snapshotFiles },
  );
  await writeSessionOkfAccess(db, sessionDbId, detail.access);
  await writeSessionOkfEvents(db, sessionDbId, detail.events);
  await writeSessionOkfPointers(db, sessionDbId, detail.pointers);
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
