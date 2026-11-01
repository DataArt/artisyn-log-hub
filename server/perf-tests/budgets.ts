import budgetsJson from './budgets.json';
import { ScenarioResult } from './types';

/** Absolute latency budget of one scenario (`budgets.json`). */
export interface Budget {
  p95Ms: number;
}

export type Budgets = Record<string, Budget>;

export type BudgetStatus = 'pass' | 'fail' | 'skipped';

export interface BudgetVerdict {
  scenario: string;
  budgetP95Ms: number;
  status: BudgetStatus;
  /** Measured p95, absent when the scenario did not run. */
  p95?: number;
  errors?: number;
  iterations?: number;
}

/**
 * The absolute p95 budgets from `perf-tests/budgets.json`. Unlike the baseline comparison
 * (relative to the previous run on the same machine), these are hard limits: a run that breaks
 * one exits non-zero.
 */
export function loadBudgets(): Budgets {
  return budgetsJson;
}

/**
 * pass — the scenario ran, p95 <= budget and no request failed;
 * fail — p95 > budget or any error (a failed or timed-out request is never a pass);
 * skipped — the scenario did not run in this mode (e.g. no heavy seed in read-only mode).
 */
export function evaluateBudgets(
  results: ScenarioResult[],
  budgets: Budgets,
): BudgetVerdict[] {
  return Object.entries(budgets).map(([scenario, budget]) => {
    const r = results.find((x) => x.scenario === scenario);
    if (!r) {
      return { scenario, budgetP95Ms: budget.p95Ms, status: 'skipped' };
    }
    const status: BudgetStatus =
      r.p95 > budget.p95Ms || r.errors > 0 ? 'fail' : 'pass';
    return {
      scenario,
      budgetP95Ms: budget.p95Ms,
      status,
      p95: r.p95,
      errors: r.errors,
      iterations: r.iterations,
    };
  });
}

export function printBudgetReport(verdicts: BudgetVerdict[]): void {
  console.log('\n▶ Latency budgets (budgets.json)');
  if (verdicts.length === 0) {
    console.log('  (no budgets defined)');
    return;
  }
  for (const v of verdicts) {
    const label = v.scenario.padEnd(26);
    if (v.status === 'skipped') {
      console.log(
        `  ${label} SKIPPED  (did not run)  budget p95 <= ${v.budgetP95Ms}ms`,
      );
      continue;
    }
    const tag = v.status === 'pass' ? 'PASS   ' : 'FAIL   ';
    console.log(
      `  ${label} ${tag}  p95 ${v.p95}ms  budget ${v.budgetP95Ms}ms  err ${v.errors}/${v.iterations}`,
    );
  }
  const failed = verdicts.filter((v) => v.status === 'fail').length;
  if (failed > 0) {
    console.log(`  ${failed} budget(s) failed — the run will exit non-zero`);
  }
}
