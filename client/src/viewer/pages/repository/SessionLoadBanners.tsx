import { Loader2 } from 'lucide-react';

/**
 * The one-line notices under the session header: the updated-session reload, and the
 * derived-lag notice of the parts manifest (`derivedLagging`, impl-plan DD-14).
 */
export function SessionLoadBanners({
  isReloadingUpdatedSession,
  derivedLagging,
}: {
  isReloadingUpdatedSession: boolean;
  derivedLagging: boolean;
}) {
  return (
    <>
      {isReloadingUpdatedSession && (
        <div className="flex shrink-0 items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading updated session…</span>
        </div>
      )}
      {derivedLagging && (
        <div
          className="shrink-0 border-b border-amber-200/60 bg-amber-50/60 px-3 py-1.5 text-xs text-amber-800/80 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300/80"
          data-testid="session-derived-lagging"
        >
          Some figures may lag behind the latest upload — the server is busy;
          this can take a couple of minutes.
        </div>
      )}
    </>
  );
}
