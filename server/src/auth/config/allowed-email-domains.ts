/** Hostname shape accepted in `ALLOWED_EMAIL_DOMAINS`: at least two dot-separated labels. */
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Parses the Mode 3 sign-up domain allow-list (`ALLOWED_EMAIL_DOMAINS`,
 * open-source readiness).
 *
 * Splits on `,`, trims and lowercases each element. Unset or empty → `[]`
 * (no restriction). Throws on an empty element, an element containing `@` or
 * internal whitespace, or one that is not a hostname.
 */
export function parseAllowedEmailDomains(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];

  return raw.split(',').map((part) => {
    const domain = part.trim().toLowerCase();
    if (domain === '') {
      throw new Error(
        `ALLOWED_EMAIL_DOMAINS contains an empty entry, got: ${raw}`,
      );
    }
    if (domain.includes('@')) {
      throw new Error(
        `ALLOWED_EMAIL_DOMAINS entries must be domains without "@", got: ${domain}`,
      );
    }
    if (/\s/.test(domain)) {
      throw new Error(
        `ALLOWED_EMAIL_DOMAINS entries must not contain whitespace, got: ${domain}`,
      );
    }
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new Error(
        `ALLOWED_EMAIL_DOMAINS entry is not a valid domain, got: ${domain}`,
      );
    }
    return domain;
  });
}
