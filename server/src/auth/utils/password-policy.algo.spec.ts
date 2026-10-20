/**
 * Table test for docs/knowledgebase/algorithms/password-policy.md. This replaced the ad hoc
 * `password-policy.spec.ts`; every case it had is a row of the doc now.
 */
import { BadRequestException } from '@nestjs/common';
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { applyPasswordPolicy } from './password-policy';

interface PolicyInput {
  policy: string | null;
  password: string;
}

type PolicyExpected =
  | { accepted: true }
  | { accepted: false; error: string; message?: string };

/** What `applyPasswordPolicy` did: accepted, or the 400 body's `error` and `message`. */
function outcome(password: string): {
  accepted: boolean;
  error?: string;
  message?: string;
} {
  try {
    applyPasswordPolicy(password);
    return { accepted: true };
  } catch (err) {
    if (!(err instanceof BadRequestException)) throw err;
    const body = err.getResponse();
    if (typeof body !== 'object') {
      throw new Error(`unexpected 400 body: ${JSON.stringify(body)}`);
    }
    const field = (key: 'error' | 'message'): string | undefined => {
      const value: unknown = key in body ? Reflect.get(body, key) : undefined;
      return typeof value === 'string' ? value : undefined;
    };
    return {
      accepted: false,
      error: field('error'),
      message: field('message'),
    };
  }
}

const rows = loadExamples<PolicyInput, PolicyExpected>('password-policy');

describe('password-policy', () => {
  const savedPolicy = process.env.PASSWORD_POLICY;
  afterEach(() => {
    if (savedPolicy === undefined) delete process.env.PASSWORD_POLICY;
    else process.env.PASSWORD_POLICY = savedPolicy;
  });

  it.each(rows)('$id', ({ input, expected }) => {
    if (input.policy === null) delete process.env.PASSWORD_POLICY;
    else process.env.PASSWORD_POLICY = input.policy;
    // A row pins `message` only where the doc says so; `error` and `accepted` always.
    expect(outcome(input.password)).toEqual(expect.objectContaining(expected));
  });
});
