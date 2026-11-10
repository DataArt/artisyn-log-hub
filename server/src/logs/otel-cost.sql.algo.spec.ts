/**
 * Table test for docs/knowledgebase/algorithms/otel-cost-selection.md: every row of the doc's
 * examples block runs against the real total, unpriced-model list, warning, mismatch,
 * sub-agent and budget tree-cost functions.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  costMismatch,
  otelComputedDiscrepancy,
  resolveSessionTotalCost,
  selectBudgetTreeCostMicros,
  selectSubagentCost,
  unpricedModelList,
  type BudgetTreeCostInput,
  type SessionCostParts,
  type SubagentCostInput,
} from './otel-cost.sql';

type OtelInput =
  | ({ kind: 'total' } & SessionCostParts)
  | ({ kind: 'subagent' } & SubagentCostInput)
  | ({ kind: 'budget-tree-cost' } & BudgetTreeCostInput)
  | { kind: 'unpriced'; lists: Array<Array<string | null>> }
  | { kind: 'discrepancy'; otel: number | null; computed: number | null }
  | {
      kind: 'mismatch';
      telemetry: number | null;
      calculated: number | null;
    };

const rows = loadExamples<OtelInput, Record<string, unknown>>(
  'otel-cost-selection',
);

it.each(rows)('$id', ({ input, expected }) => {
  switch (input.kind) {
    case 'total':
      expect({ total: resolveSessionTotalCost(input) }).toEqual(expected);
      return;
    case 'unpriced':
      expect({ models: unpricedModelList(...input.lists) }).toEqual(expected);
      return;
    case 'subagent':
      expect(
        selectSubagentCost({
          transcriptCost: input.transcriptCost,
          modelId: input.modelId,
          otelCostUsd: input.otelCostUsd,
        }),
      ).toEqual(expected);
      return;
    case 'budget-tree-cost':
      expect(
        selectBudgetTreeCostMicros({
          hookUsd: input.hookUsd,
          otelMicros: input.otelMicros,
        }),
      ).toEqual(expected);
      return;
    case 'discrepancy':
      expect({
        discrepancy: otelComputedDiscrepancy(input.otel, input.computed),
      }).toEqual(expected);
      return;
    case 'mismatch':
      expect({
        mismatch: costMismatch(input.telemetry, input.calculated),
      }).toEqual(expected);
  }
});
