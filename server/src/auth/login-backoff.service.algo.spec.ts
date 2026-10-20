/**
 * Table test for docs/knowledgebase/algorithms/login-backoff.md: each doc row is a sequence of
 * fail / check / success / wait steps run on a fresh service and a fake clock. This replaced the ad hoc
 * `login-backoff.service.spec.ts`; every case it had is a row of the doc now.
 */
import { HttpStatus } from '@nestjs/common';
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { TooManyRequestsException } from './exceptions/too-many-requests.exception';
import { LoginBackoffService } from './login-backoff.service';

/**
 * The real service is inert under NODE_ENV=test (see its `enabled` getter: the shared e2e app
 * would otherwise 429 unrelated specs). This is the one place the schedule must run.
 */
class EnabledLoginBackoffService extends LoginBackoffService {
  protected override get enabled(): boolean {
    return true;
  }
}

type Step =
  | ['fail', string, string]
  | ['check', string, string]
  | ['success', string]
  | ['wait', number];

async function run(
  service: LoginBackoffService,
  step: Step,
): Promise<number | null> {
  switch (step[0]) {
    case 'fail':
      return service.recordFailure(step[1], step[2]);
    case 'success':
      await service.recordSuccess(step[1]);
      return null;
    case 'wait':
      jest.advanceTimersByTime(step[1]);
      return null;
    case 'check':
      try {
        await service.assertNotDelayed(step[1], step[2]);
        return null;
      } catch (err) {
        if (!(err instanceof TooManyRequestsException)) throw err;
        expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        const body = err.getResponse();
        if (
          typeof body !== 'object' ||
          !('retryAfterSeconds' in body) ||
          typeof body.retryAfterSeconds !== 'number'
        ) {
          throw new Error(
            `429 without retryAfterSeconds: ${JSON.stringify(body)}`,
          );
        }
        return body.retryAfterSeconds;
      }
  }
}

const rows = loadExamples<{ steps: Step[] }, { results: (number | null)[] }>(
  'login-backoff',
);

// The limiter reads Date.now(); a fake clock makes every wait (and "check right after") exact.
beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-01T10:00:00.000Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

it.each(rows)('$id', async ({ input, expected }) => {
  const service = new EnabledLoginBackoffService();
  const results: (number | null)[] = [];
  for (const step of input.steps) {
    results.push(await run(service, step));
  }
  expect(results).toEqual(expected.results);
});
