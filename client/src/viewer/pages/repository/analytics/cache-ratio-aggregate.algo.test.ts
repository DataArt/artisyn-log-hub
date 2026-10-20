/**
 * Table test for the client twin of the scope aggregate: `aggregateCacheRatio` against the
 * `aggregate` rows of docs/knowledgebase/algorithms/cache-ratio-and-causes.md. It compares the
 * summed tokens and the ratio; `sessionCount` and `undefinedRatioSessionCount` are server-only
 * (the client counts timeline sessions only, as the doc says).
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { TimelineSession } from '../../../../models/repositories';
import { aggregateCacheRatio } from './cache-ratio-aggregate';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface SessionSpec {
  read: number;
  write: number;
  descRead?: number;
  descWrite?: number;
}

/** A timeline session carrying only the doc's cache figures; everything else is neutral. */
function timelineSession(spec: SessionSpec, index: number): TimelineSession {
  return {
    sessionId: `s-${index}`,
    startTime: '2026-10-01T10:00:00Z',
    endTime: '2026-10-01T11:00:00Z',
    firstPrompt: null,
    gitBranch: null,
    userEmail: null,
    group: null,
    workTimeMs: 0,
    totalCost: null,
    fileStatsByCategory: {},
    filesEditedWritten: 0,
    linesChanged: 0,
    imageCount: 0,
    imageTotalBytes: 0,
    mcpCallsTotal: 0,
    mcpCallsByServer: {},
    logLineCount: 0,
    cacheReadTokens: spec.read,
    cacheWriteTokens: spec.write,
    descendantCacheReadTokens: spec.descRead ?? 0,
    descendantCacheWriteTokens: spec.descWrite ?? 0,
    webSearchRequests: 0,
    inputTokensFast: 0,
    outputTokensFast: 0,
  };
}

interface AggregateExpected {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ratio: number | null;
}

const rows = loader
  .loadExamples<
    {
      kind: string;
      scope?: 'root' | 'withDescendants';
      sessions?: SessionSpec[];
    },
    AggregateExpected
  >('cache-ratio-and-causes')
  .filter((row) => row.input.kind === 'aggregate');

it.each(rows)('$id', ({ input, expected }) => {
  const pair = aggregateCacheRatio((input.sessions ?? []).map(timelineSession));
  const scope =
    input.scope === 'withDescendants' ? pair.withDescendants : pair.root;
  expect({
    cacheReadTokens: scope.read,
    cacheWriteTokens: scope.write,
  }).toEqual({
    cacheReadTokens: expected.cacheReadTokens,
    cacheWriteTokens: expected.cacheWriteTokens,
  });
  if (expected.ratio === null) {
    expect(scope.ratio).toBeNull();
  } else {
    expect(scope.ratio).toBeCloseTo(expected.ratio, 6);
  }
});
