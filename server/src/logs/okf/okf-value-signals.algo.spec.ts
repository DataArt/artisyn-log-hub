/**
 * Table test for docs/knowledgebase/algorithms/okf-value-signals.md: each row is one call of
 * `computeArticleSignals`, with the input shorthand of the doc's Examples preamble (pointer row
 * defaults, `allTimePointers` derived from the period pointers, thresholds over the defaults).
 * `expected` is compared as a nested subset of `{articles, nodes, summary, findings, yield}`, the
 * two maps turned into objects keyed by path / node id; arrays compare element by element and must
 * have the same length.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { resolveOkfThresholds } from './okf-thresholds';
import {
  computeArticleSignals,
  type OkfSignalAllTimePointerRow,
  type OkfSignalEventRow,
  type OkfSignalNodeRead,
  type OkfSignalPointerRow,
  type OkfSignalUpkeepPair,
  type OkfValueSignalsResult,
} from './okf-value-signals';

type PointerSpec = Omit<OkfSignalPointerRow, 'articleHash' | 'partial'> & {
  articleHash?: string | null;
  partial?: boolean;
};

type AllTimePointerSpec = Omit<
  OkfSignalAllTimePointerRow,
  'articleHash' | 'partial' | 'lastReadAt'
> & {
  articleHash?: string | null;
  partial?: boolean;
  lastReadAt?: number | null;
};

type EventSpec = Omit<OkfSignalEventRow, 'pattern'> & {
  pattern?: string | null;
};

interface SignalsInput {
  pointers?: PointerSpec[];
  allTimePointers?: AllTimePointerSpec[];
  events?: EventSpec[];
  allTimeTouchedPaths?: string[];
  reads?: OkfSignalNodeRead[];
  upkeep?: OkfSignalUpkeepPair[];
  latestFiles?: Record<string, { hash: string | null; size: number | null }>;
  /** Only the fields that differ from the defaults. */
  thresholds?: Record<string, unknown>;
}

const rows = loadExamples<SignalsInput, Record<string, unknown>>(
  'okf-value-signals',
);

function toPointers(specs: PointerSpec[]): OkfSignalPointerRow[] {
  return specs.map((p) => ({
    ...p,
    articleHash: p.articleHash ?? null,
    partial: p.partial ?? false,
  }));
}

function toAllTime(
  specs: AllTimePointerSpec[] | undefined,
  pointers: OkfSignalPointerRow[],
): OkfSignalAllTimePointerRow[] {
  if (specs === undefined) {
    return pointers.map((p) => ({
      articlePath: p.articlePath,
      articleHash: p.articleHash,
      pointer: p.pointer,
      isNew: p.isNew,
      partial: p.partial,
      lastReadAt: null,
    }));
  }
  return specs.map((p) => ({
    ...p,
    articleHash: p.articleHash ?? null,
    partial: p.partial ?? false,
    lastReadAt: p.lastReadAt ?? null,
  }));
}

/** The result with its two maps turned into plain objects. */
function toPlain(result: OkfValueSignalsResult): Record<string, unknown> {
  return {
    articles: Object.fromEntries(result.articles),
    nodes: Object.fromEntries(
      [...result.nodes].map(([id, n]) => [String(id), n]),
    ),
    summary: result.summary,
    findings: result.findings,
    yield: result.yield,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Nested subset: listed object keys only; arrays element by element, same length. */
function expectSubset(actual: unknown, expected: unknown, at: string): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(
        `${at}: expected an array, got ${JSON.stringify(actual)}`,
      );
    }
    expect({ at, length: actual.length }).toEqual({
      at,
      length: expected.length,
    });
    expected.forEach((item, i) => expectSubset(actual[i], item, `${at}[${i}]`));
    return;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) {
      throw new Error(
        `${at}: expected an object, got ${JSON.stringify(actual)}`,
      );
    }
    for (const [key, value] of Object.entries(expected)) {
      expectSubset(actual[key], value, `${at}.${key}`);
    }
    return;
  }
  expect({ at, value: actual }).toEqual({ at, value: expected });
}

it.each(rows)('$id', (row) => {
  const { input, expected } = row;
  const pointers = toPointers(input.pointers ?? []);
  const result = computeArticleSignals({
    pointers,
    allTimePointers: toAllTime(input.allTimePointers, pointers),
    events: (input.events ?? []).map((e) => ({
      ...e,
      pattern: e.pattern ?? null,
    })),
    allTimeTouchedPaths: input.allTimeTouchedPaths ?? [],
    reads: input.reads ?? [],
    upkeep: input.upkeep ?? [],
    ...(input.latestFiles !== undefined
      ? { latestFiles: new Map(Object.entries(input.latestFiles)) }
      : {}),
    thresholds: resolveOkfThresholds(input.thresholds ?? {}),
  });
  expectSubset(toPlain(result), expected, 'result');
});
