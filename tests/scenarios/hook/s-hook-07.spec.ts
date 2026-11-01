// S-HOOK-07. The OTEL receiver as a local attack surface: a browser, a foreign project, `../evil`,
// a huge body (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-HOOK-07; layer
// «hook (child processes)»).
//
// The real otel-receiver.js of a copied tool dir runs as a child process; requests come from
// Node's own HTTP client. Nothing talks to the stand, so the scenario runs once, on the mode-A
// stand (DD SC4 picks A and C where the mode can matter).
//
// Code facts that differ from the design text:
//   - the main receiver of steps 2–9 and 12 runs with a 30 s idle timeout instead of 3 s, so it
//     outlives the steps; the idle behaviour (step 11) gets its own receiver with 3 s;
//   - `--owner` is a JSON object `{gitRoot, repo}`; `gitRoot` is a throwaway directory, so an idle
//     exit that triggers the receiver's own upload sweep finds no server configured there;
//   - an unusable `session.id` drops only that record: the request still answers 200
//     `{partialSuccess: {}}`; the summary line is receiver.log's per-request `ingest … dropped=N`;
//   - each accepted request becomes one chunk file `<dir>/<session>/<epochMs>-<seq>.jsonl`; `.tmp`
//     files exist only between write and rename;
//   - a preflight `OPTIONS` is answered 405 `method-not-allowed` without any CORS header.
//
// Steps 13–14 (2026-10-30 OTEL tabs, hook 2.29.0): `/v1/traces` is a known path now, so the
// unknown-path probe of step 9 is `/v1/unknown`. A traces request becomes `signal:"spans"` chunk
// lines stamped with the hook version; with a project config the receiver also sends realtime
// batches to the configured Log Hub (a fake hub here), at most one per 5 s per session.
//
// Steps 15–27 (2026-10-30 shared receiver, hook 2.30.0): one receiver per OS user, launched with
// `--shared` against a fake home's `~/.artisyn/otel/` (port.json, token). They cover the DD-9
// hello/HMAC handshake and the 401s, the DD-10 register contract (400s, uploader allow-list,
// capabilities), DD-18 routing of two repos on one listener (signal filter, pending spool, tag
// fallback), DD-11 session-status, DD-20 forwarding to a fake collector, the deleted spawning repo
// (AC-A5), the persisted registry across restarts, the idle-exit line with the per-repo sweep and
// the hook's port-conflict path (DD-17). The 5-minute pending TTL is reached with a `--require`
// clock-shift preload (helpers/hook-process.ts `clockShift`), not by waiting; the forward drop
// waits out the real retry backoff (1+2+4+8+16 s).
//
// Replaces:
//   - hook/.claude/telemetry_tool/__tests__/otel-receiver.test.js (45; one representative per class)
//   - hook/.claude/telemetry_tool/__tests__/otel-register.test.js — receiver side of register (≈ 6)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { test, expect } from '../fixtures';
import {
  authedRequest,
  clockShift,
  copyToolDir,
  copyToolDirTo,
  freeLoopbackPort,
  makeFakeGitRepo,
  makeFakeHome,
  normalizePath,
  ownerHashOf,
  pathWith,
  QUIET_HOOK_CONFIG,
  readHookLog,
  repoKeyOf,
  rmrf,
  runHook,
  sharedHello,
  spawnSharedReceiver,
  startFakeCollector,
  startFakeLogHub,
  startSharedReceiver,
  telemetryDir,
  writeConfig,
  writeFakeClaude,
  writeSharedState,
  type FakeCollector,
  type FakeLogHub,
  isRecord,
  rawRequest,
  spawnReceiver,
  startReceiver,
  stopReceiver,
  tempDirs,
  waitForExit,
  type ReceiverProcess,
  type TempDirs,
} from '../helpers/hook-process';

const MAX_BODY = 20_000;
const SCOPE = { name: 'com.anthropic.claude_code.events', version: '1.0.0' };

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function logsBody(records: Array<{ sessionId?: string; nano: string }>, resource: Array<ReturnType<typeof attr>> = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('service.name', 'claude-code'), ...resource] },
        scopeLogs: [
          {
            scope: SCOPE,
            logRecords: records.map((r) => ({
              timeUnixNano: r.nano,
              observedTimeUnixNano: r.nano,
              severityNumber: 9,
              body: { stringValue: 'claude_code.user_prompt' },
              attributes: r.sessionId === undefined ? [] : [attr('session.id', r.sessionId)],
            })),
          },
        ],
      },
    ],
  };
}

function metricsBody(sessionId: string) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [attr('service.name', 'claude-code')] },
        scopeMetrics: [
          {
            scope: SCOPE,
            metrics: [
              {
                name: 'claude_code.token.usage',
                unit: 'tokens',
                sum: { dataPoints: [{ attributes: [attr('session.id', sessionId)], asInt: '42', timeUnixNano: '1735689600000000500' }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

function tracesBody(spans: Array<{ spanId: string; sessionId: string }>, resource: Array<ReturnType<typeof attr>> = []) {
  return {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', 'claude-code'), ...resource] },
      scopeSpans: [{
        scope: { name: 'com.anthropic.claude_code.tracing' },
        spans: spans.map((s) => ({
          traceId: 'scnshared07', spanId: s.spanId, parentSpanId: '', name: 'claude_code.llm_request', kind: 1,
          startTimeUnixNano: '1735689600000000000', endTimeUnixNano: '1735689601000000000',
          attributes: [attr('session.id', s.sessionId)],
        })),
      }],
    }],
  };
}

/** What a shared receiver answers in `capabilities` (DD-10). */
const CAPABILITIES = ['shared', 'auth-v1', 'spans', 'realtime', 'forward', 'session-status'];

interface SharedRepo {
  root: string;
  /** A plugin copy of the hook inside the repo (repo A's runs the receiver of steps 15–24). */
  toolDir: string;
  otelDir: string;
  hookVersion: string;
  signals: { logs: boolean; metrics: boolean; spans: boolean };
  /** A fake `send-logs-hook.js` under the repo that only records its argv into `sweepCalls`. */
  uploader: string;
  sweepCalls: string;
}

/** A repo of the shared-receiver steps: no git needed, the receiver never runs git. */
function makeSharedRepo(dirs: TempDirs, prefix: string, hookVersion: string, signals: SharedRepo['signals']): SharedRepo {
  const root = dirs.make(prefix);
  const toolDir = copyToolDirTo(path.join(root, 'plugin', 'scripts'));
  // Not created here: on a fresh install nothing has made it yet, and the shared receiver creates it
  // when the repo's first session registers (a pre-made folder once hid that it never did).
  const otelDir = path.join(root, 'telemetry', 'otel');
  const sweepCalls = path.join(root, 'sweep-calls.log');
  const uploader = path.join(root, 'fake-uploader', 'send-logs-hook.js');
  fs.mkdirSync(path.dirname(uploader), { recursive: true });
  fs.writeFileSync(uploader, `require('fs').appendFileSync(${JSON.stringify(sweepCalls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  return { root, toolDir, otelDir, hookVersion, signals, uploader, sweepCalls };
}

/** Session dirs under the otel dir that hold at least one chunk. */
function sessionDirs(otelDir: string): string[] {
  return fs
    .readdirSync(otelDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.readdirSync(path.join(otelDir, e.name)).some((n) => n.endsWith('.jsonl')))
    .map((e) => e.name)
    .sort();
}

/** Parsed lines of every chunk of one session, in write order. */
function sessionLines(otelDir: string, sessionId: string): Array<Record<string, unknown>> {
  const dir = path.join(otelDir, sessionId);
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .flatMap((n) =>
      fs
        .readFileSync(path.join(dir, n), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const parsed: Record<string, unknown> = JSON.parse(l);
          return parsed;
        }),
    );
}

/** A non-internal IPv4 address of this machine, or null. */
function externalIPv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

test('@S-HOOK-07 the OTEL receiver refuses browsers, foreign projects, path tricks and huge bodies @mode-a', async () => {
  test.setTimeout(300_000);
  const dirs = tempDirs();
  const receivers: ReceiverProcess[] = [];
  let hub: FakeLogHub | undefined;
  let collector: FakeCollector | undefined;
  try {
    const toolDir = copyToolDir(dirs);
    // sandbox/telemetry/otel: anything escaping the otel dir shows up in telemetry/ or sandbox/.
    const sandbox = dirs.make('otel');
    const telemetry = path.join(sandbox, 'telemetry');
    const otelDir = path.join(telemetry, 'otel');
    fs.mkdirSync(otelDir, { recursive: true });
    const owner = { gitRoot: dirs.make('otel-owner'), repo: 'git@git.arrakis.test:o/a.git' };
    const foreignRoot = dirs.make('otel-foreign');
    const nothingEscaped = () => {
      expect(fs.readdirSync(sandbox)).toEqual(['telemetry']);
      expect(fs.readdirSync(telemetry)).toEqual(['otel']);
    };

    let mainPort = 0;
    let main: ReceiverProcess | undefined;

    await test.step('1. no --dir or no --owner → exit 1, nothing listens; a busy port → exit 0 and the first receiver keeps working', async () => {
      const port = await freeLoopbackPort();
      const noDir = spawnReceiver(toolDir, { port, owner, idleTimeoutMs: 30_000 });
      receivers.push(noDir);
      expect(await waitForExit(noDir)).toBe(1);
      expect(noDir.stderr()).toMatch(/--dir/);
      const noOwner = spawnReceiver(toolDir, { port, dir: otelDir, idleTimeoutMs: 30_000 });
      receivers.push(noOwner);
      expect(await waitForExit(noOwner)).toBe(1);
      expect(fs.readFileSync(path.join(otelDir, 'receiver.log'), 'utf8')).toMatch(/owner/i);
      await expect(rawRequest(port, '/v1/logs', logsBody([{ sessionId: 'x', nano: '1' }]))).rejects.toThrow(/ECONNREFUSED/);

      const first = await startReceiver(toolDir, { dir: otelDir, owner, maxBodyBytes: MAX_BODY });
      receivers.push(first.receiver);
      const otherDir = dirs.make('otel-second');
      const second = spawnReceiver(toolDir, { port: first.port, dir: otherDir, owner, idleTimeoutMs: 30_000 });
      receivers.push(second);
      expect(await waitForExit(second), 'EADDRINUSE is the normal second-session path').toBe(0);
      expect((await rawRequest(first.port, '/artisyn/register', { sessionId: 's0', gitRoot: owner.gitRoot, repo: owner.repo })).status).toBe(200);
      // The main receiver of the following steps.
      mainPort = first.port;
      main = first.receiver;
    });

    await test.step('2. a correct OTLP POST with two sessions → 200, one line per session, timeUnixNano kept; metrics land as signal=metrics', async () => {
      const res = await rawRequest(mainPort, '/v1/logs', logsBody([
        { sessionId: 's1', nano: '1735689600000000001' },
        { sessionId: 's2', nano: '1735689600000000002' },
      ]));
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ partialSuccess: {} });
      const s1 = sessionLines(otelDir, 's1');
      expect(s1).toHaveLength(1);
      expect(s1[0].signal).toBe('logs');
      expect(String(s1[0].receivedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      const record = s1[0].record;
      expect(isRecord(record) ? record.timeUnixNano : null, 'timeUnixNano as sent, not the receive time').toBe('1735689600000000001');
      expect(sessionLines(otelDir, 's2')).toHaveLength(1);

      expect((await rawRequest(mainPort, '/v1/metrics', metricsBody('s3'))).status).toBe(200);
      expect(sessionLines(otelDir, 's3').map((l) => l.signal)).toEqual(['metrics']);
    });

    await test.step('3. browser requests: Origin → 403, Referer → 403, text/plain → 415; nothing written', async () => {
      const before = sessionDirs(otelDir);
      const body = logsBody([{ sessionId: 'never', nano: '1735689600000000100' }]);
      const origin = await rawRequest(mainPort, '/v1/logs', body, { headers: { Origin: 'https://evil.example' } });
      expect(origin.status).toBe(403);
      expect(origin.json?.error).toBe('forbidden');
      const referer = await rawRequest(mainPort, '/v1/logs', body, { headers: { Referer: 'https://evil.example/' } });
      expect(referer.status).toBe(403);
      const plain = await rawRequest(mainPort, '/v1/logs', JSON.stringify(body), { headers: { 'Content-Type': 'text/plain' } });
      expect(plain.status).toBe(415);
      const register = await rawRequest(
        mainPort,
        '/artisyn/register',
        { sessionId: 'never', gitRoot: owner.gitRoot, repo: owner.repo },
        { headers: { Origin: 'https://evil.example' } },
      );
      expect(register.status).toBe(403);
      expect(sessionDirs(otelDir)).toEqual(before);
    });

    await test.step('4. preflight OPTIONS /v1/logs → not 2xx and no Access-Control-Allow-* header', async () => {
      const res = await rawRequest(mainPort, '/v1/logs', undefined, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
      });
      expect(res.status).toBe(405);
      expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-allow'))).toEqual([]);
    });

    await test.step('5. dangerous session ids are dropped (nothing outside the dir), valid records of the same request kept, 200', async () => {
      const bad = ['../evil', '/etc/passwd', 'C:\\win', 'a/b', '%2e%2e%2fevil', 'z'.repeat(129), ''];
      const res = await rawRequest(
        mainPort,
        '/v1/logs',
        logsBody([...bad.map((sessionId, i) => ({ sessionId, nano: `17356896000000002${i}0` })), { sessionId: 'ok-5', nano: '1735689600000000299' }]),
      );
      expect(res.status).toBe(200);
      expect(sessionDirs(otelDir)).toContain('ok-5');
      expect(sessionLines(otelDir, 'ok-5')).toHaveLength(1);
      for (const name of fs.readdirSync(otelDir)) expect(name.includes('evil') || name.includes('passwd')).toBe(false);
      nothingEscaped();
      expect(fs.readFileSync(path.join(otelDir, 'receiver.log'), 'utf8')).toMatch(/ingest signal=logs .* records=1 dropped=7 /);
      expect(fs.readdirSync(path.dirname(sandbox)).some((n) => n.startsWith('evil'))).toBe(false);
    });

    await test.step('6. /artisyn/register: owner → 200 {ok, receiverVersion, port}; foreign gitRoot → 409 owner-mismatch; no gitRoot or a bad sessionId → 400', async () => {
      const version: string = JSON.parse(fs.readFileSync(path.join(toolDir, 'version.json'), 'utf8')).version;
      const ok = await rawRequest(mainPort, '/artisyn/register', { sessionId: 's1', gitRoot: owner.gitRoot, repo: owner.repo });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ ok: true, receiverVersion: version, port: mainPort });
      const before = sessionDirs(otelDir);
      const foreign = await rawRequest(mainPort, '/artisyn/register', { sessionId: 's9', gitRoot: foreignRoot, repo: 'git@git.arrakis.test:o/b.git' });
      expect(foreign.status).toBe(409);
      expect(foreign.json).toMatchObject({ ok: false, error: 'owner-mismatch', ownerRepo: owner.repo });
      expect(sessionDirs(otelDir)).toEqual(before);
      expect((await rawRequest(mainPort, '/artisyn/register', { sessionId: 's1', repo: owner.repo })).status).toBe(400);
      const badId = await rawRequest(mainPort, '/artisyn/register', { sessionId: '../x', gitRoot: owner.gitRoot, repo: owner.repo });
      expect(badId.status).toBe(400);
      expect(badId.json?.error).toBe('invalid-session-id');
    });

    await test.step('8. size and encodings: > maxBodyBytes → 413; gzip within the limit → 200; br → 415; broken gzip and broken JSON → 400', async () => {
      const before = sessionDirs(otelDir);
      const huge = logsBody([{ sessionId: 'too-big', nano: '1735689600000000300' }], [attr('padding', 'x'.repeat(MAX_BODY * 2))]);
      const tooBig = await rawRequest(mainPort, '/v1/logs', huge);
      expect(tooBig.status).toBe(413);
      expect(tooBig.json?.error).toBe('payload-too-large');
      // Compresses far below the wire cap, inflates above it: the cap is on the wire bytes.
      const roomy = logsBody([{ sessionId: 'gz-ok', nano: '1735689600000000301' }], [attr('padding', 'y'.repeat(MAX_BODY * 2))]);
      const gz = await rawRequest(mainPort, '/v1/logs', zlib.gzipSync(Buffer.from(JSON.stringify(roomy))), {
        headers: { 'Content-Encoding': 'gzip' },
      });
      expect(gz.status).toBe(200);
      expect(sessionLines(otelDir, 'gz-ok')).toHaveLength(1);
      const br = await rawRequest(mainPort, '/v1/logs', logsBody([{ sessionId: 'br', nano: '1' }]), { headers: { 'Content-Encoding': 'br' } });
      expect(br.status).toBe(415);
      const brokenGz = await rawRequest(mainPort, '/v1/logs', Buffer.from('not actually gzipped'), { headers: { 'Content-Encoding': 'gzip' } });
      expect(brokenGz.status).toBe(400);
      const brokenJson = await rawRequest(mainPort, '/v1/logs', '{"resourceLogs": [');
      expect(brokenJson.status).toBe(400);
      expect(brokenJson.json?.error).toBe('invalid-json');
      expect(sessionDirs(otelDir)).toEqual([...before, 'gz-ok'].sort());
    });

    await test.step('9. unknown path → 404; GET /v1/logs → 405', async () => {
      expect((await rawRequest(mainPort, '/v1/unknown', { resourceSpans: [] })).status).toBe(404);
      const get = await rawRequest(mainPort, '/v1/logs', undefined, { method: 'GET' });
      expect(get.status).toBe(405);
      expect(get.json?.error).toBe('method-not-allowed');
    });

    await test.step('10. bound to loopback only: the machine’s external address refuses the connection', async () => {
      const ip = externalIPv4();
      if (ip === null) {
        test.info().annotations.push({ type: 'skip-step', description: 'no non-internal IPv4 interface on this machine' });
        return;
      }
      await expect(rawRequest(mainPort, '/v1/logs', logsBody([{ sessionId: 'remote', nano: '1' }]), { host: ip })).rejects.toThrow(
        /ECONNREFUSED|EADDRNOTAVAIL|ETIMEDOUT|EHOSTUNREACH/,
      );
      expect(sessionDirs(otelDir)).not.toContain('remote');
    });

    await test.step('12. 20 concurrent requests for one session → 20 chunk files, no .tmp left', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          rawRequest(mainPort, '/v1/logs', logsBody([{ sessionId: 'burst', nano: `17356896000000004${String(i).padStart(2, '0')}` }])),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
      const files = fs.readdirSync(path.join(otelDir, 'burst'));
      expect(files.filter((n) => n.endsWith('.jsonl'))).toHaveLength(20);
      expect(files.filter((n) => n.endsWith('.tmp'))).toEqual([]);
      expect(sessionLines(otelDir, 'burst')).toHaveLength(20);
    });

    await test.step('13. POST /v1/traces → 200; each span becomes one signal="spans" line of its session, record ids kept, hookVersion stamped', async () => {
      const version: string = JSON.parse(fs.readFileSync(path.join(toolDir, 'version.json'), 'utf8')).version;
      const span = (spanId: string, parentSpanId: string, sessionId: string) => ({
        traceId: 'scntrace07', spanId, parentSpanId, name: 'claude_code.llm_request', kind: 1,
        startTimeUnixNano: '1735689600000000000', endTimeUnixNano: '1735689601000000000',
        attributes: [attr('session.id', sessionId), attr('request_id', `req-${spanId}`)],
      });
      const res = await rawRequest(mainPort, '/v1/traces', {
        resourceSpans: [{
          resource: { attributes: [attr('service.name', 'claude-code')] },
          scopeSpans: [{ scope: { name: 'com.anthropic.claude_code.tracing' }, spans: [span('sp1', '', 'tr-1'), span('sp2', 'sp1', 'tr-1'), span('sp3', '', 'tr-2')] }],
        }],
      });
      expect(res.status).toBe(200);
      const tr1 = sessionLines(otelDir, 'tr-1');
      expect(tr1.map((l) => l.signal)).toEqual(['spans', 'spans']);
      expect(tr1.map((l) => (isRecord(l.record) ? l.record.spanId : null))).toEqual(['sp1', 'sp2']);
      expect(tr1.every((l) => l.hookVersion === version)).toBe(true);
      expect(sessionLines(otelDir, 'tr-2')).toHaveLength(1);
    });

    await test.step('14. with serverUrl and apiKey in the owner project’s config, logs and spans reach the Log Hub in realtime: the first batch one interval after the data, the next not before another 5 s', async () => {
      hub = await startFakeLogHub((req) =>
        req.path === '/api/v2/otel-realtime'
          ? { status: 200, body: JSON.stringify({ accepted: { calls: 0, spans: 0 }, cursor: 'v1.1', minIntervalMs: 5000 }) }
          : { status: 201, body: JSON.stringify({ warnings: [] }) },
      );
      const rtOwner = { gitRoot: dirs.make('otel-rt-owner'), repo: 'git@git.arrakis.test:o/rt.git' };
      writeConfig(rtOwner.gitRoot, { base: { serverUrl: hub.url, otelEnabled: false }, local: { apiKey: 'k-rt-07' } });
      const rtDir = dirs.make('otel-rt');
      const { receiver, port } = await startReceiver(toolDir, { dir: rtDir, owner: rtOwner });
      receivers.push(receiver);
      const batches = () => hub!.requests.filter((r) => r.path === '/api/v2/otel-realtime');
      const decode = (i: number): Record<string, unknown> => {
        const r = batches()[i];
        const raw = r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (!isRecord(parsed)) throw new Error('realtime body is not an object');
        return parsed;
      };
      const t0 = Date.now();
      expect((await rawRequest(port, '/v1/logs', logsBody([{ sessionId: 'rt-07', nano: '1735689600000000700' }]))).status).toBe(200);
      await expect.poll(() => batches().length, { timeout: 12_000 }).toBe(1);
      const first = batches()[0];
      expect(first.receivedAt - t0, 'the first batch waits one interval').toBeGreaterThanOrEqual(4_500);
      expect(first.headers['x-api-key']).toBe('k-rt-07');
      expect(decode(0)).toMatchObject({ sessionId: 'rt-07', batchSeq: 1, droppedLines: 0 });
      expect(Array.isArray(decode(0).lines) && (decode(0).lines as unknown[]).length).toBe(1);

      expect((await rawRequest(port, '/v1/logs', logsBody([{ sessionId: 'rt-07', nano: '1735689600000000701' }]))).status).toBe(200);
      await expect.poll(() => batches().length, { timeout: 12_000 }).toBe(2);
      expect(batches()[1].receivedAt - first.receivedAt, 'at most one batch per 5 s').toBeGreaterThanOrEqual(4_500);
      expect(decode(1)).toMatchObject({ sessionId: 'rt-07', batchSeq: 2 });
      expect(hub!.requests.filter((r) => r.path === '/api/v2/logs'), 'no chunk upload from the receiver itself').toEqual([]);
      await stopReceiver(receiver);
    });

    await test.step('7. /artisyn/shutdown: GET → 405; foreign gitRoot → 409 and alive; the owner → exits', async () => {
      const get = await rawRequest(mainPort, '/artisyn/shutdown', undefined, { method: 'GET' });
      expect(get.status).toBe(405);
      const foreign = await rawRequest(mainPort, '/artisyn/shutdown', { gitRoot: foreignRoot });
      expect(foreign.status).toBe(409);
      expect(foreign.json?.error).toBe('owner-mismatch');
      expect(main!.exitCode()).toBeUndefined();
      const ok = await rawRequest(mainPort, '/artisyn/shutdown', { gitRoot: owner.gitRoot, sessionId: 's1' });
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ ok: true });
      expect(await waitForExit(main!)).toBe(0);
    });

    await test.step('11. idle timer: 3 s without requests → exit 0; even a rejected (403) request re-arms it', async () => {
      const idleDir = dirs.make('otel-idle');
      const { receiver, port } = await startReceiver(toolDir, { dir: idleDir, owner, idleTimeoutMs: 3000 });
      receivers.push(receiver);
      const armedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const rejected = await rawRequest(port, '/v1/logs', logsBody([{ sessionId: 'x', nano: '1' }]), {
        headers: { Origin: 'https://evil.example' },
      });
      expect(rejected.status).toBe(403);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, armedAt + 3000 + 500 - Date.now())));
      expect(receiver.exitCode(), 'the rejected request re-armed the idle timer').toBeUndefined();
      expect(await waitForExit(receiver, 8000)).toBe(0);
      expect(Date.now() - armedAt).toBeGreaterThanOrEqual(1800 + 3000 - 200);
      expect(fs.readFileSync(path.join(idleDir, 'receiver.log'), 'utf8')).toMatch(/idle-exit/);
    });

    // ---- Steps 15–27: the shared per-user receiver (task 2026-10-30-otel-shared-receiver, hook 2.30.0)
    const version: string = JSON.parse(fs.readFileSync(path.join(toolDir, 'version.json'), 'utf8')).version;
    const home = dirs.make('shared-home');
    const state = await writeSharedState(home);
    const { stateDir, token, port: sharedPort } = state;
    const auth = { token, home };
    const clock = clockShift(dirs);
    const sharedLog = () => fs.readFileSync(path.join(stateDir, 'receiver.log'), 'utf8');
    const repoA = makeSharedRepo(dirs, 'shared-a', '9.9.1-a', { logs: true, metrics: true, spans: true });
    const repoB = makeSharedRepo(dirs, 'shared-b', '9.9.1-b', { logs: true, metrics: true, spans: false });
    const keyA = repoKeyOf(repoA.root);
    const keyB = repoKeyOf(repoB.root);
    const register = (sessionId: string, repo: SharedRepo, extra: Record<string, unknown> = {}) =>
      authedRequest(sharedPort, '/artisyn/register', {
        sessionId, gitRoot: repo.root, otelDir: repo.otelDir, hookVersion: repo.hookVersion, contract: 1,
        repoKey: repoKeyOf(repo.root), signals: repo.signals, uploader: repo.uploader, realtime: null, ...extra,
      }, auth);
    const status = async (sessionId: string) => {
      const res = await authedRequest(sharedPort, '/artisyn/session-status', { sessionId }, auth);
      expect(res.status, res.body).toBe(200);
      return res.json ?? {};
    };
    const otlp = async (route: string, body: object) => {
      const res = await rawRequest(sharedPort, route, body);
      expect(res.status, `${route}: ${res.body}`).toBe(200);
    };
    const hasSession = (otelDir: string, sid: string) => fs.existsSync(path.join(otelDir, sid));
    let shared: ReceiverProcess | undefined;

    await test.step('15. shared mode, hello: 200 with a valid proof, receiverVersion, contract 1 and the capabilities; another owner → 409 without a path; a bad nonce → 400; the log names the ownerHash, never the home', async () => {
      // The receiver runs from a plugin copy inside repo A — the «spawning repo» of step 23.
      shared = await startSharedReceiver(repoA.toolDir, { home, stateDir, port: sharedPort, clock });
      receivers.push(shared);
      const hello = await sharedHello(sharedPort, auth);
      expect(hello.res.status, hello.res.body).toBe(200);
      expect(hello.proofValid, 'proof = HMAC(token, srv\\n clientNonce \\n serverNonce)').toBe(true);
      expect(hello.res.json).toMatchObject({ receiverVersion: version, contract: 1, capabilities: CAPABILITIES });
      const foreign = await sharedHello(sharedPort, { ...auth, ownerHash: ownerHashOf(dirs.make('other-home')) });
      expect(foreign.res.status).toBe(409);
      expect(foreign.res.json).toEqual({ error: 'owner-mismatch' });
      expect(foreign.res.body).not.toContain(path.basename(home));
      const badNonce = await rawRequest(sharedPort, '/artisyn/hello', { clientNonce: 'zz', ownerHash: ownerHashOf(home) });
      expect(badNonce.status).toBe(400);
      const log = sharedLog();
      expect(log).toMatch(new RegExp(`start listening on 127\\.0\\.0\\.1:${sharedPort} mode=shared ownerHash=${ownerHashOf(home).slice(0, 12)} receiverVersion=${version.replace(/\./g, '\\.')}`));
      expect(log, 'FR-A2: no home path in the shared log').not.toContain(path.basename(home));
    });

    await test.step('16. authenticated routes: no header, a malformed header, a bad MAC and a spent nonce → 401 {error:unauthorized}, one auth-reject line each, nothing registered; an unauthenticated shutdown leaves it running', async () => {
      const body = { sessionId: 'sa-never', gitRoot: repoA.root, otelDir: repoA.otelDir, hookVersion: repoA.hookVersion };
      const noHeader = await rawRequest(sharedPort, '/artisyn/register', body);
      expect(noHeader.status).toBe(401);
      expect(noHeader.json).toEqual({ error: 'unauthorized' });
      const malformed = await rawRequest(sharedPort, '/artisyn/register', body, { headers: { 'x-artisyn-auth': 'v1 abc def' } });
      expect(malformed.status).toBe(401);
      const badMac = await authedRequest(sharedPort, '/artisyn/register', body, { ...auth, signWith: 'f'.repeat(64) });
      expect(badMac.status).toBe(401);
      const ok = await authedRequest(sharedPort, '/artisyn/session-status', { sessionId: 'sa-never' }, auth);
      expect(ok.status).toBe(200);
      const spent = await authedRequest(sharedPort, '/artisyn/register', body, { ...auth, nonce: ok.nonce });
      expect(spent.status, 'a nonce is single-use').toBe(401);
      const shutdown = await rawRequest(sharedPort, '/artisyn/shutdown', {});
      expect(shutdown.status).toBe(401);
      expect(shared!.exitCode()).toBeUndefined();
      const log = sharedLog();
      for (const reason of ['missing-header', 'malformed-header', 'bad-mac', 'unknown-nonce']) {
        expect(log).toContain(`auth-reject route=/artisyn/register reason=${reason}`);
      }
      expect(log).toContain('auth-reject route=/artisyn/shutdown reason=missing-header');
      expect(log, 'the header value is never logged').not.toContain('v1 abc def');
      expect(await status('sa-never')).toMatchObject({ registered: false });
    });

    await test.step('17. register: a missing or relative field → 400 with the field; an uploader outside the repo and plugins dir, or not send-logs-hook.js → 400 uploader-not-allowed; a valid one → 200 {ok, receiverVersion, contract, capabilities, rebound:false}', async () => {
      expect((await register('sa', repoA, { gitRoot: undefined })).json).toEqual({ error: 'bad-request', reason: 'gitRoot missing' });
      expect((await register('sa', repoA, { otelDir: 'relative/otel' })).json).toEqual({ error: 'bad-request', reason: 'otelDir invalid' });
      expect((await register('../sa', repoA)).json).toEqual({ error: 'bad-request', reason: 'sessionId invalid' });
      const outside = path.join(dirs.make('outsider'), 'send-logs-hook.js');
      fs.writeFileSync(outside, '// not the hook\n');
      const wrongName = path.join(path.dirname(repoA.uploader), 'evil.js');
      fs.writeFileSync(wrongName, '// not the hook\n');
      for (const uploader of [outside, wrongName, 'send-logs-hook.js']) {
        const res = await register('sa', repoA, { uploader });
        expect(res.status, uploader).toBe(400);
        expect(res.json).toEqual({ error: 'bad-request', reason: 'uploader-not-allowed' });
      }
      expect(sharedLog()).toContain('register-reject reason=uploader-not-allowed');
      expect(await status('sa')).toMatchObject({ registered: false });

      const ok = await register('sa', repoA);
      expect(ok.status, ok.body).toBe(200);
      expect(ok.json).toEqual({ ok: true, receiverVersion: version, contract: 1, capabilities: CAPABILITIES, rebound: false });
      expect((await register('sb', repoB)).status).toBe(200);
    });

    await test.step('18. two repos on one listener: one request with sessions of A and B lands in each repo’s own otelDir, stamped with the entry’s hookVersion and the receiverVersion; one ingest line per repo, mirrored into that repo’s receiver.log only', async () => {
      await otlp('/v1/logs', logsBody([{ sessionId: 'sa', nano: '1735689600000001001' }, { sessionId: 'sb', nano: '1735689600000001002' }]));
      await otlp('/v1/metrics', metricsBody('sa'));
      const a = sessionLines(repoA.otelDir, 'sa');
      expect(a.map((l) => l.signal)).toEqual(['logs', 'metrics']);
      for (const l of a) expect({ hookVersion: l.hookVersion, receiverVersion: l.receiverVersion }).toEqual({ hookVersion: '9.9.1-a', receiverVersion: version });
      const b = sessionLines(repoB.otelDir, 'sb');
      expect(b.map((l) => [l.signal, l.hookVersion, l.receiverVersion])).toEqual([['logs', '9.9.1-b', version]]);
      expect(hasSession(repoA.otelDir, 'sb')).toBe(false);
      expect(hasSession(repoB.otelDir, 'sa')).toBe(false);
      const ingest = (key: string, signal: string) =>
        new RegExp(`ingest repo=${key} receiverVersion=${version.replace(/\./g, '\\.')} signal=${signal} bytes=\\d+ sessions=1 records=1 dropped=0 writeErrors=0`);
      expect(sharedLog()).toMatch(ingest(keyA, 'logs'));
      expect(sharedLog()).toMatch(ingest(keyB, 'logs'));
      const mirrorA = fs.readFileSync(path.join(repoA.otelDir, 'receiver.log'), 'utf8');
      expect(mirrorA).toMatch(ingest(keyA, 'logs'));
      expect(mirrorA).toMatch(ingest(keyA, 'metrics'));
      expect(mirrorA, 'repo A’s log carries only repo A').not.toContain(`repo=${keyB}`);
      expect(fs.readFileSync(path.join(repoB.otelDir, 'receiver.log'), 'utf8')).not.toContain(`repo=${keyA}`);
    });

    await test.step('19. otelTraces:false in repo B: its spans are dropped and counted, repo A keeps its own', async () => {
      await otlp('/v1/traces', tracesBody([{ spanId: 'sh-a1', sessionId: 'sa' }, { spanId: 'sh-b1', sessionId: 'sb' }]));
      expect(sessionLines(repoA.otelDir, 'sa').filter((l) => l.signal === 'spans')).toHaveLength(1);
      expect(sessionLines(repoB.otelDir, 'sb').map((l) => l.signal)).toEqual(['logs']);
      expect(sharedLog()).toMatch(new RegExp(`ingest repo=${keyB} receiverVersion=\\S+ signal=spans bytes=\\d+ sessions=0 records=0 dropped=1 `));
    });

    await test.step('20. pending: records of an unregistered session wait in the spool and land in its repo on register; past the 5-minute TTL they are dropped and counted', async () => {
      await otlp('/v1/logs', logsBody([{ sessionId: 'sc', nano: '1735689600000002001' }]));
      expect(hasSession(repoA.otelDir, 'sc')).toBe(false);
      expect(await status('sc')).toMatchObject({ registered: false, pending: 1, received: { logs: 0, metrics: 0, spans: 0 } });
      expect(sharedLog()).toMatch(/ingest repo=pending receiverVersion=\S+ signal=logs bytes=\d+ sessions=1 records=1 /);
      expect((await register('sc', repoA)).status).toBe(200);
      expect(sessionLines(repoA.otelDir, 'sc').map((l) => [l.signal, l.hookVersion])).toEqual([['logs', '9.9.1-a']]);
      expect(await status('sc')).toMatchObject({ registered: true, pending: 0, received: { logs: 1 } });
      expect(sharedLog()).toContain('pending-reroute session=sc records=1 routed=1');

      await otlp('/v1/logs', logsBody([{ sessionId: 'sd', nano: '1735689600000002002' }]));
      expect(await status('sd')).toMatchObject({ pending: 1 });
      await clock.set(6 * 60_000);
      expect(await status('sd')).toMatchObject({ registered: false, pending: 0 });
      expect(sharedLog()).toMatch(/pending-expire records=1 /);
      expect((await register('sd', repoA)).status).toBe(200);
      expect(hasSession(repoA.otelDir, 'sd'), 'nothing left to deliver').toBe(false);
    });

    await test.step('21. tag fallback: an unregistered session tagged artisyn.repo=<repoKey> of a repos.json entry lands in that repo (logs yes, spans only with traces); a registered session’s conflicting tag is ignored', async () => {
      fs.writeFileSync(path.join(stateDir, 'repos.json'), JSON.stringify({
        version: 1,
        repos: [{ repoKey: keyB, gitRoot: repoB.root, otelDir: repoB.otelDir, uploader: repoB.uploader, traces: false, installedAt: new Date().toISOString(), hookVersion: '9.9.0-tag' }],
      }));
      const tagB = [attr('artisyn.repo', keyB)];
      await otlp('/v1/logs', logsBody([{ sessionId: 'se', nano: '1735689600000003001' }, { sessionId: 'sa', nano: '1735689600000003002' }], tagB));
      expect(sessionLines(repoB.otelDir, 'se').map((l) => [l.signal, l.hookVersion, l.receiverVersion])).toEqual([['logs', '9.9.0-tag', version]]);
      expect(sessionLines(repoA.otelDir, 'sa').filter((l) => l.signal === 'logs'), 'register wins over the tag').toHaveLength(2);
      expect(hasSession(repoB.otelDir, 'sa')).toBe(false);
      await otlp('/v1/traces', tracesBody([{ spanId: 'sh-f1', sessionId: 'sf' }], tagB));
      expect(hasSession(repoB.otelDir, 'sf'), 'the repo has no traces').toBe(false);
      expect(await status('sf')).toMatchObject({ pending: 0 });
    });

    await test.step('22. session-status: counters of a registered session (pending excluded), firstRecordAt, forward off; an unknown session → registered:false with zeros; no sessionId → 400', async () => {
      const sa = await status('sa');
      expect(sa).toMatchObject({ receiverVersion: version, registered: true, received: { logs: 2, metrics: 1, spans: 1 }, pending: 0, forward: 'off' });
      expect(String(sa.firstRecordAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(await status('nobody')).toEqual({ receiverVersion: version, registered: false, received: { logs: 0, metrics: 0, spans: 0 }, firstRecordAt: null, pending: 0, forward: 'off' });
      const missing = await authedRequest(sharedPort, '/artisyn/session-status', {}, auth);
      expect(missing.status).toBe(400);
    });

    await test.step('23. forwarding (proxy): every logs request — registered or not — reaches the foreign collector byte for byte with its headers (no x-artisyn-*), no header value in the log; upstream down → retried (forward=degraded), then dropped and counted', async () => {
      const col = await startFakeCollector();
      collector = col;
      fs.writeFileSync(path.join(stateDir, 'forward.json'), JSON.stringify({
        version: 1, mode: 'proxy', fingerprint: 'scn', savedAt: new Date().toISOString(), original: { env: {} },
        signals: { logs: { endpoint: `${col.url}/upstream/v1/logs`, protocol: 'http/json' } },
      }));
      // forward.json is re-read at hello on its mtime change.
      expect((await sharedHello(sharedPort, auth)).proofValid).toBe(true);
      expect(sharedLog()).toContain('forward-config mode=proxy signals=logs');
      const headers = { Authorization: 'Bearer scn-secret-07', 'X-Tenant': 'scn-tenant', 'x-artisyn-probe': 'never-upstream' };
      const raw = (sid: string, nano: string) => Buffer.from(JSON.stringify(logsBody([{ sessionId: sid, nano }]), null, 3), 'utf8');
      const registered = raw('sa', '1735689600000004001');
      const unregistered = raw('sg', '1735689600000004002');
      expect((await rawRequest(sharedPort, '/v1/metrics', metricsBody('sa'))).status).toBe(200);
      for (const body of [registered, unregistered]) expect((await rawRequest(sharedPort, '/v1/logs', body, { headers })).status).toBe(200);
      await expect.poll(() => col.requests.length, { timeout: 10_000 }).toBe(2);
      for (const [i, sent] of [registered, unregistered].entries()) {
        const got = col.requests[i];
        expect(got.path).toBe('/upstream/v1/logs');
        expect(got.body.equals(sent), 'byte-identical payload').toBe(true);
        expect(got.headers.authorization).toBe('Bearer scn-secret-07');
        expect(got.headers['x-tenant']).toBe('scn-tenant');
        expect(got.headers['content-type']).toBe('application/json');
        expect(got.headers['x-artisyn-probe']).toBeUndefined();
      }
      expect(col.requests.some((r) => r.path.includes('metrics')), 'metrics are not in forward.json').toBe(false);
      expect(await status('sa')).toMatchObject({ forward: 'ok' });
      expect(sharedLog()).toMatch(/forward signal=logs status=200 queued=\d+ dropped=0/);

      col.setDown(true);
      const before = sessionLines(repoA.otelDir, 'sa').length;
      expect((await rawRequest(sharedPort, '/v1/logs', raw('sa', '1735689600000004003'), { headers })).status, 'Claude Code still gets its 200').toBe(200);
      expect(sessionLines(repoA.otelDir, 'sa').length, 'the local write happens regardless').toBe(before + 1);
      await expect.poll(async () => (await status('sa')).forward, { timeout: 10_000 }).toBe('degraded');
      // 6 attempts with backoff 1+2+4+8+16 s, then the request is dropped and counted.
      await expect.poll(() => /forward signal=logs status=(error|timeout) queued=0 dropped=1/.test(sharedLog()), { timeout: 50_000, intervals: [1000] }).toBe(true);
      col.setDown(false);
      const log = sharedLog();
      for (const secret of ['scn-secret-07', 'scn-tenant', 'never-upstream']) expect(log, 'no header value in receiver.log').not.toContain(secret);
    });

    await test.step('24. the spawning repo is deleted: the receiver keeps serving repo B, drops repo A’s records with one dir-gone line', async () => {
      rmrf(repoA.root);
      expect(fs.existsSync(repoA.root)).toBe(false);
      const before = sessionLines(repoB.otelDir, 'sb').length;
      for (const n of ['1735689600000005001', '1735689600000005002']) {
        await otlp('/v1/logs', logsBody([{ sessionId: 'sa', nano: n }, { sessionId: 'sb', nano: `${n}9` }]));
      }
      expect(sessionLines(repoB.otelDir, 'sb').length).toBe(before + 2);
      expect(fs.existsSync(repoA.root), 'no ghost tree recreated').toBe(false);
      expect(sharedLog().match(new RegExp(`dir-gone repo=${keyA} `, 'g')) ?? []).toHaveLength(1);
      expect((await sharedHello(sharedPort, auth)).proofValid).toBe(true);
    });

    await test.step('25. the registry survives a restart: an authenticated shutdown persists it, a new receiver routes repo B’s session without a new register; an entry past its 24 h TTL is dropped at load', async () => {
      const bye = await authedRequest(sharedPort, '/artisyn/shutdown', {}, auth);
      expect(bye.status).toBe(200);
      expect(bye.json).toEqual({ ok: true });
      expect(await waitForExit(shared!)).toBe(0);
      const registry = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'registry.json'), 'utf8')) as { sessions: Record<string, { hookVersion: string; lastSeenAt: string }> };
      expect(registry().sessions.sb).toMatchObject({ hookVersion: '9.9.1-b' });

      shared = await startSharedReceiver(toolDir, { home, stateDir, port: sharedPort });
      receivers.push(shared);
      expect(sharedLog()).toMatch(/registry-load sessions=\d+ expired=0/);
      const before = sessionLines(repoB.otelDir, 'sb').length;
      await otlp('/v1/logs', logsBody([{ sessionId: 'sb', nano: '1735689600000006001' }]));
      expect(sessionLines(repoB.otelDir, 'sb').length, 'routed by the persisted registration').toBe(before + 1);
      expect((await authedRequest(sharedPort, '/artisyn/shutdown', {}, auth)).status).toBe(200);
      expect(await waitForExit(shared)).toBe(0);

      const saved = registry();
      saved.sessions.sb.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
      fs.writeFileSync(path.join(stateDir, 'registry.json'), JSON.stringify(saved));
      // Step 26 reuses this receiver: a short idle timeout, every request below re-arms it.
      shared = await startSharedReceiver(toolDir, { home, stateDir, port: sharedPort, idleTimeoutMs: 4000 });
      receivers.push(shared);
      expect(sharedLog()).toMatch(/registry-load sessions=\d+ expired=1/);
      expect(await status('sb')).toMatchObject({ registered: false });
    });

    await test.step('26. idle exit: the short --idle-timeout-ms ends the receiver; the idle line counts this run’s ingests, and repo B’s registered uploader is swept with --otel-sweep --cwd <repo B>', async () => {
      expect((await register('sb', repoB)).status).toBe(200);
      await otlp('/v1/logs', logsBody([{ sessionId: 'sb', nano: '1735689600000007001' }]));
      expect(await waitForExit(shared!, 15_000)).toBe(0);
      expect(sharedLog()).toMatch(/idle-exit idleMs=4000 ingests=1 sessions=\d+ /);
      await expect.poll(() => fs.existsSync(repoB.sweepCalls), { timeout: 10_000 }).toBe(true);
      const calls = fs.readFileSync(repoB.sweepCalls, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
      expect(calls.at(-1)?.slice(0, 2)).toEqual(['--otel-sweep', '--cwd']);
      expect(normalizePath(String(calls.at(-1)?.[2]))).toBe(normalizePath(repoB.root));
    });

    await test.step('27. port conflict: a foreign server on the shared port → a shared receiver exits 0 (EADDRINUSE); the hook warns «otel port-conflict» once and its SessionEnd otel-status says receiver-down / port-conflict', async () => {
      const foreign = await startFakeLogHub();
      try {
        const loser = spawnSharedReceiver(toolDir, { home, stateDir, port: foreign.port });
        receivers.push(loser);
        expect(await waitForExit(loser)).toBe(0);
        const hello = await sharedHello(foreign.port, auth);
        expect(hello.proofValid).toBe(false);

        const repo = makeFakeGitRepo(dirs);
        const hookHome = makeFakeHome(dirs);
        await writeSharedState(hookHome, foreign.port);
        writeConfig(repo, { base: { ...QUIET_HOOK_CONFIG, otelEnabled: true } });
        const env = { ARTISYN_MANAGED_SETTINGS_DIR: dirs.make('no-managed'), ...pathWith(writeFakeClaude(dirs, 'fail').dir) };
        const run = (event: 'Stop' | 'SessionEnd') => runHook(toolDir, { hook_event_name: event, session_id: 'pc-1', cwd: repo }, { home: hookHome, env });
        expect((await run('Stop')).code).toBe(0);
        expect((await run('SessionEnd')).code).toBe(0);
        const log = readHookLog(repo);
        expect(log.filter((l) => l.includes(`otel port-conflict port=${foreign.port} detail=hello-status-201`)), log.join('\n')).toHaveLength(1);
        expect(log.filter((l) => l.includes('otel-status state=')), 'Stop with no records writes nothing; SessionEnd writes once').toHaveLength(1);
        const lines = fs.readFileSync(path.join(telemetryDir(repo), 'pc-1.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(lines.filter((l) => l.type === 'otel-status')).toEqual([
          expect.objectContaining({ state: 'none', reason: 'receiver-down', detail: 'port-conflict', received: { logs: 0, metrics: 0, spans: 0, firstAt: null } }),
        ]);
        expect(foreign.requests.every((r) => r.path === '/artisyn/hello'), 'nothing but hello reaches a foreign listener').toBe(true);
      } finally {
        await foreign.close();
      }
    });
  } finally {
    for (const r of receivers) await stopReceiver(r);
    await hub?.close();
    await collector?.close();
    dirs.cleanup();
  }
});
