// PoC runner: real `claude -p` sessions against a mock OTLP/HTTP collector.
// Usage: node run.mjs --work-dir <empty-or-missing dir outside the repo> [--model haiku] [--only a,b]
//        [--managed-path <file>]   (only for --only managed; elevated shell required)
// The work dir gets one sub-folder per experiment (sample project + settings); nothing is deleted.
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const workDir = path.resolve(arg('--work-dir', ''));
const model = arg('--model', 'haiku');
const only = arg('--only', '');

function assertSafeWorkDir(dir) {
  const repo = path.resolve(here, '..', '..', '..');
  const norm = (p) => path.resolve(p).toLowerCase() + path.sep;
  if (!arg('--work-dir', '')) throw new Error('--work-dir is required');
  if (path.parse(dir).root === dir) throw new Error('refusing a drive root');
  if (norm(dir) === norm(os.homedir()) || norm(os.homedir()).startsWith(norm(dir))) throw new Error('refusing the home dir or its ancestor');
  if (norm(dir).startsWith(norm(repo)) || norm(repo).startsWith(norm(dir))) throw new Error('refusing the repo, a folder in it or its ancestor');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new Error('work dir must be empty or missing');
}

// ---------- mock collector ----------
function walk(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.key === 'string' && node.value && typeof node.value === 'object') {
    const v = node.value.stringValue ?? node.value.intValue ?? node.value.boolValue ?? node.value.doubleValue;
    (out[node.key] ||= new Set()).add(String(v));
  }
  for (const k of Object.keys(node)) walk(node[k], out);
}

function resourceKeys(json) {
  const keys = new Set();
  for (const top of ['resourceLogs', 'resourceMetrics', 'resourceSpans']) {
    for (const r of json[top] || []) for (const a of r.resource?.attributes || []) keys.add(`${a.key}=${a.value?.stringValue ?? ''}`);
  }
  return [...keys];
}

function startCollector() {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') { try { buf = zlib.gunzipSync(buf); } catch { /* keep raw */ } }
      const t = Date.now();
      if (req.url === '/hook') {
        events.push({ t, kind: 'hook', ...JSON.parse(buf.toString('utf8')) });
      } else {
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* protobuf or garbage */ }
        const attrs = {};
        if (json) walk(json, attrs);
        events.push({
          t, kind: 'otlp', path: req.url, contentType: req.headers['content-type'],
          authHeader: req.headers['x-poc-auth'] ?? null,
          sessionIds: [...(attrs['session.id'] || [])], resource: json ? resourceKeys(json) : [],
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, events, port: server.address().port })));
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---------- sample session ----------
function otelEnv(port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'otlp', OTEL_TRACES_EXPORTER: 'otlp',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${base}/v1/metrics`,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
    OTEL_METRIC_EXPORT_INTERVAL: '1000', OTEL_LOGS_EXPORT_INTERVAL: '500', OTEL_TRACES_EXPORT_INTERVAL: '500',
  };
}

function hookCmd(hookPort) {
  const h = { type: 'command', command: `node "${path.join(here, 'hook.mjs')}" ${hookPort}` };
  const ev = {};
  for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) ev[name] = [{ hooks: [h] }];
  return ev;
}

function runClaude(projectDir, flagSettingsFile) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('OTEL_') || k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
    const t0 = Date.now();
    const cmd = `claude -p "Reply with the single word: ok" --model ${model} --setting-sources project,local --settings "${flagSettingsFile}"`;
    const child = spawn(cmd, { cwd: projectDir, env, shell: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, ms: Date.now() - t0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function experiment(name, { flag, local }, opts = {}) {
  const dir = path.join(workDir, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const flagFile = path.join(dir, 'flag-settings.json');
  fs.writeFileSync(flagFile, JSON.stringify(flag, null, 2));
  if (local) fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(local, null, 2));
  const before = opts.collector.events.length;
  const run = await runClaude(dir, flagFile);
  await new Promise((r) => setTimeout(r, opts.drainMs ?? 3000));
  return { name, run, events: opts.collector.events.slice(before) };
}

function summarize(r) {
  const hooks = r.events.filter((e) => e.kind === 'hook');
  const otlp = r.events.filter((e) => e.kind === 'otlp');
  const start = hooks.find((h) => h.event === 'SessionStart');
  const stops = hooks.filter((h) => h.event === 'Stop');
  const lastStop = stops[stops.length - 1];
  const sid = start?.sessionId;
  const mine = otlp.filter((e) => !sid || e.sessionIds.includes(sid) || e.sessionIds.length === 0);
  const bySignal = (p) => mine.filter((e) => e.path?.includes(p));
  const firstOf = (list) => (list.length ? list[0].t : null);
  return {
    name: r.name, exit: r.run.code, ms: r.run.ms, stdout: r.run.stdout.slice(0, 200), stderr: r.run.stderr.slice(0, 2000),
    hookEvents: hooks.map((h) => h.event),
    otlpRequests: { logs: bySignal('logs').length, metrics: bySignal('metrics').length, traces: bySignal('traces').length },
    firstOtlpVsSessionStartMs: start && mine.length ? firstOf(mine) - start.t : null,
    otlpBeforeSessionStart: start ? mine.filter((e) => e.t < start.t).length : null,
    otlpAfterLastStop: lastStop ? { logs: bySignal('logs').filter((e) => e.t > lastStop.t).length,
      metrics: bySignal('metrics').filter((e) => e.t > lastStop.t).length,
      traces: bySignal('traces').filter((e) => e.t > lastStop.t).length } : null,
    resourceAttrs: [...new Set(otlp.flatMap((e) => e.resource))].filter((a) => /artisyn|service\.name/.test(a)),
    artisynAttrBySignal: Object.fromEntries(['logs', 'metrics', 'traces'].map((s) => [s,
      bySignal(s).length ? bySignal(s).every((e) => e.resource.some((a) => a.startsWith('artisyn.repo='))) : null])),
    authHeaders: [...new Set(otlp.map((e) => e.authHeader).filter(Boolean))],
  };
}

// ---------- managed settings (FR-F1 item 3) ----------
// Writes the OS-level managed-settings.json (policy scope, applies to every Claude Code session on
// the machine while it exists), runs one session per variant, and deletes ONLY that file again.
// Refuses to run when the file already exists (never overwrites an admin's real policy). The
// folder it may create (e.g. C:\Program Files\ClaudeCode) is left in place and printed.
function defaultManagedPath() {
  if (process.platform === 'win32') return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

async function runManaged(userCollector) {
  const managedPath = path.resolve(arg('--managed-path', defaultManagedPath()));
  if (fs.existsSync(managedPath)) throw new Error(`refusing: ${managedPath} already exists (a real policy?)`);
  const managedDir = path.dirname(managedPath);
  const createdDir = !fs.existsSync(managedDir);
  try {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(managedPath, '{}', { flag: 'wx' });
    fs.unlinkSync(managedPath);
  } catch (e) {
    throw new Error(`cannot write ${managedPath} (${e.code || e.message}) — run this from an elevated (Administrator) shell`);
  }

  const managedCollector = await startCollector();
  const mPort = managedCollector.port;
  const uPort = userCollector.port;
  const base = `http://127.0.0.1:${mPort}`;
  // Each variant: what the managed file sets; the flag (non-managed) scope always carries the full
  // Artisyn-style env pointing at the "user" collector.
  const variants = [
    { name: 'managed-endpoint', env: otelEnv(mPort) },
    { name: 'managed-logs-endpoint-only', env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs` } },
    { name: 'managed-disabled', env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0' } },
    { name: 'managed-exporters-none', env: { OTEL_LOGS_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none' } },
  ];
  const out = [];
  const cleanup = () => { try { fs.unlinkSync(managedPath); } catch { /* already gone */ } };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  try {
    for (const v of variants) {
      fs.writeFileSync(managedPath, JSON.stringify({ env: v.env }, null, 2), { flag: 'wx' });
      const uBefore = userCollector.events.length;
      const mBefore = managedCollector.events.length;
      const r = await experiment(v.name, { flag: { env: otelEnv(uPort), hooks: hookCmd(uPort) } }, { collector: userCollector });
      cleanup();
      const count = (events) => {
        const otlp = events.filter((e) => e.kind === 'otlp');
        return Object.fromEntries(['logs', 'metrics', 'traces'].map((s) => [s, otlp.filter((e) => e.path?.includes(s)).length]));
      };
      out.push({
        name: v.name, managedEnv: v.env, exit: r.run.code, ms: r.run.ms,
        stdout: r.run.stdout.slice(0, 200), stderr: r.run.stderr.slice(0, 2000),
        hookEvents: userCollector.events.slice(uBefore).filter((e) => e.kind === 'hook').map((h) => h.event),
        toUserCollector: count(userCollector.events.slice(uBefore)),
        toManagedCollector: count(managedCollector.events.slice(mBefore)),
      });
    }
  } finally {
    cleanup();
    managedCollector.server.close();
    if (createdDir) console.error(`note: created ${managedDir} (now empty) — remove it yourself if you do not need it`);
  }
  return out;
}

async function main() {
  assertSafeWorkDir(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const collector = await startCollector();
  const port = collector.port;
  const results = [];
  const want = (n) => !only || only.split(',').includes(n);
  const helper = path.join(here, 'headers-helper.cmd');

  // 1. Baseline + routing attribute from project scope + unknown top-level key in settings.
  if (want('baseline')) results.push(await experiment('baseline', {
    flag: { env: otelEnv(port), hooks: hookCmd(port), _artisynOtel: { note: 'poc: unknown top-level key', previous: { x: 1 } } },
    local: { env: { OTEL_RESOURCE_ATTRIBUTES: 'artisyn.repo=poc-local' }, _artisynOtel: { note: 'poc' } },
  }, { collector }));

  // 2. Positive control: a known key with a wrong type — does -p surface settings errors at all?
  if (want('invalid')) results.push(await experiment('invalid-known-key', {
    flag: { env: otelEnv(port), hooks: hookCmd(port), cleanupPeriodDays: 'not-a-number' },
  }, { collector }));

  // 3. Endpoint with nothing listening — silent? slower?
  if (want('deadport')) {
    const dead = await freePort();
    results.push(await experiment('dead-port', { flag: { env: otelEnv(dead), hooks: hookCmd(port) } }, { collector }));
  }

  // 4. otelHeadersHelper — does Claude Code send the helper's headers to the endpoint it exports to?
  if (want('helper')) results.push(await experiment('headers-helper', {
    flag: { env: otelEnv(port), hooks: hookCmd(port), otelHeadersHelper: `"${helper}"` },
  }, { collector }));

  // 5. Managed settings (FR-F1 item 3) — needs an elevated shell, see runManaged().
  const managed = want('managed') ? await runManaged(collector) : [];

  collector.server.close();
  const out = [...results.map(summarize), ...managed];
  fs.mkdirSync(path.join(here, 'results'), { recursive: true });
  fs.writeFileSync(path.join(here, 'results', `run-${Date.now()}.json`), JSON.stringify({ claude: 'see README', results: out }, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
