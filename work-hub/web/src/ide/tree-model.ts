// The file tree's state (D12): directory listings loaded lazily one directory per call, the
// expanded directories and the selection. Paths are repo-relative with `/`; the root is `""`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../api/client";
import { listDir, type Entry } from "../api/fs";

/** The repository root. */
export const ROOT_DIR = "";

export interface TreeState {
  /** Loaded listings by directory path; a directory without an entry is not loaded yet. */
  listings: Record<string, Entry[]>;
  /** Expanded directories (the root is always shown expanded). */
  expanded: string[];
  /** Directories whose first listing is on its way. */
  loading: string[];
  /** The selected entry's path. */
  selected: string | null;
}

/** One visible row of the tree. */
export interface TreeRow {
  entry: Entry;
  depth: number;
  expanded: boolean;
  loading: boolean;
}

export const EMPTY_TREE: TreeState = {
  listings: {},
  expanded: [],
  loading: [],
  selected: null,
};

/** The directory holding `path` (`""` for a top-level entry). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? ROOT_DIR : path.slice(0, i);
}

/** The last segment of `path`. */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir === ROOT_DIR ? name : `${dir}/${name}`;
}

/** `path` is `ancestor` or lies under it. */
export function isWithin(path: string, ancestor: string): boolean {
  if (ancestor === ROOT_DIR) return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** `path` with its `from` prefix replaced by `to` (for entries moved with their folder). */
export function repointPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return `${to}${path.slice(from.length)}`;
}

function sameListing(a: Entry[] | undefined, b: Entry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.path !== y.path ||
      x.kind !== y.kind ||
      x.size !== y.size ||
      x.mtime !== y.mtime
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Stores the listing of `dir`, or drops it with everything under it when the directory is gone
 * (`null`). Expanded subdirectories that disappeared from the listing are collapsed.
 */
export function applyListing(
  state: TreeState,
  dir: string,
  entries: Entry[] | null,
): TreeState {
  if (entries === null) {
    if (dir === ROOT_DIR) return state;
    return forgetSubtree(state, dir);
  }
  if (sameListing(state.listings[dir], entries)) {
    return state.loading.includes(dir)
      ? { ...state, loading: state.loading.filter((d) => d !== dir) }
      : state;
  }
  const dirs = new Set(
    entries.filter((e) => e.kind === "dir").map((e) => e.path),
  );
  let next: TreeState = {
    ...state,
    listings: { ...state.listings, [dir]: entries },
    loading: state.loading.filter((d) => d !== dir),
  };
  const prev = state.listings[dir] ?? [];
  for (const e of prev) {
    if (e.kind === "dir" && !dirs.has(e.path)) {
      next = forgetSubtree(next, e.path);
    }
  }
  return next;
}

/** Forgets the listings and the expand state of `dir` and everything under it. */
export function forgetSubtree(state: TreeState, dir: string): TreeState {
  const listings: Record<string, Entry[]> = {};
  for (const [d, entries] of Object.entries(state.listings)) {
    if (!isWithin(d, dir)) listings[d] = entries;
  }
  return {
    ...state,
    listings,
    expanded: state.expanded.filter((d) => !isWithin(d, dir)),
    loading: state.loading.filter((d) => !isWithin(d, dir)),
  };
}

/** The rows to draw: the root's entries and, depth first, those of every expanded directory. */
export function visibleRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const expanded = new Set(state.expanded);
  const loading = new Set(state.loading);
  const walk = (dir: string, depth: number) => {
    for (const entry of state.listings[dir] ?? []) {
      const isOpen = entry.kind === "dir" && expanded.has(entry.path);
      rows.push({
        entry,
        depth,
        expanded: isOpen,
        loading: loading.has(entry.path),
      });
      if (isOpen) walk(entry.path, depth + 1);
    }
  };
  walk(ROOT_DIR, 0);
  return rows;
}

/** The directories the poll should list: the root plus every expanded one. */
export function polledDirs(state: TreeState): string[] {
  return [ROOT_DIR, ...state.expanded];
}

export interface FileTreeModel {
  state: TreeState;
  rows: TreeRow[];
  /** Loads the root listing (again). */
  loadRoot: () => Promise<void>;
  /** Expands `dir`, loading its listing the first time. */
  expand: (dir: string) => Promise<void>;
  collapse: (dir: string) => void;
  toggle: (dir: string) => void;
  select: (path: string | null) => void;
  /** Re-lists `dir` now (after an upload or a move into it). */
  reload: (dir: string) => Promise<void>;
  /** Merges poll results (`null` = the directory is gone). */
  mergeListings: (dirs: Record<string, Entry[] | null>) => void;
  /** Forgets a moved directory's subtree (its new place is listed by the next reload). */
  forget: (dir: string) => void;
  /** An error from the last root load, if any. */
  rootError: unknown;
}

/** Tree state for one view of a workspace. A new `workspaceId`/`view` pair starts empty. */
export function useFileTree(workspaceId: string, view: string): FileTreeModel {
  const [state, setState] = useState<TreeState>(EMPTY_TREE);
  const [rootError, setRootError] = useState<unknown>(null);
  const key = `${workspaceId}\u0000${view}`;
  /** The view whose answers are still wanted; answers for an older one are dropped. */
  const keyRef = useRef(key);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    stateRef.current = EMPTY_TREE;
    setState(EMPTY_TREE);
    setRootError(null);
  }, [key]);

  const fetchInto = useCallback(
    async (dir: string): Promise<void> => {
      const forKey = `${workspaceId}\u0000${view}`;
      try {
        const entries = await listDir(workspaceId, view, dir);
        if (keyRef.current !== forKey) return;
        setState((s) => applyListing(s, dir, entries));
        if (dir === ROOT_DIR) setRootError(null);
      } catch (err) {
        if (keyRef.current !== forKey) return;
        if (err instanceof ApiError && err.statusCode === 404) {
          setState((s) => applyListing(s, dir, null));
        } else {
          setState((s) => ({
            ...s,
            loading: s.loading.filter((d) => d !== dir),
          }));
        }
        if (dir === ROOT_DIR) setRootError(err);
      }
    },
    [workspaceId, view],
  );

  const expand = useCallback(
    async (dir: string) => {
      const needsLoad = stateRef.current.listings[dir] === undefined;
      setState((s) => ({
        ...s,
        expanded: s.expanded.includes(dir) ? s.expanded : [...s.expanded, dir],
        loading:
          needsLoad && !s.loading.includes(dir)
            ? [...s.loading, dir]
            : s.loading,
      }));
      if (needsLoad) await fetchInto(dir);
    },
    [fetchInto],
  );

  const collapse = useCallback((dir: string) => {
    setState((s) => ({
      ...s,
      expanded: s.expanded.filter((d) => d !== dir),
    }));
  }, []);

  const toggle = useCallback(
    (dir: string) => {
      if (state.expanded.includes(dir)) collapse(dir);
      else void expand(dir);
    },
    [state.expanded, collapse, expand],
  );

  const select = useCallback((path: string | null) => {
    setState((s) => (s.selected === path ? s : { ...s, selected: path }));
  }, []);

  const mergeListings = useCallback((dirs: Record<string, Entry[] | null>) => {
    setState((s) => {
      let next = s;
      for (const [dir, entries] of Object.entries(dirs)) {
        // Only directories the tree still shows: a collapse may have raced the poll.
        if (dir !== ROOT_DIR && !next.expanded.includes(dir)) continue;
        next = applyListing(next, dir, entries);
      }
      return next;
    });
  }, []);

  const forget = useCallback((dir: string) => {
    setState((s) => forgetSubtree(s, dir));
  }, []);

  const loadRoot = useCallback(() => fetchInto(ROOT_DIR), [fetchInto]);

  const rows = useMemo(() => visibleRows(state), [state]);

  return {
    state,
    rows,
    loadRoot,
    expand,
    collapse,
    toggle,
    select,
    reload: fetchInto,
    mergeListings,
    forget,
    rootError,
  };
}
