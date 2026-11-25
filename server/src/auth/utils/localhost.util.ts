import type { Request } from 'express';
import { getTrustedGateway } from './container-gateway.util';
import { getTrustedPeers } from './trusted-peers.util';

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1']);

/**
 * The TCP peer address with an IPv4-mapped `::ffff:` prefix stripped.
 *
 * The server listens without a host (see main.ts), so it binds the dual-stack `::` socket. An IPv4
 * connection arriving on that socket is reported by Node as `::ffff:127.0.0.1`, not `127.0.0.1`.
 */
export function peerAddress(req: Request): string {
  const remoteAddress = req.socket.remoteAddress ?? '';
  return remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
}

/**
 * Checks req.socket.remoteAddress only — never X-Forwarded-For. `TRUST_PROXY`
 * does exist and makes Express honour X-Forwarded-* for req.ip/protocol,
 * but that header stays trivially spoofable as a *security* signal, so this gate
 * keeps ignoring it. Used by Mode 1's `identify` endpoint and by
 * `AutoIdentifyGuard`, which apply the exact same restriction.
 *
 * Inside a container one further address is accepted: the container's
 * own private default gateway, resolved once at startup by
 * `container-gateway.util.ts`. Host→published-port traffic arrives from exactly
 * that address on Docker and Docker Desktop, never from loopback. Runtimes that
 * deliver it from yet another address (Rancher Desktop: `192.168.127.1`) are covered
 * by `AUTH_NONE_TRUSTED_PEERS` (trusted-peers.util.ts), which the release installer
 * fills in by probing `GET /api/v1/auth/local-check`.
 *
 * Caveat worth knowing: with Docker's userland `docker-proxy` *every* inbound
 * connection appears to come from the gateway, so the `127.0.0.1`-bound port
 * publish in `docker-compose.yml` — not this check — is the real boundary in a
 * container. Republishing the port on all interfaces extends Mode 1 to every
 * client that can reach it. See docs/knowledgebase/authorization-and-
 * authentificaiton.md.
 */
export function isLocalhostRequest(req: Request): boolean {
  const normalized = peerAddress(req);
  if (LOCAL_ADDRESSES.has(normalized)) return true;

  const trustedGateway = getTrustedGateway();
  if (trustedGateway !== null && trustedGateway === normalized) return true;

  return getTrustedPeers().peers.includes(normalized);
}
