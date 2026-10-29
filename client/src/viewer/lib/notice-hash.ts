/**
 * Versioning for the data-collection notice.
 *
 * Consent is stored server-side as one opaque `user_settings` value — the server
 * never looks inside it. What lives in there is a JSON string carrying the hash
 * of the notice text the user actually accepted, so that editing
 * `user-docs/data-collection-notice.md` (served as `/help/data-collection-notice.md`
 * by the help generator, byte-for-byte) re-asks everyone exactly once.
 *
 * `tests/e2e/helpers/notice-hash.ts` is a twin of this module — keep the
 * normalisation, the hash and the JSON shape in sync with it.
 */

/** Name of the `user_settings` row holding the consent record. */
export const DATA_COLLECTION_NOTICE_SETTING = 'dataCollectionNotice';

/** Where the notice markdown is served from. */
export const NOTICE_URL = '/help/data-collection-notice.md';

/** Placeholder in the markdown replaced with the effective retention window. */
export const RETENTION_DAYS_PLACEHOLDER = '{{RETENTION_DAYS}}';

/**
 * Heading of the section rendered as the visually distinct secrets warning.
 * It is part of the same markdown file so the Help article stays complete.
 */
export const SECRETS_SECTION_HEADING = 'If the assistant handles secrets';

/**
 * FNV-1a 32-bit over the normalised notice text, as 8 lowercase hex chars.
 * Not a security primitive — it only has to change when the text changes, and
 * it must produce the same value in the browser and in the e2e twin.
 */
export function noticeHash(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n').trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    // FNV prime 16777619, via shifts to stay in 32-bit integer math.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface ConsentRecord {
  noticeHash: string;
  acceptedAt: string;
}

/** The value written into the setting when the user accepts. */
export function encodeConsent(hash: string): string {
  const record: ConsentRecord = {
    noticeHash: hash,
    acceptedAt: new Date().toISOString(),
  };
  return JSON.stringify(record);
}

/**
 * The accepted notice hash, or `null` for anything we cannot read — absent,
 * not JSON, wrong shape. A corrupt value must only mean "ask again", never a
 * throw and never a lockout.
 */
export function parseConsent(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ConsentRecord).noticeHash === 'string' &&
      (parsed as ConsentRecord).noticeHash.length > 0
    ) {
      return (parsed as ConsentRecord).noticeHash;
    }
  } catch {
    // fall through — unparseable means not accepted
  }
  return null;
}
