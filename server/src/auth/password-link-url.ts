import { getEmailLinkBaseUrl } from '../common/public-base-url';

/**
 * Emailed password link: `<base>/#/reset-password?token=<t>`, plus
 * `&purpose=set` for admin-issued set-password links (the client then shows
 * "Set your password"). `null` when no base URL is known
 * (`PUBLIC_BASE_URL` unset in production) — the caller sends nothing.
 */
export function buildResetUrl(
  token: string,
  logger: { warn(message: string): void },
  purpose?: 'set',
): string | null {
  const base = getEmailLinkBaseUrl(logger);
  if (base === null) return null;
  const url = `${base}/#/reset-password?token=${token}`;
  return purpose === 'set' ? `${url}&purpose=set` : url;
}
