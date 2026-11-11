/**
 * Table test for `matchRecommendations` (`@loghub/recommendations`) against the rows of
 * docs/knowledgebase/algorithms/startup-recommendations.md. Each row's `input` is a
 * `StartupFacts`; the projection format is the doc's Examples prose.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  matchRecommendations,
  type RecommendationRow,
  type StartupFacts,
} from '@loghub/recommendations';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface RecoExpected {
  ids?: string[];
  count?: number;
  measuredTokens?: number;
  rows?: Record<string, Record<string, unknown>>;
}

/** Every projected key of one row; the expected row picks which of them are compared. */
function projectRow(row: RecommendationRow): Record<string, unknown> {
  const statuses: Record<string, string> = {};
  const notes: Record<string, string> = {};
  for (const item of row.items) {
    if (item.status) statuses[item.name] = item.status;
    if (item.note) notes[item.name] = item.note;
  }
  return {
    itemOrder: row.items.map((i) => i.name),
    items: Object.fromEntries(row.items.map((i) => [i.name, i.bytes])),
    statuses,
    notes,
    note: row.note,
    bytes: row.bytes,
    tokens: row.tokens,
    sharePct: row.share === null ? null : Math.round(row.share * 1000) / 10,
    snippet: row.snippet,
    controller: row.controller,
    docs: row.docs.map((d) => d.url),
  };
}

function pick(
  full: Record<string, unknown>,
  wanted: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(wanted).map((k) => [k, full[k]]));
}

const rows = loader.loadExamples<StartupFacts, RecoExpected>(
  'startup-recommendations',
);

it.each(rows)('$id', ({ input, expected }) => {
  const result = matchRecommendations(input);
  const byId = new Map(result.map((r) => [r.id, r]));
  const actual: Record<string, unknown> = {
    ids: result.map((r) => r.id),
    count: result.length,
    measuredTokens: result.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
  };
  if (expected.rows) {
    const projected: Record<string, Record<string, unknown>> = {};
    for (const [id, wanted] of Object.entries(expected.rows)) {
      const row = byId.get(id);
      projected[id] = row ? pick(projectRow(row), wanted) : {};
    }
    actual.rows = projected;
  }
  expect(pick(actual, { ...expected })).toEqual(expected);
});
