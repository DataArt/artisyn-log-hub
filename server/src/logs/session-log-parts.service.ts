import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { pipeline, Readable } from 'stream';
import * as zlib from 'zlib';
import { acceptsGzip } from '../common/accept-encoding';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { textList } from './analytics/scoped-sessions.sql';
import { readOtelStateRow } from './otel/otel-facts-read.sql';
import { computeOtelLiveness } from './otel/otel-facts.reader';
import type {
  SessionLogPart,
  SessionLogPartsManifest,
} from './dto/session-log-parts.dto';
import { partCacheCounters } from './part-cache/part-cache-counters';
import { PartCacheService } from './part-cache/part-cache.service';
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

/** The revision-only re-check of a cache hit (impl-plan DD-5 step 2). */
interface PartRevRow {
  rev: string | null;
  gz_ok: boolean | null;
}

/** Only numeric `body_rev` revisions are cached (DD-2); legacy `u…` revisions never are. */
const CACHEABLE_REV_RE = /^\d+$/;

function toBuffer(chunk: string | Buffer): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/** Yields an already-read first chunk, then the rest of the iterator, dropping nothing. */
async function* firstThenRest(
  first: Buffer,
  rest: AsyncIterator<string | Buffer>,
): AsyncGenerator<Buffer> {
  yield first;
  for (;;) {
    const next = await rest.next();
    if (next.done === true) return;
    yield toBuffer(next.value);
  }
}

/**
 * The session-log parts API (impl-plan DD-11, DD-12, DD-14 of 2026-11-23-session-logs-streaming):
 * the manifest of a session tree's stored log blobs and one blob's body, served from the
 * pre-compressed copy when it is valid.
 */
@Injectable()
export class SessionLogPartsService {
  private readonly logger = new Logger(SessionLogPartsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly cache: PartCacheService,
  ) {}

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
      tags: extras.tags,
      tagNoise: extras.tagNoise,
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
   *
   * Disk cache (impl-plan DD-5 of 2026-11-24-session-parts-disk-cache):
   *
   * - hit — when the metadata names a numeric revision with a valid copy and
   *   `<cache>/<logId>/<rev>.json.gz` exists, a revision-only query (no body column read)
   *   confirms the copy is still current, and the file is streamed with the same headers
   *   (gzip as is, or gunzipped). A stale revision, or a file whose first read fails, falls
   *   through to the database path; a vanished row answers 404 before anything is written;
   * - miss — the single query above, unchanged; after the answer is sent, a valid numeric-
   *   revision copy is written to the cache in the background (whatever the client accepted).
   */
  async streamPart(
    req: Request,
    res: Response,
    meta: TreeLogRowMeta,
  ): Promise<void> {
    if (this.cache.enabled && meta.bodyRev !== null && meta.gzReady) {
      if (await this.streamFromCache(req, res, meta.logId, meta.bodyRev)) {
        partCacheCounters.hit();
        return;
      }
      partCacheCounters.miss();
    }

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
        this.fillCache(meta.logId, row.rev, row.gz);
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
      this.fillCache(meta.logId, row.rev, row.gz);
      return;
    }

    if (row.t !== null) await writeChunk(res, row.t);
    res.end();
  }

  /** DD-5 step 4: a background cache fill of a served copy with a numeric revision. */
  private fillCache(logId: number, rev: string, gz: Buffer): void {
    if (!CACHEABLE_REV_RE.test(rev)) return;
    this.cache.store(logId, rev, gz);
  }

  /**
   * DD-5 steps 1–3: answers from the cache file when it exists and is still current. Returns
   * false (with nothing written) when the caller must fall through to the database path;
   * throws 404 (with nothing written) when the row is gone.
   */
  private async streamFromCache(
    req: Request,
    res: Response,
    logId: number,
    bodyRev: string,
  ): Promise<boolean> {
    const hit = await this.cache.openForRead(logId, bodyRev);
    if (hit === null) return false;
    try {
      const result = await this.db.execute(sql`
        SELECT body_rev::text AS rev,
               (body_rev IS NOT NULL AND body_gz_rev = body_rev AND body_gz IS NOT NULL) AS gz_ok
          FROM logs
         WHERE id = ${logId}
      `);
      const revRow = (result.rows as unknown as PartRevRow[])[0];
      if (revRow === undefined) {
        throw new NotFoundException('Session log part not found');
      }
      if (revRow.gz_ok !== true || revRow.rev !== bodyRev) return false;

      // Probe the file before any header goes out, so a read failure can still fall back (FR-10).
      const rest = hit.stream[Symbol.asyncIterator]();
      let first: Buffer;
      try {
        const next = await rest.next();
        if (next.done === true) {
          throw new Error('cache file is empty');
        }
        first = toBuffer(next.value);
      } catch (err) {
        this.logger.warn(
          `Part cache read failed for log ${logId}, serving from the database: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }

      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('ETag', `"${bodyRev}"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200);

      if (acceptsGzip(req)) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(hit.size));
        for await (const chunk of firstThenRest(first, rest)) {
          await writeChunk(res, chunk);
        }
      } else {
        await this.writeGunzipped(res, firstThenRest(first, rest));
      }
      res.end();
    } finally {
      hit.stream.destroy();
    }
    this.cache.touchOnHit(hit);
    return true;
  }

  /** Gunzips a gzip byte sequence into the response; a source error rejects the write. */
  private async writeGunzipped(
    res: Response,
    source: AsyncIterable<Buffer>,
  ): Promise<void> {
    const src = Readable.from(source);
    const gunzip = zlib.createGunzip();
    // pipeline destroys the gunzip with the source's error, so the loop below rejects.
    pipeline(src, gunzip, () => undefined);
    try {
      for await (const chunk of gunzip) {
        if (Buffer.isBuffer(chunk)) await writeChunk(res, chunk);
      }
    } finally {
      gunzip.destroy();
      src.destroy();
    }
  }
}
