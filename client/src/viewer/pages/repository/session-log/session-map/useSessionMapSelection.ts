/**
 * The Session Map's selected card in the `smSel` URL param (session-map DD-20): `main`,
 * `group:<key>` or an agent id, written with `useSearchParams` + `replace`.
 *
 * - An `smSel` naming a node the model does not know is ignored (`selectedId` is `null`).
 * - The param is dropped when the session changes and when the tab unmounts.
 * - `onSelect` is stable (the memoised cards must not re-render because the URL changed) and
 *   toggles: selecting the selected card again clears the selection.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { SessionMapModel } from './session-map-model';

export const SESSION_MAP_SEL_PARAM = 'smSel';

export interface SessionMapSelection {
  /** The selected node, `null` when nothing (or an unknown node) is selected. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  clear: () => void;
}

/**
 * Drops `smSel` from the live URL when the tab unmounts. The router's own `searchParams` are stale
 * in a cleanup (they still name this tab), so the current query is read from the hash and only
 * written back while the page path is unchanged.
 */
function useDropSelectionOnUnmount(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const latest = useRef({ navigate, pathname });
  latest.current = { navigate, pathname };
  useEffect(
    () => () => {
      const hash = window.location.hash.replace(/^#/, '');
      const q = hash.indexOf('?');
      const path = q >= 0 ? hash.slice(0, q) : hash;
      if (path !== latest.current.pathname || q < 0) return;
      const params = new URLSearchParams(hash.slice(q + 1));
      if (!params.has(SESSION_MAP_SEL_PARAM)) return;
      params.delete(SESSION_MAP_SEL_PARAM);
      const search = params.toString();
      void latest.current.navigate(
        { pathname: path, search: search ? `?${search}` : '' },
        { replace: true },
      );
    },
    [],
  );
}

export function useSessionMapSelection(
  sessionKey: string,
  model: SessionMapModel | null,
): SessionMapSelection {
  const [searchParams, setSearchParams] = useSearchParams();
  const selParam = searchParams.get(SESSION_MAP_SEL_PARAM);

  const setSelected = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (id === null) next.delete(SESSION_MAP_SEL_PARAM);
      else next.set(SESSION_MAP_SEL_PARAM, id);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const toggleRef = useRef((id: string) =>
    setSelected(selParam === id ? null : id),
  );
  toggleRef.current = (id: string) => setSelected(selParam === id ? null : id);
  const onSelect = useCallback((id: string) => toggleRef.current(id), []);
  const clear = useCallback(() => setSelected(null), [setSelected]);

  const prevSession = useRef(sessionKey);
  useEffect(() => {
    if (prevSession.current === sessionKey) return;
    prevSession.current = sessionKey;
    if (searchParams.has(SESSION_MAP_SEL_PARAM)) setSelected(null);
  }, [sessionKey, searchParams, setSelected]);
  useDropSelectionOnUnmount();

  const selectedId = useMemo(() => {
    if (selParam === null || model === null) return null;
    if (selParam === 'main') return selParam;
    if (selParam.startsWith('group:')) {
      const key = selParam.slice('group:'.length);
      return model.columns.some((c) => c.key === key) ? selParam : null;
    }
    return model.agentsById.has(selParam) ? selParam : null;
  }, [selParam, model]);

  return { selectedId, onSelect, clear };
}
