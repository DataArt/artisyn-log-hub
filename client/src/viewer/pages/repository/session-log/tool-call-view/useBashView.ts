import { useEffect, useMemo, useState } from 'react';
import {
  type BashParser,
  type BashView,
  buildShellView,
  type HighlightSegment,
  highlightBash,
  highlightPowerShell,
  type ShellKind,
  stripLhWrap,
} from '@loghub/bash-view';
import { useToolView } from './ToolViewContext';

/** The lazily loaded browser parser of one shell plus the highlight query that goes with it. */
interface LoadedParser {
  parser: BashParser;
  query: string;
}

const loading = new Map<ShellKind, Promise<LoadedParser>>();

/** The browser entry of each shell's parser — `import()` only, never a static import. */
function importParser(shell: ShellKind): Promise<LoadedParser> {
  if (shell === 'powershell')
    return import('../../../../lib/bash-view/powershell-browser-parser').then(
      async (m) => ({
        parser: await m.getBrowserPowerShellParser(),
        query: m.PS_HIGHLIGHT_QUERY,
      }),
    );
  return import('../../../../lib/bash-view/browser-parser').then(async (m) => ({
    parser: await m.getBrowserBashParser(),
    query: m.HIGHLIGHT_QUERY,
  }));
}

/**
 * Loads one shell's browser entry (and with it the runtime and that grammar's WASM) through
 * `import()` only — once per page and shell (DD-21), so a Bash-only session never fetches the
 * PowerShell grammar. A failed load is not cached, so a later view can retry.
 */
function loadParser(shell: ShellKind): Promise<LoadedParser> {
  let promise = loading.get(shell);
  if (!promise) {
    promise = importParser(shell).catch((err: unknown) => {
      loading.delete(shell);
      throw err;
    });
    loading.set(shell, promise);
  }
  return promise;
}

type Loaded = LoadedParser | null | 'failed';

/** `useLoadedParser(shell)`: that shell's parser once loaded, `null` before (or when `shell` is null), `'failed'` on error. */
function useLoadedParser(shell: ShellKind | null): Loaded {
  const [loaded, setLoaded] = useState<{ shell: ShellKind; value: Loaded }>();
  useEffect(() => {
    if (shell === null) return;
    let alive = true;
    loadParser(shell).then(
      (p) => {
        if (alive) setLoaded({ shell, value: p });
      },
      () => {
        if (alive) setLoaded({ shell, value: 'failed' });
      },
    );
    return () => {
      alive = false;
    };
  }, [shell]);
  // A result for another shell (the prop changed) is not this shell's parser.
  return loaded && loaded.shell === shell ? loaded.value : null;
}

function highlighterOf(
  shell: ShellKind,
  { parser, query }: LoadedParser,
): (text: string) => HighlightSegment[] {
  return (text: string) => {
    try {
      return shell === 'powershell'
        ? highlightPowerShell(parser, text, query)
        : highlightBash(parser, text, query);
    } catch {
      return [];
    }
  };
}

/** The text "Copy original" copies: the stored command, without the hook's wrap prefix for PowerShell (DD-11). */
function originalOf(shell: ShellKind, loaded: Loaded, command: string): string {
  if (shell !== 'powershell' || loaded === null || loaded === 'failed')
    return command;
  try {
    return stripLhWrap(loaded.parser, command);
  } catch {
    return command;
  }
}

export type BashViewState =
  | {
      state: 'loading' | 'fallback';
      /** What "Copy original" copies. */
      original: string;
      view?: undefined;
      highlight?: undefined;
    }
  | {
      state: 'ready';
      original: string;
      view: BashView;
      /** Highlight segments of any displayed text (formatted or raw). */
      highlight: (text: string) => HighlightSegment[];
    };

export function commandOf(input: Record<string, unknown>): string {
  return typeof input.command === 'string' ? input.command : '';
}

/**
 * The view of one shell command (DD-13, DD-22): `loading` until that shell's parser is in,
 * `fallback` when the command does not parse or the parser failed to load, else `ready` with the
 * view and a highlighter. Only `shell`'s parser is loaded.
 */
export function useBashView(command: string, shell: ShellKind): BashViewState {
  const { repoRoot } = useToolView();
  const loaded = useLoadedParser(shell);
  return useMemo<BashViewState>(() => {
    const original = originalOf(shell, loaded, command);
    if (loaded === 'failed') return { state: 'fallback', original };
    if (loaded === null) return { state: 'loading', original };
    let view: BashView;
    try {
      view = buildShellView(shell, loaded.parser, command, repoRoot);
    } catch {
      return { state: 'fallback', original };
    }
    if (!view.ok) return { state: 'fallback', original };
    return {
      state: 'ready',
      original,
      view,
      highlight: highlighterOf(shell, loaded),
    };
  }, [shell, loaded, command, repoRoot]);
}

/**
 * Views of many shell calls with one parser load per shell present (DD-14, DD-22), keyed by call
 * id. A row is left out until its shell's parser is in; a command that fails to build is left
 * out (its row stays raw).
 */
export function useBashViews(
  rows: ReadonlyArray<{
    id: string;
    input: Record<string, unknown>;
    shell: ShellKind;
  }>,
): Map<string, BashView> {
  const { repoRoot } = useToolView();
  const hasBash = rows.some((r) => r.shell === 'bash');
  const hasPowerShell = rows.some((r) => r.shell === 'powershell');
  const bash = useLoadedParser(hasBash ? 'bash' : null);
  const powershell = useLoadedParser(hasPowerShell ? 'powershell' : null);
  return useMemo(() => {
    const parsers: Record<ShellKind, Loaded> = { bash, powershell };
    const views = new Map<string, BashView>();
    for (const row of rows) {
      const loaded = parsers[row.shell];
      if (loaded === null || loaded === 'failed') continue;
      try {
        views.set(
          row.id,
          buildShellView(
            row.shell,
            loaded.parser,
            commandOf(row.input),
            repoRoot,
          ),
        );
      } catch {
        /* unparseable — the row keeps its raw preview */
      }
    }
    return views;
  }, [bash, powershell, rows, repoRoot]);
}
