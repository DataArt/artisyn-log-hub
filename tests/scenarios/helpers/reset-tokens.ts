// password_reset_tokens stores sha256(token) as 64 lowercase hex chars (migration 0094), never the
// token from the link. Scenarios that seed or look up a token directly in the DB go through here.
import { createHash, randomBytes } from 'crypto';
import type { Pool } from 'pg';

/** What the DB stores for a link token. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A reset token written straight into password_reset_tokens (no endpoint issues one without a
 * letter and a cooldown). Returns the plain token, as it would appear in a link.
 */
export async function seedResetToken(
  db: Pool,
  userId: number,
  expiresIn: string,
  purpose: 'reset' | 'set' = 'reset',
): Promise<string> {
  const token = `scn-${randomBytes(24).toString('hex')}`;
  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at, purpose) VALUES ($1, $2, now() + $3::interval, $4)`,
    [userId, hashResetToken(token), expiresIn, purpose],
  );
  return token;
}
