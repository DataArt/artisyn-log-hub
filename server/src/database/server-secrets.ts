import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { serverSecrets } from './schema';

/** `server_secrets.name` of the persisted session-cookie signing secret. */
export const SESSION_SECRET_NAME = 'session_secret';

/** Where the resolved `SESSION_SECRET` came from — logged once at startup. */
export type SessionSecretSource = 'env' | 'stored' | 'generated';

/**
 * Resolves `SESSION_SECRET` (open-source readiness):
 *
 * 1. a non-empty `SESSION_SECRET` env var wins;
 * 2. else the stored `server_secrets` row `name='session_secret'`;
 * 3. else 48 random bytes (base64url) are inserted with `ON CONFLICT DO
 *    NOTHING` and the row is re-read, so concurrent workers converge on one
 *    value.
 *
 * The result is written to `process.env.SESSION_SECRET`. Called at the end of
 * `initializeDatabase()`, inside the migration advisory lock. Any DB error is
 * rethrown as `Failed to load or persist SESSION_SECRET: <cause>`.
 */
export async function resolveSessionSecret<
  TSchema extends Record<string, unknown>,
>(db: NodePgDatabase<TSchema>): Promise<SessionSecretSource> {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim() !== '') return 'env';

  try {
    const readStored = async (): Promise<string | undefined> => {
      const rows = await db
        .select({ value: serverSecrets.value })
        .from(serverSecrets)
        .where(eq(serverSecrets.name, SESSION_SECRET_NAME))
        .limit(1);
      return rows[0]?.value;
    };

    const stored = await readStored();
    if (stored) {
      process.env.SESSION_SECRET = stored;
      return 'stored';
    }

    await db
      .insert(serverSecrets)
      .values({
        name: SESSION_SECRET_NAME,
        value: randomBytes(48).toString('base64url'),
      })
      .onConflictDoNothing({ target: serverSecrets.name });

    const persisted = await readStored();
    if (!persisted) {
      throw new Error('server_secrets row missing after insert');
    }
    process.env.SESSION_SECRET = persisted;
    return 'generated';
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load or persist SESSION_SECRET: ${cause}`, {
      cause: err,
    });
  }
}
