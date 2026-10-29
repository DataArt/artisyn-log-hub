/**
 * The "Tools/MCP" tab: which MCP servers and monitored CLI tools the agents called, how often
 * they failed, and every call's input and output. Used twice: as the repository view's main tab
 * (every in-scope session over a date range) and, with `sessionId`, as a session detail tab
 * (that one session tree, whole session, no date range and no Monitored tools button). The
 * Monitored tools button opens the repository settings' "Monitored Tools" tab.
 *
 * Top bar over three panes: the tools tree (collapsible to a rail), the calls table and the
 * call details, split by two draggable handles whose widths persist in localStorage (DD-21).
 * Every filter, the scope, the page and the selected call live in `t*` URL params. The tree
 * follows date range and scope only; status and search filter the table only (DD-18). While
 * the server still derives rows for some sessions, the summary refetches every
 * `PENDING_REFETCH_MS` and a grey note says so.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Skeleton } from '@/ui/skeleton';
import {
  ApiError,
  fetchToolCalls,
  fetchToolMonitoringConfig,
  fetchToolSummary,
} from '../../../api';
import { useDraggableWidth } from '../../../hooks/useDraggableWidth';
import { toIsoDateBounds } from '../reports/report-url';
import { ToolCallDetails } from './ToolCallDetails';
import { ToolCallsTable } from './ToolCallsTable';
import { ToolsTopBar, type ToolsTopBarPatch } from './ToolsTopBar';
import { ToolsTree } from './ToolsTree';
import {
  DETAILS_MIN_WIDTH,
  PENDING_REFETCH_MS,
  TABLE_WIDTH_DEFAULT,
  TABLE_WIDTH_MIN,
  TOOLS_TABLE_WIDTH_KEY,
  TOOLS_TREE_COLLAPSED_KEY,
  TOOLS_TREE_WIDTH_KEY,
  TREE_RAIL_WIDTH,
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MIN,
} from './tools-constants';
import {
  TOOLS_PARAM_KEYS,
  toolsStateFromParams,
  writeToolsState,
  type ToolsTabUrlState,
} from './tools-url-state';

export interface RepoToolsTabProps {
  repoId: number;
  teamId?: number;
  /** Root session id: show only that session tree's calls (the session detail tab). */
  sessionId?: string;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(TOOLS_TREE_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(TOOLS_TREE_COLLAPSED_KEY, String(value));
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

function LoadingSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-3 p-4" data-testid="tools-loading">
      <Skeleton className="h-full w-[280px] shrink-0" />
      <Skeleton className="h-full w-[560px] shrink-0" />
      <Skeleton className="h-full flex-1" />
    </div>
  );
}

function Splitter({
  label,
  testId,
  onMouseDown,
}: {
  label: string;
  testId: string;
  onMouseDown: React.MouseEventHandler;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-testid={testId}
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/30"
    />
  );
}

export function RepoToolsTab({ repoId, teamId, sessionId }: RepoToolsTabProps) {
  const sessionMode = sessionId !== undefined;
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(
    () => toolsStateFromParams(searchParams),
    [searchParams],
  );
  const update = (patch: Partial<ToolsTabUrlState>) =>
    setSearchParams(
      (prev) =>
        writeToolsState(
          prev,
          { ...toolsStateFromParams(prev), ...patch },
          { withRange: !sessionMode },
        ),
      { replace: true },
    );
  // Any filter or scope change starts again on page 1. A new scope (another tool or operation)
  // also drops the selected call: it belonged to the previous tool's list.
  const onFilterChange = (patch: ToolsTopBarPatch) => {
    const scopeChanged =
      patch.scope !== undefined &&
      (patch.scope.channel !== state.scope.channel ||
        patch.scope.tool !== state.scope.tool ||
        patch.scope.operation !== state.scope.operation);
    update({ ...patch, page: 1, ...(scopeChanged ? { call: null } : {}) });
  };

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const setTreeCollapsed = (value: boolean) => {
    setCollapsed(value);
    writeCollapsed(value);
  };

  const rowRef = useRef<HTMLDivElement | null>(null);
  const rowWidth = () => rowRef.current?.clientWidth ?? window.innerWidth;
  const tree = useDraggableWidth({
    storageKey: TOOLS_TREE_WIDTH_KEY,
    defaultWidth: TREE_WIDTH_DEFAULT,
    minWidth: TREE_WIDTH_MIN,
    getMaxWidth: () => rowWidth() - TABLE_WIDTH_MIN - DETAILS_MIN_WIDTH,
  });
  const treeWidth = collapsed ? TREE_RAIL_WIDTH : tree.width;
  const table = useDraggableWidth({
    storageKey: TOOLS_TABLE_WIDTH_KEY,
    defaultWidth: TABLE_WIDTH_DEFAULT,
    minWidth: TABLE_WIDTH_MIN,
    getMaxWidth: () => rowWidth() - treeWidth - DETAILS_MIN_WIDTH,
  });

  // The session tab has no date range: the server then covers the whole session.
  const bounds = sessionMode
    ? null
    : toIsoDateBounds(state.startDate, state.endDate);
  const from = bounds?.startDate;
  const to = bounds?.endDate;

  const summaryQuery = useQuery({
    queryKey: [
      'tool-summary',
      repoId,
      teamId ?? null,
      sessionId ?? null,
      from,
      to,
    ],
    queryFn: () => fetchToolSummary(repoId, { teamId, sessionId, from, to }),
    refetchInterval: (q) =>
      (q.state.data?.pendingSessions ?? 0) > 0 ? PENDING_REFETCH_MS : false,
  });
  const pending = summaryQuery.data?.pendingSessions ?? 0;

  const { scope } = state;
  const callsQuery = useQuery({
    queryKey: [
      'tool-calls',
      repoId,
      teamId ?? null,
      sessionId ?? null,
      from,
      to,
      scope.channel,
      scope.tool,
      scope.operation,
      state.status,
      state.q,
      state.page,
    ],
    queryFn: () =>
      fetchToolCalls(repoId, {
        teamId,
        sessionId,
        from,
        to,
        channel: scope.channel ?? undefined,
        tool: scope.tool ?? undefined,
        operation: scope.operation ?? undefined,
        status: state.status ?? undefined,
        q: state.q || undefined,
        page: state.page,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: pending > 0 ? PENDING_REFETCH_MS : false,
  });

  const configQuery = useQuery({
    queryKey: ['tool-monitoring-config', repoId, teamId ?? null],
    queryFn: () => fetchToolMonitoringConfig(repoId, teamId),
    enabled: !sessionMode,
  });
  // The list is edited in the repository settings; the tab's own `t*` params mean nothing there.
  const openMonitoredTools = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of TOOLS_PARAM_KEYS) next.delete(key);
        next.set('mtab', 'settings');
        next.set('stab', 'monitored-tools');
        return next;
      },
      { replace: true },
    );
  const monitoredCount = configQuery.data
    ? configQuery.data.tools.filter((t) => t.enabled).length
    : null;

  const summary = summaryQuery.data;
  const calls = callsQuery.data;
  const error = summaryQuery.error ?? callsQuery.error;
  const forbidden = error instanceof ApiError && error.statusCode === 403;

  let body;
  if (forbidden) {
    body = (
      <div
        data-testid="tools-forbidden"
        className="m-4 rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground"
      >
        You do not have access to this repository&apos;s tool usage.
      </div>
    );
  } else if (error) {
    body = (
      <div
        data-testid="tools-error"
        className="m-4 rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground"
      >
        Error — tool usage could not be loaded.
      </div>
    );
  } else if (summaryQuery.isLoading || !summary) {
    body = <LoadingSkeleton />;
  } else if (summary.totals.calls === 0 && summary.neverCalled.length === 0) {
    body = (
      <div
        data-testid="tools-empty"
        className="p-8 text-center text-sm text-muted-foreground"
      >
        <div className="font-medium text-foreground">
          {sessionMode
            ? 'No tool calls in this session'
            : 'No tool calls in this range'}
        </div>
        <div className="mt-1">
          {sessionMode
            ? 'This session called no MCP server and no monitored CLI tool.'
            : 'No session in this range called an MCP server or a monitored CLI tool.'}
        </div>
      </div>
    );
  } else {
    body = (
      <div
        ref={rowRef}
        className="flex min-h-0 flex-1 overflow-x-auto"
        data-testid="tools-panes"
      >
        <div
          className="flex shrink-0 flex-col overflow-hidden border-r border-border"
          style={{ width: treeWidth }}
          data-testid="tools-tree-pane"
        >
          {collapsed ? (
            <button
              type="button"
              onClick={() => setTreeCollapsed(false)}
              title="Expand the tools tree"
              aria-label="Expand the tools tree"
              className="flex h-full w-full items-start justify-center pt-2 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              data-testid="tools-tree-rail"
            >
              <ChevronRight className="size-4" />
            </button>
          ) : (
            <ToolsTree
              summary={summary}
              scope={scope}
              onScopeChange={(next) => onFilterChange({ scope: next })}
              onCollapse={() => setTreeCollapsed(true)}
            />
          )}
        </div>
        {collapsed ? null : (
          <Splitter
            label="Resize the tools tree"
            testId="tools-tree-split"
            onMouseDown={tree.onMouseDown}
          />
        )}
        <div
          className="flex shrink-0 flex-col overflow-hidden"
          style={{ width: table.width }}
          data-testid="tools-table-pane"
        >
          {calls ? (
            <ToolCallsTable
              items={calls.items}
              total={calls.total}
              page={calls.page}
              pageSize={calls.pageSize}
              selected={state.call}
              onSelect={(call) => update({ call })}
              onPageChange={(page) => update({ page })}
              fetching={callsQuery.isPlaceholderData}
            />
          ) : (
            <Skeleton className="m-3 h-40" />
          )}
        </div>
        <Splitter
          label="Resize the calls table"
          testId="tools-table-split"
          onMouseDown={table.onMouseDown}
        />
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          style={{ minWidth: DETAILS_MIN_WIDTH }}
          data-testid="tools-details-pane"
        >
          {state.call ? (
            <ToolCallDetails
              key={`${state.call.usageId}:${state.call.callId}`}
              repoId={repoId}
              teamId={teamId}
              callRef={state.call}
            />
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Select a call to see its input and output.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid={sessionMode ? 'session-tools-tab' : 'repo-tools-tab'}
    >
      <ToolsTopBar
        filters={state}
        onChange={onFilterChange}
        monitoredCount={monitoredCount}
        onOpenMonitoredTools={openMonitoredTools}
        sessionMode={sessionMode}
      />
      {pending > 0 && !forbidden ? (
        <div
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground"
          data-testid="tools-pending-note"
        >
          {pending === 1
            ? '1 session is still being processed…'
            : `${pending} sessions are still being processed…`}
        </div>
      ) : null}
      {body}
    </div>
  );
}
