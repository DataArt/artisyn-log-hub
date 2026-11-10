#!/usr/bin/env node
// Minimal OTLP/HTTP JSON receiver for the PoC. Claude Code drops the `console` OTEL exporter when
// it runs with --output-format json/stream-json, so the session exports OTLP http/json here instead.
// Every POST body is appended as one line {receivedAt, path, body} to raw/otlp.jsonl.
// Usage: node otlp-receiver.cjs [port]   (default 4399, binds 127.0.0.1); stop with Ctrl+C / kill.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const port = Number(process.argv[2] || 4399);
const dir = path.join(__dirname, 'raw');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'otlp.jsonl');

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { parsed = { unparsed: body.slice(0, 2000) }; }
    fs.appendFileSync(out, `${JSON.stringify({ receivedAt: new Date().toISOString(), path: req.url, body: parsed })}\n`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => process.stderr.write(`otlp receiver on 127.0.0.1:${port}\n`));
