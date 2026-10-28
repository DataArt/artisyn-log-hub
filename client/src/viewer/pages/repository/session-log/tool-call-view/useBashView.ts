import { useEffect, useMemo, useState } from 'react';
import {
  type BashParser,
  type BashView,
  buildBashView,
  type HighlightSegment,
  highlightBash,
} from '@loghub/bash-view';
import { useToolView } from './ToolViewContext';

/** The lazily loaded browser parser plus the highlight query that goes with it. */
interface LoadedParser {
  parser: BashParser;
  query: string;
}

let loading: Promise<LoadedParser> | null = null;

/**
 * Loads `browser-parser` (and with it both WASM files) through `import()` only — never statically
 * — once per page (DD-14). A failed load is not cached, so a later view can retry.
 */
function loadParser(): Promise<LoadedParser> {
  loading ??= import('../../../../lib/bash-view/browser-parser')
    .then(async (m) => ({
      parser: await m.getBrowserBashParser(),
      query: m.HIGHLIGHT_QUERY,
    }))
    .catch((err: unknown) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** `useLoadedParser(enabled)`: the parser once loaded, `null` before, `'failed'` on error. */
function useLoadedParser(enabled: boolean): LoadedParser | null | 'failed' {
  const [loaded, setLoaded] = useState<LoadedParser | null | 'failed'>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadParser().then(
      (p) => {
        if (alive) setLoaded(p);
      },
      () => {
        if (alive) setLoaded('failed');
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled]);
  return loaded;
}

export type BashViewState =
  | { state: 'loading'; view?: undefined; highlight?: undefined }
  | { state: 'fallback'; view?: undefined; highlight?: undefined }
  | {
      state: 'ready';
      view: BashView;
      /** Highlight segments of any displayed text (formatted or raw). */
      highlight: (text: string) => HighlightSegment[];
    };

export function commandOf(input: Record<string, unknown>): string {
  return typeof input.command === 'string' ? input.command : '';
}

/**
 * The Bash view of one command (DD-13): `loading` until the parser is in, `fallback` when
 * `forceFallback` (PowerShell — the parser is then never loaded), when the command does not parse
 * or the parser failed to load, else `ready` with the view and a highlighter.
 */
export function useBashView(
  command: string,
  forceFallback = false,
): BashViewState {
  const { repoRoot } = useToolView();
  const loaded = useLoadedParser(!forceFallback);
  return useMemo<BashViewState>(() => {
    if (forceFallback || loaded === 'failed') return { state: 'fallback' };
    if (loaded === null) return { state: 'loading' };
    let view: BashView;
    try {
      view = buildBashView(loaded.parser, command, repoRoot);
    } catch {
      return { state: 'fallback' };
    }
    if (!view.ok) return { state: 'fallback' };
    const { parser, query } = loaded;
    return {
      state: 'ready',
      view,
      highlight: (text: string) => {
        try {
          return highlightBash(parser, text, query);
        } catch {
          return [];
        }
      },
    };
  }, [forceFallback, loaded, command, repoRoot]);
}

/**
 * Bash views of many calls with one parser load (DD-14), keyed by call id. Empty until the parser
 * is in; a command that fails to build is left out (its row stays raw).
 */
export function useBashViews(
  rows: ReadonlyArray<{ id: string; input: Record<string, unknown> }>,
): Map<string, BashView> {
  const { repoRoot } = useToolView();
  const loaded = useLoadedParser(rows.length > 0);
  return useMemo(() => {
    const views = new Map<string, BashView>();
    if (loaded === null || loaded === 'failed') return views;
    for (const row of rows) {
      try {
        views.set(
          row.id,
          buildBashView(loaded.parser, commandOf(row.input), repoRoot),
        );
      } catch {
        /* unparseable — the row keeps its raw preview */
      }
    }
    return views;
  }, [loaded, rows, repoRoot]);
}
