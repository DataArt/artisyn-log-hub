import { useCallback, useState } from 'react';

/**
 * Tracks explicit user overrides for branch open/closed state, keyed by
 * branch key (`branch ?? '__no_branch__'`). Branches default to open only
 * for index 0 (first branch); this default is computed at the call site
 * and combined with any stored override here.
 */
export function useOpenBranches() {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  const isBranchOpen = useCallback(
    (key: string, index: number): boolean => {
      const override = overrides.get(key);
      return override ?? index === 0;
    },
    [overrides],
  );

  const toggleBranch = useCallback((key: string, index: number) => {
    setOverrides((prev) => {
      const current = prev.get(key) ?? index === 0;
      const next = new Map(prev);
      next.set(key, !current);
      return next;
    });
  }, []);

  /** Opens a branch without toggling: a deep-linked session's branch must be shown. */
  const openBranch = useCallback((key: string) => {
    setOverrides((prev) => {
      if (prev.get(key) === true) return prev;
      const next = new Map(prev);
      next.set(key, true);
      return next;
    });
  }, []);

  return { isBranchOpen, toggleBranch, openBranch };
}
