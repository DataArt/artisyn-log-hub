'use strict';
// Load generator: node bench.cjs <count> <http|fetch> [concurrency]
// Runs <count> requests against an in-process loopback server and prints {"ms":...} on stdout.
const http = require('node:http');

const count = Number(process.argv[2]) || 1000;
const mode = process.argv[3] || 'http';
const conc = Number(process.argv[4]) || 1;

const server = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('ok')); });
const agent = new http.Agent({ keepAlive: true, maxSockets: conc });

function one(port, i) {
  if (mode === 'fetch') return fetch(`http://127.0.0.1:${port}/r/${i}?q=${i}`).then((r) => r.text());
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/r/${i}?q=${i}`, agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  await one(port, -1); // warm-up
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < count) await one(port, next++);
  }));
  const ms = performance.now() - t0;
  agent.destroy();
  server.close();
  console.log(JSON.stringify({ mode, count, conc, ms: Math.round(ms) }));
});
