// The IDE's tabs (Visual/UX "Tab row"): pinned tabs first — the chat and the Login / Configure
// service tabs, with no close control and never moved — then the file tabs in opening order.

import { useCallback, useMemo, useReducer } from "react";

import { isWithin, repointPath } from "./tree-model";

/** A pinned tab: the workstream chat or a service tab. Its id is its kind. */
export type PinnedKind = "chat" | "login" | "configure";

export interface PinnedTab {
  kind: PinnedKind;
  id: PinnedKind;
  title: string;
}

export interface FileTab {
  kind: "file";
  /**
   * Stable for the tab's life (`file:<n>`), also when its file is moved, so the editor keeps its
   * unsaved text.
   */
  id: string;
  /** Repo-relative path. */
  path: string;
  dirty: boolean;
}

export type Tab = PinnedTab | FileTab;

export interface TabsState {
  pinned: PinnedTab[];
  files: FileTab[];
  activeId: string | null;
  /** Sequence of the next file tab id. */
  nextId: number;
}

/** The order pinned tabs keep among themselves, whatever order they were added in. */
const PINNED_ORDER: Record<PinnedKind, number> = {
  chat: 0,
  login: 1,
  configure: 2,
};

export type TabsAction =
  | { type: "openFile"; path: string }
  | { type: "focus"; id: string }
  | { type: "close"; id: string }
  | { type: "setDirty"; id: string; dirty: boolean }
  | { type: "pin"; tab: PinnedTab; focus: boolean }
  | { type: "unpin"; id: PinnedKind }
  | { type: "moved"; from: string; to: string }
  | { type: "reset"; pinned: PinnedTab[] };

/** The tab to show after `id` closes: its right neighbour, else its left one. */
function neighbourOf(state: TabsState, id: string): string | null {
  const order = [
    ...state.pinned.map((t) => t.id),
    ...state.files.map((t) => t.id),
  ];
  const i = order.indexOf(id);
  if (i < 0) return state.activeId;
  return order[i + 1] ?? order[i - 1] ?? null;
}

export function initialTabs(pinned: PinnedTab[] = []): TabsState {
  return {
    pinned,
    files: [],
    activeId: pinned[0]?.id ?? null,
    nextId: 1,
  };
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "openFile": {
      const open = state.files.find((t) => t.path === action.path);
      if (open) {
        return state.activeId === open.id
          ? state
          : { ...state, activeId: open.id };
      }
      const id = `file:${state.nextId}`;
      return {
        ...state,
        files: [
          ...state.files,
          { kind: "file", id, path: action.path, dirty: false },
        ],
        activeId: id,
        nextId: state.nextId + 1,
      };
    }
    case "focus": {
      const exists =
        state.pinned.some((t) => t.id === action.id) ||
        state.files.some((t) => t.id === action.id);
      return exists && state.activeId !== action.id
        ? { ...state, activeId: action.id }
        : state;
    }
    case "close": {
      if (!state.files.some((t) => t.id === action.id)) return state;
      const activeId =
        state.activeId === action.id
          ? neighbourOf(state, action.id)
          : state.activeId;
      return {
        ...state,
        files: state.files.filter((t) => t.id !== action.id),
        activeId,
      };
    }
    case "setDirty": {
      const tab = state.files.find((t) => t.id === action.id);
      if (!tab || tab.dirty === action.dirty) return state;
      return {
        ...state,
        files: state.files.map((t) =>
          t.id === action.id ? { ...t, dirty: action.dirty } : t,
        ),
      };
    }
    case "pin": {
      const others = state.pinned.filter((t) => t.id !== action.tab.id);
      const pinned = [...others, action.tab].sort(
        (a, b) => PINNED_ORDER[a.kind] - PINNED_ORDER[b.kind],
      );
      return {
        ...state,
        pinned,
        activeId:
          action.focus || state.activeId === null
            ? action.tab.id
            : state.activeId,
      };
    }
    case "unpin": {
      if (!state.pinned.some((t) => t.id === action.id)) return state;
      const activeId =
        state.activeId === action.id
          ? neighbourOf(state, action.id)
          : state.activeId;
      return {
        ...state,
        pinned: state.pinned.filter((t) => t.id !== action.id),
        activeId,
      };
    }
    case "moved": {
      // Tabs of the moved file, or of files under a moved folder, follow it (D12).
      const byPath = new Map(
        state.files
          .filter((t) => !isWithin(t.path, action.from))
          .map((t) => [t.path, t.id]),
      );
      let activeId = state.activeId;
      const files: FileTab[] = [];
      for (const t of state.files) {
        if (!isWithin(t.path, action.from)) {
          files.push(t);
          continue;
        }
        const path = repointPath(t.path, action.from, action.to);
        const existing = byPath.get(path);
        if (existing !== undefined) {
          // A tab was already open on the replaced target: it stays, the moved one goes.
          if (activeId === t.id) activeId = existing;
          continue;
        }
        byPath.set(path, t.id);
        files.push({ ...t, path });
      }
      return { ...state, files, activeId };
    }
    case "reset":
      return { ...initialTabs(action.pinned), nextId: state.nextId };
  }
}

export interface TabsStore {
  state: TabsState;
  /** Pinned tabs first, then file tabs. */
  tabs: Tab[];
  active: Tab | null;
  openFile: (path: string) => void;
  focus: (id: string) => void;
  close: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  pin: (tab: PinnedTab, focus?: boolean) => void;
  unpin: (id: PinnedKind) => void;
  /** Re-points tabs after `from` was moved to `to`. */
  moved: (from: string, to: string) => void;
  /** Drops every tab (a different view) and starts with `pinned`. */
  reset: (pinned?: PinnedTab[]) => void;
}

export function useTabs(initialPinned: PinnedTab[] = []): TabsStore {
  const [state, dispatch] = useReducer(tabsReducer, initialPinned, initialTabs);

  const openFile = useCallback(
    (path: string) => dispatch({ type: "openFile", path }),
    [],
  );
  const focus = useCallback(
    (id: string) => dispatch({ type: "focus", id }),
    [],
  );
  const close = useCallback(
    (id: string) => dispatch({ type: "close", id }),
    [],
  );
  const setDirty = useCallback(
    (id: string, dirty: boolean) => dispatch({ type: "setDirty", id, dirty }),
    [],
  );
  const pin = useCallback(
    (tab: PinnedTab, focusIt = true) =>
      dispatch({ type: "pin", tab, focus: focusIt }),
    [],
  );
  const unpin = useCallback(
    (id: PinnedKind) => dispatch({ type: "unpin", id }),
    [],
  );
  const moved = useCallback(
    (from: string, to: string) => dispatch({ type: "moved", from, to }),
    [],
  );
  const reset = useCallback(
    (pinned: PinnedTab[] = []) => dispatch({ type: "reset", pinned }),
    [],
  );

  const tabs = useMemo<Tab[]>(
    () => [...state.pinned, ...state.files],
    [state.pinned, state.files],
  );
  const active = useMemo(
    () => tabs.find((t) => t.id === state.activeId) ?? null,
    [tabs, state.activeId],
  );

  return {
    state,
    tabs,
    active,
    openFile,
    focus,
    close,
    setDirty,
    pin,
    unpin,
    moved,
    reset,
  };
}
