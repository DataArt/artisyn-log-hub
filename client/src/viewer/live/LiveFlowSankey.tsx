/**
 * The Live view sankey (2026-11-05 follow-up): the shared `OtelFlowSankey` over
 * `buildLiveFlowData` — cost from models to teams, users, repositories and sessions for a parent
 * node, tokens from models to agents for a session. Not shown for an agent.
 */
import { useMemo } from 'react';
import type { OtelLiveNode, OtelLiveView } from '../../models/otel-live';
import { layoutFlow } from '../pages/repository/otel/otel-cost-flow-layout';
import {
  formatTokenCount,
  formatUsd,
} from '../pages/repository/otel/otel-format';
import { OtelFlowSankey } from '../pages/repository/otel/OtelFlowSankey';
import { buildLiveFlowData } from './live-flow-data';

export function LiveFlowSankey({
  view,
  nodes,
  selected,
}: {
  view: OtelLiveView;
  nodes: readonly OtelLiveNode[];
  selected: OtelLiveNode;
}) {
  const data = useMemo(
    () => buildLiveFlowData(view.flows, nodes, selected),
    [view.flows, nodes, selected],
  );
  if (data === null) return null;
  const tokens = data.weight === 'tokens';
  return (
    <OtelFlowSankey
      title={tokens ? 'Token flow' : 'Cost flow'}
      subtitle={`${data.columnLabels.join(' → ').toLowerCase()} · last 2 h`}
      footnote={
        tokens
          ? 'Tokens = input + output + cache read + cache write. Hover a band or a node for tokens, share and calls.'
          : 'A session linked to two teams or repositories is counted once, under the first. Hover a band or a node for cost, share and calls.'
      }
      columnLabels={data.columnLabels}
      buildLayout={(width, height) =>
        layoutFlow(data.rows, data.columnLabels.length, {
          width,
          height,
          // Rows are one per root and model, so only bands next to the model column sum sessions.
          sessionBand: (ci) => !tokens && ci === 0,
        })
      }
      formatValue={(v) => (tokens ? formatTokenCount(v) : formatUsd(v))}
      isEmpty={data.rows.length === 0}
      emptyText={
        tokens ? 'No tokens in the last 2 h.' : 'No cost in the last 2 h.'
      }
      testId="live-flow"
    />
  );
}
