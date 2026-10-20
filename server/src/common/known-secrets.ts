import type { LoggerService } from '@nestjs/common';

/**
 * Publicly known `SESSION_SECRET` values (open-source readiness): the dev literal from the root `.env.defaults`, the e2e test
 * fallback and the release-template placeholders.
 */
export const KNOWN_INSECURE_SECRETS: readonly string[] = [
  'dev-local-secret-change-in-production',
  'test-secret-for-e2e',
  'change-me',
  'change-me-to-a-long-random-string',
];

/** Publicly known database passwords (dev compose, docs, release-template placeholder). */
export const KNOWN_INSECURE_DB_PASSWORDS: readonly string[] = [
  'pw',
  'secret',
  'postgres',
  'change-me',
];

const CONTEXT = 'Security';

/** Password component of a `postgres://user:pass@host/db` URL, or `null`. */
export function parseDatabasePassword(
  databaseUrl: string | undefined,
): string | null {
  if (!databaseUrl) return null;
  try {
    const url = new URL(databaseUrl);
    return url.password ? decodeURIComponent(url.password) : null;
  } catch {
    return null;
  }
}

/**
 * Logs one warning per known insecure value in use. Silent in Mode 1
 * (`AUTH_MODE=none`, localhost-only, no auth model). Never throws or blocks
 * startup. Called once per worker process from `main.ts`, after
 * `initializeDatabase()` has resolved `SESSION_SECRET`.
 */
export function warnKnownSecrets(
  authMode: string | undefined,
  logger: LoggerService,
): void {
  if (authMode === 'none') return;

  const secret = process.env.SESSION_SECRET;
  if (secret && KNOWN_INSECURE_SECRETS.includes(secret)) {
    logger.warn(
      'security: known insecure SESSION_SECRET in use — set a unique value',
      CONTEXT,
    );
  }

  const dbPassword =
    process.env.DB_PASSWORD || parseDatabasePassword(process.env.DATABASE_URL);
  if (dbPassword && KNOWN_INSECURE_DB_PASSWORDS.includes(dbPassword)) {
    logger.warn(
      'security: known insecure database password in use — set a unique value',
      CONTEXT,
    );
  }
}
