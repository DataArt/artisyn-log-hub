/**
 * Session Map cards (session-map DD-14, Visual/UX notes): the centred main card and one column per
 * workflow run (plus "Agents spawned by the main session"), each with a header of totals and its
 * agent cards, nested agents indented. The node card itself lives in `SessionMapAgentCard.tsx`.
 */
import { memo, useMemo } from 'react';
import { formatDuration } from '../../../../lib/format';
import { AgentCard, cardStateClass, NodeCardBody } from './SessionMapAgentCard';
import {
  type AgentOrder,
  columnRows,
  type MapColumn,
  type MapNode,
  type MapNodeState,
  stateAt,
} from './session-map-model';
import {
  COLUMN_SCROLL_AFTER,
  COLUMN_W,
  FAILED_COLOR,
  MAIN_CARD_MAX_W,
} from './session-map.constants';
import { formatMapUsd } from './session-map-format';

/** Whole minutes a node has been running at `t` (for the `N min…` duration). */
export function runningMinutes(
  state: MapNodeState,
  f: number | null,
  t: number,
): number {
  if (state !== 'running' || f === null || !Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((t - f) / 60_000));
}

export interface MainCardProps {
  node: MapNode;
  state: MapNodeState;
  runningMin: number;
  selected: boolean;
  treeCost: number;
  onSelect: (id: string) => void;
}

export const MainCard = memo(function MainCard({
  node,
  state,
  runningMin,
  selected,
  treeCost,
  onSelect,
}: MainCardProps) {
  return (
    <button
      type="button"
      data-testid="session-map-main"
      data-state={state}
      aria-pressed={selected}
      onClick={() => onSelect('main')}
      style={{ maxWidth: MAIN_CARD_MAX_W }}
      className={`mx-auto block w-full rounded-lg bg-white p-3 text-left text-xs shadow-sm hover:shadow ${cardStateClass(state, selected, false)}`}
    >
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        Main session{node.model ? ` · ${node.model}` : ''}
      </div>
      <NodeCardBody
        node={node}
        state={state}
        runningMin={runningMin}
        costScale={treeCost}
        costScaleLabel="the whole session"
      />
    </button>
  );
});

export interface GroupColumnProps {
  column: MapColumn;
  order: AgentOrder;
  /** Time position; `Infinity` when there is no timeline. */
  t: number;
  live: boolean;
  atNow: boolean;
  highlight: ReadonlySet<string> | null;
  selectedId: string | null;
  maxAgentCost: number;
  onSelect: (id: string) => void;
}

export function GroupColumn({
  column,
  order,
  t,
  live,
  atNow,
  highlight,
  selectedId,
  maxAgentCost,
  onSelect,
}: GroupColumnProps) {
  const rows = useMemo(() => columnRows(column, order), [column, order]);
  const groupId = `group:${column.key}`;
  const headerSelected = selectedId === groupId;
  const scrolls = rows.length > COLUMN_SCROLL_AFTER;
  const duration =
    column.kind === 'workflow' &&
    column.startMs !== null &&
    column.endMs !== null
      ? formatDuration(column.endMs - column.startMs)
      : null;
  return (
    <div
      data-testid={`session-map-group-${column.key}`}
      className="flex shrink-0 flex-col gap-2"
      style={{ width: COLUMN_W }}
    >
      <button
        type="button"
        data-testid={`session-map-group-${column.key}-header`}
        aria-pressed={headerSelected}
        onClick={() => onSelect(groupId)}
        className={`rounded-md bg-slate-50 p-2 text-left text-xs ${headerSelected ? 'border-2 border-blue-600' : 'border border-slate-200'}`}
      >
        <div className="truncate font-semibold" title={column.label}>
          {column.label}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
          <span className="font-mono text-foreground">
            {formatMapUsd(column.cost)}
          </span>
          <span>{rows.length} agents</span>
          <span>{column.calls} calls</span>
          {column.failures > 0 && (
            <span style={{ color: FAILED_COLOR }}>
              {column.failures} failed
            </span>
          )}
          {duration !== null && <span>{duration}</span>}
        </div>
      </button>
      <div
        className={`flex flex-col gap-2 ${scrolls ? 'max-h-[70vh] overflow-y-auto pr-1' : ''}`}
      >
        {rows.map(({ node, depth }) => {
          const state = stateAt(node, t, { live, atNow });
          return (
            <AgentCard
              key={node.id}
              node={node}
              depth={depth}
              state={state}
              runningMin={runningMinutes(state, node.f, t)}
              selected={selectedId === node.id}
              dimmed={highlight !== null && !highlight.has(node.id)}
              maxAgentCost={maxAgentCost}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </div>
  );
}
