import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import type { TreeLogRowMeta } from './session-tree-logs-meta';
import { LogStreamLimiter } from './streaming/log-stream-limiter';
import {
  abortStream,
  StreamAbortedError,
  writeChunk,
} from './streaming/response-stream';

/**
 * Streams session-log responses one log row at a time (impl-plan DD-1, DD-2, DD-4 of
 * 2026-11-23-session-logs-streaming), so a worker holds at most one row's text plus the
 * socket's buffer instead of the whole tree's bodies and the assembled JSON document.
 */
@Injectable()
export class SessionLogsStreamService {
  private readonly logger = new Logger(SessionLogsStreamService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly limiter: LogStreamLimiter,
  ) {}

  /** DD-1: one row's body as text — `null` when the row is gone or its body is NULL. */
  async readBodyText(logId: number): Promise<string | null> {
    const result = await this.db.execute(
      sql`SELECT body::text AS t FROM logs WHERE id = ${logId}`,
    );
    const row = (result.rows as unknown as { t: string | null }[])[0];
    return row?.t ?? null;
  }

  /**
   * Runs `write` under a `LogStreamLimiter` permit (DD-3). Call it after the access checks and
   * the metadata reads — every 4xx must already be thrown — and before the first byte.
   *
   * - The client closing while queued drops the request silently (nothing was sent).
   * - A failure before the first byte is rethrown, so Nest's exception filter answers it.
   * - A failure after the first byte destroys the socket (`abortStream`): the status line is
   *   already out, so a broken connection is the only honest signal left.
   */
  async runLimited(res: Response, write: () => Promise<void>): Promise<void> {
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', onClose);
    let release: (() => void) | undefined;
    try {
      release = await this.limiter.acquire(controller.signal);
      await write();
    } catch (err) {
      if (err instanceof StreamAbortedError) {
        abortStream(res);
        return;
      }
      if (res.headersSent) {
        this.logger.error(
          `Session log stream failed after the first byte: ${err instanceof Error ? err.message : String(err)}`,
        );
        abortStream(res);
        return;
      }
      throw err;
    } finally {
      release?.();
      res.off('close', onClose);
    }
  }

  /**
   * DD-4: writes the legacy `/logs` document, byte-identical to the former single-string
   * answer:
   *
   * `{"main":<artisyn + claude merged>,"subagents":[<entry>,…],<tailJson>}`
   *
   * `rows` is `readTreeLogsMeta` output (root claude/artisyn rows, then `claude-subagent` rows in
   * `sessions.session_id` order). `tailJson` is the members after `subagents` without the leading
   * comma and the closing brace: `"subagentStats":…,"rootStats":…,…,"harnessSnapshot":…`.
   * The caller has already answered 404 / 422 for a missing root claude row or NULL body; a row
   * that changes under the stream (root claude gone) throws, which aborts the response.
   */
  async writeLegacyLogs(
    res: Response,
    rows: readonly TreeLogRowMeta[],
    tailJson: string,
  ): Promise<void> {
    const rootClaude = rows.find((r) => r.isRoot && r.logType === 'claude');
    if (rootClaude === undefined) {
      throw new Error('Root claude log row missing');
    }
    const rootArtisyn = rows.find(
      (r) => r.isRoot && r.logType === 'artisyn' && !r.bodyIsNull,
    );

    await writeChunk(res, '{"main":');

    // Artisyn events (metadata) first, then claude events, without parsing either body: both
    // are JSON arrays, joined by dropping artisyn's closing `]` and claude's opening `[`.
    let artisynWritten = false;
    if (rootArtisyn !== undefined) {
      const a = (await this.readBodyText(rootArtisyn.logId))?.trim() ?? null;
      if (a !== null && a !== '' && a !== '[]') {
        await writeChunk(res, a.slice(0, -1));
        artisynWritten = true;
      }
    }
    const c = (await this.readBodyText(rootClaude.logId))?.trim() ?? null;
    if (c === null) {
      throw new Error('Root claude log body vanished during the stream');
    }
    if (!artisynWritten) {
      await writeChunk(res, c);
    } else if (c === '[]') {
      await writeChunk(res, ']');
    } else {
      await writeChunk(res, ',' + c.slice(1));
    }

    // `parentSessionId` is the DB-authoritative immediate parent (session/agent) — the only
    // reliable source for the client's nesting tree; it is never derived from transcript content.
    await writeChunk(res, ',"subagents":[');
    let first = true;
    for (const row of rows) {
      if (row.logType !== 'claude-subagent' || row.bodyIsNull) continue;
      const body = await this.readBodyText(row.logId);
      if (body === null) continue;
      await writeChunk(
        res,
        `${first ? '' : ','}{"sessionId":${JSON.stringify(row.sessionId)},"parentSessionId":${JSON.stringify(row.parentSessionId)},"agentDescription":${JSON.stringify(row.agentDescription)},"workflowPhase":${JSON.stringify(row.workflowPhase)},"logs":`,
      );
      await writeChunk(res, body);
      await writeChunk(res, '}');
      first = false;
    }
    await writeChunk(res, `],${tailJson}}`);
    res.end();
  }
}
