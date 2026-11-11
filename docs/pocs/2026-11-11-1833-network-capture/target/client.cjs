'use strict';
// node client.cjs <url>[,<url>...] [delayMs] [listen]
// Waits delayMs, optionally starts a server (like a dev server), fetches every URL, prints statuses.
const http = require('node:http');

const urls = (process.argv[2] || '').split(',').filter(Boolean);
const delay = Number(process.argv[3]) || 0;
const listen = process.argv[4] === 'listen';

async function main() {
  let server;
  if (listen) server = await new Promise((r) => { const s = http.createServer((q, a) => a.end('dev')).listen(0, '127.0.0.1', () => r(s)); });
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const out = [];
  for (const u of urls) out.push(await fetch(u).then((r) => r.text().then(() => r.status), (e) => 'error ' + e.name));
  console.log(out.join(' '));
  if (server) server.close();
}
main();
