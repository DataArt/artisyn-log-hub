/**
 * Left pane of the Live modal (2026-11-04 otel-live-view, Visual/UX notes): the tree nodes the
 * server sent (`inTree`, already in display order) nested by `parentKey`, all expanded at first (the chevron collapses a node's children). A row is
 * chevron, type icon, label (full text in `title`), 🔒 on restricted teams, the cost on the right
 * and an ⓘ shown on hover that opens the details panel. Ended nodes are greyed with an "ended"
 * chip. Clicking a row selects the node.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  FolderGit2,
  FolderX,
  House,
  Info,
  Lock,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OtelLiveNode, OtelLiveNodeType } from '../../models/otel-live';
import { formatMicrosUsd } from '../pages/repository/otel/otel-format';

const TYPE_ICONS: Record<OtelLiveNodeType, LucideIcon> = {
  home: House,
  team: Users,
  noteam: FolderX,
  repo: FolderGit2,
  session: Terminal,
  agent: Bot,
};

export interface LiveTreeProps {
  nodes: readonly OtelLiveNode[];
  selected: string | null;
  onSelect: (key: string) => void;
  onOpenPanel: (key: string) => void;
}

export function liveNodeLabel(node: OtelLiveNode): string {
  if (node.type === 'home') return 'Home';
  if (node.type === 'noteam') return 'No team';
  return node.label;
}

/**
 * A session label split into who (the user email, top line) and what (the prompt excerpt, bottom
 * line). The server keeps sending one `userEmail · excerpt` string; null when it has another shape.
 */
export function liveSessionLines(
  node: OtelLiveNode,
): { who: string; what: string } | null {
  if (node.type !== 'session' || node.userEmail === null) return null;
  const prefix = `${node.userEmail} · `;
  if (!node.label.startsWith(prefix)) return null;
  return { who: node.userEmail, what: node.label.slice(prefix.length) };
}

/** Node label for a row: two lines (who / what) for a session, one line otherwise. */
export function LiveNodeLabel({ node }: { node: OtelLiveNode }) {
  const label = liveNodeLabel(node);
  const lines = liveSessionLines(node);
  if (lines === null) {
    return (
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col leading-tight" title={label}>
      <span className="truncate text-[11px] text-muted-foreground">
        {lines.who}
      </span>
      <span className="truncate">{lines.what}</span>
    </span>
  );
}

function costOf(node: OtelLiveNode): bigint {
  try {
    return BigInt(node.totals.costUsdMicros);
  } catch {
    return 0n;
  }
}

/** Which node keys grew in cost since the previous `nodes`, plus a counter that restarts the flash. */
export interface LiveTreeTicks {
  keys: ReadonlySet<string>;
  seq: number;
}

/**
 * Compares every node's cost with the previous answer: a key whose cost went up is in `keys`
 * until the next answer. The first answer flashes nothing; a node new to the tree flashes only
 * when it already has a cost (it appeared because it ticked).
 */
function useLiveTreeTicks(nodes: readonly OtelLiveNode[]): LiveTreeTicks {
  const prevRef = useRef<Map<string, bigint> | null>(null);
  const [ticks, setTicks] = useState<LiveTreeTicks>({
    keys: new Set(),
    seq: 0,
  });
  useEffect(() => {
    const prev = prevRef.current;
    const next = new Map(nodes.map((n) => [n.key, costOf(n)]));
    prevRef.current = next;
    if (prev === null) return;
    const grown = new Set<string>();
    for (const [key, cost] of next) {
      if (cost > (prev.get(key) ?? 0n)) grown.add(key);
    }
    setTicks((t) => ({ keys: grown, seq: t.seq + 1 }));
  }, [nodes]);
  return ticks;
}

interface RowProps extends Omit<LiveTreeProps, 'nodes'> {
  node: OtelLiveNode;
  depth: number;
  childMap: Map<string, OtelLiveNode[]>;
  ticks: LiveTreeTicks;
  collapsedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

function TreeRow({
  node,
  depth,
  childMap,
  selected,
  onSelect,
  onOpenPanel,
  ticks,
  collapsedKeys,
  onToggle,
}: RowProps) {
  const ticked = ticks.keys.has(node.key);
  const collapsed = collapsedKeys.has(node.key);
  const kids = childMap.get(node.key) ?? [];
  const Icon = TYPE_ICONS[node.type];
  const label = liveNodeLabel(node);
  return (
    <li>
      <div
        className={cn(
          'group relative flex items-start gap-1 rounded pr-1 hover:bg-accent',
          selected === node.key && 'bg-accent font-medium',
          !node.live && 'text-muted-foreground opacity-60',
        )}
        style={{ paddingLeft: depth * 12 }}
        data-testid="live-tree-node"
        data-key={node.key}
        data-live={node.live ? 'true' : 'false'}
        data-ticked={ticked ? 'true' : undefined}
      >
        {ticked && (
          // Re-keyed on every poll so a row that grows again flashes again.
          <span
            key={ticks.seq}
            className="live-tick-flash pointer-events-none absolute inset-0 rounded"
            aria-hidden
          />
        )}
        {/* Every item sits in an h-5 slot, so a two-line session label keeps them on its top line. */}
        <button
          type="button"
          className={cn(
            'box-content flex h-5 shrink-0 items-center py-0.5 pl-1 text-muted-foreground hover:text-foreground',
            kids.length === 0 && 'invisible',
          )}
          aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          aria-expanded={kids.length > 0 ? !collapsed : undefined}
          tabIndex={kids.length === 0 ? -1 : undefined}
          onClick={() => onToggle(node.key)}
          data-testid="live-tree-toggle"
        >
          <ChevronDown
            className={cn(
              'size-3 transition-transform',
              collapsed && '-rotate-90',
            )}
            aria-hidden
          />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-1 py-0.5 text-left"
          title={label}
          aria-current={selected === node.key ? 'true' : undefined}
          onClick={() => onSelect(node.key)}
          data-testid="live-tree-select"
        >
          <span className="flex h-5 shrink-0 items-center">
            <Icon className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
          <LiveNodeLabel node={node} />
          {node.restricted && (
            <span className="flex h-5 shrink-0 items-center">
              <Lock
                className="size-3 text-muted-foreground"
                aria-label="Only your own sessions are shown for this team"
                data-testid="live-tree-restricted"
              />
            </span>
          )}
          {!node.live && (
            <span className="flex h-5 shrink-0 items-center">
              <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                ended
              </span>
            </span>
          )}
        </button>
        <span className="box-content flex h-5 shrink-0 items-center py-0.5 font-mono text-xs text-muted-foreground">
          {formatMicrosUsd(node.totals.costUsdMicros)}
        </span>
        <button
          type="button"
          aria-label={`Details of ${label}`}
          className="mt-0.5 flex h-5 shrink-0 items-center rounded px-0.5 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          onClick={() => onOpenPanel(node.key)}
          data-testid="live-tree-info"
        >
          <Info className="size-3.5" />
        </button>
      </div>
      {kids.length > 0 && !collapsed && (
        <ul>
          {kids.map((k) => (
            <TreeRow
              key={k.key}
              node={k}
              depth={depth + 1}
              childMap={childMap}
              selected={selected}
              onSelect={onSelect}
              onOpenPanel={onOpenPanel}
              ticks={ticks}
              collapsedKeys={collapsedKeys}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function LiveTree({
  nodes,
  selected,
  onSelect,
  onOpenPanel,
}: LiveTreeProps) {
  const { roots, children } = useMemo(() => {
    const inTree = nodes.filter((n) => n.inTree);
    const keys = new Set(inTree.map((n) => n.key));
    const byParent = new Map<string, OtelLiveNode[]>();
    const top: OtelLiveNode[] = [];
    for (const n of inTree) {
      // A node whose parent is missing is shown at the top rather than dropped.
      if (n.parentKey === null || !keys.has(n.parentKey)) {
        top.push(n);
        continue;
      }
      const list = byParent.get(n.parentKey) ?? [];
      list.push(n);
      byParent.set(n.parentKey, list);
    }
    return { roots: top, children: byParent };
  }, [nodes]);
  const ticks = useLiveTreeTicks(nodes);
  // Everything starts expanded; the chevron collapses a node's children for this modal session.
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onToggle = useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  return (
    <ul className="text-sm" data-testid="live-tree">
      {roots.map((n) => (
        <TreeRow
          key={n.key}
          node={n}
          depth={0}
          childMap={children}
          selected={selected}
          onSelect={onSelect}
          onOpenPanel={onOpenPanel}
          ticks={ticks}
          collapsedKeys={collapsedKeys}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}
