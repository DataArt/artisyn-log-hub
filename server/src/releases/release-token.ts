import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';

/** Lifetime of a minted download link: 24 hours, in seconds. */
export const RELEASE_LINK_TTL_SECONDS = 86400;

/**
 * The only file names a release link may ever address.
 * Capture 1 is the UTC stamp (`YYYYMMDD-HHMMSS`), capture 2 the architecture.
 *
 * Checking this **before** anything touches the filesystem is what turns
 * `?file=../../etc/passwd` into a refusal rather than a path resolution.
 */
export const RELEASE_ZIP_NAME_RE =
  /^artisyn-log-hub-(\d{8}-\d{6})-(amd64|arm64)\.zip$/;

/** Result of `verifyReleaseToken`. */
export type ReleaseTokenVerdict = 'invalid' | 'expired' | 'ok';

/**
 * HMAC key for release download links.
 *
 * `RELEASE_LINK_SECRET` wins when set and non-empty. Otherwise the key is
 * derived from `SESSION_SECRET` with HKDF-SHA256 (info `release-link`), so
 * the session-signing secret itself is never used directly as an HMAC key for
 * a value handed out in URLs.
 */
export function getReleaseLinkKey(): string | Buffer {
  const explicit = process.env.RELEASE_LINK_SECRET;
  if (explicit) return explicit;
  return Buffer.from(
    hkdfSync(
      'sha256',
      process.env.SESSION_SECRET ?? '',
      '',
      'release-link',
      32,
    ),
  );
}

function payload(file: string, exp: number | string): string {
  return `${file}:${exp}`;
}

/**
 * HMAC-SHA256 over `file:exp`, base64url-encoded.
 *
 * @param file Release zip file name.
 * @param exp Absolute expiry in **epoch seconds**.
 * @param secret HMAC key — callers pass `getReleaseLinkKey()`.
 *   It is an argument rather than an env read so unit tests need no env.
 */
export function signReleaseToken(
  file: string,
  exp: number,
  secret: string | Buffer,
): string {
  return createHmac('sha256', secret)
    .update(payload(file, exp))
    .digest('base64url');
}

/**
 * Validates a redeem request's query triple. Checks run in exactly this order:
 * file pattern, `exp` shape, signature, expiry — so a malformed file name is
 * rejected before any path is built from it, and an expired link is only ever
 * reported as expired once its signature has been proven genuine.
 *
 * Deliberately says nothing about whether the file is still on disk or still
 * in the current inventory: a link keeps working for its whole window even
 * after a newer stamp supersedes it (the caller turns a missing file into 404).
 */
export function verifyReleaseToken(
  file: string,
  exp: string,
  sig: string,
  secret: string | Buffer,
): ReleaseTokenVerdict {
  if (!RELEASE_ZIP_NAME_RE.test(file)) return 'invalid';
  if (!/^\d+$/.test(exp)) return 'invalid';

  const expected = Buffer.from(
    createHmac('sha256', secret).update(payload(file, exp)).digest('base64url'),
    'utf8',
  );
  const actual = Buffer.from(sig, 'utf8');
  if (expected.length !== actual.length) return 'invalid';
  if (!timingSafeEqual(expected, actual)) return 'invalid';

  if (Number(exp) * 1000 <= Date.now()) return 'expired';
  return 'ok';
}
