import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

export type ConsumeResult =
  | { status: 'ok'; userId: number }
  | { status: 'unknown' }
  | { status: 'expired' }
  | { status: 'already_used' };

/**
 * Same shape as the (adapted) PasswordResetTokensService — not a shared
 * generic class, since the two tables already diverge in column naming
 * (consumed_at here vs. used_at on password_reset_tokens, the latter
 * predating the email-confirmation feature).
 */
@Injectable()
export class EmailConfirmationTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async create(userId: number) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    const rows = await this.db
      .insert(schema.emailConfirmationTokens)
      .values({ userId, token, expiresAt })
      .returning();
    return rows[0];
  }

  async issueWithCooldown(
    userId: number,
  ): Promise<
    | { status: 'issued'; token: string }
    | { status: 'cooldown'; retryAfterSeconds: number }
  > {
    return this.db.transaction(async (tx) => {
      // See PasswordResetTokensService.issueWithCooldown for why this lock
      // is required — serializes concurrent issuance attempts for the same
      // user so two racing requests can't both pass the cooldown check.
      await tx.execute(
        sql`select id from ${schema.users} where id = ${userId} for update`,
      );

      const [latest] = await tx
        .select({ createdAt: schema.emailConfirmationTokens.createdAt })
        .from(schema.emailConfirmationTokens)
        .where(eq(schema.emailConfirmationTokens.userId, userId))
        .orderBy(desc(schema.emailConfirmationTokens.createdAt))
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
        .update(schema.emailConfirmationTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(schema.emailConfirmationTokens.userId, userId),
            isNull(schema.emailConfirmationTokens.consumedAt),
          ),
        );

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
      await tx
        .insert(schema.emailConfirmationTokens)
        .values({ userId, token, expiresAt });

      return { status: 'issued', token };
    });
  }

  /**
   * Lookup-then-atomic-consume — see PasswordResetTokensService.consume for
   * the full rationale (a bare atomic UPDATE can't distinguish "unknown" from
   * "already consumed").
   */
  async consume(token: string): Promise<ConsumeResult> {
    const [row] = await this.db
      .select()
      .from(schema.emailConfirmationTokens)
      .where(eq(schema.emailConfirmationTokens.token, token));
    if (!row) return { status: 'unknown' };
    if (row.consumedAt) return { status: 'already_used' };
    if (row.expiresAt.getTime() < Date.now()) return { status: 'expired' };

    const updated = await this.db
      .update(schema.emailConfirmationTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(schema.emailConfirmationTokens.id, row.id),
          isNull(schema.emailConfirmationTokens.consumedAt),
        ),
      )
      .returning({ userId: schema.emailConfirmationTokens.userId });
    if (!updated[0]) return { status: 'already_used' };
    return { status: 'ok', userId: updated[0].userId };
  }
}
