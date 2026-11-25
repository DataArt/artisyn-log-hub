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
// Step 28 (2026-11-18 receiver upload queue, hook 3.0.0): the shared receiver's uploader role —
// `uploader.lock` and `heartbeat.json` under the fake home's `~/.artisyn/upload/`, a queued
// `session-end` job run with `send-logs-hook.js --run-job` right after start (drain), and no idle
// exit while that job runs. Shared receivers run with the fake home as HOME/USERPROFILE, so the
// uploaders they spawn resolve `~` the same way.
//
// Steps 29–30 (same task, phase 2): a 503 makes the uploader rewrite the job (`attempts`,
// `nextAttemptAt`) and the job keeps the receiver from idling out; a 400 moves it to `failed/` and
// the empty queue lets the receiver exit. A receiver and its uploader killed mid-job leave a dead
// claim and a stale `uploader.lock`; the next receiver takes both over and re-runs the job (AC-2).
//
// Phase 3 (same task, hook 3.0.0, mandatory receiver): step 27's receiver on a foreign-held port
// keeps the uploader role queue-only (heartbeat `listening: false`) and runs a queued job, a second
// one exits 0; step 31 has one receiver serve an `otelEnabled: false` repo (jobs yes, OTLP records
// no) next to an `otelEnabled: true` one; step 32 checks that each job's `hook-status` carries the
// version of the hook copy that queued it, plus `nodeVersion`. Receivers a hook run spawned
// detached are killed through their `uploader.lock` pid at the end of the step.
//
// Step 33 (follow-up, failed/ re-queue): after a power-off (stale lock, heartbeat and claim of a dead
// pid) the receiver takes the role, runs the queued job of repo Y (done), and that `done` triggers
// the re-queue: repo X's `max-attempts` record comes back as one `stop` job and uploads, while repo
// Z's `upload-rejected` record stays in `failed/`.
//
// Replaces:
//   - hook/.claude/telemetry_tool/__tests__/otel-receiver.test.js (45; one representative per class)
//   - hook/.claude/telemetry_tool/__tests__/otel-register.test.js — receiver side of register (≈ 6)
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { test, expect } from '../fixtures';
import {
  authedRequest,
  claudeProjectDir,
  clockShift,
  copyToolDir,
  copyToolDirTo,
  freeLoopbackPort,
  HOOK_SOURCE_DIR,
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
  runScript,
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

/** What a shared receiver answers in `capabilities` (DD-10); `upload-queue-v1` since hook 3.0.0. */
const CAPABILITIES = ['shared', 'auth-v1', 'spans', 'realtime', 'forward', 'session-status', 'upload-queue-v1'];

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

/**
 * Best effort: kill the receiver that holds `<home>/.artisyn/upload/uploader.lock` — one a hook run
 * spawned detached (DD-7) rather than the scenario, so `receivers` does not know it.
 */
function killUploaderOf(home: string | undefined): void {
  if (!home) return;
  try {
    const lock: unknown = JSON.parse(fs.readFileSync(path.join(home, '.artisyn', 'upload', 'uploader.lock'), 'utf8'));
    if (isRecord(lock) && typeof lock.pid === 'number' && lock.pid !== process.pid) process.kill(lock.pid);
  } catch {
    // no lock, or the process is already gone
  }
}

test('@S-HOOK-07 the OTEL receiver refuses browsers, foreign projects, path tricks and huge bodies @mode-a', async () => {
  test.setTimeout(420_000);
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
      // Hook 3.3.2+: one `first-record` line per session and signal names the producer (service and scope).
      const firstRecords = mirrorA.split('\n').filter((l) => l.includes(`first-record repo=${keyA} session=sa `));
      expect(firstRecords.map((l) => l.slice(l.indexOf('signal=')))).toEqual([
        `signal=logs service=claude-code serviceVersion=- scope=${SCOPE.name}@${SCOPE.version}`,
        `signal=metrics service=claude-code serviceVersion=- scope=${SCOPE.name}@${SCOPE.version}`,
      ]);
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

    // Steps 27, 29 and 30 (2026-11-18 receiver upload queue): the port conflict, retries,
    // `failed/`, the idle rule and a receiver killed mid-job. Each step gets its own fake home with
    // one queued `session-end` job, written like step 28's by a SessionEnd under a faked heartbeat.
    const queueSetup = async (hubUrl: string, sid: string, apiKey: string, port?: number) => {
      const qHome = makeFakeHome(dirs);
      const qState = await writeSharedState(qHome, port);
      const qTool = copyToolDirTo(path.join(qHome, '.claude', 'plugins', 'log-hub-hooks', 'scripts'));
      const qRepo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:scn/hook07/${sid}.git` });
      writeConfig(qRepo, { base: { ...QUIET_HOOK_CONFIG, serverUrl: hubUrl, sendLogsTimeoutMs: 10_000 }, local: { apiKey } });
      fs.writeFileSync(path.join(telemetryDir(qRepo), `${sid}.jsonl`), `{"event":"prompt_start","session_id":"${sid}"}\n`);
      fs.writeFileSync(path.join(claudeProjectDir(qHome, qRepo), `${sid}.jsonl`), `{"type":"user","sessionId":"${sid}"}\n`);
      const uploadState = path.join(qHome, '.artisyn', 'upload');
      const queueDir = path.join(uploadState, 'queue');
      const failedDir = path.join(uploadState, 'failed');
      const heartbeatFile = path.join(uploadState, 'heartbeat.json');
      fs.mkdirSync(uploadState, { recursive: true });
      fs.writeFileSync(heartbeatFile, JSON.stringify({ schema: 1, pid: process.pid, capabilities: ['upload-queue-v1'], uploadContract: 1, ts: Date.now() }));
      const end = await runHook(qTool, { hook_event_name: 'SessionEnd', session_id: sid, cwd: qRepo }, { home: qHome });
      expect(end.code, end.stderr).toBe(0);
      fs.rmSync(heartbeatFile);
      const queued = () => (fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((n) => n.endsWith('.json') || n.endsWith('.claim')).sort() : []);
      const [job] = queued();
      expect(job).toMatch(new RegExp(`^${sid}_\\d{8}T\\d{9}Z_session-end_\\d+-[0-9a-f]{4}\\.json$`));
      const readJob = (): Record<string, unknown> | null => {
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(path.join(queueDir, job), 'utf8'));
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      };
      const receiverLog = () => fs.readFileSync(path.join(qState.stateDir, 'receiver.log'), 'utf8');
      return { qHome, qState, qTool, qRepo, queueDir, failedDir, job, queued, readJob, receiverLog };
    };

    await test.step('27. port conflict: a foreign server on the shared port → the shared receiver that takes the uploader role stays up queue-only (heartbeat listening:false) and runs a queued job, a second receiver exits 0 (EADDRINUSE, no role); the hook warns «otel port-conflict» once and its SessionEnd otel-status says receiver-down / port-conflict', async () => {
      const foreign = await startFakeLogHub();
      // Each upload is answered after 1 s, so the job outlives the second receiver's start.
      const jobHub = await startFakeLogHub(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { status: 201, body: '{"warnings":[]}' };
      });
      let hookHome: string | undefined;
      try {
        // DD-8 phase 3: the uploader role does not need the OTLP port.
        const q = await queueSetup(jobHub.url, 'pq-1', 'k-hook07-queue-only', foreign.port);
        const heartbeatFile = path.join(q.qHome, '.artisyn', 'upload', 'heartbeat.json');
        const params = { home: q.qHome, stateDir: q.qState.stateDir, port: foreign.port, idleTimeoutMs: 2000 };
        const queueOnly = spawnSharedReceiver(q.qTool, params);
        receivers.push(queueOnly);
        await expect
          .poll(() => {
            try {
              const hb: unknown = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
              return isRecord(hb) && hb.pid === queueOnly.child.pid ? hb.listening : undefined;
            } catch {
              return undefined;
            }
          }, { timeout: 10_000 })
          .toBe(false);
        expect(queueOnly.exitCode(), 'queue-only: alive without the port').toBeUndefined();
        expect(q.receiverLog()).toContain(`queue-only: port ${foreign.port} busy`);

        // A second receiver finds the port busy and the uploader lock held by a live pid → exit 0.
        const second = spawnSharedReceiver(q.qTool, params);
        receivers.push(second);
        expect(await waitForExit(second, 10_000)).toBe(0);
        expect(queueOnly.exitCode(), 'the queue-only receiver keeps running').toBeUndefined();

        // The queued job runs under the queue-only receiver, then the empty queue lets it idle out.
        await expect.poll(() => jobHub.uploads().sort(), { timeout: 30_000 }).toEqual(['artisyn/pq-1', 'claude/pq-1']);
        await expect.poll(q.queued, { timeout: 20_000 }).toEqual([]);
        expect(jobHub.requests.every((r) => r.headers['x-api-key'] === 'k-hook07-queue-only')).toBe(true);
        expect(await waitForExit(queueOnly, 20_000)).toBe(0);
        const queueLog = q.receiverLog();
        expect(queueLog).toMatch(new RegExp(` job-done job=${q.job}`));
        expect(queueLog).toMatch(/idle-exit .*queue-only: no queued or running job/);
        expect(foreign.requests, 'the queue-only receiver never talks to the foreign listener').toHaveLength(0);
        const hello = await sharedHello(foreign.port, auth);
        expect(hello.proofValid).toBe(false);

        const repo = makeFakeGitRepo(dirs);
        hookHome = makeFakeHome(dirs);
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
        // The hook's fallback may have spawned its own queue-only receiver for hookHome (DD-7,
        // 10-min idle timeout): stop it, so nothing outlives the scenario.
        killUploaderOf(hookHome);
        await foreign.close();
        await jobHub.close();
      }
    });

    await test.step('28. upload queue (hook 3.0.0): a shared receiver takes the uploader role, writes heartbeat.json (DD-6), runs a queued session-end job against the fake Log Hub with --run-job and deletes it; it does not idle-exit while the job runs', async () => {
      // Each upload is answered after 2.5 s, so the job (two files) outlives the 1.5 s idle timeout.
      const slowHub = await startFakeLogHub(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return { status: 201, body: '{"warnings":[]}' };
      });
      try {
        const qHome = makeFakeHome(dirs);
        const qState = await writeSharedState(qHome);
        // The hook as a plugin under the fake home, so the receiver accepts its send-logs-hook.js.
        const qTool = copyToolDirTo(path.join(qHome, '.claude', 'plugins', 'log-hub-hooks', 'scripts'));
        const qRepo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/hook07/queue.git' });
        writeConfig(qRepo, { base: { ...QUIET_HOOK_CONFIG, serverUrl: slowHub.url, sendLogsTimeoutMs: 10_000 }, local: { apiKey: 'k-hook07-queue' } });
        fs.writeFileSync(path.join(telemetryDir(qRepo), 'q-1.jsonl'), '{"event":"prompt_start","session_id":"q-1"}\n');
        fs.writeFileSync(path.join(claudeProjectDir(qHome, qRepo), 'q-1.jsonl'), '{"type":"user","sessionId":"q-1"}\n');
        const uploadState = path.join(qHome, '.artisyn', 'upload');
        const queueDir = path.join(uploadState, 'queue');
        const heartbeatFile = path.join(uploadState, 'heartbeat.json');
        const queued = () => (fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((n) => n.endsWith('.json') || n.endsWith('.claim')) : []);

        // The job a SessionEnd leaves while an uploader is up (faked heartbeat), queued before any receiver runs.
        fs.mkdirSync(uploadState, { recursive: true });
        fs.writeFileSync(heartbeatFile, JSON.stringify({ schema: 1, pid: process.pid, capabilities: ['upload-queue-v1'], uploadContract: 1, ts: Date.now() }));
        const end = await runHook(qTool, { hook_event_name: 'SessionEnd', session_id: 'q-1', cwd: qRepo }, { home: qHome });
        expect(end.code, end.stderr).toBe(0);
        fs.rmSync(heartbeatFile);
        const [job] = queued();
        expect(job).toMatch(/^q-1_\d{8}T\d{9}Z_session-end_\d+-[0-9a-f]{4}\.json$/);
        expect(slowHub.requests).toHaveLength(0);

        const receiver = await startSharedReceiver(qTool, { home: qHome, stateDir: qState.stateDir, port: qState.port, idleTimeoutMs: 1500 });
        receivers.push(receiver);
        await expect
          .poll(() => {
            try {
              const hb: unknown = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
              return isRecord(hb) && hb.listening === true;
            } catch {
              return false;
            }
          }, { timeout: 10_000 })
          .toBe(true);
        const hb: unknown = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
        if (!isRecord(hb)) throw new Error('heartbeat.json is not an object');
        expect(hb).toMatchObject({ schema: 1, pid: receiver.child.pid, version, capabilities: CAPABILITIES, uploadContract: 1, listening: true });
        expect(Number.isFinite(Date.parse(String(hb.startedAt))), 'startedAt is an ISO time').toBe(true);
        expect(Math.abs(Date.now() - Number(hb.ts)), 'ts is fresh').toBeLessThan(15_000);
        const lock: unknown = JSON.parse(fs.readFileSync(path.join(uploadState, 'uploader.lock'), 'utf8'));
        expect(lock).toMatchObject({ pid: receiver.child.pid, version });

        // Drained on start: the job runs as `--run-job`, uploads the session's two files and is deleted.
        await expect.poll(() => slowHub.uploads().sort(), { timeout: 30_000 }).toEqual(['artisyn/q-1', 'claude/q-1']);
        await expect.poll(queued, { timeout: 20_000 }).toEqual([]);
        expect(slowHub.requests.every((r) => r.headers['x-api-key'] === 'k-hook07-queue')).toBe(true);
        expect(readHookLog(qRepo, 'send-logs-hook.js').some((l) => l.includes(`run-job done: ${job}`))).toBe(true);

        // The job ran for ≥ 5 s against a 1.5 s idle timeout: the receiver logged its end before idling out.
        expect(await waitForExit(receiver, 15_000)).toBe(0);
        const log = fs.readFileSync(path.join(qState.stateDir, 'receiver.log'), 'utf8').split('\n');
        const at = (event: string) => log.findIndex((l) => l.includes(` ${event} `) && (event === 'idle-exit' || l.includes(`job=${job}`)));
        expect(at('job-start'), log.join('\n')).toBeGreaterThan(-1);
        expect(at('job-done'), 'the job finished under this receiver').toBeGreaterThan(at('job-start'));
        expect(at('idle-exit'), 'no idle exit while the job ran').toBeGreaterThan(at('job-done'));
        expect(fs.existsSync(heartbeatFile), 'the heartbeat is removed on exit').toBe(false);
        expect(fs.existsSync(path.join(uploadState, 'uploader.lock')), 'the uploader lock is released on exit').toBe(false);
      } finally {
        await slowHub.close();
      }
    });

    await test.step('29. retries and failed/: a 503 makes the uploader reschedule the job (attempts 1, a future nextAttemptAt) and the receiver does not idle-exit while it waits; once due, a 400 sends it to failed/; the empty queue then lets the receiver idle-exit', async () => {
      const retryHub = await startFakeLogHub(() => ({ status: 503, body: '{"message":"maintenance"}' }));
      try {
        const q = await queueSetup(retryHub.url, 'rt-1', 'k-hook07-retry');
        const receiver = await startSharedReceiver(q.qTool, { home: q.qHome, stateDir: q.qState.stateDir, port: q.qState.port, idleTimeoutMs: 1500 });
        receivers.push(receiver);

        // Drain on start → --run-job → 503 → exit 10 with the job rewritten under its claim (DD-9).
        await expect.poll(() => (q.queued().length === 1 ? q.readJob()?.attempts : undefined), { timeout: 30_000 }).toBe(1);
        expect(q.queued(), 'the claim is released').toEqual([q.job]);
        const rescheduled = q.readJob();
        expect(rescheduled).toMatchObject({ attempts: 1 });
        expect(Number(rescheduled?.nextAttemptAt), 'backoffMs(1) = 30 s ahead').toBeGreaterThan(Date.now() + 10_000);
        expect(String(rescheduled?.lastError)).toMatch(/^retryable: /);
        expect(retryHub.requests.length).toBeGreaterThan(0);
        // The child rewrites the job before it exits; the receiver logs job-retry only on that exit,
        // so the line can land a moment after the rescheduled job is visible.
        await expect.poll(q.receiverLog, { timeout: 10_000 }).toMatch(new RegExp(` job-retry job=${q.job} exit=10 retryable — attempts=1 `));

        // A retryable job is a blocking job: three idle periods pass and the receiver keeps running.
        await new Promise((resolve) => setTimeout(resolve, 4500));
        expect(receiver.exitCode(), 'no idle-exit while a retryable job waits').toBeUndefined();
        expect(q.receiverLog()).not.toMatch(/idle-exit/);

        // The job comes due (nextAttemptAt rewritten atomically, like the uploader does) and now meets a 400.
        retryHub.respond(() => ({ status: 400, body: '{"message":"bad request"}' }));
        const tmp = path.join(q.queueDir, `.${q.job}.scn.tmp`);
        fs.writeFileSync(tmp, JSON.stringify({ ...rescheduled, nextAttemptAt: null }));
        // On Windows a rename over a file the receiver is reading at that moment fails with EPERM:
        // retry briefly, like a writer racing a reader would.
        await expect.poll(() => {
          try {
            fs.renameSync(tmp, path.join(q.queueDir, q.job));
            return true;
          } catch (err) {
            if (isRecord(err) && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) return false;
            throw err;
          }
        }, { timeout: 5000, intervals: [50] }).toBe(true);
        await expect.poll(() => fs.existsSync(path.join(q.failedDir, q.job)), { timeout: 30_000 }).toBe(true);
        expect(q.queued()).toEqual([]);
        const failed: unknown = JSON.parse(fs.readFileSync(path.join(q.failedDir, q.job), 'utf8'));
        expect(failed).toMatchObject({ sessionId: 'rt-1', trigger: 'session-end', attempts: 1, failedReason: 'upload-rejected' });
        expect(isRecord(failed) && Number.isFinite(Date.parse(String(failed.failedAt))), 'failedAt is an ISO time').toBe(true);
        // failJob() writes the failed/ record first and the hook.log line right after it, in another
        // process: wait for the line instead of reading the log the instant the record appears.
        await expect
          .poll(() => readHookLog(q.qRepo, 'send-logs-hook.js').some((l) => l.includes(`job failed: ${q.job} reason=upload-rejected`)), { timeout: 10_000 })
          .toBe(true);

        // Nothing blocks any more: the receiver idles out after the job went to failed/.
        expect(await waitForExit(receiver, 15_000)).toBe(0);
        const log = q.receiverLog().split('\n');
        const failedAt = log.findIndex((l) => l.includes(` job-failed job=${q.job} exit=11`));
        expect(failedAt, log.join('\n')).toBeGreaterThan(-1);
        expect(log.findIndex((l) => l.includes(' idle-exit ')), 'idle-exit after the job left the queue').toBeGreaterThan(failedAt);
      } finally {
        await retryHub.close();
      }
    });

    await test.step('30. AC-2: the receiver (and its uploader) is killed while the job uploads; a new receiver takes the stale uploader lock, re-runs the job past its dead claim and the server gets the same uploads', async () => {
      const slowHub = await startFakeLogHub(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { status: 201, body: '{"warnings":[]}' };
      });
      try {
        const q = await queueSetup(slowHub.url, 'kj-1', 'k-hook07-kill');
        const first = await startSharedReceiver(q.qTool, { home: q.qHome, stateDir: q.qState.stateDir, port: q.qState.port });
        receivers.push(first);
        const claimFile = path.join(q.queueDir, `${q.job}.claim`);
        await expect.poll(() => fs.existsSync(claimFile) && slowHub.requests.length > 0, { timeout: 30_000, intervals: [100] }).toBe(true);
        const claim: unknown = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
        if (!isRecord(claim) || typeof claim.pid !== 'number') throw new Error(`claim has no pid: ${JSON.stringify(claim)}`);
        const uploaderPid = claim.pid;
        expect(uploaderPid).not.toBe(first.child.pid);

        // A hard kill: no exit handler runs, so heartbeat.json, uploader.lock and the claim stay behind.
        first.child.kill('SIGKILL');
        await waitForExit(first, 5000);
        try {
          process.kill(uploaderPid, 'SIGKILL');
        } catch {
          // already gone
        }
        const alive = (pid: number) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        await expect.poll(() => alive(uploaderPid), { timeout: 10_000 }).toBe(false);
        expect(q.queued(), 'the job and its dead claim are left').toEqual([q.job, `${q.job}.claim`]);
        expect(fs.existsSync(path.join(q.qHome, '.artisyn', 'upload', 'uploader.lock'))).toBe(true);
        expect(slowHub.uploads().filter((u) => u === 'claude/kj-1' || u === 'artisyn/kj-1').length, 'the killed run did not finish').toBeLessThan(2);

        const second = await startSharedReceiver(q.qTool, { home: q.qHome, stateDir: q.qState.stateDir, port: q.qState.port });
        receivers.push(second);
        await expect.poll(q.queued, { timeout: 40_000 }).toEqual([]);
        const lock: unknown = JSON.parse(fs.readFileSync(path.join(q.qHome, '.artisyn', 'upload', 'uploader.lock'), 'utf8'));
        expect(lock, 'the stale uploader lock was retaken').toMatchObject({ pid: second.child.pid });
        expect(new Set(slowHub.uploads()), 'the same uploads as an uninterrupted run').toEqual(new Set(['artisyn/kj-1', 'claude/kj-1']));
        expect(slowHub.requests.every((r) => r.headers['x-api-key'] === 'k-hook07-kill')).toBe(true);
        expect(readHookLog(q.qRepo, 'send-logs-hook.js').some((l) => l.includes(`run-job done: ${q.job}`))).toBe(true);
        expect(fs.existsSync(path.join(telemetryDir(q.qRepo), '.upload.lock')), 'the dead uploader’s repo lock is freed').toBe(false);
        await stopReceiver(second);
      } finally {
        await slowHub.close();
      }
    });

    await test.step('31. phase 3: one receiver serves repo A (otelEnabled:true) and repo B (otelEnabled:false); the lifecycle re-arm registers both, the session-end jobs of both upload, and OTLP records are stored only for A — no chunk under B’s otel dir', async () => {
      const mixHub = await startFakeLogHub();
      const mHome = makeFakeHome(dirs);
      try {
        const mState = await writeSharedState(mHome);
        const mTool = copyToolDirTo(path.join(mHome, '.claude', 'plugins', 'log-hub-hooks', 'scripts'));
        const mEnv = { ARTISYN_MANAGED_SETTINGS_DIR: dirs.make('no-managed'), ...pathWith(writeFakeClaude(dirs, 'fail').dir) };
        const repos = [
          { sid: 'mx-a', otelEnabled: true, apiKey: 'k-hook07-mix-a' },
          { sid: 'mx-b', otelEnabled: false, apiKey: 'k-hook07-mix-b' },
        ].map((r) => {
          const root = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:scn/hook07/${r.sid}.git` });
          writeConfig(root, {
            base: { ...QUIET_HOOK_CONFIG, otelEnabled: r.otelEnabled, otelRealtime: false, serverUrl: mixHub.url, sendLogsTimeoutMs: 10_000 },
            local: { apiKey: r.apiKey },
          });
          fs.writeFileSync(path.join(telemetryDir(root), `${r.sid}.jsonl`), `{"event":"prompt_start","session_id":"${r.sid}"}\n`);
          fs.writeFileSync(path.join(claudeProjectDir(mHome, root), `${r.sid}.jsonl`), `{"type":"user","sessionId":"${r.sid}"}\n`);
          return { ...r, root, otelDir: path.join(telemetryDir(root), 'otel') };
        });
        const [a, b] = repos;
        const receiver = await startSharedReceiver(mTool, { home: mHome, stateDir: mState.stateDir, port: mState.port });
        receivers.push(receiver);
        const mAuth = { token: mState.token, home: mHome };

        // The lifecycle re-arm of a tool event registers each session — B's with every signal off.
        for (const r of repos) {
          const rearm = await runScript(mTool, 'lifecycle-hook.js', { hook_event_name: 'PostToolUse', session_id: r.sid, cwd: r.root }, { home: mHome, env: mEnv });
          expect(rearm.code, rearm.stderr).toBe(0);
          const st = await authedRequest(mState.port, '/artisyn/session-status', { sessionId: r.sid }, mAuth);
          expect(st.json, `${r.sid} registered by the re-arm`).toMatchObject({ registered: true });
        }
        const otlp = await rawRequest(mState.port, '/v1/logs', logsBody([{ sessionId: 'mx-a', nano: '1735689600000031001' }, { sessionId: 'mx-b', nano: '1735689600000031002' }]));
        expect(otlp.status, otlp.body).toBe(200);
        expect(sessionLines(a.otelDir, 'mx-a').map((l) => l.signal)).toEqual(['logs']);
        const chunksUnder = (dir: string): string[] => {
          if (!fs.existsSync(dir)) return [];
          return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? chunksUnder(path.join(dir, e.name)) : e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []);
        };
        expect(chunksUnder(b.otelDir), 'otelEnabled:false stores no OTLP record').toEqual([]);

        // Both SessionEnds hand off to the one uploader; each job uploads with its own repo's key.
        for (const r of repos) {
          const end = await runHook(mTool, { hook_event_name: 'SessionEnd', session_id: r.sid, cwd: r.root }, { home: mHome, env: mEnv });
          expect(end.code, end.stderr).toBe(0);
          expect(readHookLog(r.root, 'send-logs-hook.js').some((l) => l.includes(`queued: job=${r.sid}_`)), `${r.sid} handed off`).toBe(true);
        }
        const mQueue = path.join(mHome, '.artisyn', 'upload', 'queue');
        await expect.poll(() => (fs.existsSync(mQueue) ? fs.readdirSync(mQueue).filter((n) => n.endsWith('.json') || n.endsWith('.claim')) : []), { timeout: 30_000 }).toEqual([]);
        const uploads = mixHub.uploads();
        expect(uploads).toEqual(expect.arrayContaining(['artisyn/mx-a', 'claude/mx-a', 'artisyn/mx-b', 'claude/mx-b']));
        for (const req of mixHub.requests) {
          const repo = repos.find((r) => r.sid === req.sessionId);
          if (repo) expect(req.headers['x-api-key'], `${req.type}/${req.sessionId}`).toBe(repo.apiKey);
        }
        expect(chunksUnder(b.otelDir)).toEqual([]);
        await stopReceiver(receiver);
      } finally {
        killUploaderOf(mHome);
        await mixHub.close();
      }
    });

    await test.step('32. two repos whose hook copies differ (3.0.0 and a copy set to 3.0.1) each queue a stop job: each uploaded hook-status carries the hookVersion of its own repo’s copy and a nodeVersion', async () => {
      const verHub = await startFakeLogHub();
      const vHome = makeFakeHome(dirs);
      try {
        const vState = await writeSharedState(vHome);
        const baseVersion: string = JSON.parse(fs.readFileSync(path.join(HOOK_SOURCE_DIR, 'version.json'), 'utf8')).version;
        const copies = [
          { sid: 'vv-1', version: baseVersion, plugin: 'log-hub-hooks' },
          { sid: 'vv-2', version: '3.0.1', plugin: 'log-hub-hooks-next' },
        ].map((c) => {
          const tool = copyToolDirTo(path.join(vHome, '.claude', 'plugins', c.plugin, 'scripts'));
          fs.writeFileSync(path.join(tool, 'version.json'), JSON.stringify({ version: c.version }, null, 2));
          const root = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:scn/hook07/${c.sid}.git` });
          writeConfig(root, { base: { ...QUIET_HOOK_CONFIG, serverUrl: verHub.url, sendLogsTimeoutMs: 10_000 }, local: { apiKey: `k-hook07-${c.sid}` } });
          fs.writeFileSync(path.join(telemetryDir(root), `${c.sid}.jsonl`), `{"event":"prompt_start","session_id":"${c.sid}"}\n`);
          fs.writeFileSync(path.join(claudeProjectDir(vHome, root), `${c.sid}.jsonl`), `{"type":"user","sessionId":"${c.sid}"}\n`);
          return { ...c, tool, root };
        });
        // One receiver (from the first copy) runs both jobs, each with the uploader that queued it.
        // `stop` jobs: their full scan is the run that carries hook-status (a session-end job only
        // flushes the session's files).
        const receiver = await startSharedReceiver(copies[0].tool, { home: vHome, stateDir: vState.stateDir, port: vState.port });
        receivers.push(receiver);
        for (const c of copies) {
          const stop = await runHook(c.tool, { hook_event_name: 'Stop', session_id: c.sid, cwd: c.root }, { home: vHome });
          expect(stop.code, stop.stderr).toBe(0);
          expect(readHookLog(c.root, 'send-logs-hook.js').some((l) => l.includes(`queued: job=${c.sid}_`)), `${c.sid} handed off`).toBe(true);
        }
        const vQueue = path.join(vHome, '.artisyn', 'upload', 'queue');
        await expect.poll(() => (fs.existsSync(vQueue) ? fs.readdirSync(vQueue).filter((n) => n.endsWith('.json') || n.endsWith('.claim')) : []), { timeout: 30_000 }).toEqual([]);
        for (const c of copies) {
          const artisyn = verHub.requests.filter((r) => r.type === 'artisyn' && r.sessionId === c.sid);
          expect(artisyn.length, `artisyn/${c.sid} uploaded`).toBeGreaterThan(0);
          const body = (artisyn[0].headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(artisyn[0].body) : artisyn[0].body).toString('utf8');
          const statuses = body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.type === 'hook-status');
          expect(statuses, `${c.sid}: one hook-status`).toHaveLength(1);
          expect(statuses[0]).toMatchObject({ hookVersion: c.version, nodeVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) });
          expect(statuses[0]).toMatchObject({ uploadQueue: expect.objectContaining({ mode: 'job' }) });
        }
        await stopReceiver(receiver);
      } finally {
        killUploaderOf(vHome);
        await verHub.close();
      }
    });

    await test.step('33. after reboot: a stale uploader.lock, heartbeat.json and claim of a dead pid; failed/ holds a max-attempts job of repo X and an upload-rejected job of repo Z, the queue a job of repo Y. The receiver takes the role, runs Y (done), then re-queues X as one stop job that uploads; X’s failed/ record is gone, Z’s stays', async () => {
      const rqHub = await startFakeLogHub();
      let rqHome: string | undefined;
      try {
        // Repo Y: its session-end job is queued (queueSetup fakes a fresh heartbeat for the hand-off).
        const q = await queueSetup(rqHub.url, 'rq-y', 'k-hook07-rq-y');
        rqHome = q.qHome;
        const uploadState = path.join(q.qHome, '.artisyn', 'upload');
        const heartbeatFile = path.join(uploadState, 'heartbeat.json');
        // Repos X and Z of the same user: each hands a session-end job off, which is then turned
        // into its failed/ record — X ran out of attempts (no connection), Z was refused with a 4xx.
        const failedOf = async (sid: string, reason: string, extra: Record<string, unknown>) => {
          const root = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:scn/hook07/${sid}.git` });
          writeConfig(root, { base: { ...QUIET_HOOK_CONFIG, serverUrl: rqHub.url, sendLogsTimeoutMs: 10_000 }, local: { apiKey: `k-hook07-${sid}` } });
          fs.writeFileSync(path.join(telemetryDir(root), `${sid}.jsonl`), `{"event":"prompt_start","session_id":"${sid}"}\n`);
          fs.writeFileSync(path.join(claudeProjectDir(q.qHome, root), `${sid}.jsonl`), `{"type":"user","sessionId":"${sid}"}\n`);
          fs.writeFileSync(heartbeatFile, JSON.stringify({ schema: 1, pid: process.pid, capabilities: ['upload-queue-v1'], uploadContract: 1, ts: Date.now() }));
          const end = await runHook(q.qTool, { hook_event_name: 'SessionEnd', session_id: sid, cwd: root }, { home: q.qHome });
          expect(end.code, end.stderr).toBe(0);
          fs.rmSync(heartbeatFile);
          const name = q.queued().find((n) => n.startsWith(`${sid}_`));
          if (!name) throw new Error(`no queued job of ${sid}: ${JSON.stringify(q.queued())}`);
          const job: unknown = JSON.parse(fs.readFileSync(path.join(q.queueDir, name), 'utf8'));
          if (!isRecord(job)) throw new Error(`${name} is not an object`);
          fs.mkdirSync(q.failedDir, { recursive: true });
          fs.writeFileSync(path.join(q.failedDir, name), JSON.stringify({ ...job, ...extra, failedAt: new Date().toISOString(), failedReason: reason }, null, 2));
          fs.rmSync(path.join(q.queueDir, name));
          return { sid, root, name };
        };
        const x = await failedOf('rq-x', 'max-attempts', { attempts: 10, lastError: 'retryable: server unreachable' });
        const z = await failedOf('rq-z', 'upload-rejected', { attempts: 1, lastError: 'permanent: HTTP 400' });
        expect(q.queued()).toEqual([q.job]);

        // The state a power-off leaves: lock, heartbeat and Y's claim all name a pid that is gone.
        const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
        const deadAt = new Date(Date.now() - 600_000).toISOString();
        fs.writeFileSync(path.join(uploadState, 'uploader.lock'), JSON.stringify({ pid: deadPid, startedAt: deadAt, version: '3.0.0' }));
        fs.writeFileSync(heartbeatFile, JSON.stringify({ schema: 1, pid: deadPid, capabilities: ['upload-queue-v1'], uploadContract: 1, listening: true, startedAt: deadAt, ts: Date.now() - 600_000 }));
        fs.writeFileSync(path.join(q.queueDir, `${q.job}.claim`), JSON.stringify({ pid: deadPid, startedAt: deadAt }));

        const receiver = await startSharedReceiver(q.qTool, { home: q.qHome, stateDir: q.qState.stateDir, port: q.qState.port });
        receivers.push(receiver);

        // Y runs first (drain), then X comes back from failed/ as one stop job and uploads too.
        await expect.poll(() => rqHub.uploads(), { timeout: 40_000 }).toEqual(expect.arrayContaining(['artisyn/rq-y', 'claude/rq-y', 'artisyn/rq-x', 'claude/rq-x']));
        await expect.poll(q.queued, { timeout: 30_000 }).toEqual([]);
        const lock: unknown = JSON.parse(fs.readFileSync(path.join(uploadState, 'uploader.lock'), 'utf8'));
        expect(lock, 'the stale uploader lock was retaken').toMatchObject({ pid: receiver.child.pid });
        expect(fs.existsSync(path.join(q.failedDir, x.name)), 'X’s failed/ record is gone').toBe(false);
        expect(fs.existsSync(path.join(q.failedDir, z.name)), 'Z’s upload-rejected record stays').toBe(true);
        expect(rqHub.uploads().some((u) => u.endsWith('/rq-z')), 'Z is never retried').toBe(false);
        for (const req of rqHub.requests) {
          if (req.sessionId === 'rq-x') expect(req.headers['x-api-key'], `${req.type}/rq-x`).toBe('k-hook07-rq-x');
        }

        const log = q.receiverLog().split('\n');
        const yDone = log.findIndex((l) => l.includes(` job-done job=${q.job} exit=0`));
        const requeued = log.findIndex((l) => l.includes(' job-requeued '));
        expect(yDone, log.join('\n')).toBeGreaterThan(-1);
        expect(requeued, 'X is re-queued after Y is done').toBeGreaterThan(yDone);
        const requeuedLine = log[requeued];
        const m = /job-requeued (rq-x_\d{8}T\d{9}Z_stop_\d+-[0-9a-f]{4}\.json) from 1 failed \(max-attempts\) requeueCount=1/.exec(requeuedLine);
        expect(m, requeuedLine).not.toBeNull();
        const newJob = m ? m[1] : '';
        expect(log.filter((l) => l.includes(' job-requeued ')), 'one re-queued job, none for Z').toHaveLength(1);
        // The uploader deletes the job before it exits, so the receiver's job-done line may trail the empty queue.
        await expect.poll(() => q.receiverLog().includes(` job-done job=${newJob} exit=0`), { timeout: 10_000, message: 'the re-queued stop job finished done' }).toBe(true);
        expect(readHookLog(x.root, 'send-logs-hook.js').some((l) => l.includes(`run-job done: ${newJob}`))).toBe(true);
        await stopReceiver(receiver);
      } finally {
        killUploaderOf(rqHome);
        await rqHub.close();
      }
    });
  } finally {
    for (const r of receivers) await stopReceiver(r);
    await hub?.close();
    await collector?.close();
    dirs.cleanup();
  }
});
