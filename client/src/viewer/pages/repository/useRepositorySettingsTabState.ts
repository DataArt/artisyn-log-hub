import { useSearchParams } from 'react-router-dom';
import { SETTINGS_TABS, type SettingsTab } from '../../tab-ids';

// The tab ids live in the pure `tab-ids.ts` module; re-exported for existing importers.
export { SETTINGS_TABS, type SettingsTab };

/**
 * Parses the `stab` search param into a valid SettingsTab, falling back to the
 * default (`SETTINGS_TABS[0]`) for missing or unrecognized values.
 */
export function parseSettingsTab(value: string | null): SettingsTab {
  if (value != null && (SETTINGS_TABS as readonly string[]).includes(value)) {
    return value as SettingsTab;
  }
  return SETTINGS_TABS[0];
}

/**
 * URL-backed Settings sub-tab state (`stab` param — distinct from the session
 * detail `tab` param and the RepositoryView `mtab` param, since all three can
 * be present at once). Default tab is omitted from the URL.
 */
export function useRepositorySettingsTabState() {
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = parseSettingsTab(searchParams.get('stab'));

  function setTab(next: SettingsTab) {
    const nextParams = new URLSearchParams(searchParams);
    if (next === SETTINGS_TABS[0]) {
      nextParams.delete('stab');
    } else {
      nextParams.set('stab', next);
    }
    setSearchParams(nextParams, { replace: true });
  }

  return { tab, setTab };
}
