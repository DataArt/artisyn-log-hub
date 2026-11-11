'use strict';
// PoC Node.js network tap, loaded with NODE_OPTIONS=--require <this file>.
// Observes only: diagnostics_channel subscribers plus `once` listeners on lifecycle events
// ('lookup', 'connect', 'secureConnect', 'close', 'end'). Never adds an 'error' listener (that would
// swallow errors the program expects to crash on), never reads a stream, never patches a module.
// Every callback is wrapped in try/catch: an exception thrown by a diagnostics_channel subscriber is
// re-thrown by Node on the next tick as an uncaughtException, so an unguarded bug here would crash
// the user's program (see README, Q2).
//
// Env:
//   LOGHUB_NET_TAP=0                 kill switch
//   LOGHUB_NET_TAP_DIR=<dir>         output dir (must exist; nothing is recorded otherwise)
//   LOGHUB_NET_TAP_LOOPBACK=1        PoC only: also record loopback (for offline tests)
//   LOGHUB_NET_TAP_MAX_RECORDS=500   per-process record cap
//   LOGHUB_NET_TAP_MAX_BYTES=262144  per-process file byte cap
//   LOGHUB_NET_TAP_TEST_THROW=guarded|raw   PoC only: inject a bug in every handler
//   LOGHUB_NET_TAP_SKIP=1            this process is Log Hub's own (hook helper): record nothing
//   LOGHUB_NET_TAP_SKIP_DIR=<dir>    record nothing when the main script lives under <dir> (hook install dir)
//   LOGHUB_NET_TAP_EXCLUDE=h[:p],..  destinations never recorded (the Log Hub server, the OTEL receiver)
//   LOGHUB_NET_TAP_SERVICE_AFTER_S=30  a process older than this is a long-running "service"
try {
  (function main() {
    const env = process.env;
    if (env.LOGHUB_NET_TAP === '0') return;
    const dir = env.LOGHUB_NET_TAP_DIR;
    if (!dir) return;
    if (env.LOGHUB_NET_TAP_SKIP === '1') return;
    const skipDir = env.LOGHUB_NET_TAP_SKIP_DIR;
    if (skipDir && process.argv[1]) {
      const norm = (p) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      if (norm(process.argv[1]).startsWith(norm(skipDir) + '/')) return;
    }

    const dc = require('node:diagnostics_channel');
    const fs = require('node:fs');
    const path = require('node:path');

    const MAX_RECORDS = Number(env.LOGHUB_NET_TAP_MAX_RECORDS) || 500;
    const MAX_BYTES = Number(env.LOGHUB_NET_TAP_MAX_BYTES) || 262144;
    const MAX_PATH = 256; // path excerpt; query string is never stored, only its length
    const KEEP_LOOPBACK = env.LOGHUB_NET_TAP_LOOPBACK === '1';
    const TEST_THROW = env.LOGHUB_NET_TAP_TEST_THROW || '';
    const SERVICE_AFTER_MS = (Number(env.LOGHUB_NET_TAP_SERVICE_AFTER_S) || 30) * 1000;
    const EXCLUDE = String(env.LOGHUB_NET_TAP_EXCLUDE || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    let listening = null; // first listen() of this process -> it is a service
    function role() {
      if (listening) return 'service';
      return process.uptime() * 1000 > SERVICE_AFTER_MS ? 'service' : 'script';
    }
    function excluded(host, port) {
      if (!EXCLUDE.length || !host) return false;
      const h = String(host).toLowerCase();
      return EXCLUDE.some((e) => e === h || e === h + ':' + port);
    }

    const now = () => performance.now();
    const t0Epoch = Date.now() - performance.now();

    let fd = -1;
    let disabled = false;
    let records = 0;
    let bytes = 0;
    let dropped = 0;
    let truncatedMarked = false;

    function open() {
      if (fd !== -1 || disabled) return fd !== -1;
      try {
        const name = `net-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
        fd = fs.openSync(path.join(dir, name), 'a');
        const head = JSON.stringify({
          t: 'proc', v: 1, pid: process.pid, ppid: process.ppid, node: process.version,
          script: process.argv[1] ? path.basename(process.argv[1]).slice(0, 128) : '(eval)',
          ts: Date.now(),
        }) + '\n';
        fs.writeSync(fd, head);
        bytes += Buffer.byteLength(head);
        return true;
      } catch {
        disabled = true; // unwritable dir: record nothing, forever, silently
        return false;
      }
    }

    function emit(rec) {
      if (disabled) return;
      if (rec.host && excluded(rec.host, rec.port)) return;
      rec.role = role();
      if (listening) rec.listenPort = listening.port;
      if (records >= MAX_RECORDS || bytes >= MAX_BYTES) {
        dropped++;
        if (!truncatedMarked && open()) {
          truncatedMarked = true;
          try { fs.writeSync(fd, JSON.stringify({ t: 'truncated', after: records, ts: Date.now() }) + '\n'); } catch { disabled = true; }
        }
        return;
      }
      if (!open()) return;
      const line = JSON.stringify(rec) + '\n';
      try {
        fs.writeSync(fd, line);
        records++;
        bytes += Buffer.byteLength(line);
      } catch { disabled = true; }
    }

    process.on('exit', () => {
      try { if (dropped > 0 && fd !== -1) fs.writeSync(fd, JSON.stringify({ t: 'summary', recorded: records, dropped }) + '\n'); } catch { /* ignore */ }
      try { if (fd !== -1) fs.closeSync(fd); } catch { /* ignore */ }
    });

    function safe(fn) {
      return function guarded(msg, name) {
        try {
          if (TEST_THROW === 'guarded') throw new Error('tap bug (test)');
          fn(msg, name);
        } catch { /* fail open */ }
      };
    }
    function sub(name, fn) {
      if (TEST_THROW === 'raw') { dc.subscribe(name, () => { throw new Error('tap bug (test, raw)'); }); return; }
      dc.subscribe(name, safe(fn));
    }

    function isLoopback(host) {
      if (KEEP_LOOPBACK || !host) return false;
      const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
      return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' ||
        /^127\./.test(h) || /^::ffff:127\./.test(h);
    }
    const ms = (a, b) => (a != null && b != null ? Math.round((b - a) * 10) / 10 : undefined);
    function splitPath(p) {
      const s = String(p || '/');
      const q = s.indexOf('?');
      const bare = q === -1 ? s : s.slice(0, q);
      return { path: bare.length > MAX_PATH ? bare.slice(0, MAX_PATH) : bare, pathLen: bare.length, qLen: q === -1 ? 0 : s.length - q - 1 };
    }

    // ---- listen: a process that serves a port is a "service" (dev server, backend, watcher) ----
    sub('tracing:net.server.listen:asyncEnd', ({ server }) => {
      if (listening) return;
      const a = server && server.address && server.address();
      listening = { port: a && typeof a === 'object' ? a.port : undefined };
      // no record of its own: a listen-only process must not create a file
    });

    // ---- sockets: connect / dns / tls phases, raw socket records ----
    const sockInfo = new WeakMap(); // socket -> { start, lookup, connect, tls, host, port, used }
    sub('net.client.socket', ({ socket }) => {
      const info = { start: now(), used: false };
      sockInfo.set(socket, info);
      socket.once('lookup', safe((err, address, family, host) => { info.lookup = now(); info.host = info.host || host; info.addr = address; }));
      socket.once('connect', safe(() => { info.connect = now(); info.addr = info.addr || socket.remoteAddress; info.port = socket.remotePort; }));
      socket.once('secureConnect', safe(() => { info.tls = now(); info.host = info.host || socket.servername; }));
      socket.once('close', safe(() => {
        if (info.used) return; // reported as http/fetch
        const host = info.host || socket.servername || info.addr || socket.remoteAddress;
        if (isLoopback(host) || isLoopback(info.addr)) return;
        if (!host && !info.addr) return; // e.g. a pipe / unix socket
        emit({
          t: 'socket', ts: Math.round(t0Epoch + info.start), host, port: info.port, tls: info.tls != null,
          bytesIn: socket.bytesRead, bytesOut: socket.bytesWritten, durMs: ms(info.start, now()),
          phases: { dns: ms(info.start, info.lookup), connect: ms(info.lookup ?? info.start, info.connect), tls: ms(info.connect, info.tls) },
        });
      }));
    });

    function phasesFor(socket, reqStart) {
      const i = socket && sockInfo.get(socket);
      if (!i) return { reused: true };
      i.used = true;
      if (i.start < reqStart - 1) return { reused: true }; // keep-alive socket opened earlier
      return { dns: ms(i.start, i.lookup), connect: ms(i.lookup ?? i.start, i.connect), tls: ms(i.connect, i.tls) };
    }

    // ---- http / https client ----
    const reqInfo = new WeakMap();
    // `created` (newer Node) fires before the socket is made, `start` after; take the earliest.
    const onReq = ({ request }) => {
      if (reqInfo.has(request)) return;
      const host = request.host || (request.getHeader && request.getHeader('host'));
      if (isLoopback(host)) return;
      reqInfo.set(request, { start: now() });
    };
    sub('http.client.request.created', onReq);
    sub('http.client.request.start', onReq);
    sub('http.client.response.finish', ({ request, response }) => {
      const info = reqInfo.get(request);
      if (!info) return;
      info.ttfb = now();
      const sock = request.socket;
      const in0 = sock ? sock.bytesRead : 0;
      const out = sock ? sock.bytesWritten : undefined;
      const done = safe(() => {
        if (info.done) return;
        info.done = true;
        const end = now();
        const p = splitPath(request.path);
        emit({
          t: 'http', ts: Math.round(t0Epoch + info.start), method: request.method,
          scheme: request.protocol ? request.protocol.replace(':', '') : undefined,
          host: request.host, port: sock ? sock.remotePort : undefined, ...p,
          status: response.statusCode,
          bytesIn: sock ? sock.bytesRead : undefined, bytesInAtHeaders: in0, bytesOut: out,
          durMs: ms(info.start, end),
          phases: { ...phasesFor(sock, info.start), ttfb: ms(info.start, info.ttfb), transfer: ms(info.ttfb, end) },
        });
      });
      response.once('end', done);
      response.once('close', done);
    });
    sub('http.client.request.error', ({ request, error }) => {
      const info = reqInfo.get(request);
      if (!info || info.done) return;
      info.done = true;
      const p = splitPath(request.path);
      emit({ t: 'http', ts: Math.round(t0Epoch + info.start), method: request.method, host: request.host, ...p, status: 'error', err: error && (error.code || error.name), durMs: ms(info.start, now()) });
    });

    // ---- fetch (undici) ----
    const fInfo = new WeakMap();
    sub('undici:request:create', ({ request }) => {
      let host;
      try { host = new URL(request.origin).hostname; } catch { host = String(request.origin); }
      if (isLoopback(host)) return;
      fInfo.set(request, { start: now(), host, bytesIn: 0 });
    });
    sub('undici:client:sendHeaders', ({ request, socket }) => {
      const i = fInfo.get(request);
      if (i) { i.socket = socket; i.sent = now(); i.out0 = socket.bytesWritten; i.in0 = socket.bytesRead; }
    });
    sub('undici:request:headers', ({ request, response }) => {
      const i = fInfo.get(request);
      if (i) { i.ttfb = now(); i.status = response.statusCode; }
    });
    sub('undici:request:bodyChunkReceived', ({ request, chunk }) => {
      const i = fInfo.get(request);
      if (i && chunk) i.bytesIn += chunk.length;
    });
    function fetchDone(request, err) {
      const i = fInfo.get(request);
      if (!i || i.done) return;
      i.done = true;
      const end = now();
      let port;
      try { const u = new URL(request.origin); port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { /* ignore */ }
      emit({
        t: 'fetch', ts: Math.round(t0Epoch + i.start), method: request.method,
        scheme: String(request.origin).split(':')[0], host: i.host, port, ...splitPath(request.path),
        status: err ? 'error' : i.status, err: err ? (err.code || err.name) : undefined,
        // wire bytes (headers + body) from the socket delta: works on every version; bodyBytes needs
        // undici:request:bodyChunkReceived (Node >= 24), else unknown (never 0)
        bytesIn: i.socket ? i.socket.bytesRead - (i.in0 || 0) : undefined, bodyBytes: i.bytesIn || undefined, bytesOut: i.socket ? i.socket.bytesWritten - (i.out0 || 0) : undefined,
        durMs: ms(i.start, end),
        phases: { ...phasesFor(i.socket, i.start), ttfb: ms(i.start, i.ttfb), transfer: ms(i.ttfb, end) },
      });
    }
    sub('undici:request:trailers', ({ request }) => fetchDone(request));
    sub('undici:request:error', ({ request, error }) => fetchDone(request, error || {}));
  })();
} catch { /* fail open: a broken tap must never stop the program */ }
