/**
 * Table test for docs/knowledgebase/algorithms/session-logs-delta.md: `input.op` picks the call —
 * cursor round trip / decode / encode, `classifyDeltaRows` or `checkGrowth`.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  checkGrowth,
  classifyDeltaRows,
  decodeDeltaCursor,
  encodeDeltaCursor,
  type DeltaClassification,
  type DeltaCurrentRow,
  type DeltaCursorRow,
  type DeltaGrowth,
} from './session-logs-delta';

type DeltaInput =
  | { op: 'roundtrip'; rows: DeltaCursorRow[] }
  | {
      op: 'decode';
      raw?: string;
      json?: unknown;
      repeat?: { char: string; count: number };
    }
  | { op: 'encode'; count: number; row: Omit<DeltaCursorRow, 'sid'> }
  | {
      op: 'classify';
      cursor: DeltaCursorRow[];
      current: DeltaCurrentRow[];
      tree: number[];
    }
  | {
      op: 'growth';
      prevN: number;
      prevFp: string;
      newLen: number;
      fpAtPrevN: string;
    };

interface DeltaExpected {
  rows?: DeltaCursorRow[];
  empty?: boolean;
  unchanged?: string[];
  changed?: string[];
  new?: string[];
  stale?: string[];
  growth?: DeltaGrowth;
}

const rows = loadExamples<DeltaInput, DeltaExpected>('session-logs-delta');

function rawOf(input: Extract<DeltaInput, { op: 'decode' }>): string {
  if (input.repeat) return input.repeat.char.repeat(input.repeat.count);
  if (input.json !== undefined) {
    return Buffer.from(JSON.stringify(input.json), 'utf8').toString(
      'base64url',
    );
  }
  return input.raw ?? '';
}

const key = (r: { sid: number; t: string }): string => `${r.sid}:${r.t}`;

function bucketKeys(c: DeltaClassification): Record<string, string[]> {
  return {
    unchanged: c.unchanged.map((r) => key(r.current)),
    changed: c.changed.map((r) => key(r.current)),
    new: c.new.map(key),
    stale: c.stale.map(key),
  };
}

it.each(rows)('$id', ({ input, expected }) => {
  switch (input.op) {
    case 'roundtrip':
      expect(decodeDeltaCursor(encodeDeltaCursor(input.rows))).toEqual(
        expected.rows,
      );
      return;
    case 'decode':
      expect(decodeDeltaCursor(rawOf(input))).toEqual(expected.rows);
      return;
    case 'encode': {
      const many = Array.from({ length: input.count }, (_, i) => ({
        ...input.row,
        sid: i + 1,
      }));
      expect(encodeDeltaCursor(many) === '').toBe(expected.empty);
      return;
    }
    case 'classify':
      expect(
        bucketKeys(classifyDeltaRows(input.cursor, input.current, input.tree)),
      ).toEqual(expected);
      return;
    case 'growth':
      expect(
        checkGrowth(input.prevN, input.prevFp, input.newLen, input.fpAtPrevN),
      ).toBe(expected.growth);
      return;
  }
});
