'use strict';

// Writes `.br` (brotli) + `.gz` (gzip) siblings next to every compressible file in
// the built client output, so the server can serve a precompressed variant instead
// of compressing the same immutable bytes on every request.
//
// Wired into `client/package.json` → "build" rather than into the repo-root
// `scripts/` dir on purpose: Docker's `client-build` stage only receives
// `COPY client/ ./client/`, so a root-level script would be invisible there and
// would need a second call site to keep in sync. Hanging it off client's own
// "build" gives exactly one call site that every build path already goes through
// (local `npm run build:client`, and the Docker `RUN cd client && bun run build`).
//
// Counterpart on the serve side: `server/src/common/precompressed-static.ts`.
// The extension allowlist below and that file's content-type map must stay in sync.
//
// Conventions per the `nodejs-script` skill: CommonJS (`.cjs` because
// client/package.json is `"type": "module"`), synchronous I/O, built-ins only,
// diagnostics to stderr, explicit exit codes.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Text-ish outputs vite can emit. Deliberately excludes anything already
// compressed (.woff2, .png, .tgz, ...) — and, by construction, excludes .br/.gz
// too, so a second consecutive run never produces `foo.js.br.br`.
const COMPRESSIBLE = new Set([
  '.js',
  '.css',
  '.html',
  '.svg',
  '.json',
  '.md',
  '.txt',
  '.map',
  '.wasm',
]);

// Below this size the per-request header/framing overhead of a separate variant
// outweighs the saving.
const MIN_BYTES = 1024;

// A variant is kept only if it is at least this much smaller than the original.
// Expressed as an integer percentage and compared with integer arithmetic so the
// boundary case (exactly 10% smaller) is exact — `raw * 0.1` is not.
const MIN_GAIN_PERCENT = 10;

// q11 buys a further 1.6% for +3.9s on every build (measured on the current
// 22-file set); q10 is the better trade. gzip stays at 9 — the whole set costs
// 110ms there.
const BROTLI_QUALITY = 10;
const GZIP_LEVEL = 9;

function isCompressible(name) {
  return COMPRESSIBLE.has(path.extname(name).toLowerCase());
}

function worthKeeping(rawSize, outSize) {
  return (rawSize - outSize) * 100 >= rawSize * MIN_GAIN_PERCENT;
}

/** Absolute paths of every compressible file under `dir`, recursively. */
function listCompressible(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listCompressible(full));
    } else if (entry.isFile() && isCompressible(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function precompress(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`target directory not found: ${dir}`);
  }

  const candidates = listCompressible(dir);
  const result = {
    scanned: candidates.length,
    files: 0,
    rawBytes: 0,
    brBytes: 0,
    gzBytes: 0,
  };

  for (const file of candidates) {
    const buf = fs.readFileSync(file);
    if (buf.length < MIN_BYTES) continue;

    const br = zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    const gz = zlib.gzipSync(buf, { level: GZIP_LEVEL });

    const keepBr = worthKeeping(buf.length, br.length);
    const keepGz = worthKeeping(buf.length, gz.length);
    if (!keepBr && !keepGz) continue;

    if (keepBr) {
      fs.writeFileSync(`${file}.br`, br);
      result.brBytes += br.length;
    }
    if (keepGz) {
      fs.writeFileSync(`${file}.gz`, gz);
      result.gzBytes += gz.length;
    }
    result.files += 1;
    result.rawBytes += buf.length;
  }

  return result;
}

function kb(bytes) {
  return `${Math.round(bytes / 1024)} KB`;
}

module.exports = {
  COMPRESSIBLE,
  MIN_BYTES,
  MIN_GAIN_PERCENT,
  isCompressible,
  worthKeeping,
  listCompressible,
  precompress,
};

if (require.main === module) {
  try {
    const target = process.argv[2]
      ? path.resolve(process.argv[2])
      : path.resolve(__dirname, '..', 'dist');
    const startedAt = Date.now();
    const r = precompress(target);
    process.stderr.write(
      `precompress: ${r.files}/${r.scanned} files, ` +
        `raw ${kb(r.rawBytes)} → br ${kb(r.brBytes)} / gz ${kb(r.gzBytes)} ` +
        `in ${Date.now() - startedAt} ms\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`precompress error: ${err.message}\n`);
    process.exit(1);
  }
}
