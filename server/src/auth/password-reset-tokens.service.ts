import { createHash, randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';
import type { PasswordLinkPurpose } from '../database/schema';
import { RESET_LINK_TTL_MS } from './password-link-ttl';

const RESEND_COOLDOWN_MS = 60 * 1000;

/** A fresh random link token — goes into the emailed link, never into the DB. */
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What `password_reset_tokens.token` stores for a link token: its sha256 as
 * 64 lowercase hex chars, so a DB read never yields a usable link. Migration
 * 0094 hashed the rows written before it the same way.
 */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type ConsumeResult =
  | { status: 'ok'; userId: number }
  | { status: 'unknown' }
  | { status: 'expired' }
  | { status: 'already_used' };

type TokenRow = typeof schema.passwordResetTokens.$inferSelect;

@Injectable()
export class PasswordResetTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** Issues a token with no cooldown and no invalidation; returns its plain value. */
  async create(
    userId: number,
    ttlMs: number = RESET_LINK_TTL_MS,
    purpose: PasswordLinkPurpose = 'reset',
  ): Promise<{ token: string }> {
    const token = generateResetToken();
    await this.db.insert(schema.passwordResetTokens).values({
      userId,
      token: hashResetToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
      purpose,
    });
    return { token };
  }

  /**
   * Cooldown-check + invalidate-prior + issue-new in one DB transaction, so
   * two concurrent requests for the same account can't both pass the cooldown
   * check and each invalidate/reissue a token. Returns the new token's plain
   * value, or the remaining cooldown seconds if a prior token is too recent.
   *
   * - `set` (admin-issued, 24 h): the cooldown counts only earlier `set`
   *   links that still work, so an anonymous "Forgot password?" never blocks
   *   the admin's "Resend link", nor does a link an email rename retired;
   *   every earlier link stops working.
   * - `reset` ("Forgot password?", 1 h): the cooldown counts any link; only
   *   earlier `reset` links stop working, so an anonymous request cannot
   *   cancel an admin-issued set-password link.
   *
   * `expectedEmail`: the address the caller is about to mail the link to.
   * If the account's email no longer matches once the row is locked (an
   * admin renamed it meanwhile), nothing is issued (`stale`) — the link
   * would go to the old address.
   */
  async issueWithCooldown(
    userId: number,
    purpose: PasswordLinkPurpose,
    ttlMs: number,
    expectedEmail?: string,
  ): Promise<
    | { status: 'issued'; token: string }
    | { status: 'cooldown'; retryAfterSeconds: number }
    | { status: 'stale' }
  > {
    const t = schema.passwordResetTokens;
    return this.db.transaction(async (tx) => {
      // Locks the user row for the duration of this transaction, serializing
      // two concurrent issuance attempts for the same user — without this,
      // both could read "no recent token" under READ COMMITTED and each
      // insert their own row, defeating both the cooldown and the
      // invalidate-prior guarantee (requirements.md: "two concurrent resend
      // requests ... cannot both pass the cooldown check"). An email rename
      // takes the same lock.
      const locked = await tx.execute<{ email: string }>(
        sql`select email from ${schema.users} where id = ${userId} for update`,
      );
      const currentEmail = locked.rows[0]?.email;
      if (
        expectedEmail !== undefined &&
        currentEmail?.toLowerCase() !== expectedEmail.toLowerCase()
      ) {
        return { status: 'stale' };
      }

      const [latest] = await tx
        .select({ createdAt: t.createdAt })
        .from(t)
        .where(
          purpose === 'set'
            ? and(eq(t.userId, userId), eq(t.purpose, 'set'), isNull(t.usedAt))
            : eq(t.userId, userId),
        )
        .orderBy(desc(t.createdAt))
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
        .update(t)
        .set({ usedAt: new Date() })
        .where(
          purpose === 'set'
            ? and(eq(t.userId, userId), isNull(t.usedAt))
            : and(
                eq(t.userId, userId),
                isNull(t.usedAt),
                eq(t.purpose, 'reset'),
              ),
        );

      const token = generateResetToken();
      await tx.insert(t).values({
        userId,
        token: hashResetToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
        purpose,
      });

      return { status: 'issued', token };
    });
  }

  /**
   * Whether `token` would be accepted right now, without using it up — lets
   * the caller validate the new password first, so a typo or a password that
   * fails the policy does not burn a one-time link.
   */
  async check(token: string): Promise<ConsumeResult> {
    return statusOf(await this.find(token));
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
    const row = await this.find(token);
    const status = statusOf(row);
    if (status.status !== 'ok' || !row) return status;

    const t = schema.passwordResetTokens;
    const updated = await this.db
      .update(t)
      .set({ usedAt: new Date() })
      .where(and(eq(t.id, row.id), isNull(t.usedAt)))
      .returning({ userId: t.userId });
    if (!updated[0]) return { status: 'already_used' };

    // A successful reset makes any other still-outstanding link for this
    // user moot too (e.g. an admin's set link after "Forgot password?").
    await this.db
      .update(t)
      .set({ usedAt: new Date() })
      .where(and(eq(t.userId, updated[0].userId), isNull(t.usedAt)));

    return { status: 'ok', userId: updated[0].userId };
  }

  private async find(token: string): Promise<TokenRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.token, hashResetToken(token)));
    return row;
  }
}

function statusOf(row: TokenRow | undefined): ConsumeResult {
  if (!row) return { status: 'unknown' };
  if (row.usedAt) return { status: 'already_used' };
  if (row.expiresAt.getTime() < Date.now()) return { status: 'expired' };
  return { status: 'ok', userId: row.userId };
}
