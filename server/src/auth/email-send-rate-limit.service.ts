import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';
import { TooManyRequestsException } from './exceptions/too-many-requests.exception';

/** Emails a single source IP may trigger per hour in strict-managed ("Forgot password?"). */
export const EMAIL_SEND_LIMIT_PER_IP_PER_HOUR = 20;

/** Set-password emails one administrator may trigger per hour (create user, resend link). */
export const EMAIL_SEND_LIMIT_PER_ADMIN_PER_HOUR = 100;

/** Share of calls that also delete expired windows, so the table stays small. */
const CLEANUP_SHARE = 0.05;

/**
 * Limit on requests that send an email — auth mode `strict-managed` only;
 * every other mode is unaffected (both methods are no-ops there).
 *
 * Fixed one-hour windows in `email_send_counters`, so every cluster worker
 * counts against the same budget. Anonymous requests are keyed by client IP,
 * admin actions by the admin's user id: a flood of anonymous requests from
 * behind the same proxy cannot block an administrator's create / resend.
 *
 * Callers run their other rate limits and DTO validation first, then the
 * limit, then any account lookup, so an unknown email counts the same as a
 * known one.
 */
@Injectable()
export class EmailSendRateLimitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Counts one anonymous email-sending request from `ip`; 429 once over the
   * limit. The key holds a hash of the IP: behind `TRUST_PROXY=true` the
   * value comes from a client-controlled header and can be any length.
   */
  async consumeIp(ip: string): Promise<void> {
    const ipHash = createHash('sha256').update(ip, 'utf8').digest('hex');
    await this.consume(`ip:${ipHash}`, EMAIL_SEND_LIMIT_PER_IP_PER_HOUR);
  }

  /** Counts one admin-triggered email; 429 once over the limit. */
  async consumeAdmin(adminUserId: number): Promise<void> {
    await this.consume(
      `admin:${adminUserId}`,
      EMAIL_SEND_LIMIT_PER_ADMIN_PER_HOUR,
    );
  }

  private async consume(key: string, limit: number): Promise<void> {
    if (process.env.AUTH_MODE !== 'strict-managed') return;

    // In ON CONFLICT ... SET every expression reads the row's old values, so
    // both CASEs see the same (old) window_start.
    const result = await this.db.execute<{
      count: number;
      seconds_left: string;
    }>(sql`
      insert into email_send_counters (key, window_start, count)
      values (${key}, now(), 1)
      on conflict (key) do update set
        count = case
          when email_send_counters.window_start <= now() - interval '1 hour' then 1
          else email_send_counters.count + 1
        end,
        window_start = case
          when email_send_counters.window_start <= now() - interval '1 hour' then now()
          else email_send_counters.window_start
        end
      returning count,
        extract(epoch from (window_start + interval '1 hour' - now())) as seconds_left
    `);

    if (Math.random() < CLEANUP_SHARE) {
      await this.db.execute(
        sql`delete from email_send_counters where window_start <= now() - interval '1 hour'`,
      );
    }

    const row = result.rows[0];
    if (row && Number(row.count) > limit) {
      throw new TooManyRequestsException(
        Math.max(1, Math.ceil(Number(row.seconds_left))),
      );
    }
  }
}
