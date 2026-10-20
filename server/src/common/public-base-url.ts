import { isProduction } from './runtime-env';

/** Fallback used outside production when `PUBLIC_BASE_URL` is not set (the Vite dev client). */
export const DEV_PUBLIC_BASE_URL = 'http://localhost:5173';

/**
 * The externally reachable base URL of this server, used for links that leave
 * the request context (emailed confirm/reset links). Never derived from the
 * request's `Host` header, which a caller controls.
 *
 * - `PUBLIC_BASE_URL` set → that value with trailing `/` stripped.
 * - unset, outside production → `http://localhost:5173`.
 * - unset, in production → `null` (callers skip the email and warn).
 *
 * Read at call time so specs can change the env between cases.
 */
export function getPublicBaseUrl(): string | null {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return isProduction() ? null : DEV_PUBLIC_BASE_URL;
}

/** True when `value` parses as an absolute `http:` or `https:` URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Logged once per process when an emailed link cannot be built. */
export const PUBLIC_BASE_URL_MISSING_WARNING =
  'mail: PUBLIC_BASE_URL not set — email link not sent';

let missingWarningLogged = false;

/**
 * `getPublicBaseUrl()` for emailed links. On `null` it logs
 * `PUBLIC_BASE_URL_MISSING_WARNING` — once per process — and returns `null`;
 * the caller then skips the email.
 */
export function getEmailLinkBaseUrl(logger: {
  warn(message: string): void;
}): string | null {
  const base = getPublicBaseUrl();
  if (base === null && !missingWarningLogged) {
    missingWarningLogged = true;
    logger.warn(PUBLIC_BASE_URL_MISSING_WARNING);
  }
  return base;
}

/** Test hook: lets a spec observe the once-per-process warning again. */
export function resetPublicBaseUrlWarningForTests(): void {
  missingWarningLogged = false;
}
