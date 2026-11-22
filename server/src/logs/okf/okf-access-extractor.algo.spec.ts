/**
 * Table test for docs/knowledgebase/algorithms/okf-access-extraction.md: `extractOkfDetail`
 * against each row's `expected.rows` (the `access` list), with the real server `tree-sitter-bash`
 * and `tree-sitter-powershell` parsers (`ShellParsers`), so the Bash and PowerShell rows also cover
 * `analyzeBash` / `analyzePowerShell`'s `readAccess` on the server. `noParser: true` passes no parser
 * at all, `noPowerShellParser: true` only the Bash one. A row
 * that also gives `expected.events` / `expected.pointers` / `expected.eventCount` /
 * `expected.pointerCount` / `expected.truncated` / `expected.seq` has those compared too.
 * `input.bundleRoots` is passed as the `bundleRoots` option (pointer resolution, DD-P4).
 */
import type { ShellParsers } from '@loghub/bash-view';
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import {
  extractOkfAccess,
  extractOkfDetail,
  type OkfAccessRow,
  type OkfEventRow,
  type OkfPointerRow,
  type OkfSeqItem,
  type OkfSnapshotFileInfo,
} from './okf-access-extractor';
import { getServerShellParsers } from './server-shell-parsers';

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
  /** `bundleRoots` of the extraction: repo-relative bundle root folders (`''` = repo root). */
  bundleRoots?: string[];
}

interface RowExpected {
  rows: OkfAccessRow[];
  events?: OkfEventRow[];
  pointers?: OkfPointerRow[];
  eventCount?: number;
  pointerCount?: number;
  truncated?: boolean;
  seq?: OkfSeqItem[];
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

let loaded: ShellParsers = { bash: null, powershell: null };

beforeAll(async () => {
  loaded = await getServerShellParsers();
  if (!loaded.bash) throw new Error('server bash parser failed to load');
  if (!loaded.powershell)
    throw new Error('server powershell parser failed to load');
});

it.each(rows)('$id', (row) => {
  const { input, expected } = row;
  const parsers: ShellParsers =
    row.noParser === true
      ? { bash: null, powershell: null }
      : row.noPowerShellParser === true
        ? { bash: loaded.bash, powershell: null }
        : loaded;
  const options = {
    isSubagentLog: input.subagent === true,
    ...(input.snapshotFiles !== undefined
      ? { snapshotFiles: new Map(Object.entries(input.snapshotFiles)) }
      : {}),
    ...(input.bundleRoots !== undefined
      ? { bundleRoots: input.bundleRoots }
      : {}),
  };
  const entries = toEntries(input);
  const roots = input.roots ?? DEFAULT_ROOTS;
  const detail = extractOkfDetail(entries, roots, parsers, options);
  expect(detail.access).toEqual(expected.rows);
  // `extractOkfAccess` is the `access` part of the same walk.
  expect(extractOkfAccess(entries, roots, parsers, options)).toEqual(
    expected.rows,
  );
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
  if (expected.seq !== undefined) {
    expect(detail.seq).toEqual(expected.seq);
  }
});
