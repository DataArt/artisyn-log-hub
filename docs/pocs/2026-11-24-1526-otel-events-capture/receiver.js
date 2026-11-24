'use strict';
// Minimal OTLP/HTTP-JSON receiver: appends every POST body to <out>/raw.ndjson as
// {"ts","path","body"} and answers 200 {}. It stands in for the hook's receiver, which forwards
// the same lines unchanged. An HTTP server is callback-based by nature — the only async code here.
// Usage: node receiver.js --port <port> --out <dir>
const fs = require('fs');
const http = require('http');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const port = Number(arg('--port'));
const outDir = arg('--out');
if (!port || !outDir) {
  process.stderr.write('usage: node receiver.js --port <port> --out <dir>\n');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'raw.ndjson');

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { unparsed: text.slice(0, 2000) };
    }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), path: req.url, body }) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => {
  process.stderr.write(`receiver listening on 127.0.0.1:${port}, writing ${file}\n`);
});
