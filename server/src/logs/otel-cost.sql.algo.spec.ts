/**
 * Table test for docs/knowledgebase/algorithms/otel-cost-selection.md: every row of the doc's
 * examples block runs against the real selection, warning and mismatch functions.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  costMismatch,
  isOtelCostIncomplete,
  otelComputedDiscrepancy,
  resolveSessionTotalCost,
} from './otel-cost.sql';

type OtelInput =
  | { kind: 'select'; otel: number | null; computed: number | null }
  | {
      kind: 'mismatch';
      telemetry: number | null;
      calculated: number | null;
    };

const rows = loadExamples<OtelInput, Record<string, unknown>>(
  'otel-cost-selection',
);

it.each(rows)('$id', ({ input, expected }) => {
  if (input.kind === 'select') {
    expect({
      total: resolveSessionTotalCost(input.otel, input.computed),
      incomplete: isOtelCostIncomplete(input.otel, input.computed),
      discrepancy: otelComputedDiscrepancy(input.otel, input.computed),
    }).toEqual(expected);
    return;
  }
  expect({
    mismatch: costMismatch(input.telemetry, input.calculated),
  }).toEqual(expected);
});
