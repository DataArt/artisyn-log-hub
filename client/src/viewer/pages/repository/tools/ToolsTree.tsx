/**
 * Left pane of the Tools/MCP tab: All tools → MCP / CLI groups → tools → operations. Each row
 * carries its calls number, a bar ∝ calls / the busiest tool's calls and a coloured error %
 * chip. A row click sets the scope of the calls table; chevrons expand and collapse (state kept
 * here, not in the URL). Monitored CLI tools without calls in range show as `never called`.
 */
import { useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Input } from '@/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import type {
  ToolUsageChannel,
  ToolUsageSummaryResponse,
  ToolUsageToolSummary,
} from '../../../../models/tool-monitoring';
import {
  CHANNEL_LABELS,
  EMPTY_AGG,
  groupLastUsed,
  sortTreeItems,
  toolLastUsed,
  TOOLS_TREE_SORT_KEYS,
  TOOLS_TREE_SORT_LABELS,
  type ToolsTreeSortKey,
} from './tools-tree-model';
import type { ToolsScope } from './tools-url-state';
import { TreeRow } from './ToolsTreeRow';

const CHANNELS: readonly ToolUsageChannel[] = ['mcp', 'cli'];

const GROUP_LABELS: Record<ToolUsageChannel, string> = {
  mcp: 'MCP servers',
  cli: 'CLI tools',
};

export interface ToolsTreeProps {
  summary: ToolUsageSummaryResponse;
  scope: ToolsScope;
  onScopeChange: (scope: ToolsScope) => void;
  onCollapse: () => void;
}

function matches(text: string, filter: string): boolean {
  return filter === '' || text.toLowerCase().includes(filter);
}

function sameScope(a: ToolsScope, b: ToolsScope): boolean {
  return (
    a.channel === b.channel && a.tool === b.tool && a.operation === b.operation
  );
}

const toolKey = (channel: ToolUsageChannel, tool: string) =>
  `t:${channel}:${tool}`;

export function ToolsTree({
  summary,
  scope,
  onScopeChange,
  onCollapse,
}: ToolsTreeProps) {
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<ToolsTreeSortKey>('calls');
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>(['g:mcp', 'g:cli']);
    if (scope.channel && scope.tool)
      init.add(toolKey(scope.channel, scope.tool));
    return init;
  });

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const maxCalls = useMemo(
    () => Math.max(0, ...summary.tools.map((t) => t.calls)),
    [summary.tools],
  );
  const f = filter.trim().toLowerCase();

  const select = (next: ToolsScope) => onScopeChange(next);

  const renderTool = (tool: ToolUsageToolSummary) => {
    const key = toolKey(tool.channel, tool.tool);
    const toolMatches = matches(tool.tool, f);
    const ops = sortTreeItems(
      toolMatches
        ? tool.operations
        : tool.operations.filter((o) => matches(o.operation, f)),
      sortKey,
      (o) => o,
      (o) => o.lastUsedAt,
      (o) => o.operation,
    );
    if (!toolMatches && ops.length === 0) return null;
    const open = expanded.has(key) || (f !== '' && !toolMatches);
    const toolScope: ToolsScope = {
      channel: tool.channel,
      tool: tool.tool,
      operation: null,
    };
    return (
      <div key={key} role="group">
        <TreeRow
          level={2}
          label={tool.tool}
          title={`${tool.tool}: ${tool.calls} calls`}
          agg={tool}
          maxCalls={maxCalls}
          selected={sameScope(scope, toolScope)}
          onSelect={() => select(toolScope)}
          expanded={open}
          onToggle={ops.length > 0 ? () => toggle(key) : undefined}
          testId="tools-tree-tool"
        />
        {open
          ? ops.map((op) => {
              const opScope = { ...toolScope, operation: op.operation };
              return (
                <TreeRow
                  key={op.operation}
                  level={3}
                  label={op.operation}
                  title={`${tool.tool} · ${op.operation}: ${op.calls} calls`}
                  agg={op}
                  maxCalls={maxCalls}
                  selected={sameScope(scope, opScope)}
                  onSelect={() => select(opScope)}
                  testId="tools-tree-operation"
                />
              );
            })
          : null}
      </div>
    );
  };

  const groups = CHANNELS.map((channel) => {
    const tools = summary.tools.filter((t) => t.channel === channel);
    const never =
      channel === 'cli'
        ? summary.neverCalled.filter((n) => matches(n, f)).sort()
        : [];
    const toolRows = sortTreeItems(
      tools,
      sortKey,
      (t) => t,
      toolLastUsed,
      (t) => t.tool,
    )
      .map(renderTool)
      .filter((r) => r !== null);
    if (toolRows.length === 0 && never.length === 0) return null;
    return {
      channel,
      agg: summary.groups[channel],
      last: groupLastUsed(tools),
      toolRows,
      never,
    };
  }).filter((g) => g !== null);

  const sortedGroups = sortTreeItems(
    groups,
    sortKey,
    (g) => g.agg,
    (g) => g.last,
    (g) => g.channel,
  );

  const allScope: ToolsScope = { channel: null, tool: null, operation: null };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tools-tree">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <div className="flex items-center gap-1">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tools"
            aria-label="Filter tools"
            className="h-7 text-xs md:text-xs"
            data-testid="tools-tree-filter"
          />
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse the tools tree"
            aria-label="Collapse the tools tree"
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            data-testid="tools-tree-collapse"
          >
            <ChevronLeft className="size-4" />
          </button>
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={sortKey}
          onValueChange={(v) => {
            const key = TOOLS_TREE_SORT_KEYS.find((k) => k === v);
            if (key) setSortKey(key);
          }}
          aria-label="Sort tools by"
          data-testid="tools-tree-sort"
          className="w-full"
        >
          {TOOLS_TREE_SORT_KEYS.map((k) => (
            <ToggleGroupItem
              key={k}
              value={k}
              className="h-6 flex-1 px-1 text-[10px]"
            >
              {TOOLS_TREE_SORT_LABELS[k]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div
        role="tree"
        aria-label="Tools"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        <TreeRow
          level={0}
          label="All tools"
          title={`All tools: ${summary.totals.calls} calls`}
          agg={summary.totals}
          maxCalls={maxCalls}
          selected={sameScope(scope, allScope)}
          onSelect={() => select(allScope)}
          testId="tools-tree-all"
        />
        {sortedGroups.map((g) => {
          const key = `g:${g.channel}`;
          const open = expanded.has(key) || f !== '';
          const groupScope: ToolsScope = {
            channel: g.channel,
            tool: null,
            operation: null,
          };
          return (
            <div key={key} role="group">
              <TreeRow
                level={1}
                label={`${GROUP_LABELS[g.channel]} (${g.agg.tools})`}
                title={`${CHANNEL_LABELS[g.channel]}: ${g.agg.calls} calls`}
                agg={g.agg}
                maxCalls={maxCalls}
                selected={sameScope(scope, groupScope)}
                onSelect={() => select(groupScope)}
                expanded={open}
                onToggle={() => toggle(key)}
                badge={g.channel}
                testId="tools-tree-group"
              />
              {open ? (
                <>
                  {g.toolRows}
                  {g.never.map((name) => {
                    const neverScope: ToolsScope = {
                      channel: 'cli',
                      tool: name,
                      operation: null,
                    };
                    return (
                      <TreeRow
                        key={`never:${name}`}
                        level={2}
                        label={name}
                        title={`${name}: monitored, no calls in this range`}
                        agg={EMPTY_AGG}
                        maxCalls={maxCalls}
                        selected={sameScope(scope, neverScope)}
                        onSelect={() => select(neverScope)}
                        neverCalled
                        testId="tools-tree-never-called"
                      />
                    );
                  })}
                </>
              ) : null}
            </div>
          );
        })}
        {f !== '' && sortedGroups.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No tool matches “{filter.trim()}”.
          </div>
        ) : null}
      </div>
    </div>
  );
}
