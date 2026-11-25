import { isTrustablePrivateIpv4 } from './container-gateway.util';

/**
 * `AUTH_NONE_TRUSTED_PEERS`: extra exact addresses Mode 1 (`AUTH_MODE=none`) treats as local, next
 * to loopback and the container's own gateway (see localhost.util.ts).
 *
 * Why it exists: some container runtimes deliver host→published-port traffic from an address that
 * is neither loopback nor the container's default gateway. Rancher Desktop on Windows forwards
 * `127.0.0.1:5003` through its own VM network and the peer arrives as `192.168.127.1`, while the
 * container's gateway is the compose bridge's `172.x.0.1` — so without this list Mode 1 is unusable
 * there. The release installer probes `GET /api/v1/auth/local-check` after starting the app and
 * writes the address it saw into `.env` (install.ps1 / install.sh), so no one types it by hand.
 *
 * Same guard as the gateway: only well-formed private IPv4 addresses, one exact address per entry,
 * never a subnet. Anything else is reported back as rejected (logged at startup) and ignored.
 */
export interface TrustedPeers {
  peers: string[];
  rejected: string[];
}

/** Splits on commas and whitespace; keeps private IPv4 addresses once, in order. */
export function parseTrustedPeers(raw: string | undefined): TrustedPeers {
  const peers: string[] = [];
  const rejected: string[] = [];
  for (const entry of (raw ?? '').split(/[\s,]+/)) {
    if (entry === '') continue;
    if (!isTrustablePrivateIpv4(entry)) {
      rejected.push(entry);
    } else if (!peers.includes(entry)) {
      peers.push(entry);
    }
  }
  return { peers, rejected };
}

let cached: TrustedPeers | undefined;

/** Memoized per process: env is read once, no work on the request path. */
export function getTrustedPeers(): TrustedPeers {
  if (cached === undefined) {
    cached = parseTrustedPeers(process.env.AUTH_NONE_TRUSTED_PEERS);
  }
  return cached;
}
