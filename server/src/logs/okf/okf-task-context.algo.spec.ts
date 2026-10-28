/**
 * Table test for docs/knowledgebase/algorithms/okf-task-context.md: a row with `input.text` runs
 * `cleanTaskText` against `expected.text`; a row with `input.entries` runs `filterUserPrompts`
 * against `expected.prompts`.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { cleanTaskText, filterUserPrompts } from './okf-task-context';

const rows = loadExamples<
  { text?: string; entries?: unknown[]; subagent?: boolean },
  { text?: string | null; prompts?: string[] }
>('okf-task-context');

it.each(rows)('$id', ({ input, expected }) => {
  if (input.entries !== undefined) {
    expect(
      filterUserPrompts(input.entries, {
        isSubagentLog: input.subagent === true,
      }),
    ).toEqual(expected.prompts);
  } else {
    expect(cleanTaskText(input.text ?? '')).toBe(expected.text);
  }
});
