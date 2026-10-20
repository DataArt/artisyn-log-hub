import { LoggerService } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import pino, { Logger } from 'pino';
import PinoPretty from 'pino-pretty';
import { Writable } from 'stream';
import { LogbackTransform } from './logback-formatter';

/**
 * Pure day-tag computation, extracted so it (and the instance-suffix
 * behavior below) can be unit tested without spinning up a real file stream.
 * `date` defaults to `new Date()` in production use; tests pass a fixed date.
 */
export function computeDayTag(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Cluster workers set NODE_APP_INSTANCE (0, 1, 2, ...) — suffix the log
 * filename so each instance's log rotates to its own file instead of
 * interleaving into a shared one. Unset locally, so dev output is unchanged.
 */
export function computeInstanceSuffix(): string {
  return process.env.NODE_APP_INSTANCE !== undefined
    ? `-i${process.env.NODE_APP_INSTANCE}`
    : '';
}

/**
 * Same NODE_APP_INSTANCE signal as computeInstanceSuffix(), formatted for the
 * console line itself rather than a filename — all cluster workers share one
 * stdout stream (unlike the per-instance log files), so without this prefix
 * their interleaved lines are indistinguishable. Empty outside cluster mode.
 */
export function computeInstancePrefix(): string {
  return process.env.NODE_APP_INSTANCE !== undefined
    ? `[i${process.env.NODE_APP_INSTANCE}] `
    : '';
}

/** Full rotated app-log filename for a given day tag, e.g. `app-2026-01-01-i0.log`. */
export function computeAppLogFileName(date: Date = new Date()): string {
  return `app-${computeDayTag(date)}${computeInstanceSuffix()}.log`;
}

// Daily rotating file stream — works in ncc bundles unlike pino-roll transport workers
class DailyRotateStream extends Writable {
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
        path.join(this.dir, computeAppLogFileName()),
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

function createLogger(): Logger {
  const prettyStream = PinoPretty({
    colorize: true,
    ignore: 'pid,hostname,context',
    messageFormat: (log, messageKey) => {
      const ctx =
        typeof log.context === 'string' && log.context
          ? `{${log.context}} `
          : '';
      const rawMsg = log[messageKey];
      let msg: string;
      if (rawMsg === null || rawMsg === undefined) {
        msg = '';
      } else if (typeof rawMsg === 'object') {
        msg = JSON.stringify(rawMsg);
      } else if (
        typeof rawMsg === 'string' ||
        typeof rawMsg === 'number' ||
        typeof rawMsg === 'boolean' ||
        typeof rawMsg === 'bigint'
      ) {
        msg = String(rawMsg);
      } else {
        msg = '';
      }
      return `${computeInstancePrefix()}${ctx}${msg}`;
    },
  });
  const fileRotate = new DailyRotateStream('logs');
  const logbackTransform = new LogbackTransform();
  logbackTransform.pipe(fileRotate);
  return pino(
    { level: 'trace' },
    pino.multistream([
      { stream: prettyStream, level: 'trace' },
      { stream: logbackTransform, level: 'trace' },
    ]),
  );
}

const logger = createLogger();

export class AppLogger implements LoggerService {
  log(message: unknown, context?: string) {
    logger.info({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string) {
    logger.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: string) {
    logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string) {
    logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string) {
    logger.trace({ context }, String(message));
  }

  fatal(message: unknown, context?: string) {
    logger.fatal({ context }, String(message));
  }
}
