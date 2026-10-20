import * as fs from 'fs';
import { join, sep } from 'path';

/**
 * Content-encoding negotiation for the precompressed client assets produced by
 * `client/scripts/precompress.cjs`.
 *
 * The build writes `.br`/`.gz` siblings next to every compressible file in
 * `client/dist`, which the asset phase copies into `dist/public`. This module
 * teaches the stock `ServeStaticModule` (bare `express.static`, which does no
 * negotiation at all) to hand out the right variant:
 *
 *  - `createPrecompressedStaticMiddleware()` runs *before* `express.static`, sets
 *    `Content-Encoding` / `Content-Type` / `Vary` itself, and rewrites `req.url`
 *    to the variant file. `express.static` then streams that file, computing
 *    `Content-Length`/`ETag` from the bytes it actually sends.
 *  - `precompressedCacheHeaders()` is the `serveStaticOptions.setHeaders` hook and
 *    is responsible only for `Cache-Control`.
 *
 * Why setting the headers up-front composes with the stock stack: `send` calls
 * `setHeader()` — which emits the `headers` event our `setHeaders` hook rides on —
 * *before* `type()` (`send/index.js` `SendStream.prototype.send`), and both
 * `type()` and send's own `Cache-Control` default return early when the header is
 * already present. So our values win and are never overwritten by the `.br`
 * extension being mistaken for a content type.
 *
 * The static root is passed in rather than computed here: a module under
 * `server/src/common/` sees a different `__dirname` in dev than in the flattened
 * ncc bundle (see `static-dir.ts` for the full account of that trap). Callers pass
 * `join(__dirname, 'public')` from `main.ts`/`app.module.ts`, which are at the same
 * level in both layouts.
 */

/** Which variants exist on disk for one original file. */
export interface PrecompressedVariants {
  br: boolean;
  gz: boolean;
}

/** URL path of the original file (leading `/`, `/`-separated) → variants present. */
export type PrecompressedManifest = Map<string, PrecompressedVariants>;

/**
 * Content types for exactly the extension allowlist in
 * `client/scripts/precompress.cjs` (`COMPRESSIBLE`) — keep the two in sync.
 *
 * Spelled out rather than delegated to `mime.contentType()` because `mime-types`
 * is a *transitive* dependency of `send`/`serve-static`, not a declared dependency
 * of `server/package.json`; importing it from production code would be an
 * undeclared dependency. `precompressed-static.spec.ts` pins every entry here
 * against `mime-types`' own output so the two cannot drift silently.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Walks `root` once and records which precompressed variants exist, keyed by the
 * URL path of the *original* file. Never throws: a missing or unreadable root
 * (fresh checkout, unbundled run, dev where the root holds no client assets) just
 * yields an empty manifest, i.e. "no precompression available".
 */
export function buildPrecompressedManifest(
  root: string,
): PrecompressedManifest {
  const manifest: PrecompressedManifest = new Map();

  const walk = (dir: string, urlPrefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${urlPrefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;

      const suffix = entry.name.endsWith('.br')
        ? 'br'
        : entry.name.endsWith('.gz')
          ? 'gz'
          : null;
      if (!suffix) continue;

      const original = `${urlPrefix}${entry.name.slice(0, -3)}`;
      // Only originals whose own extension is on the allowlist count. This is
      // what keeps `/public/static/hooks.tar.gz` — a shipped artefact that merely
      // happens to end in `.gz` — from registering a phantom `hooks.tar` entry
      // (the `/static/*` artefacts stay served by their existing paths).
      if (!contentTypeFor(original)) continue;

      const existing = manifest.get(original) ?? { br: false, gz: false };
      existing[suffix] = true;
      manifest.set(original, existing);
    }
  };

  try {
    walk(root, '/');
  } catch {
    return new Map();
  }
  return manifest;
}

/**
 * Best encoding to serve for an `Accept-Encoding` header, or `null` for identity.
 *
 * Honours an explicit `q=0` ("not acceptable") and `*`, but deliberately does not
 * rank by relative q-values: `br` wins over `gzip` whenever both are acceptable
 * and available. That is standard static-server behaviour and avoids a
 * float-comparison edge case for no practical gain.
 */
export function pickEncoding(
  acceptEncoding: string | undefined,
  available: PrecompressedVariants,
): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null;

  const acceptable = new Set<string>();
  for (const part of acceptEncoding.split(',')) {
    const [rawToken, ...params] = part.split(';');
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;

    const qParam = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith('q='));
    if (qParam) {
      const q = Number.parseFloat(qParam.slice(2));
      if (!Number.isNaN(q) && q <= 0) continue;
    }
    acceptable.add(token);
  }

  if (available.br && (acceptable.has('br') || acceptable.has('*')))
    return 'br';
  if (available.gz && (acceptable.has('gzip') || acceptable.has('*')))
    return 'gzip';
  return null;
}

/**
 * Content type for the *original* pathname, so a `.br`/`.gz` response is never
 * labelled `application/octet-stream`. `undefined` for an unmapped extension —
 * the caller then leaves `Content-Type` to `express.static`.
 */
export function contentTypeFor(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) return undefined;
  return CONTENT_TYPES[pathname.slice(dot).toLowerCase()];
}

interface StaticRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface StaticResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Express middleware that rewrites a request for a precompressed file to its
 * variant. O(1) per request (one `Map` lookup, no `stat`), and a no-op for
 * anything not in the manifest — so `/api/*`, `/health*` and `/static/*` are
 * untouched.
 *
 * Must be registered before `express.static`. Registering it via `app.use()` in
 * `bootstrap()` is early enough: `ServeStaticModule` registers its `express.static`
 * from `onModuleInit`, which Nest calls inside `app.listen()`.
 */
export function createPrecompressedStaticMiddleware(
  root: string,
): (req: StaticRequest, res: StaticResponse, next: () => void) => void {
  const manifest = buildPrecompressedManifest(root);

  return (req, res, next) => {
    if (manifest.size === 0) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Serving a byte range of a different representation than the client asked
    // for is legal but pointless here — nothing range-requests JS/CSS.
    if (req.headers.range) return next();
    if (!req.url) return next();

    const queryAt = req.url.indexOf('?');
    const rawPath = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
    const query = queryAt === -1 ? '' : req.url.slice(queryAt);

    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      return next(); // malformed percent-escape — let express.static handle it
    }

    const available = manifest.get(pathname);
    if (!available) return next();

    // Set even when identity is served: both deployed environments sit behind an
    // outer proxy, and without this a shared cache could cross-serve encodings.
    res.setHeader('Vary', 'Accept-Encoding');

    const acceptEncoding = req.headers['accept-encoding'];
    const encoding = pickEncoding(
      Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding,
      available,
    );
    if (!encoding) return next();

    res.setHeader('Content-Encoding', encoding);
    const contentType = contentTypeFor(pathname);
    if (contentType) res.setHeader('Content-Type', contentType);

    req.url = `${rawPath}${encoding === 'br' ? '.br' : '.gz'}${query}`;
    return next();
  };
}

/**
 * `serveStaticOptions.setHeaders` hook: marks the content-hashed `assets/` output
 * immutable and leaves everything else alone.
 *
 * Scoped by path segment rather than by "the name looks hashed" because only
 * vite's `assets/` output is content-hashed — `index.html`, `/favicon.svg` and
 * `/help/*.md` have stable names and must keep revalidating. The same rule keeps
 * the `ServeStaticModule` SPA fallback (`res.sendFile(indexFilePath)`, which also
 * runs this hook) out of the immutable bucket.
 */
export function precompressedCacheHeaders(
  res: StaticResponse,
  filePath: string,
): void {
  if (filePath.includes(`${sep}assets${sep}`)) {
    res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
  }
}
