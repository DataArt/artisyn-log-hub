/**
 * The "Cost flow" card (2026-10-30 otel-tabs-traces, DD-28 / FR-26): the facts route's `flows`
 * rows, laid out by `layoutOtelCostFlow` and drawn by the shared `OtelFlowSankey`.
 */
import type { ReactNode } from 'react';
import type { OtelFlowRow } from '../../../../models/repositories';
import { formatUsd } from './otel-format';
import {
  layoutOtelCostFlow,
  OTEL_FLOW_COLUMN_LABELS,
  type OtelFlowColumn,
} from './otel-cost-flow-layout';
import { OtelFlowSankey } from './OtelFlowSankey';

export interface OtelCostFlowProps {
  flows: readonly OtelFlowRow[];
  columns: readonly OtelFlowColumn[];
  /** Subtitle, e.g. which columns and that the period / filters follow the chart. */
  subtitle?: ReactNode;
}

export function OtelCostFlow({ flows, columns, subtitle }: OtelCostFlowProps) {
  return (
    <OtelFlowSankey
      title="Cost flow"
      subtitle={
        subtitle ??
        `${columns.map((c) => OTEL_FLOW_COLUMN_LABELS[c].toLowerCase()).join(' → ')} · same period and filters as the chart`
      }
      footnote="Hover a band or a node for cost, share and calls. Branch = the session's git branch; (unknown) = no git branch recorded."
      columnLabels={columns.map((c) => OTEL_FLOW_COLUMN_LABELS[c])}
      buildLayout={(width, height) =>
        layoutOtelCostFlow(flows, columns, { width, height })
      }
      formatValue={formatUsd}
      isEmpty={flows.length === 0}
      emptyText="No cost in this period."
      testId="otel-cost-flow"
    />
  );
}
