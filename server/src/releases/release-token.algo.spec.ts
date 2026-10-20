/**
 * Table test for docs/knowledgebase/algorithms/release-link-token.md. Genuine signatures are made
 * as each row describes; the clock is pinned to the row's `now`.
 */
import { createHmac } from 'crypto';
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  signReleaseToken,
  verifyReleaseToken,
  type ReleaseTokenVerdict,
} from './release-token';

/** The key the doc says the server verifies with. */
const SERVER_KEY = 'release-key';

interface ReleaseInput {
  file: string;
  exp: string;
  now: number;
  sign?: { file?: string; exp?: string; key?: string; extra?: string };
  sig?: string;
}

/**
 * The genuine signature of `file:exp` under `key`. `signReleaseToken` takes `exp` as a number, so
 * it signs exactly the text only when that text is how the number prints; for any other text
 * (empty, leading zero, sign, space) the same HMAC-SHA256 is applied to the text directly.
 */
function genuineSignature(file: string, expText: string, key: string): string {
  const exp = Number(expText);
  if (expText !== '' && String(exp) === expText) {
    return signReleaseToken(file, exp, key);
  }
  return createHmac('sha256', key)
    .update(`${file}:${expText}`)
    .digest('base64url');
}

function signatureOf(input: ReleaseInput): string {
  if (input.sig !== undefined) return input.sig;
  const sign = input.sign ?? {};
  return (
    genuineSignature(
      sign.file ?? input.file,
      sign.exp ?? input.exp,
      sign.key ?? SERVER_KEY,
    ) + (sign.extra ?? '')
  );
}

const rows = loadExamples<ReleaseInput, { verdict: ReleaseTokenVerdict }>(
  'release-link-token',
);

afterEach(() => {
  jest.restoreAllMocks();
});

it.each(rows)('$id', ({ input, expected }) => {
  jest.spyOn(Date, 'now').mockReturnValue(input.now * 1000);
  expect({
    verdict: verifyReleaseToken(
      input.file,
      input.exp,
      signatureOf(input),
      SERVER_KEY,
    ),
  }).toEqual(expected);
});
