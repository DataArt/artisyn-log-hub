import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { textList } from './analytics/scoped-sessions.sql';
import { readOtelStateRow } from './otel/otel-facts-read.sql';
import { computeOtelLiveness } from './otel/otel-facts.reader';
import type {
  SessionLogPart,
  SessionLogPartsManifest,
} from './dto/session-log-parts.dto';
import type { TreeLogRowMeta } from './session-tree-logs-meta';
import { writeChunk } from './streaming/response-stream';

/**
 * Age after which a still-pending upload or re-extract request marks the manifest's derived
 * figures as lagging (DD-14).
 */
export const DERIVED_LAG_MS = 30_000;

/** DD-8: a part's revision — `body_rev` when set, else `'u' + updated_at` in microseconds. */
export function partRev(meta: TreeLogRowMeta): string {
  return meta.bodyRev ?? `u${meta.updatedAtMicros}`;
}

/** DD-12: the part's strong ETag. */
export function partETag(meta: TreeLogRowMeta): string {
  return `"${partRev(meta)}"`;
}

/** True when `If-None-Match` names the part's current ETag (or is `*`). */
export function partNotModified(req: Request, meta: TreeLogRowMeta): boolean {
  const header = req.headers['if-none-match'];
  if (header === undefined) return false;
  const etag = partETag(meta);
  const values = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((v) => v.trim().replace(/^W\//, ''));
  return values.some((v) => v === etag || v === '*');
}

/** True when the request's `Accept-Encoding` admits gzip (not with `q=0`). */
function acceptsGzip(req: Request): boolean {
  const raw = req.headers['accept-encoding'];
  const header = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  for (const token of header.split(',')) {
    const [name, ...params] = token.trim().toLowerCase().split(';');
    if (name.trim() !== 'gzip' && name.trim() !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q !== undefined && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

/** The headers every part answer carries (200 and 304), mirroring `precompressed-static.ts`. */
export function setPartHeaders(res: Response, meta: TreeLogRowMeta): void {
  // Set even when identity is served, so a shared cache never cross-serves encodings.
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', partETag(meta));
  // Revalidate every time: the ETag makes the revalidation a cheap 304.
  res.setHeader('Cache-Control', 'private, no-cache');
}

interface PartBodyRow {
  gz: Buffer | null;
  t: string | null;
  rev: string;
}

/**
 * The session-log parts API (impl-plan DD-11, DD-12, DD-14 of 2026-11-23-session-logs-streaming):
 * the manifest of a session tree's stored log blobs and one blob's body, served from the
 * pre-compressed copy when it is valid.
 */
@Injectable()
export class SessionLogPartsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * DD-11: the manifest — every `meta` row with a body, in DD-5 order, with its DD-8 revision,
   * plus the tree's small figures (`extras`) and the DD-14 lag flag.
   */
  async buildManifest(
    rootRowId: number,
    meta: readonly TreeLogRowMeta[],
    extras: Omit<
      SessionLogPartsManifest,
      'parts' | 'derivedLagging' | 'liveness' | 'serverTime'
    >,
  ): Promise<SessionLogPartsManifest> {
    const parts: SessionLogPart[] = meta
      .filter((m) => !m.bodyIsNull)
      .map((m) => ({
        sessionId: m.sessionId,
        logType: m.logType,
        rev: partRev(m),
        parentSessionId: m.parentSessionId,
        agentDescription: m.agentDescription,
        workflowPhase: m.workflowPhase,
        workflowRunId: m.workflowRunId,
      }));
    const sessionIds = [...new Set(meta.map((m) => m.sessionId))];
    const now = new Date();
    const [derivedLagging, otelState] = await Promise.all([
      this.isDerivedLagging(rootRowId, sessionIds),
      readOtelStateRow(this.db, rootRowId),
    ]);
    return {
      parts,
      subagentStats: extras.subagentStats,
      rootStats: extras.rootStats,
      workflows: extras.workflows,
      turnEndAdvisor: extras.turnEndAdvisor,
      sessionAttribution: extras.sessionAttribution,
      harnessSnapshot: extras.harnessSnapshot,
      derivedLagging,
      liveness: computeOtelLiveness(otelState, now),
      serverTime: now.toISOString(),
    };
  }

  /**
   * DD-14: true when an upload of one of the tree's sessions has waited in the queue, or the
   * root has waited for a re-extract, longer than {@link DERIVED_LAG_MS}.
   */
  private async isDerivedLagging(
    rootRowId: number,
    sessionIds: readonly string[],
  ): Promise<boolean> {
    const lagInterval = `${DERIVED_LAG_MS} milliseconds`;
    const uploadLag =
      sessionIds.length === 0
        ? sql`false`
        : sql`EXISTS (
            SELECT 1 FROM upload_queue uq
            WHERE uq.session_id IN (${textList([...sessionIds])})
              AND uq.status IN ('pending', 'processing')
              AND uq.received_at < now() - ${lagInterval}::interval
          )`;
    const result = await this.db.execute(sql`
      SELECT (${uploadLag}
        OR EXISTS (
          SELECT 1 FROM session_reextract_queue rq
          WHERE rq.session_pk = ${rootRowId}
            AND rq.requested_at < now() - ${lagInterval}::interval
        )) AS lagging
    `);
    const row = (result.rows as unknown as { lagging: boolean }[])[0];
    return row?.lagging === true;
  }

  /**
   * DD-12: writes one part's body (a JSON array of log lines) with a 200. The caller has
   * already answered 404 / 400 / 304 and holds a `LogStreamLimiter` permit.
   *
   * - valid compressed copy, gzip accepted → the stored bytes with `Content-Encoding: gzip`;
   * - valid copy, gzip not accepted → the copy decompressed on the fly;
   * - no valid copy → `body::text`.
   *
   * One query reads either the copy or the text, never both. A row whose body went NULL or
   * vanished since the metadata read answers 404 (nothing has been written yet then).
   */
  async streamPart(
    req: Request,
    res: Response,
    meta: TreeLogRowMeta,
  ): Promise<void> {
    // The ETag names the revision of the bytes actually sent: the row may have been rewritten
    // since the metadata read, and a stale ETag would let a later 304 pin the old body.
    const result = await this.db.execute(sql`
      SELECT CASE WHEN body_rev IS NOT NULL AND body_gz_rev = body_rev
                  THEN body_gz END AS gz,
             CASE WHEN body_rev IS NOT NULL AND body_gz_rev = body_rev AND body_gz IS NOT NULL
                  THEN NULL ELSE body::text END AS t,
             COALESCE(body_rev::text,
                      'u' || ((extract(epoch from updated_at) * 1e6)::bigint)::text) AS rev
        FROM logs
       WHERE id = ${meta.logId}
    `);
    const row = (result.rows as unknown as PartBodyRow[])[0];
    if (row === undefined || (row.gz === null && row.t === null)) {
      throw new NotFoundException('Session log part not found');
    }

    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', `"${row.rev}"`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200);

    if (row.gz !== null) {
      if (acceptsGzip(req)) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(row.gz.length));
        await writeChunk(res, row.gz);
        res.end();
        return;
      }
      const gunzip = Readable.from([row.gz]).pipe(zlib.createGunzip());
      try {
        for await (const chunk of gunzip) {
          if (Buffer.isBuffer(chunk)) await writeChunk(res, chunk);
        }
      } finally {
        gunzip.destroy();
      }
      res.end();
      return;
    }

    if (row.t !== null) await writeChunk(res, row.t);
    res.end();
  }
}
