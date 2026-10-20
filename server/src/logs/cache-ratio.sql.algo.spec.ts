/**
 * Table test for docs/knowledgebase/algorithms/cache-ratio-and-causes.md: the ratio, the scope
 * aggregate, the per-session cause walk and the scope cause sums, each against the real code.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { cacheReadRatio } from './cache-ratio.sql';
import {
  aggregateScope,
  buildCauses,
  type CacheRatioCauseRow,
  type CacheRatioScopeKey,
  type CacheRatioSessionRow,
} from './reports/cache-read-ratio.service';
import { classifyTurnCauses, type WalkedTurn } from './turn-walk';

interface SessionSpec {
  read: number;
  write: number;
  descRead?: number;
  descWrite?: number;
  descSessions?: number;
}

interface CauseRowSpec {
  threshold: number;
  compaction: number;
  reread: number;
  unattributed: number;
  compactionTurns: number;
  rereadTurns: number;
  unattributedTurns: number;
}

type CacheInput =
  | { kind: 'ratio'; read: number; write: number }
  | { kind: 'aggregate'; scope: CacheRatioScopeKey; sessions: SessionSpec[] }
  | {
      kind: 'classify';
      threshold: number;
      orphan: number;
      turns: { creation: number; compact: boolean; paths: string[] }[];
    }
  | { kind: 'scope-causes'; threshold: number; rows: (CauseRowSpec | null)[] };

/** A session row carrying only what the doc's input sets; the rest is neutral. */
function sessionRow(
  spec: SessionSpec | null,
  cause: CacheRatioCauseRow | null,
): CacheRatioSessionRow {
  return {
    startTime: '2026-10-01T00:00:00.000Z',
    branch: null,
    userEmail: 'dev@arrakis.test',
    cacheReadTokens: spec?.read ?? 0,
    cacheWriteTokens: spec?.write ?? 0,
    cacheWrite5mTokens: spec?.write ?? 0,
    cacheWrite1hTokens: 0,
    priceCacheRead: null,
    priceCacheWrite5m: null,
    priceCacheWrite1h: null,
    descendantSessionCount: spec?.descSessions ?? 0,
    descendantCacheReadTokens: spec?.descRead ?? 0,
    descendantCacheWriteTokens: spec?.descWrite ?? 0,
    descendantCacheWrite5mTokens: spec?.descWrite ?? 0,
    descendantCacheWrite1hTokens: 0,
    descendantCacheReadCost: null,
    descendantCacheWriteCost: null,
    cause,
    attributionValues: null,
  };
}

function causeRow(spec: CauseRowSpec): CacheRatioCauseRow {
  return {
    threshold: spec.threshold,
    compactionTokens: spec.compaction,
    fileRereadTokens: spec.reread,
    unattributedTokens: spec.unattributed,
    compactionTurns: spec.compactionTurns,
    fileRereadTurns: spec.rereadTurns,
    unattributedTurns: spec.unattributedTurns,
  };
}

function evaluate(input: CacheInput): Record<string, unknown> {
  switch (input.kind) {
    case 'ratio':
      return { ratio: cacheReadRatio(input.read, input.write) };
    case 'aggregate': {
      const result = aggregateScope(
        input.sessions.map((s) => sessionRow(s, null)),
        input.scope,
      );
      return {
        sessionCount: result.sessionCount,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        ratio: result.ratio,
        undefinedRatioSessionCount: result.undefinedRatioSessionCount,
      };
    }
    case 'classify': {
      const turns: WalkedTurn[] = input.turns.map((t, i) => ({
        index: i + 1,
        uuid: `turn-${i + 1}`,
        creationTokens: t.creation,
        paths: t.paths,
        hasCompactBoundary: t.compact,
      }));
      return {
        ...classifyTurnCauses(
          {
            turns,
            totalCreationTokens:
              turns.reduce((sum, t) => sum + t.creationTokens, 0) +
              input.orphan,
            orphanCreationTokens: input.orphan,
          },
          input.threshold,
        ),
      };
    }
    case 'scope-causes': {
      const result = buildCauses(
        input.rows.map((r) =>
          sessionRow(null, r === null ? null : causeRow(r)),
        ),
        input.threshold,
        'default',
      );
      return {
        totalCreationTokens: result.totalCreationTokens,
        compactionShare: result.compaction.share,
        fileRereadShare: result.fileReread.share,
        unattributedShare: result.unattributed.share,
        compactionTurns: result.compaction.turns,
        fileRereadTurns: result.fileReread.turns,
        unattributedTurns: result.unattributed.turns,
        staleSessionCount: result.staleSessionCount,
        sessionsWithoutCauseData: result.sessionsWithoutCauseData,
      };
    }
  }
}

/** Ratios and shares to 6 decimal places (|diff| < 5e-7), as the doc says; all else exact. */
function closeTo(expected: Record<string, unknown>): Record<string, unknown> {
  const matcher: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expected)) {
    const fractional = key === 'ratio' || key.endsWith('Share');
    matcher[key] =
      fractional && typeof value === 'number'
        ? expect.closeTo(value, 6)
        : value;
  }
  return matcher;
}

const rows = loadExamples<CacheInput, Record<string, unknown>>(
  'cache-ratio-and-causes',
);

it.each(rows)('$id', ({ input, expected }) => {
  expect(evaluate(input)).toEqual(closeTo(expected));
});
