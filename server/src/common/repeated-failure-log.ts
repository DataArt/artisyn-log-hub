import type { Logger } from '@nestjs/common';

/**
 * Logs a periodic sweep's failures without flooding the error log: the first
 * failure with a given message is an ERROR, an identical repeat goes to DEBUG,
 * and the first success after failures logs one INFO and resets the state.
 *
 * The key is the error message compared with the previous failure only, so
 * A, B, A logs three ERRORs. State is in memory per worker: a restart (or
 * another cluster worker) logs the first failure again.
 */
export class RepeatedFailureLog {
  private lastKey: string | null = null;
  private failedCount = 0;

  constructor(
    private readonly logger: Logger,
    private readonly label: string,
  ) {}

  failed(err: unknown): void {
    const key = err instanceof Error ? err.message : String(err);
    this.failedCount++;
    if (key !== this.lastKey) {
      this.logger.error(
        `${this.label} failed: ${key} (repeats suppressed until the sweep recovers)`,
        err instanceof Error ? err.stack : undefined,
      );
      this.lastKey = key;
    } else {
      this.logger.debug(`${this.label} failed again: ${key}`);
    }
  }

  succeeded(): void {
    if (this.failedCount > 0) {
      this.logger.log(
        `${this.label} recovered after ${this.failedCount} failed sweeps`,
      );
    }
    this.lastKey = null;
    this.failedCount = 0;
  }
}
