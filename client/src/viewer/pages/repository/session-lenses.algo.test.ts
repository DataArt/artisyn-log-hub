/**
 * Table test for `lensRow` and `lensDefaultTab` against the rows of
 * docs/knowledgebase/algorithms/session-lens-row.md. Each row carries exactly one of
 * `input.lensRow` or `input.lensDefaultTab`.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { SessionGroup, SessionTab } from '../../tab-ids';
import { lensDefaultTab, lensRow, type LensId } from './session-lenses';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface LensInput {
  lensRow?: { lens: LensId; active: SessionTab; visible: SessionTab[] };
  lensDefaultTab?: { lens: LensId; visible: SessionTab[] };
}

interface LensExpected {
  row?: SessionTab[];
  extra?: SessionTab | null;
  more?: { group: SessionGroup; tabs: SessionTab[] }[];
  tab?: SessionTab;
}

const rows = loader.loadExamples<LensInput, LensExpected>('session-lens-row');

it.each(rows)('$id', ({ input, expected }) => {
  if (input.lensRow) {
    const { lens, active, visible } = input.lensRow;
    expect(lensRow(lens, active, visible)).toEqual({
      row: expected.row,
      extra: expected.extra,
      more: expected.more,
    });
    return;
  }
  if (input.lensDefaultTab) {
    const { lens, visible } = input.lensDefaultTab;
    expect(lensDefaultTab(lens, visible)).toBe(expected.tab);
    return;
  }
  throw new Error('row has neither lensRow nor lensDefaultTab');
});
