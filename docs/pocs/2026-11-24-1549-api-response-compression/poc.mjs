// PoC for Part B of task 2026-11-24-traffic-optimization: how to gzip large JSON API answers on
// Express 5 (the server's version). Compares
//   A) the `compression` middleware (1.8.2), and
//   B) a small in-house middleware that wraps `res.json` (Nest replies plain objects via res.json)
//      and gzips with async `zlib.gzip` (thread pool, not the event loop).
// Prints PASS/FAIL per check and size/time numbers for a ~9 MB OTEL-like answer.
import http from 'node:http';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import express from 'express';
import compression from 'compression';

const gzipAsync = promisify(zlib.gzip);
const THRESHOLD = 8 * 1024;

/** An OTEL-like answer: spans dominate, ~9 MB of JSON. */
function bigOtelLike() {
  const spans = [];
  for (let i = 0; i < 6264; i++) {
    spans.push({
      traceId: (i * 7919).toString(16).padStart(32, '0'),
      spanId: (i * 104729).toString(16).padStart(16, '0'),
      parentSpanId: i % 5 === 0 ? null : ((i - 1) * 104729).toString(16).padStart(16, '0'),
      name: ['claude_code.llm_request', 'claude_code.tool', 'claude_code.interaction'][i % 3],
      startTimeUnixNano: String(1764000000000000000n + BigInt(i) * 1000000n),
      endTimeUnixNano: String(1764000000000000000n + BigInt(i) * 1000000n + 523000n),
      attributes: {
        'session.id': '9fc6b5cc-0000-4000-8000-000000000000',
        tool_name: ['Bash', 'Read', 'Edit', 'Grep'][i % 4],
        input_tokens: 1000 + (i % 977),
        output_tokens: 50 + (i % 311),
        cache_read_tokens: 20000 + (i % 4099),
        model: 'claude-opus-5-5',
        'prompt.id': `p-${i % 400}`,
        extra: 'x'.repeat(900 + (i % 400)),
      },
    });
  }
  return { spans, calls: [], interval: 'auto' };
}
const BIG = bigOtelLike();
const BIG_JSON = JSON.stringify(BIG);

/** Same rule as the server's `acceptsGzip`: gzip listed and not `q=0`. */
function acceptsGzip(req) {
  const h = String(req.headers['accept-encoding'] ?? '');
  return h.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    if (name.trim().toLowerCase() !== 'gzip' && name.trim() !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

/** Variant B: wrap res.json for /api paths. */
function jsonGzip({ threshold }) {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.vary('Accept-Encoding');
      if (res.getHeader('Content-Encoding') || !acceptsGzip(req)) return originalJson(body);
      const text = JSON.stringify(body);
      if (text === undefined || Buffer.byteLength(text) < threshold) return originalJson(body);
      gzipAsync(text).then(
        (gz) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', String(gz.length));
          res.end(gz);
        },
        (err) => next(err),
      );
      return res;
    };
    next();
  };
}

function routes(app) {
  app.get('/api/big', (_req, res) => res.json(BIG));
  app.get('/api/small', (_req, res) => res.json({ ok: true }));
  app.get('/api/pregz', (_req, res) => {
    const gz = zlib.gzipSync(JSON.stringify({ part: 'x'.repeat(50000) }));
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(gz);
  });
  app.get('/api/stream', (_req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    let n = 0;
    const t = setInterval(() => {
      res.write(JSON.stringify({ n, pad: 'y'.repeat(4000) }) + '\n');
      if (++n === 5) {
        clearInterval(t);
        res.end();
      }
    }, 20);
  });
  app.get('/static.json', (_req, res) => res.json({ pad: 'z'.repeat(50000) }));
}

const appA = express();
appA.use(
  compression({
    threshold: THRESHOLD,
    filter: (req, res) =>
      req.path.startsWith('/api/') && String(res.getHeader('Content-Type') ?? '').startsWith('application/json'),
  }),
);
routes(appA);
const appB = express();
appB.use(jsonGzip({ threshold: THRESHOLD }));
routes(appB);

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return server;
}

function get(port, path, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const headers = acceptEncoding === undefined ? {} : { 'Accept-Encoding': acceptEncoding };
    const started = process.hrtime.bigint();
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks = [];
        let firstChunkMs = null;
        res.on('data', (c) => {
          if (firstChunkMs === null) firstChunkMs = Number(process.hrtime.bigint() - started) / 1e6;
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            enc: res.headers['content-encoding'] ?? 'identity',
            vary: res.headers['vary'] ?? '',
            wire: Buffer.concat(chunks),
            ms: Number(process.hrtime.bigint() - started) / 1e6,
            firstChunkMs,
          }),
        );
      })
      .on('error', reject);
  });
}

function decode(r) {
  if (r.enc === 'gzip') return zlib.gunzipSync(r.wire);
  if (r.enc === 'br') return zlib.brotliDecompressSync(r.wire);
  if (r.enc === 'deflate') return zlib.inflateSync(r.wire);
  return r.wire;
}

const line = (v, name, ok, detail) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${v} ${name}  ${detail}`);

async function run(v, app) {
  const server = await listen(app);
  const port = server.address().port;
  for (const ae of ['gzip, deflate, br', 'gzip']) {
    let maxLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 5);
      last = now;
    }, 5);
    const r = await get(port, '/api/big', ae);
    clearInterval(probe);
    const plain = decode(r);
    const same = plain.toString() === BIG_JSON;
    line(v, `big AE="${ae}"`, r.enc === 'gzip' && same && /Accept-Encoding/i.test(r.vary),
      `enc=${r.enc} vary="${r.vary}" plain=${plain.length} wire=${r.wire.length} ratio=${(plain.length / r.wire.length).toFixed(1)}x total=${r.ms.toFixed(0)}ms maxLoopLag=${maxLag.toFixed(1)}ms identicalJson=${same}`);
  }
  {
    const r = await get(port, '/api/big', undefined);
    line(v, 'big no-AE', r.enc === 'identity' && /Accept-Encoding/i.test(r.vary), `enc=${r.enc} vary="${r.vary}" wire=${r.wire.length}`);
  }
  {
    const r = await get(port, '/api/big', 'gzip;q=0, identity');
    line(v, 'big gzip;q=0', r.enc === 'identity', `enc=${r.enc}`);
  }
  {
    const r = await get(port, '/api/small', 'gzip');
    line(v, 'small<threshold', r.enc === 'identity', `enc=${r.enc} vary="${r.vary}" wire=${r.wire.length}`);
  }
  {
    const r = await get(port, '/api/pregz', 'gzip');
    let ok = false;
    try {
      ok = JSON.parse(zlib.gunzipSync(r.wire).toString()).part.length === 50000;
    } catch {
      ok = false;
    }
    line(v, 'pre-gzipped', r.enc === 'gzip' && ok, `enc=${r.enc} singleGunzipParses=${ok}`);
  }
  {
    const r = await get(port, '/api/stream', 'gzip');
    line(v, 'streamed ndjson', r.enc === 'identity' && r.firstChunkMs < r.ms - 40,
      `enc=${r.enc} firstChunk=${r.firstChunkMs.toFixed(0)}ms total=${r.ms.toFixed(0)}ms`);
  }
  {
    const r = await get(port, '/static.json', 'gzip');
    line(v, 'non-/api', r.enc === 'identity', `enc=${r.enc}`);
  }
  server.close();
}

await run('A(compression)', appA);
await run('B(res.json wrap)', appB);

const s = Buffer.from(BIG_JSON);
for (const level of [6, 1]) {
  const t = performance.now();
  const gz = zlib.gzipSync(s, { level });
  console.log(`INFO  gzip level=${level} plain=${s.length} gz=${gz.length} ${(performance.now() - t).toFixed(0)}ms (this machine)`);
}
