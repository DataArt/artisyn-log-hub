import helmet from 'helmet';
import type { RequestHandler } from 'express';

// WHY these choices:
// - style-src allows 'unsafe-inline' (scripts do NOT): the built client sets inline
//   style *attributes*; script-src stays strict since the bundle has no inline scripts.
// - img-src/font-src allow data:: Vite inlines small images and fonts as data: URIs.
// - useDefaults: false omits helmet's default upgrade-insecure-requests directive,
//   which would break plain-HTTP internal deployments (no TLS on the LAN).
// - frame-ancestors 'none' + X-Frame-Options: DENY (frameguard): both anti-framing
//   mechanisms so old browsers that ignore CSP still refuse to embed the app.
// Explicit RequestHandler type: helmet's own return type is not assignable enough for
// @typescript-eslint/no-unsafe-argument at the consumer.apply() call site.
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
});
