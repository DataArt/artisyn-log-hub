/**
 * db.ts — minimal raw-SQL DB helper for e2e specs that must read data the UI
 * can never show them (e.g. a password-reset token that was "emailed").
 *
 * Deliberately raw `pg` SQL, not a `drizzle-orm` + schema import: this package
 * (tests/e2e/) is isolated from server/, so importing server/src/database/schema
 * would reach across the package boundary. Mirrors the connection shape of
 * server/test/helpers/db-client.helper.ts (DATABASE_URL / DB_USER / DB_PASSWORD).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

let pool: Pool | undefined;
let envDefaultsLoaded = false;

/**
 * Playwright's test process never imports server/src/app.module.ts (whose
 * import-time `dotenvConfig()` call is what gives the *server* process its
 * DATABASE_URL), so unlike server-side jest tests, DATABASE_URL here is only
 * ever set if the caller's shell happened to export it — nothing in this
 * repo actually guarantees that for `npm run test:e2e` (run from repo root,
 * see root package.json). Fill in whatever's missing from the checked-in
 * `.env.defaults` (repo root) so this helper works the same regardless of
 * ambient shell state; an already-set env var always wins.
 */
function loadEnvDefaultsOnce(): void {
  if (envDefaultsLoaded) return;
  envDefaultsLoaded = true;
  let raw: string;
  try {
    raw = fs.readFileSync(
      path.resolve(process.cwd(), '.env.defaults'),
      'utf8',
    );
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(eq + 1).trim();
    }
  }
}

function getPool(): Pool {
  if (!pool) {
    loadEnvDefaultsOnce();
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
  }
  return pool;
}

/** Fetches the most recently issued password-reset token for the given email. */
export async function getLatestResetTokenForEmail(
  email: string,
): Promise<string> {
  const result = await getPool().query<{ token: string }>(
    `SELECT prt.token
     FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE u.email = $1
     ORDER BY prt.created_at DESC
     LIMIT 1`,
    [email.toLowerCase()],
  );
  if (result.rows.length === 0) {
    throw new Error(`No password reset token found for ${email}`);
  }
  return result.rows[0].token;
}

/**
 * Fetches the most recently issued email-confirmation token for the given
 * email, or null if none exists (Mode other than password-confirm, or the
 * account is already confirmed). DB-read, not Mailpit — this is the generic
 * "get a session" bootstrap path, not a test about the email flow itself
 * (mirrors server/test/helpers/email-confirmation.helper.ts).
 */
export async function getLatestConfirmationTokenForEmail(
  email: string,
): Promise<string | null> {
  const result = await getPool().query<{ token: string }>(
    `SELECT ect.token
     FROM email_confirmation_tokens ect
     JOIN users u ON u.id = ect.user_id
     WHERE u.email = $1
     ORDER BY ect.created_at DESC
     LIMIT 1`,
    [email.toLowerCase()],
  );
  return result.rows[0]?.token ?? null;
}

/** Deletes a test user by email (api_keys/password_reset_tokens cascade via FK). */
export async function deleteUserByEmail(email: string): Promise<void> {
  await getPool().query('DELETE FROM users WHERE email = $1', [
    email.toLowerCase(),
  ]);
}

/**
 * Registers `modelId` as an auto-added, unpriced model: a `model_pricing_meta` row with no
 * `model_pricing` row, exactly what telemetry ingest creates for an unknown model.
 */
export async function insertUnpricedModel(modelId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO model_pricing_meta (model_id, first_seen_at)
     VALUES ($1, now())
     ON CONFLICT (model_id) DO NOTHING`,
    [modelId],
  );
}

/** Deletes every price version and the meta row of `modelId`. */
export async function deleteModelPricing(modelId: string): Promise<void> {
  await getPool().query('DELETE FROM model_pricing WHERE model_id = $1', [
    modelId,
  ]);
  await getPool().query('DELETE FROM model_pricing_meta WHERE model_id = $1', [
    modelId,
  ]);
}

/**
 * Polls `upload_queue` until no `pending`/`processing` row remains for
 * `sessionId` + `logType`, i.e. the server's queue worker has stored (or rejected)
 * an upload made through `POST /api/v2/logs` — the only upload route since v1 was
 * removed (open-source readiness). Throws when a `failed` or
 * `rejected_foreign_session` row is left for that session and type, or on timeout.
 */
export async function waitForUploadQueueDrained(
  sessionId: string,
  logType: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastRows: Array<{ status: string; error_message: string | null }> = [];

  while (Date.now() < deadline) {
    const result = await getPool().query<{
      status: string;
      error_message: string | null;
    }>(
      `SELECT status, error_message
       FROM upload_queue
       WHERE session_id = $1 AND log_type = $2`,
      [sessionId, logType],
    );
    lastRows = result.rows;

    const bad = lastRows.filter(
      (r) => r.status === 'failed' || r.status === 'rejected_foreign_session',
    );
    if (bad.length > 0) {
      throw new Error(
        `Upload of ${logType} log for session ${sessionId} ended as ` +
          bad.map((r) => `${r.status} (${r.error_message ?? ''})`).join(', '),
      );
    }
    const inFlight = lastRows.some(
      (r) => r.status === 'pending' || r.status === 'processing',
    );
    if (!inFlight) return;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the upload queue to process the ` +
      `${logType} log of session ${sessionId}. Last rows: ${JSON.stringify(lastRows)}`,
  );
}
