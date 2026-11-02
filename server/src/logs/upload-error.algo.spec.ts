/**
 * Table test for docs/knowledgebase/algorithms/upload-error-classify.md: `classify` rows run
 * against `classifyUploadError` (the row's `error` is rebuilt as an `Error` with its `cause`
 * chain and `code`), `warning` rows against `formatFailedUploadWarning`. Only the fields a row
 * pins are compared.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { classifyUploadError, formatFailedUploadWarning } from './upload-error';

interface ErrorSpec {
  message: string;
  code?: string;
  cause?: ErrorSpec;
  detail?: string;
  constraint?: string;
  table?: string;
}

type Input =
  | { fn: 'classify'; error: ErrorSpec; repeat?: number }
  | {
      fn: 'warning';
      fileName: string;
      errorMessage: string | null;
      errorKind: string | null;
    };

const rows = loadExamples<Input, Record<string, unknown>>(
  'upload-error-classify',
);

function buildError(spec: ErrorSpec, repeat = 0): Error {
  const message = repeat > 0 ? spec.message.repeat(repeat) : spec.message;
  const err = new Error(message) as Error & Record<string, unknown>;
  for (const key of ['code', 'detail', 'constraint', 'table'] as const) {
    if (spec[key] !== undefined) err[key] = spec[key];
  }
  if (spec.cause) err.cause = buildError(spec.cause);
  return err;
}

it.each(rows)('$id', ({ input, expected }) => {
  if (input.fn === 'warning') {
    expect(
      formatFailedUploadWarning(
        input.fileName,
        input.errorMessage,
        input.errorKind,
      ),
    ).toBe(expected.warning);
    return;
  }
  const actual = classifyUploadError(buildError(input.error, input.repeat));
  for (const key of ['kind', 'code', 'summary', 'logDetail'] as const) {
    if (key in expected) expect(actual[key]).toEqual(expected[key]);
  }
  if ('summaryLength' in expected) {
    expect(actual.summary).toHaveLength(Number(expected.summaryLength));
  }
  if ('summaryEndsWith' in expected) {
    expect(actual.summary.endsWith(String(expected.summaryEndsWith))).toBe(
      true,
    );
  }
});
