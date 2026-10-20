/**
 * Masks an email address for log lines (GDPR: server logs should not carry
 * full personal email addresses). Keeps the first character of the local part
 * and the whole domain, so a line can still be correlated by an operator:
 *
 *   maskEmail('dune@arrakis.test') → 'd***@arrakis.test'
 *
 * Input without an `@` (or with an empty local part) is masked entirely as
 * `***`, followed by `@<domain>` when there is a domain.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '***';
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at < 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.length > 0 ? local[0] : '';
  return `${head}***@${domain}`;
}
