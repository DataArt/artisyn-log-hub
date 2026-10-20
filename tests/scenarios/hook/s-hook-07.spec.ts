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
// Replaces:
//   - hook/.claude/telemetry_tool/__tests__/otel-receiver.test.js (45; one representative per class)
//   - hook/.claude/telemetry_tool/__tests__/otel-register.test.js — receiver side of register (≈ 6)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { test, expect } from '../fixtures';
import {
  copyToolDir,
  freeLoopbackPort,
  isRecord,
  rawRequest,
  spawnReceiver,
  startReceiver,
  stopReceiver,
  tempDirs,
  waitForExit,
  type ReceiverProcess,
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
  test.setTimeout(120_000);
  const dirs = tempDirs();
  const receivers: ReceiverProcess[] = [];
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
      expect((await rawRequest(mainPort, '/v1/traces', { resourceSpans: [] })).status).toBe(404);
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
  } finally {
    for (const r of receivers) await stopReceiver(r);
    dirs.cleanup();
  }
});
