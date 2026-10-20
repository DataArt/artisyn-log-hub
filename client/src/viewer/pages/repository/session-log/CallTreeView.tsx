import { useMemo, useState } from 'react';
import type * as React from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import type { SessionLogsData } from '../../../api';
import type { ModelPricingMap } from '../../../../models/pricing';
import { parseSessionLogs, buildAgentParentMap } from './log-parser';
import { cn } from '../../../lib/cn';
import { formatTokens, formatCost } from '../../../lib/format';
import { DetailTooltip } from '../../../components/DetailTooltip';
import {
  TYPE_COLOR_BG,
  DEPTH_PADDING,
  DEFAULT_COLLAPSED_TYPES,
  FILTERABLE_GROUP_TYPES,
  getNodeId,
} from './call-tree/types';
import type { CallTreeNode } from './call-tree/types';
import {
  computeLeafCost,
  computeActualCost,
  sumDescendantLeafCost,
  formatCostShare,
} from './call-tree/cost-utils';
import { useCallTreeNodes } from './call-tree/useCallTreeNodes';
import { getSessionLogsErrorMessage } from './session-logs-error';

interface Props {
  logsData: SessionLogsData | undefined;
  isLoading: boolean;
  error: Error | null;
  pricing?: ModelPricingMap;
  topN: number | null;
  onTopNChange: (n: number | null) => void;
  /** Dashboard preview — render with every default-open node collapsed on mount. */
  startCollapsed?: boolean;
  /** Dashboard preview — narrower cost-share column so the table fits a grid tile. */
  compact?: boolean;
}

function collectDefaultOpenIds(
  nodes: CallTreeNode[],
  parentId: string,
  into: Set<string>,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const id = getNodeId(node, parentId, i);
    if (node.expandable && !DEFAULT_COLLAPSED_TYPES.has(node.type)) {
      into.add(id);
    }
    if (node.children) collectDefaultOpenIds(node.children, id, into);
  }
}

export function CallTreeView({
  logsData,
  isLoading,
  error,
  pricing,
  topN,
  onTopNChange,
  startCollapsed = false,
  compact = false,
}: Props) {
  const parsed = useMemo(
    () =>
      logsData !== undefined
        ? parseSessionLogs(logsData.main, {
            harnessSnapshot: logsData.harnessSnapshot ?? null,
          })
        : null,
    [logsData],
  );

  const subagentLogsMap = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const sa of logsData?.subagents ?? []) {
      const agentId = sa.sessionId.startsWith('agent-')
        ? sa.sessionId.slice('agent-'.length)
        : sa.sessionId;
      map.set(agentId, sa.logs);
    }
    return map;
  }, [logsData]);

  const agentParentMap = useMemo(
    () => buildAgentParentMap(logsData?.subagents ?? []),
    [logsData],
  );

  const treeNodes = useCallTreeNodes(
    parsed,
    logsData,
    subagentLogsMap,
    pricing,
    agentParentMap,
  );

  // Tracks nodes that have been toggled away from their default expand state. The lazy
  // initializer runs once on mount, after treeNodes is already available above.
  const [toggled, setToggled] = useState<Set<string>>(() => {
    if (!startCollapsed) return new Set();
    const ids = new Set<string>();
    collectDefaultOpenIds(treeNodes, 'root', ids);
    return ids;
  });

  const sessionModel = parsed?.summary.model;

  // Use the actual session token breakdown so this matches the session header cost.
  const sessionTotalCost = useMemo(
    () =>
      computeActualCost(
        parsed?.summary.tokenBreakdown ?? null,
        sessionModel,
        pricing,
      ),
    [parsed, sessionModel, pricing],
  );

  // Global top-N: leaf IDs + ancestor IDs. Ancestors drive which expandable rows stay visible.
  const topNSets = useMemo(() => {
    if (topN === null) return null;
    const leaves: Array<{ id: string; tokens: number; ancestors: string[] }> =
      [];
    function collect(
      nodes: CallTreeNode[],
      parentId: string,
      ancestors: string[],
    ) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const id = getNodeId(node, parentId, i);
        if (
          !node.expandable &&
          node.pricingType === 'input' &&
          !FILTERABLE_GROUP_TYPES.has(node.type) &&
          node.tokens != null &&
          node.tokens > 0
        ) {
          leaves.push({ id, tokens: node.tokens, ancestors });
        }
        if (node.children) collect(node.children, id, [...ancestors, id]);
      }
    }
    collect(treeNodes, 'root', []);
    leaves.sort((a, b) => b.tokens - a.tokens);
    const top = leaves.slice(0, topN);
    const leafIds = new Set(top.map((l) => l.id));
    const ancestorIds = new Set<string>();
    for (const l of top) for (const a of l.ancestors) ancestorIds.add(a);
    return { leafIds, ancestorIds };
  }, [topN, treeNodes]);

  const topNLeafIds = topNSets?.leafIds ?? null;
  const topNAncestorIds = topNSets?.ancestorIds ?? null;

  function toggle(id: string) {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderRows(
    nodes: CallTreeNode[],
    depth: number,
    parentId: string,
  ): React.ReactNode[] {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const nodeId = getNodeId(node, parentId, i);

      // When topN is active: hide all leaf nodes that are not in the top-N spend set.
      // This covers: output, cache, user-prompt outside top-N, level-2 aggregates.
      if (topNLeafIds !== null && !node.expandable) {
        if (
          node.pricingType !== 'input' || // output / cache-write / cache-read
          FILTERABLE_GROUP_TYPES.has(node.type) || // level-2 sub-agent aggregate rows
          !topNLeafIds.has(nodeId) // individual input leaf outside top-N
        ) {
          continue;
        }
      }

      // When topN active: hide any expandable node whose subtree has no top-N descendants.
      if (
        topNAncestorIds !== null &&
        node.expandable &&
        !topNAncestorIds.has(nodeId)
      )
        continue;

      // Nodes in DEFAULT_COLLAPSED_TYPES start collapsed; others start expanded.
      // 'toggled' tracks departures from the default state.
      // When a top-N filter is active, filterable groups are forced open.
      const defaultOpen = !DEFAULT_COLLAPSED_TYPES.has(node.type);
      const forceOpen =
        topNSets !== null && FILTERABLE_GROUP_TYPES.has(node.type);
      const isExpanded =
        node.expandable &&
        (forceOpen ||
          (defaultOpen ? !toggled.has(nodeId) : toggled.has(nodeId)));
      const depthPadding = DEPTH_PADDING[Math.min(depth, 2)];
      const colorBgClass = TYPE_COLOR_BG[node.type];

      // For cost share % computation: prompts/total use actual cost; others use estimates.
      const nodeCost =
        node.actualCost !== undefined
          ? node.actualCost
          : node.pricingType && node.tokens != null
            ? computeLeafCost(
                node.tokens,
                node.pricingType,
                node.model ?? sessionModel,
                pricing,
              )
            : sumDescendantLeafCost(node, sessionModel, pricing);

      // Dollar cost only displayed for prompt rows and session total.
      const showCostCell =
        node.type === 'prompt' || node.type === 'session-total';
      const displayCost = showCostCell ? node.actualCost : undefined;

      let costShareStr = '—';
      let costShareBar: React.ReactNode = null;
      if (
        nodeCost !== null &&
        sessionTotalCost !== null &&
        sessionTotalCost > 0
      ) {
        const rawShare =
          node.type === 'session-total'
            ? 100
            : (nodeCost / sessionTotalCost) * 100;
        // Clamp — estimated costs can occasionally exceed the actual total.
        const share = Math.min(rawShare, 100);
        costShareStr = formatCostShare(share);
        const barWidth = Math.min(
          node.type === 'session-total' ? 100 : share,
          100,
        );
        costShareBar = (
          <div className="relative h-1.5 w-full overflow-hidden bg-muted">
            <div
              className="absolute inset-y-0 left-0 bg-primary/30"
              style={{ width: `${barWidth}%` }}
            />
          </div>
        );
      }

      rows.push(
        <tr
          key={nodeId}
          className={cn(
            'border-b border-border/30 hover:bg-muted/30',
            node.expandable && 'cursor-pointer',
            topNLeafIds !== null &&
              topNLeafIds.has(nodeId) &&
              'bg-sky-50/70 dark:bg-sky-950/30',
          )}
          onClick={node.expandable ? () => toggle(nodeId) : undefined}
        >
          <td className={cn('py-1 border-r border-border/20', depthPadding)}>
            <DetailTooltip rows={node.tooltipRows}>
              <div
                className={cn(
                  'flex items-center gap-1.5',
                  compact ? 'min-w-0' : 'whitespace-nowrap',
                )}
              >
                {node.expandable ? (
                  <ChevronRight
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground transition-transform',
                      isExpanded && 'rotate-90',
                    )}
                  />
                ) : (
                  <span className="size-3 shrink-0" />
                )}
                <span
                  className={cn(
                    'inline-block w-1.5 h-3.5 flex-shrink-0',
                    colorBgClass,
                  )}
                />
                <span
                  className={cn(
                    'text-xs text-foreground/80',
                    compact ? 'truncate' : 'whitespace-nowrap',
                  )}
                >
                  {node.label}
                </span>
                {node.type === 'sub-agent' && node.model && !compact && (
                  <span className="ml-1 text-xs text-muted-foreground bg-muted px-1.5 py-0.5">
                    {node.model}
                  </span>
                )}
              </div>
            </DetailTooltip>
          </td>
          <td
            className={cn(
              'py-1 px-2 text-right font-mono text-xs text-muted-foreground border-r border-border/20',
              compact ? 'overflow-hidden truncate' : 'whitespace-nowrap',
            )}
          >
            {node.tokens === null
              ? '—'
              : node.tokens === undefined
                ? ''
                : formatTokens(node.tokens)}
          </td>
          <td
            className={cn(
              'py-1 px-2 text-right font-mono text-xs text-muted-foreground border-r border-border/20',
              compact ? 'overflow-hidden truncate' : 'whitespace-nowrap',
            )}
          >
            {showCostCell
              ? displayCost != null
                ? formatCost(displayCost)
                : '—'
              : ''}
          </td>
          <td
            className={cn('py-1 pl-3 pr-2', compact && 'overflow-hidden')}
            style={compact ? undefined : { minWidth: '290px' }}
          >
            <div className="flex flex-col gap-0.5">
              <span
                className={cn(
                  'text-xs text-muted-foreground',
                  compact ? 'truncate' : 'whitespace-nowrap',
                )}
              >
                {costShareStr}
              </span>
              {!compact && costShareBar}
            </div>
          </td>
        </tr>,
      );

      if (isExpanded && node.children) {
        // Always pass the full children array so each child's index matches its nodeId in topNLeafIds.
        // The leaf-level check above skips non-qualifying leaves inside the recursive call.
        rows.push(...renderRows(node.children, depth + 1, nodeId));
      }
    }
    return rows;
  }

  // --------------------------------------------------------------------------
  // Loading / error / empty states
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {getSessionLogsErrorMessage(error)}
        </p>
      </div>
    );
  }

  if (parsed === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No data available</p>
      </div>
    );
  }

  if (parsed.turns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No turns found.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Sticky header — model badge + top-N filter */}
      <div
        className={cn(
          'sticky top-0 z-10 bg-background border-b border-border/20 flex items-center gap-3',
          compact ? 'px-2 py-1 flex-wrap' : 'px-4 py-2',
        )}
      >
        {sessionModel && (
          <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-muted text-foreground/70">
            {sessionModel}
          </span>
        )}
        <div className="flex divide-x divide-sky-200 dark:divide-sky-800 border border-sky-200 dark:border-sky-800">
          {([null, 5, 10, 20] as const).map((n) => (
            <button
              key={n ?? 'all'}
              onClick={() => onTopNChange(n)}
              className={cn(
                'px-2.5 py-0.5 text-xs transition-colors',
                topN === n
                  ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 font-medium'
                  : 'text-muted-foreground hover:bg-sky-50 dark:hover:bg-sky-900/20',
              )}
            >
              {n === null ? 'All' : `Top ${n}`}
            </button>
          ))}
        </div>
      </div>
      {/* Non-compact: horizontal scroll, sized to its natural content width. Compact (Dashboard
          preview): no scrollbar — the table itself is narrowed to fit instead. */}
      <div className={compact ? 'p-2 overflow-hidden' : 'p-4 overflow-x-auto'}>
        <table
          className={cn(
            'text-sm border-collapse',
            compact && 'w-full table-fixed',
          )}
        >
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th
                className="py-1 pr-4 text-left font-medium border-r border-border/20"
                style={compact ? { width: '40%' } : undefined}
              >
                Component
              </th>
              <th
                className="py-1 px-2 text-right font-medium border-r border-border/20"
                style={compact ? { width: '16%' } : undefined}
              >
                Tokens
              </th>
              <th
                className="py-1 px-2 text-right font-medium border-r border-border/20"
                style={compact ? { width: '22%' } : undefined}
              >
                Cost
              </th>
              <th
                className="py-1 pl-3 text-left font-medium"
                style={compact ? { width: '22%' } : { minWidth: '290px' }}
              >
                Cost share
              </th>
            </tr>
          </thead>
          <tbody>{renderRows(treeNodes, 0, 'root')}</tbody>
        </table>
      </div>
    </div>
  );
}
