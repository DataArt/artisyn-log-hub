/**
 * Table test for the display formats of the OKF tab (`okf-format.ts`) against the `format` rows of
 * docs/knowledgebase/algorithms/okf-usage-counting.md (rules 24–27). `input.fn` names the
 * function, `input.calls` is a list of argument lists, `expected.results` the returned strings
 * (`null` where the function returns `null`). The other row kinds run in the server test.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  formatApproxCost,
  formatApproxTokens,
  formatKbShare,
  formatSpend,
} from './okf-format';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../scripts/algo-docs/load-examples.cjs',
  );

type Arg = number | boolean | null;

interface FormatInput {
  fn?: string;
  calls?: Arg[][];
}

function num(v: Arg | undefined, at: string): number {
  if (typeof v !== 'number') throw new Error(`${at}: expected a number`);
  return v;
}

function numOrNull(v: Arg | undefined, at: string): number | null {
  if (v === null) return null;
  return num(v, at);
}

function call(fn: string, args: Arg[]): string | null {
  switch (fn) {
    case 'formatApproxTokens':
      return formatApproxTokens(num(args[0], fn));
    case 'formatApproxCost':
      return formatApproxCost(numOrNull(args[0], fn), args[1] === true);
    case 'formatSpend':
      return formatSpend(num(args[0], fn));
    case 'formatKbShare':
      return formatKbShare(numOrNull(args[0], fn), numOrNull(args[1], fn));
    default:
      throw new Error(`unknown fn ${fn}`);
  }
}

const formatRows = loader
  .loadExamples<
    FormatInput,
    { results?: (string | null)[] }
  >('okf-usage-counting')
  .filter((row) => row.kind === 'format');

it.each(formatRows)('$id', ({ input, expected }) => {
  const fn = input.fn ?? '';
  const results = (input.calls ?? []).map((args) => call(fn, args));
  expect({ results }).toEqual(expected);
});
