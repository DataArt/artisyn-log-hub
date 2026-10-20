/**
 * Parses the `TRUST_PROXY` environment variable into a value Express's
 * `app.set('trust proxy', …)` understands.
 *
 * Off by default (unset/empty/`false`) so every existing install keeps its
 * current behaviour byte-for-byte. When enabled it takes precedence over
 * `COOKIE_SECURE` (see `app.module.ts`) and also makes `req.ip` reflect the
 * real client address behind a reverse proxy.
 *
 * Accepted values mirror Express's own `trust proxy` setting:
 * - `true` — trust the left-most `X-Forwarded-*` entry
 * - a hop count, e.g. `1` — trust that many proxies closest to the app
 * - an IP/CIDR list, e.g. `127.0.0.1, ::1` — trust those addresses
 */
export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
