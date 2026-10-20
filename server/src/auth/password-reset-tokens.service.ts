import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1h — shorter than email-confirmation's 24h
const RESEND_COOLDOWN_MS = 60 * 1000;

export type ConsumeResult =
  | { status: 'ok'; userId: number }
  | { status: 'unknown' }
  | { status: 'expired' }
  | { status: 'already_used' };

@Injectable()
export class PasswordResetTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async create(userId: number) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    const rows = await this.db
      .insert(schema.passwordResetTokens)
      .values({ userId, token, expiresAt })
      .returning();
    return rows[0];
  }

  /**
   * Cooldown-check + invalidate-prior + issue-new in one DB transaction, so
   * two concurrent requests for the same account can't both pass the cooldown
   * check and each invalidate/reissue a token. Returns the new token's plain
   * value, or the remaining cooldown seconds if a prior token is too recent.
   */
  async issueWithCooldown(
    userId: number,
  ): Promise<
    | { status: 'issued'; token: string }
    | { status: 'cooldown'; retryAfterSeconds: number }
  > {
    return this.db.transaction(async (tx) => {
      // Locks the user row for the duration of this transaction, serializing
      // two concurrent issuance attempts for the same user — without this,
      // both could read "no recent token" under READ COMMITTED and each
      // insert their own row, defeating both the cooldown and the
      // invalidate-prior guarantee (requirements.md: "two concurrent resend
      // requests ... cannot both pass the cooldown check").
      await tx.execute(
        sql`select id from ${schema.users} where id = ${userId} for update`,
      );

      const [latest] = await tx
        .select({ createdAt: schema.passwordResetTokens.createdAt })
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.userId, userId))
        .orderBy(desc(schema.passwordResetTokens.createdAt))
        .limit(1);
      if (latest) {
        const elapsedMs = Date.now() - latest.createdAt.getTime();
        if (elapsedMs < RESEND_COOLDOWN_MS) {
          return {
            status: 'cooldown',
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000),
            ),
          };
        }
      }

      await tx
        .update(schema.passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.passwordResetTokens.userId, userId),
            isNull(schema.passwordResetTokens.usedAt),
          ),
        );

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
      await tx
        .insert(schema.passwordResetTokens)
        .values({ userId, token, expiresAt });

      return { status: 'issued', token };
    });
  }

  /**
   * Lookup-then-atomic-consume: a bare atomic UPDATE can't distinguish
   * "unknown token" from "already used", so this reads the row by token
   * first, then only attempts the atomic consume when it's still eligible.
   * Two concurrent calls with the same valid token still resolve to exactly
   * one 'ok' and one 'already_used' — the second call's UPDATE affects zero
   * rows because the first already set used_at.
   */
  async consume(token: string): Promise<ConsumeResult> {
    const [row] = await this.db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.token, token));
    if (!row) return { status: 'unknown' };
    if (row.usedAt) return { status: 'already_used' };
    if (row.expiresAt.getTime() < Date.now()) return { status: 'expired' };

    const updated = await this.db
      .update(schema.passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.passwordResetTokens.id, row.id),
          isNull(schema.passwordResetTokens.usedAt),
        ),
      )
      .returning({ userId: schema.passwordResetTokens.userId });
    if (!updated[0]) return { status: 'already_used' };

    // Pre-existing behavior: a successful reset makes any other still-
    // outstanding link for this user moot too. Mostly a no-op now that
    // issueWithCooldown() already invalidates the prior token at issuance
    // time, but kept as a defensive backstop.
    await this.db
      .update(schema.passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.passwordResetTokens.userId, updated[0].userId),
          isNull(schema.passwordResetTokens.usedAt),
        ),
      );

    return { status: 'ok', userId: updated[0].userId };
  }
}
