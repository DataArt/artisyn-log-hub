/**
 * releases.ts — the stand's release zips and signed download links for S-REL-02.
 *
 * The stand's RELEASES_DIR is `<STAND_RUN_DIR>/releases` (`standEnv()` in `modes.ts`), read per
 * request by `ReleasesService`, so a scenario drops zips there and the admin inventory sees them
 * at once.
 *
 * A link's signature is `HMAC-SHA256(key, "<file>:<exp>")` in base64url
 * (`server/src/releases/release-token.ts`). Without `RELEASE_LINK_SECRET` the key is
 * HKDF-SHA256 of `SESSION_SECRET` (info `release-link`, 32 bytes). Modes A and C start the stand
 * without `SESSION_SECRET`, so the server generates one and stores it in `server_secrets`
 * (`name = 'session_secret'`) of the stand schema — that is where `releaseLinkKey()` reads it.
 */
import { createHmac, hkdfSync } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';
import { STAND_RELEASES_SUBDIR } from '../modes';

/** The stand's RELEASES_DIR; throws when the runner did not pass STAND_RUN_DIR. */
export function standReleasesDir(stand: { runDir: string }): string {
  if (!stand.runDir) {
    throw new Error('STAND_RUN_DIR is not set — run the scenario suite through npm run test:scenarios.');
  }
  return path.join(stand.runDir, STAND_RELEASES_SUBDIR);
}

/** Writes `files` (name → content) into `dir`, creating it. */
export function writeReleaseFiles(dir: string, files: Record<string, Buffer | string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

/** The release-link HMAC key of a stand started without SESSION_SECRET / RELEASE_LINK_SECRET (modes A, C). */
export async function releaseLinkKey(db: Pool): Promise<Buffer> {
  const { rows } = await db.query<{ value: string }>(
    "SELECT value FROM server_secrets WHERE name = 'session_secret'",
  );
  if (!rows[0]) throw new Error('server_secrets has no session_secret row');
  return Buffer.from(hkdfSync('sha256', rows[0].value, '', 'release-link', 32));
}

/** base64url HMAC-SHA256 over `file:exp` — the `sig` of a release link. */
export function signRelease(file: string, exp: number | string, key: Buffer | string): string {
  return createHmac('sha256', key).update(`${file}:${exp}`).digest('base64url');
}

/** `/api/v1/releases/download?file=…&exp=…&sig=…` (path only, for the anonymous `api` context). */
export function releaseDownloadPath(file: string, exp: number | string, sig: string): string {
  return `/api/v1/releases/download?file=${encodeURIComponent(file)}&exp=${exp}&sig=${sig}`;
}
