import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  parseTagParams,
  TAG_PARAM,
  tagFiltersToParams,
  type TagFilter,
} from '../../../lib/session-tags';

/**
 * The session list's tag filter (2026-11-24 otel-session-tags, FR-6), mirrored into the
 * repeatable URL `tag=` param (`tag=<key>` / `tag=<key>:<value>`) so a filtered list is
 * shareable. Replaces the params without a history entry.
 */
export function useSessionTagFilterParam() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawKey = searchParams.getAll(TAG_PARAM).join('\u0000');
  const tagFilters = useMemo(
    () => parseTagParams(rawKey === '' ? [] : rawKey.split('\u0000')),
    [rawKey],
  );

  const setTagFilters = useCallback(
    (next: readonly TagFilter[]) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.delete(TAG_PARAM);
          for (const v of tagFiltersToParams(next)) params.append(TAG_PARAM, v);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { tagFilters, setTagFilters };
}
