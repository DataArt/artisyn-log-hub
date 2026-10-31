/**
 * Table test for docs/knowledgebase/algorithms/otel-facts.md: every row of the doc's examples
 * block runs against the real classification, event-time, call-key, bucket, interval, time-zone,
 * extraction and query-source functions.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { TRANSCRIPT_QUERY_SOURCES } from '../otel-cost.sql';
import {
  bucketStart5m,
  classifyOtelCall,
  isOtelCallProvisional,
  isValidOtelTimeZone,
  pickOtelInterval,
  type OtelClassifyInput,
} from './otel-classify';
import type { OtelIntervalScope } from './otel-facts.types';
import {
  OTEL_VISIBLE_QUERY_SOURCES,
  lookupQuerySource,
} from './otel-query-source-dictionary';
import {
  extractOtelCalls,
  extractOtelSpans,
  otelCallKey,
  resolveOtelEventTime,
} from './otel-records';

type FactsInput =
  | ({ kind: 'classify' } & OtelClassifyInput)
  | { kind: 'provisional'; firstSeq: number; transcriptSeq: number | null }
  | { kind: 'eventTime'; line: unknown }
  | {
      kind: 'callKey';
      calls: Array<{ requestId: string | null; record: unknown }>;
    }
  | { kind: 'bucket5m'; time: string }
  | { kind: 'interval'; from: string; to: string; scope: OtelIntervalScope }
  | { kind: 'tz'; tz: string }
  | { kind: 'calls'; lines: unknown[] }
  | { kind: 'spans'; lines: unknown[] }
  | { kind: 'dictionary' }
  | { kind: 'querySource'; name: string };

const rows = loadExamples<FactsInput, Record<string, unknown>>('otel-facts');

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** Expands the doc's `{"$repeat": [char, count]}` placeholder into a long string. */
function expandRepeat(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandRepeat);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const repeat = obj['$repeat'];
    if (Array.isArray(repeat) && Object.keys(obj).length === 1) {
      return String(repeat[0]).repeat(Number(repeat[1]));
    }
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, expandRepeat(v)]),
    );
  }
  return value;
}

it.each(rows)('$id', ({ input, expected }) => {
  switch (input.kind) {
    case 'classify': {
      expect({
        structure: classifyOtelCall({
          inTree: input.inTree,
          inSubagentTranscript: input.inSubagentTranscript,
          querySource: input.querySource,
          treeHasRequestIds: input.treeHasRequestIds,
          provisional: input.provisional,
        }),
      }).toEqual(expected);
      return;
    }
    case 'provisional':
      expect({
        provisional: isOtelCallProvisional(input.firstSeq, input.transcriptSeq),
      }).toEqual(expected);
      return;
    case 'eventTime':
      expect({ eventTime: iso(resolveOtelEventTime(input.line)) }).toEqual(
        expected,
      );
      return;
    case 'callKey':
      expect({
        keys: input.calls.map((c) => otelCallKey(c.requestId, c.record)),
      }).toEqual(expected);
      return;
    case 'bucket5m':
      expect({
        bucketStart: bucketStart5m(new Date(input.time)).toISOString(),
      }).toEqual(expected);
      return;
    case 'interval':
      expect({
        interval: pickOtelInterval(
          new Date(input.from),
          new Date(input.to),
          input.scope,
        ),
      }).toEqual(expected);
      return;
    case 'tz':
      expect({ valid: isValidOtelTimeZone(input.tz) }).toEqual(expected);
      return;
    case 'calls': {
      const calls = extractOtelCalls(input.lines).map((c) => ({
        ...c,
        eventTime: c.eventTime.toISOString(),
        costUsdMicros:
          c.costUsdMicros === null ? null : c.costUsdMicros.toString(),
      }));
      expect({ calls }).toMatchObject(expected);
      return;
    }
    case 'spans': {
      const result = extractOtelSpans(expandRepeat(input.lines) as unknown[]);
      const spans = result.spans.map((s) => ({
        ...s,
        startTime: s.startTime.toISOString(),
        endTime: iso(s.endTime),
      }));
      expect({ spans, skipped: result.skipped }).toMatchObject(expected);
      return;
    }
    case 'dictionary':
      expect({
        visible: [...OTEL_VISIBLE_QUERY_SOURCES],
        transcript: [...TRANSCRIPT_QUERY_SOURCES],
      }).toEqual(expected);
      return;
    case 'querySource':
      expect(lookupQuerySource(input.name)).toEqual(
        expect.objectContaining(expected),
      );
  }
});
