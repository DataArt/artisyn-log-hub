/**
 * Table test for docs/knowledgebase/algorithms/tool-wrapper-matching.md: `matchWrapperRecords`
 * against each row's `expected` lists (matched / indirect / transcript-only).
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { operationOfArgs } from './cli-command-recognition';
import type { WrapperCallRecord } from './tool-calls-log';
import {
  matchWrapperRecords,
  type TranscriptCliCall,
} from './wrapper-record-matching';

interface UseInput {
  id: string;
  ts: number;
  resultTs: number | null;
  recognized: { tool: string; args: string[] }[];
  agentSawBytes?: number | null;
}

interface RecordInput {
  callId: string;
  tool: string;
  args: string[];
  at: number;
  stdout?: number;
  stderr?: number;
  consumerClosed?: boolean;
}

interface RowInput {
  uses: UseInput[];
  records: RecordInput[];
}

interface RowExpected {
  matched: { callId: string; toolUseId: string; slot: number; cut: boolean }[];
  indirect: { callId: string; toolUseId: string | null; cut: boolean }[];
  transcriptOnly: { toolUseId: string; slot: number; tool: string }[];
}

const BASE_MS = Date.parse('2026-10-28T10:00:00.000Z');

const rows = loadExamples<RowInput, RowExpected>('tool-wrapper-matching');

/** Seconds after the base as epoch ms, rounded to whole ms. */
function atMs(seconds: number): number {
  return BASE_MS + Math.round(seconds * 1000);
}

function toCall(use: UseInput): TranscriptCliCall {
  return {
    toolUseId: use.id,
    ts: atMs(use.ts),
    resultTs: use.resultTs === null ? null : atMs(use.resultTs),
    recognized: use.recognized.map((r) => ({
      tool: r.tool,
      args: r.args,
      operation: operationOfArgs(r.args),
    })),
    agentSawBytes: use.agentSawBytes ?? null,
  };
}

function toRecord(rec: RecordInput): WrapperCallRecord {
  const startedAtMs = atMs(rec.at);
  return {
    callId: rec.callId,
    sessionId: null,
    tool: rec.tool,
    args: rec.args,
    real: null,
    cwd: null,
    shell: 'bash',
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    endedAt: null,
    exitCode: null,
    durationMs: null,
    bytes: { stdin: 0, stdout: rec.stdout ?? 0, stderr: rec.stderr ?? 0 },
    consumerClosed: rec.consumerClosed === true,
    truncated: false,
    capture: 'full',
    encoding: 'utf8',
    textDropped: false,
    textClamped: false,
  };
}

it.each(rows)('$id', ({ input, expected }) => {
  const result = matchWrapperRecords(
    input.records.map(toRecord),
    input.uses.map(toCall),
  );
  expect({
    matched: result.matched.map((m) => ({
      callId: m.record.callId,
      toolUseId: m.call.toolUseId,
      slot: m.slot,
      cut: m.cut,
    })),
    indirect: result.indirect.map((i) => ({
      callId: i.record.callId,
      toolUseId: i.toolUseId,
      cut: i.cut,
    })),
    transcriptOnly: result.transcriptOnly.map((t) => ({
      toolUseId: t.call.toolUseId,
      slot: t.slot,
      tool: t.recognized.tool,
    })),
  }).toEqual(expected);
});
