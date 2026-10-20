import { Injectable } from '@nestjs/common';
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible';
import { TooManyRequestsException } from './exceptions/too-many-requests.exception';

/**
 * Huge budget on purpose: `rate-limiter-flexible` is used here only as a
 * counter + TTL store, never as a rejecter. The `0s / 1s / 2s / 3s …` schedule
 * is computed from `consumedPoints` and applied with `gate.block()`, so the
 * limiter must never reject a `consume()` on its own.
 */
const POINTS_BUDGET = 1_000_000;

/**
 * A counter is forgotten this long after its FIRST failure (bounded memory). The window is fixed,
 * not sliding: later failures add to the count but do not extend it (rate-limiter-flexible keeps
 * the first expiry).
 */
const COUNTER_DURATION_SECONDS = 900;

function msLeft(res: RateLimiterRes | null): number {
  if (res === null) return 0;
  return Math.max(0, res.msBeforeNext);
}

/**
 * Progressive login delay.
 *
 * Two dimensions are tracked independently — the account (by lowercased email)
 * and the source IP — and the applied delay is `max(account, ip)`.
 *
 * Schedule, per dimension: the 1st failure costs nothing, the 2nd blocks for
 * 1s, the 3rd for 2s, the 4th for 3s, and so on (`consumedPoints - 1`).
 *
 * State is per-process and in memory only: a restart forgives everyone, and a
 * multi-worker deployment tracks a fraction of the attempts per worker. That is
 * the accepted trade-off — this is a brute-force speed bump, not a lockout.
 */
@Injectable()
export class LoginBackoffService {
  /** Consecutive-failure count per key. */
  private readonly counter = new RateLimiterMemory({
    points: POINTS_BUDGET,
    duration: COUNTER_DURATION_SECONDS,
  });

  /**
   * Currently applied delay per key. The 1s `duration` is only a floor —
   * `block(key, seconds)` force-sets the real expiry, and `get()` reports the
   * time left through `msBeforeNext`.
   */
  private readonly gate = new RateLimiterMemory({
    points: POINTS_BUDGET,
    duration: 1,
  });

  /**
   * Off under `NODE_ENV=test`, the same escape hatch `app.module.ts:52` and
   * `utils/password-policy.ts` already use.
   *
   * Reason: a test run drives ONE shared app process (the contract suite's
   * app) from 127.0.0.1, so the per-IP dimension would accumulate every
   * deliberately-failed login in the run and start 429-ing unrelated cases'
   * legitimate logins. The schedule
   * itself is covered by `login-backoff.service.algo.spec.ts` (rows from
   * docs/knowledgebase/algorithms/login-backoff.md), which subclasses this
   * service and overrides this getter to `true` — hence `protected`, and hence
   * a getter rather than a field read once in the constructor.
   */
  protected get enabled(): boolean {
    return process.env.NODE_ENV !== 'test';
  }

  private accountKey(email: string): string {
    return `a:${email.trim().toLowerCase()}`;
  }

  private ipKey(ip: string): string {
    return `i:${ip}`;
  }

  /**
   * Throws `TooManyRequestsException` when either dimension is still serving a
   * delay, without touching the counters — a request rejected here must not
   * extend its own penalty.
   */
  async assertNotDelayed(email: string, ip: string): Promise<void> {
    if (!this.enabled) return;
    const [account, source] = await Promise.all([
      this.gate.get(this.accountKey(email)),
      this.gate.get(this.ipKey(ip)),
    ]);
    const ms = Math.max(msLeft(account), msLeft(source));
    if (ms > 0) {
      throw new TooManyRequestsException(Math.ceil(ms / 1000));
    }
  }

  /**
   * Records one failed attempt on both dimensions and returns the larger delay
   * (in seconds) now in force — 0 when this was the first failure on both.
   */
  async recordFailure(email: string, ip: string): Promise<number> {
    if (!this.enabled) return 0;
    const applied = await Promise.all([
      this.applyDelay(this.accountKey(email)),
      this.applyDelay(this.ipKey(ip)),
    ]);
    return Math.max(0, ...applied);
  }

  /**
   * Clears the account's counter and delay. The IP keys are deliberately left
   * alone: one good login must not wipe the history of an IP that is walking
   * through other accounts.
   */
  async recordSuccess(email: string): Promise<void> {
    if (!this.enabled) return;
    const key = this.accountKey(email);
    await Promise.all([this.counter.delete(key), this.gate.delete(key)]);
  }

  private async applyDelay(key: string): Promise<number> {
    const failures = await this.countFailure(key);
    const seconds = failures - 1;
    if (seconds < 1) return 0;
    await this.gate.block(key, seconds);
    return seconds;
  }

  /**
   * `consume()` rejects (with a `RateLimiterRes`, not an `Error`) once the
   * budget is exhausted. That needs ~1M failures on one key inside the window,
   * but an unhandled rejection there would turn a failed login into a 500, so
   * the count is read off the rejection instead.
   */
  private async countFailure(key: string): Promise<number> {
    try {
      const res = await this.counter.consume(key);
      return res.consumedPoints;
    } catch (rejection) {
      const res = rejection as Partial<RateLimiterRes>;
      return typeof res?.consumedPoints === 'number'
        ? res.consumedPoints
        : POINTS_BUDGET;
    }
  }
}
