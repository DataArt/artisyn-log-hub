/**
 * One node card of the Session Map (session-map Visual/UX notes, wireframe `session-map-cards.svg`):
 * the zone cost bar, the tool-family mix bar, top tools, the failed badge, the fixed-colour
 * context bar and the duration (the bars and their hover hints live in `SessionMapCardBars`).
 * `AgentCard` is `React.memo` with primitive per-`t` props (`state`, `runningMin`, `selected`,
 * `dimmed`), so a scrub only re-renders cards whose state moved.
 */
import { memo } from 'react';
import { formatDuration } from '../../../../lib/format';
import type { MapAgentNode, MapNode, MapNodeState } from './session-map-model';
import { FAILED_COLOR, NEST_INDENT } from './session-map.constants';
import { formatMapUsd, formatShare } from './session-map-format';
import { ContextBar, CostBar, MixBar } from './SessionMapCardBars';

export interface NodeCardBodyProps {
  node: MapNode;
  state: MapNodeState;
  /** Whole minutes running so far at `t`; only used while `state === 'running'`. */
  runningMin: number;
  /** Scale of the zone cost bar (`maxAgentCost`, or the tree cost for the main card). */
  costScale: number;
  /** What a full cost bar stands for, shown in its hint ("the most expensive agent"). */
  costScaleLabel: string;
}

/** The shared body of the main card and the agent cards. */
export function NodeCardBody({
  node,
  state,
  runningMin,
  costScale,
  costScaleLabel,
}: NodeCardBodyProps) {
  const duration =
    state === 'running'
      ? `${runningMin} min…`
      : node.f !== null && node.l !== null
        ? formatDuration(node.l - node.f)
        : '–';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={node.label}
        >
          {node.label}
        </span>
        {state === 'running' && (
          <span className="shrink-0 rounded-full bg-green-100 px-1.5 text-[10px] font-semibold uppercase text-green-700">
            running
          </span>
        )}
        {node.failures > 0 && (
          <span
            className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold text-white"
            style={{ backgroundColor: FAILED_COLOR }}
            title={`${node.failures} failed call(s)`}
          >
            {node.failures} failed
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground">
          {formatMapUsd(node.cost)}
        </span>
        <span title="Share of the whole session cost">
          {formatShare(node.share)} of session
        </span>
        <span className="ml-auto">{duration}</span>
      </div>
      <CostBar
        cost={node.cost}
        share={node.share}
        scale={costScale}
        scaleLabel={costScaleLabel}
      />
      <MixBar familyCounts={node.familyCounts} />
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {node.topTools.length > 0
            ? node.topTools.map((t) => `${t.name} ${t.count}`).join(' · ')
            : 'no tool calls'}
        </span>
        <span className="shrink-0">{node.calls} calls</span>
      </div>
      <ContextBar
        peakContext={node.peakContext}
        contextLength={node.contextLength}
      />
    </div>
  );
}

/** Border / opacity classes of a card for its state (Visual/UX notes "Card states"). */
export function cardStateClass(
  state: MapNodeState,
  selected: boolean,
  dimmed: boolean,
): string {
  const border = selected
    ? 'border-2 border-blue-600'
    : state === 'future'
      ? 'border border-dashed border-slate-300'
      : 'border border-slate-200';
  const opacity = dimmed
    ? 'opacity-30'
    : state === 'future'
      ? 'opacity-[.35]'
      : '';
  return `${border} ${opacity}`;
}

export interface AgentCardProps {
  node: MapAgentNode;
  depth: number;
  state: MapNodeState;
  runningMin: number;
  selected: boolean;
  dimmed: boolean;
  maxAgentCost: number;
  onSelect: (id: string) => void;
}

export const AgentCard = memo(function AgentCard({
  node,
  depth,
  state,
  runningMin,
  selected,
  dimmed,
  maxAgentCost,
  onSelect,
}: AgentCardProps) {
  return (
    <div
      style={{ marginLeft: depth * NEST_INDENT }}
      className={depth > 0 ? 'border-l-2 border-slate-200 pl-1.5' : ''}
    >
      <button
        type="button"
        data-testid={`session-map-agent-${node.id}`}
        data-state={state}
        data-dimmed={dimmed ? 'true' : 'false'}
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
        className={`w-full rounded-md bg-white p-2 text-left text-xs shadow-sm transition-opacity hover:shadow ${cardStateClass(state, selected, dimmed)}`}
      >
        <NodeCardBody
          node={node}
          state={state}
          runningMin={runningMin}
          costScale={maxAgentCost}
          costScaleLabel="the most expensive agent"
        />
      </button>
    </div>
  );
});
