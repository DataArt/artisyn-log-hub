import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export const BASH_CALL_PARAM = 'bashCall';

/**
 * The Bash tab's selected call id in the `bashCall` URL param (DD-19). `select` replaces the
 * history entry rather than pushing one. A missing or unknown id is resolved by the caller
 * (row 1 is shown) without rewriting the URL.
 */
export function useBashCallParam(): [
  selectedId: string | null,
  select: (id: string) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get(BASH_CALL_PARAM);

  const select = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams);
      next.set(BASH_CALL_PARAM, id);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return [selectedId, select];
}
