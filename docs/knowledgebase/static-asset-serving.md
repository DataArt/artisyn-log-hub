---
type: "Reference"
title: "Static Asset Serving (precompression, negotiation, cache policy)"
description: "How the built client SPA reaches the runtime and is served: the build-time brotli/gzip precompression step, the Accept-Encoding negotiation middleware, the /assets/ immutable cache policy, why dev is a no-op, and the rejected alternatives."
tags:
  - client
  - server
  - build
  - performance
timestamp: "2026-08-21T22:40:00+04:00"
---

# Static Asset Serving

Read this before touching anything that serves the built client: the `ServeStaticModule`
registration, `client/package.json` `"build"`, the `Dockerfile` `client-build` stage, or the
`Cache-Control`/`Content-Encoding` headers on client assets.

## 1. How client assets reach the runtime

Two paths, both ending at the same runtime layout (`dist/public`):

| | Docker image | Local `npm run build` |
|---|---|---|
| Build the SPA | `Dockerfile` stage `client-build`: `RUN cd client && bun install && bun run build` | `npm run build:client` → `cd client && bun run build` |
| Copy it in | `COPY --from=client-build /app/client/dist ./dist/public` | `scripts/build-assets.js` → `copyClient()`: `client/dist` → `dist/public` |
| Hook artefacts | `COPY --from=hooks-build /app/server/src/public/static/ ./dist/public/static/` | `copyStatic()`: `server/src/public` → `dist/public/public` |

Both copy the *whole* `client/dist` tree recursively, which is why the precompression step
(below) needs no `Dockerfile`, `docker-compose*.yml`, `scripts/build*.js` or `.gitlab-ci.yml`
change: the `.br`/`.gz` siblings are just more files in `client/dist`.

At runtime the tree is served by `ServeStaticModule.forRoot({ rootPath: join(__dirname, 'public'),
serveRoot: '/' })` in `server/src/app.module.ts` — i.e. bare `express.static`, which does **no**
content-encoding negotiation of its own.

## 2. Build-time precompression

`client/scripts/precompress.cjs`, run from `client/package.json` → `"build"`
(`vite build && node scripts/precompress.cjs`).

It walks the target dir (default `client/dist`) and writes a `.br` and a `.gz` sibling next to
every file that qualifies:

- **Extension allowlist** (`COMPRESSIBLE`): `.js .css .html .svg .json .md .txt .map .wasm`.
  Already-compressed binaries (`.png`, `.woff2`, `.tgz`) are never double-compressed — and
  because `.br`/`.gz` are not on the list, a second consecutive run can never produce
  `index.js.br.br`.
- **`MIN_BYTES = 1024`** — below that the variant is not worth a separate file.
- **`MIN_GAIN_PERCENT = 10`** — a variant is discarded unless it is at least 10% smaller.
  Compared with integer arithmetic (`(raw - out) * 100 >= raw * 10`) so the exact-10% boundary
  is exact; `raw * 0.1` is not.
- **Levels: brotli q10, gzip 9.** Measured on the current 22-file set: q10 = 0.919 MB in 1.8 s,
  q11 = 0.904 MB in 5.7 s. 15 KB (1.6%) is not worth +3.9 s on every build. gzip stays at 9
  because the whole set costs 110 ms there.
- **Synchronous throughout**, per the `nodejs-script` skill. The whole set costs ~1.9 s.

Actual output on a code-split build: `22/27 files, raw 3685 KB → br 941 KB / gz 1111 KB in
~1.9 s` (the summary line the script writes to **stderr**).

Both encodings ship. Chrome and Firefox only advertise `br` on secure origins, and plain-HTTP
LAN installs are supported (`COOKIE_SECURE` defaults to `false` in `release/docker-compose.yml`),
so `.gz` is what keeps those installs compressed.

The script exports its helpers (`isCompressible`, `worthKeeping`, `listCompressible`,
`precompress`) and is covered by `client/scripts/__tests__/precompress.test.cjs`, run by the repo
root `npm run test:scripts`.

Vite sets `emptyOutDir: true`, so every build starts from an empty `client/dist` and the script
re-runs over whatever vite just produced. A `.br` can never outlive the file it was made from.

## 3. Serve-time negotiation

`server/src/common/precompressed-static.ts`, wired at both ends:

- `server/src/main.ts`:
  `app.use(createPrecompressedStaticMiddleware(join(__dirname, 'public')))`
- `server/src/app.module.ts`:
  `serveStaticOptions: { setHeaders: precompressedCacheHeaders }`

**Manifest, built once at boot.** `buildPrecompressedManifest(root)` walks the static root and
records which variants exist, keyed by the URL path of the *original* file
(`/assets/index-abc.js` → `{ br: true, gz: true }`). Only originals whose own extension is on the
allowlist are recorded, which is what keeps `/static/hooks.tar.gz` — a shipped tarball that merely
ends in `.gz` — from registering a phantom `hooks.tar` entry. The walk never throws: a missing or
unreadable root yields an empty manifest, i.e. "no precompression available".

**Per request: O(1), no `stat`.** The middleware returns immediately for a non-`GET`/`HEAD`
method, a request carrying `Range`, an empty manifest, or a path that is not in the manifest — so
`/api/*`, `/health*` and `/static/*` are untouched. On a manifest hit it sets
`Vary: Accept-Encoding`, and if `pickEncoding()` returns an encoding it also sets
`Content-Encoding` and `Content-Type` and rewrites `req.url` to the `.br`/`.gz` file.
`express.static` then streams that file, computing `Content-Length` and `ETag` from the bytes it
actually sends.

`Vary` is set **even when the identity variant is served** — both deployed environments sit behind
an outer proxy, and without it a shared cache could hand `br` bytes to a client that cannot decode
them.

**`pickEncoding()`** honours an explicit `q=0` (`br;q=0, gzip` correctly yields gzip) and `*`, but
deliberately does not rank by relative q-values: `br` wins over `gzip` whenever both are
acceptable and available. Standard static-server behaviour, and it avoids a float-comparison edge
case for no practical gain.

**Why setting headers up-front composes with the stock stack** (verified at `send` 1.2.1 /
`serve-static` 2.2.1): `SendStream.prototype.send` calls `setHeader()` — which emits the `headers`
event that `serveStaticOptions.setHeaders` rides on — *before* `type()`, and both `type()` and
send's own `Cache-Control` default return early when the header is already present. So our
`Content-Type` and `Cache-Control` win and a `.br` file is never mislabelled
`application/octet-stream`.

**Why a `bootstrap()`-time `app.use()` is early enough:** `ServeStaticModule` registers its
`express.static` from `onModuleInit`, which Nest calls from `NestApplication.init()` — inside
`app.listen()`, after everything `app.use()`d in `bootstrap()`. The pre-existing
`X-Frame-Options` middleware in `main.ts` already relies on this same ordering.

**Content types are spelled out** in a `CONTENT_TYPES` map rather than delegated to
`mime.contentType()`, because `mime-types` is a *transitive* dependency of `send`/`serve-static`,
not a declared dependency of `server/package.json` — importing it from production code would be an
undeclared dependency; keep the table in step with `mime-types` by hand.

**Range requests fall through** to the identity file. Serving a byte range of a different
representation is legal but pointless here — nothing in the app range-requests JS/CSS.

## 4. Cache policy

`precompressedCacheHeaders(res, filePath)` sets
`Cache-Control: public, max-age=31536000, immutable` **only** when the served path contains an
`assets` segment. Everything else keeps its previous revalidating behaviour.

Scoped by path segment, not by "the filename looks hashed", because only vite's `assets/` output is
content-hashed. `index.html`, `/favicon.svg` and `/help/*.md` have stable names and must keep
revalidating — and the same rule keeps the `ServeStaticModule` SPA fallback
(`res.sendFile(indexFilePath)`, which also runs this hook) out of the immutable bucket. An
`immutable` `index.html` would pin users to a stale build.

## 5. Dev is a no-op

In dev the static root is `server/src/public`, which holds no client assets — vite serves the SPA
on `http://localhost:5173`. The manifest is therefore empty and the middleware returns on its
first line. Nothing about the dev loop changes, and `bun run dev` never runs the precompress step
(it hangs off `build` only).

The same follows for e2e: `playwright.config.ts` uses `baseURL: http://localhost:5173`, so the
Playwright suites never go through `ServeStaticModule` and cannot cover this behaviour.
The scenario stand serves the built bundle through `ServeStaticModule`, so it is what exercises it.

**`ServeStaticModule`'s error handler and `/api/*`.** The module also registers an Express error
handler that, for any path in its `exclude` list, drops the incoming error and calls
`next(new NotFoundException('Cannot <METHOD> <url>'))`. Any middleware that reports an error
through `next(err)` on an `/api/*` route would therefore surface as 404. This is why the body
parsers, gzip sniffer, session and passport middleware are wrapped in `throwMiddlewareErrors()` —
see `hook-api-versioning.md` → "Per-route body limits". The handler is absent from apps built with
`Test.createTestingModule()`, so the regular e2e suite cannot see it.

## 6. What is deliberately *not* served: `dist/releases/`

The downloadable release zips live at `/app/dist/releases` — a **sibling** of the served
`dist/public/` tree, never inside it. Nothing about static serving changes because of them:

- The `ServeStaticModule` `rootPath` is `join(__dirname, 'public')`, so a sibling directory is
  simply outside its reach. **The `exclude` list in `server/src/app.module.ts` is unchanged** —
  `releases/` needs no entry there, and adding one would be misleading.
- The precompression walk (`client/scripts/precompress.cjs`) runs over `client/dist` only, and the
  boot-time manifest walk (`buildPrecompressedManifest`) over the static root — neither ever sees
  the releases directory. A `.zip` is not on the `COMPRESSIBLE` allowlist anyway.
- The zips are reachable **only** through the signed, time-limited link redeemed at
  `GET /api/v1/releases/download`, which the existing `'/api{/*path}'` exclude entry already keeps
  out of static serving. A file-name guess against `/static/…` or `/…` returns the SPA fallback,
  never a bundle.

This placement is the security property, not an accident: inside `public/` these multi-hundred-MB
bundles would be handed to any anonymous visitor who guessed the file name. The directory is
resolved by `resolveReleasesDir()` (`server/src/releases/`).

## 7. Rejected alternatives

**In-container nginx** in front of the Node process (evaluated and rejected). It would have
given compression and caching for free, but it adds a proxy hop that breaks five things:

- Mode 1's local-caller gate (`server/src/auth/utils/localhost.util.ts`) would see the nginx
  address instead of the real caller.
- The per-IP login backoff (`server/src/auth/local.strategy.ts`) would collapse into one global
  bucket.
- It shifts the `TRUST_PROXY` hop count for every existing install.
- The 2500 MB ingest limit (`server/src/common/logs-body-limit.ts`) needs matching
  `client_max_body_size` / `proxy_request_buffering` care.
- It adds a process the cluster primary did not fork, which the `SystemInfoService`
  expected-vs-actual worker-count comparison reports as a fault.

**Runtime `compression` middleware.** It would compress the same immutable bytes on every request,
burning event-loop CPU in every cluster worker forever, and still get a worse ratio than an offline
brotli pass. Precompression is strictly better for content-addressed output.

**Compressing API responses** is a separate, still-open question — precompression cannot cover
dynamic payloads, and a `compression` middleware scoped to `/api` reintroduces per-request CPU and
interacts with the gzip request-body sniffing in `server/src/logs/gzip-sniff.middleware.ts`.
Deliberately out of scope here.
