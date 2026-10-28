/**
 * Table test for docs/knowledgebase/algorithms/cli-command-recognition.md: `recognizeCliCalls`
 * against each row's `expected.calls`, with the real server `tree-sitter-bash` parser (injected
 * the way `okf/okf-access-extractor.algo.spec.ts` does it).
 */
import type { BashParser } from '@loghub/bash-view';
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import type { ToolCallShell } from '../../database/schema/index';
import { getServerBashParser } from '../okf/server-bash-parser';
import {
  recognizeCliCalls,
  type RecognizedCliCall,
} from './cli-command-recognition';

interface RowInput {
  shell: ToolCallShell;
  tools: string[];
  command: string;
}

const rows = loadExamples<RowInput, { calls: RecognizedCliCall[] }>(
  'cli-command-recognition',
);

let parser: BashParser | null = null;

beforeAll(async () => {
  parser = await getServerBashParser();
  if (!parser) throw new Error('server bash parser failed to load');
});

it.each(rows)('$id', (row) => {
  const { input, expected } = row;
  const result = recognizeCliCalls(
    row.noParser === true ? null : parser,
    input.command,
    input.shell,
    input.tools,
  );
  expect(result).toEqual(expected.calls);
});
