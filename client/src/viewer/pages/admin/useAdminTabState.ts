import { useSearchParams } from 'react-router-dom';
import { ADMIN_TABS, type AdminTab } from '../../tab-ids';

// The tab ids live in the pure `tab-ids.ts` module; re-exported for existing importers.
export { ADMIN_TABS, type AdminTab };

/**
 * Parses the `tab` search param into a valid AdminTab, falling back to the
 * default (`ADMIN_TABS[0]`) for missing or unrecognized values.
 */
export function parseAdminTab(value: string | null): AdminTab {
  if (value != null && (ADMIN_TABS as readonly string[]).includes(value)) {
    return value as AdminTab;
  }
  return ADMIN_TABS[0];
}

/**
 * URL-backed admin tab state: derives the active tab from the `tab` search
 * param and returns a setter that syncs it back via `setSearchParams`
 * (replace, no history entry). The default tab is omitted from the URL.
 */
export function useAdminTabState() {
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = parseAdminTab(searchParams.get('tab'));

  function setTab(next: AdminTab) {
    const nextParams = new URLSearchParams(searchParams);
    if (next === ADMIN_TABS[0]) {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', next);
    }
    setSearchParams(nextParams, { replace: true });
  }

  return { tab, setTab };
}
