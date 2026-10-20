import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { Writable } from 'stream';
import { requestContextStorage } from './request-context';

export const SLOW_QUERY_THRESHOLD_MS = 100;

/**
 * Prefix a query's SQL text with this marker (e.g. via `sql.raw(NO_LOG_MARKER)`
 * in a drizzle `sql` template) to suppress its routine `info`-level "SQL
 * query" log line — for high-frequency polling queries (like the upload
 * queue scheduler's per-tick checks) that would otherwise flood the SQL log.
 * Slow-query and error logging still fire regardless of the marker, since
 * those indicate an actual problem worth surfacing.
 */
export const NO_LOG_MARKER = '/* no-log */';

export function isNoLogQuery(sql: string): boolean {
  return sql.trimStart().startsWith(NO_LOG_MARKER);
}

/**
 * Pure day-tag computation — duplicated from app-logger.ts's equivalent
 * (each rotating stream is self-contained by design), extracted so it (and
 * the instance-suffix behavior below) can be unit tested without spinning up
 * a real file stream. `date` defaults to `new Date()` in production use;
 * tests pass a fixed date.
 */
export function computeDayTag(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * See app-logger.ts's `computeInstanceSuffix()` for rationale: suffix with
 * the cluster worker's NODE_APP_INSTANCE when set, so each instance's SQL
 * log rotates to its own file.
 */
export function computeInstanceSuffix(): string {
  return process.env.NODE_APP_INSTANCE !== undefined
    ? `-i${process.env.NODE_APP_INSTANCE}`
    : '';
}

/** Full rotated SQL-log filename for a given day tag, e.g. `sql-2026-01-01-i0.log`. */
export function computeSqlLogFileName(date: Date = new Date()): string {
  return `sql-${computeDayTag(date)}${computeInstanceSuffix()}.log`;
}

class DailyRotateSqlStream extends Writable {
  private dayTag = '';
  private fileStream: fs.WriteStream | null = null;

  constructor(private readonly dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
  }

  private getFileStream(): fs.WriteStream {
    const tag = computeDayTag();
    if (tag !== this.dayTag || !this.fileStream) {
      this.fileStream?.end();
      this.dayTag = tag;
      this.fileStream = fs.createWriteStream(
        path.join(this.dir, computeSqlLogFileName()),
        { flags: 'a' },
      );
    }
    return this.fileStream;
  }

  _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.getFileStream().write(chunk, cb);
  }
}

const sqlPino = pino(
  { level: 'trace', base: null },
  new DailyRotateSqlStream('logs'),
);

export function logSqlQuery(
  sql: string,
  durationMs: number,
  error?: unknown,
): void {
  const ctx = requestContextStorage.getStore();
  const entry = {
    ...(ctx ? { endpoint: ctx.endpoint, callUuid: ctx.callUuid } : {}),
    sql: sql.trim(),
    durationMs,
    ...(error != null
      ? {
          error: error instanceof Error ? error.message : JSON.stringify(error),
        }
      : {}),
  };

  if (error != null) {
    sqlPino.error(entry, 'SQL error');
  } else if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    sqlPino.warn(entry, `Slow query (>${SLOW_QUERY_THRESHOLD_MS}ms)`);
  } else if (!isNoLogQuery(sql)) {
    sqlPino.info(entry, 'SQL query');
  }
}
