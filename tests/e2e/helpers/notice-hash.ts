/**
 * notice-hash.ts — e2e twin of `client/src/viewer/lib/notice-hash.ts`.
 *
 * Why this exists: the data-collection notice gates every authenticated route,
 * so `global.setup.ts` has to accept it for each storageState role before any
 * other spec can see the app at all. Accepting it means writing the *current*
 * notice hash, which the client computes in the browser — this module computes
 * the same value in Node, reading the markdown straight off disk.
 *
 * It is a deliberate twin, in the same sense as `helpers/pricing.ts`: the
 * normalisation, the FNV-1a hash and the stored JSON shape must stay identical
 * to the client module, or every existing spec starts failing behind the
 * consent screen.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Twin of `DATA_COLLECTION_NOTICE_SETTING`. */
export const DATA_COLLECTION_NOTICE_SETTING = 'dataCollectionNotice';

/** The markdown the client fetches from `/help/data-collection-notice.md`. */
const NOTICE_PATH = path.resolve(
  __dirname,
  '../../../client/public/help/data-collection-notice.md',
);

/** Twin of `noticeHash` — FNV-1a 32-bit, 8 lowercase hex chars. */
export function noticeHash(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n').trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The notice markdown as the app serves it. */
export function readNoticeText(): string {
  return fs.readFileSync(NOTICE_PATH, 'utf8');
}

/** Twin of `encodeConsent` — the value written into the setting. */
export function consentSettingValue(): string {
  return JSON.stringify({
    noticeHash: noticeHash(readNoticeText()),
    acceptedAt: new Date().toISOString(),
  });
}
