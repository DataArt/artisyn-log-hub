import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';

/**
 * Prunes rows from the `auth_sessions` session store so that a security event
 * (password change, account deletion) actually invalidates the user's other
 * devices instead of only the current one.
 *
 * Two things about this file are deliberate:
 *
 * 1. **Raw SQL, not Drizzle.** `auth_sessions` is created and owned by
 *    `connect-pg-simple` (`app.module.ts` — `tableName: 'auth_sessions'`,
 *    `createTableIfMissing: true`), so it has no entry in
 *    `server/src/database/schema/index.ts` and can only be reached through
 *    `sql` templates.
 * 2. **The user id is compared as a string.** `SessionSerializer.serializeUser`
 *    stores the bare numeric id (`session.serializer.ts:13-18`), so Passport
 *    writes `{"passport":{"user":5}}` into the `sess` JSON column and
 *    `sess -> 'passport' ->> 'user'` yields the *text* `'5'`. Binding a JS
 *    number on the right-hand side would make Postgres try `text = integer`
 *    and raise `operator does not exist`, so the id is stringified first and
 *    the comparison stays text-to-text.
 *
 * Every method swallows its errors: by the time these run,
 * the password change / account deletion has already committed, so a failure
 * to prune stale session rows must not turn a successful request into a 500.
 */
@Injectable()
export class AuthSessionsService {
  private readonly logger = new Logger(AuthSessionsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Signs the user out everywhere except the session that made the request
   * (identified by its `sid`, i.e. `req.sessionID`).
   */
  async deleteOtherSessionsForUser(
    userId: number,
    keepSid: string,
  ): Promise<void> {
    try {
      await this.db.execute(
        sql`delete from auth_sessions
            where (sess -> 'passport' ->> 'user') = ${String(userId)}
              and sid <> ${keepSid}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to invalidate other sessions for user id=${userId}: ${String(err)}`,
      );
    }
  }

  /** Signs the user out everywhere, including the current session. */
  async deleteAllSessionsForUser(userId: number): Promise<void> {
    try {
      await this.db.execute(
        sql`delete from auth_sessions
            where (sess -> 'passport' ->> 'user') = ${String(userId)}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to invalidate all sessions for user id=${userId}: ${String(err)}`,
      );
    }
  }
}
