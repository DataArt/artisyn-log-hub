/**
 * Table test for docs/knowledgebase/algorithms/log-retention.md: a row either plans a cleanup
 * (`files` + `today` + `policy` -> `deleted`) or reads the policy from env (`env` -> `policy`).
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  LogRetentionPolicy,
  planLogCleanup,
  readLogRetentionPolicy,
} from './log-retention-plan';

interface Input {
  files?: [string, number][];
  today?: string;
  policy?: LogRetentionPolicy;
  env?: Record<string, string>;
}

interface Expected {
  deleted?: string[];
  policy?: LogRetentionPolicy;
}

const rows = loadExamples<Input, Expected>('log-retention');

it.each(rows)('$id', ({ input, expected }) => {
  if (input.env) {
    expect(readLogRetentionPolicy(input.env)).toEqual(expected.policy);
    return;
  }
  if (!input.files || !input.today || !input.policy) {
    throw new Error('A plan row needs files, today and policy');
  }
  const files = input.files.map(([name, size]) => ({ name, size }));
  expect(planLogCleanup(files, input.today, input.policy)).toEqual(
    expected.deleted,
  );
});
