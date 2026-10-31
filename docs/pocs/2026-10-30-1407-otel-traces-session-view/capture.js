// Minimal OTLP/HTTP-JSON capture receiver for the PoC: accepts POST /v1/logs, /v1/metrics and
// /v1/traces on 127.0.0.1 and appends each request (with its arrival time) to out/<signal>.jsonl.
// It also serves the built prototype (GET /) and the newest trace (GET /spans) for live polling.
// It is a long-running server, so unlike the repo's hook scripts it is event-driven by necessity.
//
// Usage: node capture.js [port]   (default 4399; Ctrl+C to stop)
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { newestTraceForPage } = require('./otlp');

const port = Number(process.argv[2] || 4399);
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const SIGNALS = { '/v1/logs': 'logs', '/v1/metrics': 'metrics', '/v1/traces': 'traces' };

// GET / serves the built prototype; GET /spans returns the newest trace's spans so the page can
// poll it and redraw the waterfall as batches arrive (the near-realtime check).
function serveGet(route, res) {
  if (route === '' || route === '/otel-tabs.html') {
    const file = path.join(outDir, 'otel-tabs.html');
    if (!fs.existsSync(file)) return res.writeHead(404).end('run node build.js first');
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
  }
  if (route === '/spans') {
    const out = newestTraceForPage(path.join(outDir, 'traces.jsonl'), path.join(outDir, 'logs.jsonl'));
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ spans: out }));
  }
  return res.writeHead(404).end();
}

const server = http.createServer((req, res) => {
  const route = (req.url || '').split('?')[0].replace(/\/$/, '');
  if (req.method === 'GET') {
    serveGet(route, res);
    return;
  }
  const signal = SIGNALS[route];
  if (req.method !== 'POST' || !signal) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { unparsed: raw.slice(0, 200), contentType: req.headers['content-type'] };
    }
    const line = JSON.stringify({ receivedAt: new Date().toISOString(), body });
    fs.appendFileSync(path.join(outDir, `${signal}.jsonl`), line + '\n', 'utf8');
    process.stderr.write(`${new Date().toISOString()} ${signal} ${raw.length}B\n`);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`capture listening on 127.0.0.1:${port}\n`);
});
