/**
 * The three queries the data-collection consent gate reads.
 *
 * They are defined once here because three places must agree on them exactly:
 * `Bootstrap` prefetches them before it lets any route render,
 * `useDataCollectionConsent` decides from them, and
 * `DataCollectionConsentScreen` renders from them. If the keys or the query
 * functions drifted apart, the gate would fetch again at render time and the
 * app would flash behind (or in front of) the consent screen.
 *
 * `staleTime: Infinity` is what makes the prefetched data count as fresh at
 * mount, so no observer refetches what `Bootstrap` already loaded. None of the
 * three changes while the tab is open: the notice is a static asset, the
 * retention window is server config, and the consent row is invalidated by
 * hand the moment the user accepts.
 */
import { fetchRetentionDays, fetchUserSettings } from '../api';
import { NOTICE_URL } from './notice-hash';

/** Key prefix for the per-user settings cache — invalidate with this alone. */
export const USER_SETTINGS_KEY = 'user-settings';

/**
 * Scoped to the user id on purpose. Under auth mode `none` a user switches
 * identity without a page reload, so `Bootstrap` never re-runs — an unscoped
 * key would let the newly identified user inherit the previous one's consent
 * row and walk straight past the notice.
 */
export function userSettingsQuery(userId: number) {
  return {
    queryKey: [USER_SETTINGS_KEY, userId] as const,
    queryFn: fetchUserSettings,
    staleTime: Infinity,
  };
}

export const consentNoticeQuery = {
  queryKey: ['consent-notice'] as const,
  queryFn: async (): Promise<string> => {
    const res = await fetch(NOTICE_URL);
    if (!res.ok) throw new Error('data-collection notice unavailable');
    return res.text();
  },
  staleTime: Infinity,
};

export const retentionDaysQuery = {
  queryKey: ['retention-days'] as const,
  queryFn: fetchRetentionDays,
  staleTime: Infinity,
};
