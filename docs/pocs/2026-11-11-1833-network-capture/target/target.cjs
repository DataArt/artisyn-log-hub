'use strict';
// Target program for the tap: http.get, https.get, fetch, a raw TCP socket and a DNS lookup against a
// loopback server (and, with TARGET_EXTERNAL=1, against example.com). Prints deterministic output and
// exits with code 3, so tap-on and tap-off runs can be compared byte for byte.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');

const body = 'x'.repeat(5000);
const server = http.createServer((req, res) => {
  let n = 0;
  req.on('data', (c) => { n += c.length; });
  req.on('end', () => { res.setHeader('content-type', 'text/plain'); res.end(`${req.method} ${req.url} in=${n} ${body}`); });
});
const raw = net.createServer((s) => { s.end('raw-hello\n'); });

function get(url) {
  return new Promise((resolve) => {
    (url.startsWith('https') ? https : http).get(url, (res) => {
      let len = 0;
      res.on('data', (c) => { len += c.length; });
      res.on('end', () => resolve(`${res.statusCode} len=${len}`));
    }).on('error', (e) => resolve(`error ${e.code}`));
  });
}

server.listen(0, '127.0.0.1', () => raw.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const rawPort = raw.address().port;
  const out = [];
  out.push('http.get ' + await get(`http://127.0.0.1:${port}/a?token=secret`));
  const r = await fetch(`http://localhost:${port}/b`, { method: 'POST', body: 'y'.repeat(1234) });
  out.push(`fetch ${r.status} len=${(await r.text()).length}`);
  out.push('raw ' + await new Promise((resolve) => {
    const s = net.connect(rawPort, '127.0.0.1');
    let d = '';
    s.on('data', (c) => { d += c; });
    s.on('close', () => resolve(d.trim()));
  }));
  out.push('dns ' + await new Promise((resolve) => dns.lookup('localhost', (e) => resolve(e ? 'error' : 'ok'))));
  if (process.env.TARGET_EXTERNAL === '1') {
    const ext = [];
    ext.push('https.get ' + await get('https://example.com/?q=1'));
    try {
      const e = await fetch('https://example.org/path/x?y=2', { signal: AbortSignal.timeout(8000) });
      ext.push(`fetch ${e.status} len=${(await e.text()).length}`);
    } catch (e) { ext.push(`fetch error ${e.cause ? e.cause.code : e.name}`); }
    console.error('external: ' + ext.join('; ')); // stderr: external results vary by network
  }
  console.log(out.join('\n'));
  server.close();
  raw.close();
  process.exitCode = 3;
}));
