/**
 * `?live=<nodeKey>` URL state of the Live view (2026-11-04 otel-live-view, DD-15).
 *
 * The modal is open iff the param is present. Opening pushes a history entry (so Back closes
 * it); selecting a node and closing replace. Every write copies the current search params
 * first, so the page's own params survive. The details-panel key is local modal state, not URL.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { HOME_LIVE_KEY } from './live-node-key';

export const LIVE_URL_PARAM = 'live';

export interface LiveUrlState {
  /** The selected node key; null while the modal is closed. */
  liveKey: string | null;
  /** Opens the modal at home (push). */
  open: () => void;
  /** Selects a node (replace). */
  select: (key: string) => void;
  /** Closes the modal: drops `live` (replace). */
  close: () => void;
}

export function useLiveUrlState(): LiveUrlState {
  const [searchParams, setSearchParams] = useSearchParams();
  const liveKey = searchParams.get(LIVE_URL_PARAM);

  const write = useCallback(
    (key: string | null, replace: boolean) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key === null) next.delete(LIVE_URL_PARAM);
          else next.set(LIVE_URL_PARAM, key);
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  const open = useCallback(() => write(HOME_LIVE_KEY, false), [write]);
  const select = useCallback((key: string) => write(key, true), [write]);
  const close = useCallback(() => write(null, true), [write]);

  return { liveKey, open, select, close };
}
