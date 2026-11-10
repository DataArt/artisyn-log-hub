/**
 * Table test for docs/knowledgebase/algorithms/budget-spend-math.md: every row of
 * docs/algorithm-examples/budget-spend-math.json runs against the real budget math.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import {
  computeBudgetForecast,
  markAnomalyDays,
  markCostlySessions,
  selectThresholdNotices,
  type BudgetForecastInput,
  type CostlyTree,
} from './budget-math';

type BudgetMathInput =
  | ({ kind: 'forecast' } & BudgetForecastInput)
  | {
      kind: 'anomaly-days';
      dailyMicros: number[];
      elapsedUnits: number;
      spendMicros: number;
    }
  | { kind: 'costly-sessions'; trees: CostlyTree[] }
  | {
      kind: 'threshold-notices';
      thresholds: number[];
      spendMicros: number;
      amountMicros: number;
      existing: number[];
    };

const rows = loadExamples<BudgetMathInput, Record<string, unknown>>(
  'budget-spend-math',
);

it.each(rows)('$id', ({ input, expected }) => {
  switch (input.kind) {
    case 'forecast':
      expect(
        computeBudgetForecast({
          spendMicros: input.spendMicros,
          amountMicros: input.amountMicros,
          elapsedUnits: input.elapsedUnits,
          totalUnits: input.totalUnits,
          isCurrent: input.isCurrent,
        }),
      ).toEqual(expected);
      return;
    case 'anomaly-days':
      expect({
        days: markAnomalyDays({
          dailyMicros: input.dailyMicros,
          elapsedUnits: input.elapsedUnits,
          spendMicros: input.spendMicros,
        }),
      }).toEqual(expected);
      return;
    case 'costly-sessions':
      expect(markCostlySessions(input.trees)).toEqual(expected);
      return;
    case 'threshold-notices':
      expect(
        selectThresholdNotices({
          thresholds: input.thresholds,
          spendMicros: input.spendMicros,
          amountMicros: input.amountMicros,
          existing: input.existing,
        }),
      ).toEqual(expected);
  }
});
