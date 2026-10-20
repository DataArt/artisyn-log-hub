import type { Request } from 'express';
import { getTrustedGateway } from './container-gateway.util';

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1']);

/**
 * Checks req.socket.remoteAddress only — never X-Forwarded-For. `TRUST_PROXY`
 * does exist and makes Express honour X-Forwarded-* for req.ip/protocol,
 * but that header stays trivially spoofable as a *security* signal, so this gate
 * keeps ignoring it. Used by Mode 1's `identify` endpoint and by
 * `AutoIdentifyGuard`, which apply the exact same restriction.
 *
 * The server listens without a host (see main.ts), so it binds the dual-stack
 * `::` socket. An IPv4 loopback connection arriving on that socket is reported
 * by Node as the IPv4-mapped IPv6 form `::ffff:127.0.0.1`, not `127.0.0.1` —
 * strip that prefix before comparing, or every user whose OS/browser resolves
 * `localhost` to the IPv4 address gets rejected as non-local.
 *
 * Inside a container one further address is accepted: the container's
 * own private default gateway, resolved once at startup by
 * `container-gateway.util.ts`. Host→published-port traffic arrives from exactly
 * that address and never from loopback, so without this Mode 1 is unusable in
 * the released image. Outside a container nothing changes — the gateway resolves
 * to null and only `127.0.0.1`/`::1` pass.
 *
 * Caveat worth knowing: with Docker's userland `docker-proxy` *every* inbound
 * connection appears to come from the gateway, so the `127.0.0.1`-bound port
 * publish in `docker-compose.yml` — not this check — is the real boundary in a
 * container. Republishing the port on all interfaces extends Mode 1 to every
 * client that can reach it. See docs/knowledgebase/authorization-and-
 * authentificaiton.md.
 */
export function isLocalhostRequest(req: Request): boolean {
  const remoteAddress = req.socket.remoteAddress ?? '';
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  if (LOCAL_ADDRESSES.has(normalized)) return true;

  const trustedGateway = getTrustedGateway();
  return trustedGateway !== null && trustedGateway === normalized;
}
