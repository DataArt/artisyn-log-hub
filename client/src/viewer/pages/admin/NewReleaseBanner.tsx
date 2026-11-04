import { ArrowUpCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLogHubRelease } from '../../hooks/useLogHubRelease';

/**
 * Admin-only, non-dismissable strip above the Admin tabs: a newer official Log Hub release exists.
 * Renders nothing for non-admins, on an error, or while no update is available.
 */
export function NewReleaseBanner() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { data } = useLogHubRelease(isAdmin);
  if (!isAdmin || !data?.updateAvailable) return null;

  return (
    <div
      data-testid="admin-new-release-banner"
      className="mx-4 mt-3 shrink-0 flex items-center gap-2 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-200"
    >
      <ArrowUpCircle className="size-4 shrink-0" />
      <span>
        A newer Log Hub version is available: {data.latestVersion} (this server
        runs {data.currentVersion}).
      </span>
      {data.releaseUrl && (
        <a
          href={data.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium"
        >
          View release
        </a>
      )}
    </div>
  );
}
