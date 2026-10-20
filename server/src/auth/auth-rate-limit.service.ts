import { Injectable } from '@nestjs/common';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { TooManyRequestsException } from './exceptions/too-many-requests.exception';

/** Route names used as the first segment of every limiter key. */
export const AUTH_RATE_LIMIT_ROUTES = {
  signup: 'signup',
  forgot: 'forgot',
  resend: 'resend',
  reset: 'reset',
} as const;

export type AuthRateLimitRoute =
  (typeof AUTH_RATE_LIMIT_ROUTES)[keyof typeof AUTH_RATE_LIMIT_ROUTES];

const DEFAULT_POINTS = 5;
const DEFAULT_WINDOW_SEC = 900;

/** Non-negative integer from env, else the default. */
function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Positive integer from env, else the default. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = readNonNegativeInt(raw, fallback);
  return value > 0 ? value : fallback;
}

/**
 * Per-IP and per-email request limits for the unauthenticated auth routes
 * that send email or accept a token: signup, forgot-password,
 * resend-confirmation and reset-password (open-source readiness).
 *
 * - `AUTH_RATE_LIMIT_POINTS` (default 5; `0` disables limiting) requests per
 *   `AUTH_RATE_LIMIT_WINDOW_SEC` (default 900) per key.
 * - Keys: `<route>:i:<ip>` and `<route>:a:<lowercased email>`.
 *
 * Both settings are read once in the constructor, so each app instance gets
 * its own limiter. State is in memory and per process: in cluster mode each
 * worker counts on its own, so the effective limit is about N × the limit.
 */
@Injectable()
export class AuthRateLimitService {
  private readonly points = readNonNegativeInt(
    process.env.AUTH_RATE_LIMIT_POINTS,
    DEFAULT_POINTS,
  );
  private readonly windowSec = readPositiveInt(
    process.env.AUTH_RATE_LIMIT_WINDOW_SEC,
    DEFAULT_WINDOW_SEC,
  );
  private readonly limiter: RateLimiterMemory | null =
    this.points > 0
      ? new RateLimiterMemory({
          points: this.points,
          duration: this.windowSec,
        })
      : null;

  /**
   * Counts one request from `ip` on `route`. Throws
   * `TooManyRequestsException` (429 + `Retry-After`) once over the limit.
   */
  async consumeIp(route: AuthRateLimitRoute, ip: string): Promise<void> {
    const res = await this.consume(`${route}:i:${ip}`);
    if (res !== null) {
      throw new TooManyRequestsException(
        Math.max(1, Math.ceil(res.msBeforeNext / 1000)),
      );
    }
  }

  /**
   * Counts one request for `email` on `route`. Returns `false` when over the
   * limit and never throws — the caller decides how to answer.
   */
  async consumeEmail(
    route: AuthRateLimitRoute,
    email: string,
  ): Promise<boolean> {
    const res = await this.consume(`${route}:a:${email.trim().toLowerCase()}`);
    return res === null;
  }

  /**
   * Retry-After for an email-limited signup: the time left on that key, read
   * without consuming another point. 1s when nothing is recorded.
   */
  async emailRetryAfterSeconds(
    route: AuthRateLimitRoute,
    email: string,
  ): Promise<number> {
    if (!this.limiter) return 1;
    const res = await this.limiter.get(
      `${route}:a:${email.trim().toLowerCase()}`,
    );
    return Math.max(1, Math.ceil((res?.msBeforeNext ?? 0) / 1000));
  }

  /**
   * `null` when the request is within the limit; the rejection's
   * `RateLimiterRes` when it is over. A memory limiter only rejects with a
   * `RateLimiterRes`, but anything else is rethrown rather than swallowed.
   */
  private async consume(key: string): Promise<RateLimiterRes | null> {
    if (!this.limiter) return null;
    try {
      await this.limiter.consume(key);
      return null;
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) return rejection;
      throw rejection;
    }
  }
}
