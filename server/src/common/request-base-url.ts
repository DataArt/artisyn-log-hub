import type { Request } from 'express';

// The client is served from the same origin as the API (see ServeStaticModule
// in app.module.ts), so the incoming request's own protocol/host always match
// whatever URL the browser is actually using — no separate base-URL config to
// keep in sync with the real deployment domain.
export function getRequestBaseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}
