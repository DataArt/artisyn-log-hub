/**
 * Table test for docs/knowledgebase/algorithms/okf-access-extraction.md: `extractOkfDetail`
 * against each row's `expected.rows` (the `access` list), with the real server `tree-sitter-bash`
 * parser (DD-37), so the Bash rows also cover `analyzeBash`'s `readAccess` on the server. A row
 * that also gives `expected.events` / `expected.pointers` / `expected.eventCount` /
 * `expected.pointerCount` / `expected.truncated` has those compared too.
 */
import type { BashParser } from '@loghub/bash-view';
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import {
  extractOkfAccess,
  extractOkfDetail,
  type OkfAccessRow,
  type OkfEventRow,
  type OkfPointerRow,
  type OkfSnapshotFileInfo,
} from './okf-access-extractor';
import { getServerBashParser } from './server-bash-parser';

interface CallInput {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  resultBytes?: number;
  sidechain?: boolean;
  /** The tool_result carries `is_error: true`. */
  isError?: boolean;
  /** Emit the call this many times (ids `t<k>` keep counting). */
  repeat?: number;
}

interface RowInput {
  calls: CallInput[];
  cwd?: string;
  roots?: string[];
  subagent?: boolean;
  /** Text of a first `user` line (the prompt), before any call. */
  prompt?: string;
  /** `snapshotFiles` of the extraction, as `{ path: { size, hash } }`. */
  snapshotFiles?: Record<string, OkfSnapshotFileInfo>;
}

interface RowExpected {
  rows: OkfAccessRow[];
  events?: OkfEventRow[];
  pointers?: OkfPointerRow[];
  eventCount?: number;
  pointerCount?: number;
  truncated?: boolean;
}

const DEFAULT_CWD = '/work/acme-app';
const DEFAULT_ROOTS = ['/work/acme-app'];

const rows = loadExamples<RowInput, RowExpected>('okf-access-extraction');

/** The transcript lines of one row, as described in the doc's Examples preamble. */
function toEntries(input: RowInput): object[] {
  const cwd = input.cwd ?? DEFAULT_CWD;
  const entries: object[] = [];
  if (input.prompt !== undefined) {
    entries.push({
      type: 'user',
      cwd,
      message: { role: 'user', content: input.prompt },
    });
  }
  let k = 0;
  for (const call of input.calls) {
    for (let r = 0; r < (call.repeat ?? 1); r++) {
      k += 1;
      const id = call.id ?? `t${k}`;
      const sidechain = call.sidechain === true ? { isSidechain: true } : {};
      entries.push({
        type: 'assistant',
        cwd,
        ...sidechain,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id, name: call.name, input: call.input },
          ],
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
              ...(call.isError === true ? { is_error: true } : {}),
            },
          ],
        },
      });
    }
  }
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
  const options = {
    isSubagentLog: input.subagent === true,
    ...(input.snapshotFiles !== undefined
      ? { snapshotFiles: new Map(Object.entries(input.snapshotFiles)) }
      : {}),
  };
  const entries = toEntries(input);
  const roots = input.roots ?? DEFAULT_ROOTS;
  const detail = extractOkfDetail(
    entries,
    roots,
    noParser ? null : parser,
    options,
  );
  expect(detail.access).toEqual(expected.rows);
  // `extractOkfAccess` is the `access` part of the same walk.
  expect(
    extractOkfAccess(entries, roots, noParser ? null : parser, options),
  ).toEqual(expected.rows);
  if (expected.events !== undefined) {
    expect(detail.events).toEqual(expected.events);
  }
  if (expected.pointers !== undefined) {
    expect(detail.pointers).toEqual(expected.pointers);
  }
  if (expected.eventCount !== undefined) {
    expect(detail.events).toHaveLength(expected.eventCount);
  }
  if (expected.pointerCount !== undefined) {
    expect(detail.pointers).toHaveLength(expected.pointerCount);
  }
  if (expected.truncated !== undefined) {
    expect(detail.truncated).toBe(expected.truncated);
  }
});
