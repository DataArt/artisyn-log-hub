/**
 * Table test for docs/knowledgebase/algorithms/local-request-detection.md. Part A rows run
 * `isLocalhostRequest` with the process's trusted gateway pinned by the row; part B rows run the
 * real `resolveTrustedGateway` / `isTrustablePrivateIpv4` against a fake filesystem.
 */
import type { Request } from 'express';
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import type * as ContainerGateway from './container-gateway.util';
import { getTrustedGateway } from './container-gateway.util';
import { isLocalhostRequest } from './localhost.util';

// Only the memoized process-wide lookup is replaced; the pure functions stay real.
jest.mock('./container-gateway.util', () => ({
  ...jest.requireActual<typeof ContainerGateway>('./container-gateway.util'),
  getTrustedGateway: jest.fn(() => null),
}));

const { resolveTrustedGateway, isTrustablePrivateIpv4 } = jest.requireActual<
  typeof ContainerGateway
>('./container-gateway.util');

const getTrustedGatewayMock = jest.mocked(getTrustedGateway);

type LocalInput =
  | {
      kind: 'request';
      remoteAddress: string | null;
      headers?: Record<string, string>;
      trustedGateway: string | null;
    }
  | {
      kind: 'gateway';
      files: Record<string, string>;
      env: Record<string, string>;
      pid: number;
      throws?: true;
    }
  | { kind: 'private'; address: string };

/**
 * A test double, not a real Express request: it carries the peer address, the headers and the
 * proxy-derived `ip`, so a check that read anything but the peer address would be caught.
 */
function fakeRequest(
  remoteAddress: string | null,
  headers: Record<string, string>,
): Request {
  return {
    socket: { remoteAddress: remoteAddress ?? undefined },
    headers,
    // What Express reports as `req.ip` behind a trusted proxy, so a check that used it would be
    // fooled by the header just like one that read the header itself.
    ip: headers['x-forwarded-for'] ?? remoteAddress ?? undefined,
  } as unknown as Request;
}

function evaluate(input: LocalInput): Record<string, unknown> {
  switch (input.kind) {
    case 'request':
      getTrustedGatewayMock.mockReturnValue(input.trustedGateway);
      return {
        local: isLocalhostRequest(
          fakeRequest(input.remoteAddress, input.headers ?? {}),
        ),
      };
    case 'gateway': {
      const { files, throws } = input;
      const fail = (path: string): never => {
        throw new Error(`EACCES: ${path}`);
      };
      return {
        trustedGateway: resolveTrustedGateway({
          probe: {
            exists: (path) => (throws ? fail(path) : path in files),
            read: (path) =>
              throws ? fail(path) : path in files ? files[path] : null,
          },
          env: input.env,
          pid: input.pid,
        }),
      };
    }
    case 'private':
      return { trusted: isTrustablePrivateIpv4(input.address) };
  }
}

const rows = loadExamples<LocalInput, Record<string, unknown>>(
  'local-request-detection',
);

afterEach(() => {
  getTrustedGatewayMock.mockReturnValue(null);
});

it.each(rows)('$id', ({ input, expected }) => {
  expect(evaluate(input)).toEqual(expected);
});
