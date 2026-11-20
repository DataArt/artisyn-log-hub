import type { Request } from 'express';

/**
 * Source IP for the auth and email rate limits. `req.ip` honours TRUST_PROXY
 * (see common/trust-proxy.ts); without it Express reports the socket peer.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
