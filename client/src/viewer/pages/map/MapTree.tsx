/**
 * The All views tree (FR-E2, FR-E8, DD-18): an ARIA tree with roving `tabIndex`. The expand state
 * is remembered per user (`map-expanded`, DD-6); a first visit opens the top level and the rail
 * context's path. A filter dims non-matching leaves and opens the branches of its matches without
 * touching the stored state, and ↑/↓ then cycle through the matches only.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { readUserItem, writeUserItem } from '../../lib/user-storage';
import { TooltipProvider } from '../../ui/tooltip';
import { flattenVisible, parseExpanded } from './map-tree-model';
import { MapTreeRowView } from './MapTreeRow';
import type { NavFilterResult, NavNode } from './nav-tree';

/** Top-level container ids (`buildNavTree`), open on a first visit. */
const TOP_LEVEL_IDS = [
  'questions',
  'teams',
  'repos',
  'apikeys',
  'admin',
  'help',
];

const MD_QUERY = '(min-width: 768px)';

function subscribeMd(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(MD_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function isMdUp(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(MD_QUERY).matches
    : true;
}

export interface MapTreeHandle {
  /** Moves focus into the tree: the first match while filtering, else the focused row. */
  focusTree: () => void;
}

export interface MapTreeProps {
  nodes: readonly NavNode[];
  query: string;
  /** `matchNavFilter` result; `null` without a query. */
  filter: NavFilterResult | null;
  userId: number | undefined;
  /** Containers to open on top of the stored state (the rail context's path). */
  openPath: readonly string[];
  /** A leaf is opened, or a greyed node's "choose … ▸" is clicked (the page opens the picker). */
  onActivate: (node: NavNode) => void;
  /** `/` pressed inside the tree. */
  onFocusFilter: () => void;
  handleRef?: Ref<MapTreeHandle>;
}

export function MapTree({
  nodes,
  query,
  filter,
  userId,
  openPath,
  onActivate,
  onFocusFilter,
  handleRef,
}: MapTreeProps) {
  const wide = useSyncExternalStore(subscribeMd, isMdUp, () => true);

  const [stored, setStored] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...(readUserItem(userId, 'map-expanded', parseExpanded) ??
          TOP_LEVEL_IDS),
        ...openPath,
      ]),
  );
  // Branches collapsed by hand while a filter is on; dropped when the query changes.
  const [filterCollapsed, setFilterCollapsed] = useState<{
    query: string;
    ids: ReadonlySet<string>;
  }>({ query: '', ids: new Set() });
  const collapsedNow = useMemo(
    () =>
      filterCollapsed.query === query ? filterCollapsed.ids : new Set<string>(),
    [filterCollapsed, query],
  );

  const filterExpand = useMemo(() => new Set(filter?.expand ?? []), [filter]);
  const matchSet = useMemo(() => new Set(filter?.matches ?? []), [filter]);

  const expanded = useMemo(() => {
    if (!filter) return stored;
    const out = new Set(stored);
    for (const id of filterExpand) if (!collapsedNow.has(id)) out.add(id);
    return out;
  }, [filter, stored, filterExpand, collapsedNow]);

  const rows = useMemo(
    () => flattenVisible(nodes, expanded),
    [nodes, expanded],
  );
  const matchRows = useMemo(
    () => (filter ? rows.filter((r) => matchSet.has(r.node.id)) : []),
    [filter, rows, matchSet],
  );

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const effectiveFocus =
    focusedId !== null && rows.some((r) => r.node.id === focusedId)
      ? focusedId
      : (matchRows[0]?.node.id ?? rows[0]?.node.id ?? null);

  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    const el = rowEls.current.get(id);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const moveFocus = useCallback((id: string | undefined) => {
    if (id === undefined) return;
    pendingFocus.current = id;
    setFocusedId(id);
    rowEls.current.get(id)?.focus();
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      focusTree: () => {
        moveFocus(matchRows[0]?.node.id ?? effectiveFocus ?? undefined);
      },
    }),
    [matchRows, effectiveFocus, moveFocus],
  );

  const toggle = useCallback(
    (id: string) => {
      const open = expanded.has(id);
      if (filter && filterExpand.has(id) && !stored.has(id)) {
        // Opened only by the filter: collapse or reopen it for this query, storage untouched.
        const ids = new Set(collapsedNow);
        if (open) ids.add(id);
        else ids.delete(id);
        setFilterCollapsed({ query, ids });
        return;
      }
      const next = new Set(stored);
      if (open) next.delete(id);
      else next.add(id);
      setStored(next);
      writeUserItem(userId, 'map-expanded', [...next]);
      if (filter && !open && collapsedNow.has(id)) {
        const ids = new Set(collapsedNow);
        ids.delete(id);
        setFilterCollapsed({ query, ids });
      }
    },
    [expanded, filter, filterExpand, stored, collapsedNow, query, userId],
  );

  const activate = useCallback(
    (node: NavNode) => {
      if (node.kind === 'container') toggle(node.id);
      else onActivate(node);
    },
    [toggle, onActivate],
  );

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>, index: number) {
    const row = rows[index];
    const { node } = row;
    const isContainer = node.kind === 'container';
    const open = expanded.has(node.id);
    const step = (dir: 1 | -1) => {
      if (filter) {
        if (matchRows.length === 0) return;
        const pos = matchRows.findIndex((r) => r.node.id === node.id);
        const nextPos =
          pos < 0
            ? dir === 1
              ? matchRows.findIndex((r) => rows.indexOf(r) > index)
              : matchRows.length - 1
            : (pos + dir + matchRows.length) % matchRows.length;
        moveFocus(matchRows[nextPos < 0 ? 0 : nextPos].node.id);
        return;
      }
      moveFocus(rows[index + dir]?.node.id);
    };
    switch (e.key) {
      case 'ArrowDown':
        step(1);
        break;
      case 'ArrowUp':
        step(-1);
        break;
      case 'ArrowRight':
        if (!isContainer) return;
        if (!open) toggle(node.id);
        else moveFocus(rows[index + 1]?.node.id);
        break;
      case 'ArrowLeft':
        if (isContainer && open) toggle(node.id);
        else if (row.parentId !== null) moveFocus(row.parentId);
        break;
      case 'Enter':
        activate(node);
        break;
      case 'Home':
        moveFocus(rows[0]?.node.id);
        break;
      case 'End':
        moveFocus(rows[rows.length - 1]?.node.id);
        break;
      case '/':
        onFocusFilter();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <TooltipProvider>
      <div role="tree" aria-label="All views" className="flex flex-col">
        {rows.map((row, index) => {
          const { node } = row;
          return (
            <MapTreeRowView
              key={node.id}
              row={row}
              expanded={expanded.has(node.id)}
              focused={node.id === effectiveFocus}
              query={filter ? query : ''}
              dimmed={
                filter !== null &&
                node.kind === 'leaf' &&
                !matchSet.has(node.id)
              }
              synonym={filter?.synonymHit[node.id]}
              wide={wide}
              setRef={(el) => {
                if (el) rowEls.current.set(node.id, el);
                else rowEls.current.delete(node.id);
              }}
              onFocus={() => setFocusedId(node.id)}
              onClick={() => {
                setFocusedId(node.id);
                activate(node);
              }}
              onChoose={() => {
                setFocusedId(node.id);
                onActivate(node);
              }}
              onKeyDown={(e) => onKeyDown(e, index)}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );
}
