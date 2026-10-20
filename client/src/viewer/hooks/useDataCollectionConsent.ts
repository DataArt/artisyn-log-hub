import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { consentNoticeQuery, userSettingsQuery } from '../lib/consent-queries';
import {
  DATA_COLLECTION_NOTICE_SETTING,
  noticeHash,
  parseConsent,
} from '../lib/notice-hash';

export type ConsentState = 'loading' | 'required' | 'accepted';

/**
 * Whether the current user has accepted the *current* data-collection notice.
 *
 * On the normal path this never returns `'loading'`: `Bootstrap` prefetches
 * both queries before it lets any route render and both are
 * `staleTime: Infinity`, so the answer comes from cache at first paint — the
 * app never flashes behind the consent screen, nor the screen in front of an
 * accepted user.
 *
 * `'loading'` exists for the one path `Bootstrap` cannot cover: under auth mode
 * `none` the user can switch identity without a reload, so the settings of the
 * newly identified user have to be fetched here. Showing neither the app nor
 * the notice until that lands is what keeps the gate honest — the query is
 * keyed by user id precisely so the previous user's consent is never read as
 * this one's.
 */
export function useDataCollectionConsent(): ConsentState {
  const { user } = useAuth();
  const settings = useQuery({
    ...userSettingsQuery(user?.id ?? 0),
    enabled: user != null,
  });
  const { data: noticeText } = useQuery(consentNoticeQuery);

  // No notice text means we could not read the notice — never lock the user out
  // over a failed asset fetch.
  if (!noticeText) return 'accepted';
  if (settings.data === undefined) {
    // An outright failure must not lock anyone out either; only a genuinely
    // pending fetch holds the gate.
    return settings.isError ? 'accepted' : 'loading';
  }

  const stored =
    settings.data.find((s) => s.name === DATA_COLLECTION_NOTICE_SETTING)
      ?.value ?? null;
  const acceptedHash = parseConsent(stored);
  return acceptedHash === noticeHash(noticeText) ? 'accepted' : 'required';
}
