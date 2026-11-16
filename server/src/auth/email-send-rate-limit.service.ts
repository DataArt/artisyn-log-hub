import { Injectable } from '@nestjs/common';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { TooManyRequestsException } from './exceptions/too-many-requests.exception';

/** Emails a single source IP may trigger per hour in strict-managed. */
export const EMAIL_SEND_LIMIT_PER_IP_PER_HOUR = 20;

/**
 * Per-IP limit on requests that send an email (forgot password, admin create
 * user, admin resend link) — auth mode `strict-managed` only; every other
 * mode is unaffected (`consumeIp` is a no-op there).
 *
 * In memory and per process: in cluster mode each worker counts on its own.
 * Callers run their other rate limits and DTO validation first, then
 * `consumeIp`, then any account lookup, so an unknown email counts the same
 * as a known one.
 */
@Injectable()
export class EmailSendRateLimitService {
  private readonly limiter = new RateLimiterMemory({
    keyPrefix: 'email-send',
    points: EMAIL_SEND_LIMIT_PER_IP_PER_HOUR,
    duration: 3600,
  });

  /**
   * Counts one email-sending request from `ip`. Throws
   * `TooManyRequestsException` (429 + `Retry-After`) once over the limit.
   */
  async consumeIp(ip: string): Promise<void> {
    if (process.env.AUTH_MODE !== 'strict-managed') return;
    try {
      await this.limiter.consume(ip);
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) {
        throw new TooManyRequestsException(
          Math.max(1, Math.ceil(rejection.msBeforeNext / 1000)),
        );
      }
      throw rejection;
    }
  }
}
