'use strict';
// Probe: which diagnostics_channel names fire for http / fetch / net / tls / dns in this Node
// version, and which payload keys they carry. Run: node probe-channels.cjs
const dc = require('node:diagnostics_channel');
const http = require('node:http');
const dns = require('node:dns');

const candidates = [
  'http.client.request.created', 'http.client.request.start', 'http.client.request.error',
  'http.client.response.finish',
  'undici:request:create', 'undici:request:bodySent', 'undici:request:headers',
  'undici:request:trailers', 'undici:request:error', 'undici:client:sendHeaders',
  'undici:client:beforeConnect', 'undici:client:connected', 'undici:client:connectError',
  'undici:request:bodyChunkSent', 'undici:request:bodyChunkReceived',
  'net.client.socket', 'net.server.socket', 'tls.client.socket',
  'tracing:net.client.connect:start', 'tracing:net.client.connect:end',
  'tracing:net.server.listen:asyncStart', 'tracing:net.server.listen:asyncEnd',
  'tracing:dns.lookup:start', 'tracing:dns.lookup:end', 'dns.lookup',
];
const seen = {};
for (const name of candidates) {
  dc.subscribe(name, (msg) => {
    const keys = msg && typeof msg === 'object' ? Object.keys(msg) : [];
    seen[name] = (seen[name] || { n: 0, keys });
    seen[name].n++;
  });
}

const server = http.createServer((req, res) => { res.end('hello'); });
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  await new Promise((r) => http.get(`http://127.0.0.1:${port}/a`, (res) => { res.resume(); res.on('end', r); }));
  await fetch(`http://127.0.0.1:${port}/b`).then((r) => r.text());
  await new Promise((r) => dns.lookup('localhost', () => r()));
  let ext = 'skipped';
  try {
    const r = await fetch('https://example.com/', { signal: AbortSignal.timeout(5000) });
    await r.text();
    ext = `ok ${r.status}`;
  } catch (e) { ext = `failed: ${e.cause ? e.cause.code : e.name}`; }
  server.close();
  console.log(`node ${process.version}; external fetch: ${ext}`);
  for (const name of candidates) {
    console.log(`${seen[name] ? 'FIRED ' + seen[name].n : 'never  '}\t${name}\t${seen[name] ? seen[name].keys.join(',') : ''}`);
  }
});
