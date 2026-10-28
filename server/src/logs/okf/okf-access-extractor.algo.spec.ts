/**
 * Table test for docs/knowledgebase/algorithms/okf-access-extraction.md: `extractOkfAccess`
 * against each row's `expected.rows`, with the real server `tree-sitter-bash` parser (DD-37), so
 * the Bash rows also cover `analyzeBash`'s `readAccess` on the server.
 */
import type { BashParser } from '@loghub/bash-view';
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { extractOkfAccess, type OkfAccessRow } from './okf-access-extractor';
import { getServerBashParser } from './server-bash-parser';

interface CallInput {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  resultBytes?: number;
  sidechain?: boolean;
}

interface RowInput {
  calls: CallInput[];
  cwd?: string;
  roots?: string[];
  subagent?: boolean;
}

const DEFAULT_CWD = '/work/acme-app';
const DEFAULT_ROOTS = ['/work/acme-app'];

const rows = loadExamples<RowInput, { rows: OkfAccessRow[] }>(
  'okf-access-extraction',
);

/** The transcript lines of one row, as described in the doc's Examples preamble. */
function toEntries(input: RowInput): object[] {
  const cwd = input.cwd ?? DEFAULT_CWD;
  const entries: object[] = [];
  input.calls.forEach((call, i) => {
    const id = call.id ?? `t${i + 1}`;
    const sidechain = call.sidechain === true ? { isSidechain: true } : {};
    entries.push({
      type: 'assistant',
      cwd,
      ...sidechain,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: call.name, input: call.input }],
      },
    });
    entries.push({
      type: 'user',
      cwd,
      ...sidechain,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: call.result ?? 'x'.repeat(call.resultBytes ?? 0),
          },
        ],
      },
    });
  });
  return entries;
}

let parser: BashParser | null = null;

beforeAll(async () => {
  parser = await getServerBashParser();
  if (!parser) throw new Error('server bash parser failed to load');
});

it.each(rows)('$id', (row) => {
  const { input, expected } = row;
  const noParser = row.noParser === true;
  const result = extractOkfAccess(
    toEntries(input),
    input.roots ?? DEFAULT_ROOTS,
    noParser ? null : parser,
    { isSubagentLog: input.subagent === true },
  );
  expect(result).toEqual(expected.rows);
});
