/**
 * The OKF tree: bundle → folder → file with read heat, write bar and markers. Shared by the
 * session OKF tab and the repo OKF tab (`variant`).
 *
 * All rows render unconditionally (no inner scroll container), like the change-surface tree.
 * The parent can call `scrollToNode(bundle, path)` through `ref`: it opens every ancestor,
 * highlights the node and scrolls it into view after the next render.
 */
import {
  Fragment,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import type { OkfTreeNode } from '../../../../../models/repositories';
import {
  filterOkfTreeByFiles,
  findOkfNodePath,
  folderScanCounts,
  flattenOkfTree,
  isExpanded,
  sortOkfTree,
  type OkfHeatMetric,
} from './okf-tree';
import {
  OkfTreeHeader,
  OkfTreeRow,
  type OkfTreeVariant,
} from './okf-tree-rows';
import { OkfTreeLegend } from './okf-tree-columns';
import {
  okfTreeFilePaths,
  type OkfSessionDetails,
} from './okf-session-details';
import {
  OkfAgentPointerRow,
  OkfMissRow,
  OkfOrphanMisses,
} from './okf-tree-session-rows';

export interface OkfTreeHandle {
  scrollToNode: (bundle: string | null, path?: string) => void;
}

export interface OkfTreeProps {
  tree: readonly OkfTreeNode[];
  metric: OkfHeatMetric;
  variant?: OkfTreeVariant;
  /** Bundle roots that are gitignored (chip on the bundle row). */
  ignoredBundles?: ReadonlySet<string>;
  /** Label of the synthetic `bundle: null` group. */
  nullGroupLabel: string;
  /** When set, only these file paths (one agent's reads) are shown. */
  fileFilter?: ReadonlySet<string> | null;
  /** Note shown above the rows while `fileFilter` is set. */
  filterNote?: string;
  /** Repo tab: a file name opens the article drill-down. */
  onOpenArticle?: (path: string) => void;
  /** Session tab: per-agent new pointers and routing misses by article path. */
  details?: OkfSessionDetails;
  ref?: Ref<OkfTreeHandle>;
}

export function OkfTree({
  tree,
  metric,
  variant = 'session',
  ignoredBundles,
  nullGroupLabel,
  fileFilter = null,
  filterNote,
  onOpenArticle,
  details,
  ref,
}: OkfTreeProps) {
  const [openPointers, setOpenPointers] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const orphanMisses = useMemo(() => {
    if (!details) return [];
    const inTree = okfTreeFilePaths(tree);
    return [...details.misses]
      .filter(([path]) => !inTree.has(path))
      .flatMap(([, list]) => list);
  }, [details, tree]);
  const togglePointers = (path: string) => {
    setOpenPointers((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [highlight, setHighlight] = useState<string | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const sorted = useMemo(() => sortOkfTree(tree, metric), [tree, metric]);
  const folderScans = useMemo(() => folderScanCounts(tree), [tree]);
  const shown = useMemo(
    () => (fileFilter ? filterOkfTreeByFiles(sorted, fileFilter) : sorted),
    [sorted, fileFilter],
  );
  const rows = useMemo(
    () => flattenOkfTree(shown, overrides),
    [shown, overrides],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToNode: (bundle, path) => {
        const trail = findOkfNodePath(sorted, bundle, path);
        if (!trail) return;
        setOverrides((prev) => {
          const next = new Map(prev);
          // Every ancestor opens; the target itself keeps its state.
          for (const key of trail.slice(0, -1)) next.set(key, true);
          return next;
        });
        setHighlight(trail[trail.length - 1]);
        setScrollTick((t) => t + 1);
      },
    }),
    [sorted],
  );

  useEffect(() => {
    if (scrollTick === 0 || highlight === null) return;
    const el = containerRef.current?.querySelector(
      `[data-okf-key="${CSS.escape(highlight)}"]`,
    );
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [scrollTick, highlight]);

  const toggle = (key: string) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      const node = rows.find((r) => r.key === key)?.node;
      const current = node ? isExpanded(node, prev) : true;
      next.set(key, !current);
      return next;
    });
  };

  return (
    <div
      ref={containerRef}
      data-testid="okf-tree"
      className="min-w-0 overflow-x-auto rounded-md border border-border bg-card"
    >
      {/* The repo variant's fixed columns are wider than the tree beside the side panel at
          xl widths; the name column keeps a minimum width and the tree scrolls sideways. */}
      <div className="min-w-fit">
        <OkfTreeHeader metric={metric} variant={variant} />
        {fileFilter && filterNote ? (
          <div className="border-b border-border bg-accent/40 px-3 py-1 text-[11px] text-muted-foreground">
            {filterNote}
          </div>
        ) : null}
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No KB paths to show
          </div>
        ) : (
          <div>
            {rows.map((entry) => {
              const path = entry.node.kind === 'file' ? entry.node.path : null;
              const ptrs = path ? details?.pointers.get(path) : undefined;
              const misses = path ? details?.misses.get(path) : undefined;
              const open = path !== null && openPointers.has(path);
              return (
                <Fragment key={entry.key}>
                  <OkfTreeRow
                    entry={entry}
                    metric={metric}
                    variant={variant}
                    bundleLabel={entry.top.bundle ?? nullGroupLabel}
                    bundleIgnored={
                      entry.top.bundle !== null &&
                      (ignoredBundles?.has(entry.top.bundle) ?? false)
                    }
                    folderScans={folderScans.get(entry.key) ?? 0}
                    highlighted={highlight === entry.key}
                    onToggle={toggle}
                    onOpenArticle={onOpenArticle}
                    pointerToggle={
                      path && ptrs
                        ? {
                            open,
                            agents: ptrs.length,
                            onToggle: () => togglePointers(path),
                          }
                        : undefined
                    }
                  />
                  {open
                    ? ptrs?.map((p) => (
                        <OkfAgentPointerRow
                          key={`p:${p.agentId}`}
                          entry={p}
                          depth={entry.depth}
                        />
                      ))
                    : null}
                  {misses?.map((m) => (
                    <OkfMissRow
                      key={`m:${m.agentId}`}
                      miss={m}
                      depth={entry.depth}
                    />
                  ))}
                </Fragment>
              );
            })}
          </div>
        )}
        {!fileFilter ? <OkfOrphanMisses misses={orphanMisses} /> : null}
        {variant === 'repo' ? <OkfTreeLegend /> : null}
      </div>
    </div>
  );
}
