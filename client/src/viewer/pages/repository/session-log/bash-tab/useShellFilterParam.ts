import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ShellKind } from '@loghub/bash-view';
import { BASH_CALL_PARAM } from './useBashCallParam';

export const SHELL_FILTER_PARAM = 'shell';

/** `'bash'` / `'powershell'` as written in the URL; any other value reads as no filter (All). */
function parseShell(value: string | null): ShellKind | null {
  if (value === 'bash') return 'bash';
  if (value === 'powershell') return 'powershell';
  return null;
}

/**
 * The Shell tab's shell filter in the `shell` URL param (DD-24): `'bash' | 'powershell' | null`
 * (All). An unknown value reads as `null`; whether the shell has calls is checked by the caller.
 * `setShell` replaces the history entry (same pattern as `useBashCallParam`) and can rewrite the
 * selected call (`bashCall`) in the same update, so the two params never race each other.
 */
export function useShellFilterParam(): [
  shell: ShellKind | null,
  setShell: (shell: ShellKind | null, selectId?: string) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const shell = parseShell(searchParams.get(SHELL_FILTER_PARAM));

  const setShell = useCallback(
    (next: ShellKind | null, selectId?: string) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set(SHELL_FILTER_PARAM, next);
      else params.delete(SHELL_FILTER_PARAM);
      if (selectId !== undefined) params.set(BASH_CALL_PARAM, selectId);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return [shell, setShell];
}
