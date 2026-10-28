// OKF snapshot (DD-13..DD-22 in docs/tasks/todo/2026-10-27-okf-usage-tab/impl-plan.md): the
// hook's self-reported inventory of the repo's OKF knowledge-base bundles (each bundle's root,
// `index.md`, and every `.md` file with its ignored flag, size and content hash), uploaded as one
// `okf-snapshot` NDJSON line (full body) plus an `okf-snapshot-ref` line on artisyn uploads of the
// current session. Clone of `../harness-snapshot.ts`: the server never recomputes the hook's
// `okfSnapshotId` (DD-14) — it only format-validates it and stores/loads the body verbatim, keyed
// by (owning user_id, snapshot id). Only the ROOT session of a tree is bound (DD-21); sub-agent
// nodes resolve their root's id via `resolveRootOkfSnapshotId`.
import { Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  okfSnapshots,
  sessions,
  uploadQueue,
} from '../../database/schema/index';
import { PENDING_QUEUE_STATUSES, SNAPSHOT_ID_RE } from '../harness-snapshot';
import { topAncestorIdsSql } from '../session-tree.sql';

const logger = new Logger('OkfSnapshot');

type AnyRecord = Record<string, unknown>;

/** DD-18: the server accepts an OKF snapshot id only if it is 64 lowercase hex chars. */
export const OKF_SNAPSHOT_ID_RE = SNAPSHOT_ID_RE;

/** DD-18: an `okf-snapshot` line whose serialized body exceeds this is ignored (id stays unknown). */
export const OKF_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

/** One `.md` file of a bundle (DD-13). `size` is UTF-8 bytes on disk, `hash` its sha256 hex. */
export interface OkfSnapshotFile {
  path: string;
  ignored: boolean;
  size: number;
  hash: string;
}

/** One OKF bundle (DD-13): rooted by an `index.md` with an `okf_version:` front-matter key. */
export interface OkfSnapshotBundle {
  root: string;
  index: string;
  /** The bundle's `index.md` ignored flag. */
  ignored: boolean;
  files: OkfSnapshotFile[];
}

/**
 * DD-13's `okf-snapshot` event body, minus its `type` discriminant — what
 * {@link extractOkfSnapshot} returns and what `okf_snapshots.body` stores verbatim.
 */
export interface OkfSnapshotBody {
  okfSnapshotId: string;
  schemaVersion: number;
  bundles: OkfSnapshotBundle[];
}

/**
 * Extracts and validates the first `okf-snapshot` line of an artisyn upload. The first line
 * that validates wins; every rejected line is logged, and the upload is still processed
 * otherwise unchanged.
 */
export function extractOkfSnapshot(lines: object[]): OkfSnapshotBody | null {
  for (const line of lines) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'okf-snapshot') continue;

    const id = rec['okfSnapshotId'];
    if (typeof id !== 'string' || !OKF_SNAPSHOT_ID_RE.test(id)) {
      logger.warn(
        `okf-snapshot line rejected: okfSnapshotId is not a 64-char hex string`,
      );
      continue;
    }

    if (rec['schemaVersion'] !== 1) {
      logger.warn(
        `okf-snapshot line rejected (okfSnapshotId ${id.slice(0, 12)}): unsupported schemaVersion ${JSON.stringify(rec['schemaVersion'])}`,
      );
      continue;
    }

    if (!Array.isArray(rec['bundles'])) {
      logger.warn(
        `okf-snapshot line rejected (okfSnapshotId ${id.slice(0, 12)}): bundles must be an array`,
      );
      continue;
    }

    const body: AnyRecord = { ...rec };
    delete body['type'];
    const serializedBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (serializedBytes > OKF_SNAPSHOT_MAX_BYTES) {
      logger.warn(
        `okf-snapshot line rejected (okfSnapshotId ${id.slice(0, 12)}): body is ${serializedBytes} bytes, over the ${OKF_SNAPSHOT_MAX_BYTES} limit`,
      );
      continue;
    }

    return body as unknown as OkfSnapshotBody;
  }
  return null;
}

/** Extracts the first valid `okf-snapshot-ref` id of an artisyn upload (DD-13). */
export function extractOkfSnapshotRef(lines: object[]): string | null {
  for (const line of lines) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'okf-snapshot-ref') continue;
    const id = rec['okfSnapshotId'];
    if (typeof id === 'string' && OKF_SNAPSHOT_ID_RE.test(id)) {
      return id;
    }
  }
  return null;
}

/**
 * Stores one hook-reported OKF snapshot verbatim, scoped to its uploading owner.
 * `ON CONFLICT (user_id, snapshot_id) DO NOTHING` — the id is content-derived and immutable.
 * Returns whether a row was actually inserted (logging only).
 */
export async function storeOkfSnapshot(
  tx: DrizzleDb,
  userId: number,
  body: OkfSnapshotBody,
): Promise<boolean> {
  const inserted = await tx
    .insert(okfSnapshots)
    .values({ userId, snapshotId: body.okfSnapshotId, body })
    .onConflictDoNothing({
      target: [okfSnapshots.userId, okfSnapshots.snapshotId],
    })
    .returning({ id: okfSnapshots.id });
  return inserted.length > 0;
}

/**
 * DD-21: binds a ROOT session to an OKF snapshot id the first time one is known for it —
 * `UPDATE sessions SET okf_snapshot_id = $id WHERE id = $root AND okf_snapshot_id IS NULL`.
 * Never rebound afterwards.
 */
export async function bindSessionOkfSnapshot(
  tx: DrizzleDb,
  rootSessionRowId: number,
  okfSnapshotId: string,
): Promise<boolean> {
  const bound = await tx
    .update(sessions)
    .set({ okfSnapshotId })
    .where(
      and(
        eq(sessions.id, rootSessionRowId),
        sql`${sessions.okfSnapshotId} IS NULL`,
      ),
    )
    .returning({ id: sessions.id });
  return bound.length > 0;
}

/** Loads a stored OKF snapshot body for (owning user, snapshot id), or `null` if not found. */
export async function loadOkfSnapshot(
  db: DrizzleDb,
  userId: number,
  okfSnapshotId: string,
): Promise<OkfSnapshotBody | null> {
  const [row] = await db
    .select({ body: okfSnapshots.body })
    .from(okfSnapshots)
    .where(
      and(
        eq(okfSnapshots.userId, userId),
        eq(okfSnapshots.snapshotId, okfSnapshotId),
      ),
    )
    .limit(1);
  return (row?.body as OkfSnapshotBody | undefined) ?? null;
}

/**
 * DD-22's "known" check (mirrors `isHarnessSnapshotKnown`): true when an `okf_snapshots` row
 * already exists for this owner, or an in-flight `upload_queue` row (status in
 * {@link PENDING_QUEUE_STATUSES}) already carries this id as its `okfSnapshotFull=1` upload.
 */
export async function isOkfSnapshotKnown(
  db: DrizzleDb,
  userId: number,
  okfSnapshotId: string,
): Promise<boolean> {
  const [storedRow] = await db
    .select({ id: okfSnapshots.id })
    .from(okfSnapshots)
    .where(
      and(
        eq(okfSnapshots.userId, userId),
        eq(okfSnapshots.snapshotId, okfSnapshotId),
      ),
    )
    .limit(1);
  if (storedRow) return true;

  const [queuedRow] = await db
    .select({ id: uploadQueue.id })
    .from(uploadQueue)
    .where(
      and(
        eq(uploadQueue.userId, userId),
        eq(uploadQueue.okfSnapshotId, okfSnapshotId),
        inArray(uploadQueue.status, [...PENDING_QUEUE_STATUSES]),
      ),
    )
    .limit(1);
  return queuedRow !== undefined;
}

/**
 * Deletes every `okf_snapshots` row no session references any more, across all owners
 * (orphan test by snapshot id alone, like `deleteOrphanHarnessSnapshots`).
 */
export async function deleteOrphanOkfSnapshots(tx: DrizzleDb): Promise<void> {
  await tx.execute(
    sql`DELETE FROM okf_snapshots os
        WHERE NOT EXISTS (
          SELECT 1 FROM sessions s WHERE s.okf_snapshot_id = os.snapshot_id
        )`,
  );
}

/** A one-element Postgres `bigint[]` literal for {@link topAncestorIdsSql}. */
function singleIdArraySql(id: number) {
  return sql`${`{${id}}`}::bigint[]`;
}

/** The top-ancestor `sessions.id` of a tree node (the node itself for a root). */
export async function resolveRootSessionDbId(
  db: DrizzleDb,
  sessionDbId: number,
): Promise<number> {
  const result = await db.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(singleIdArraySql(sessionDbId))}
    SELECT top_id FROM top_ancestors LIMIT 1
  `);
  const row = result.rows[0] as { top_id: string | number } | undefined;
  return row ? Number(row.top_id) : sessionDbId;
}

/**
 * DD-21: the OKF snapshot id a tree node sees — its TOP ancestor's `sessions.okf_snapshot_id`
 * (sub-agent nodes are never bound themselves). `null` when the root has no snapshot.
 */
export async function resolveRootOkfSnapshotId(
  db: DrizzleDb,
  sessionDbId: number,
): Promise<string | null> {
  const result = await db.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(singleIdArraySql(sessionDbId))}
    SELECT s.okf_snapshot_id
    FROM top_ancestors t
    JOIN sessions s ON s.id = t.top_id
    LIMIT 1
  `);
  const row = result.rows[0] as { okf_snapshot_id: string | null } | undefined;
  return row?.okf_snapshot_id ?? null;
}

/**
 * The ingest/import OKF step (DD-21): stores a full `okf-snapshot` line of this artisyn upload
 * (if any) for `userId`, then binds the tree's ROOT session to the ref id — or the full line's
 * own id when there is no separate ref — only while the root is still unbound. A no-op when the
 * upload carries neither line (old hooks, old zips).
 */
export async function storeAndBindOkfSnapshot(
  tx: DrizzleDb,
  userId: number,
  sessionRowId: number,
  lines: object[],
): Promise<void> {
  const full = extractOkfSnapshot(lines);
  if (full !== null) {
    await storeOkfSnapshot(tx, userId, full);
  }
  const ref = extractOkfSnapshotRef(lines) ?? full?.okfSnapshotId ?? null;
  if (ref === null) return;
  const rootId = await resolveRootSessionDbId(tx, sessionRowId);
  await bindSessionOkfSnapshot(tx, rootId, ref);
}
