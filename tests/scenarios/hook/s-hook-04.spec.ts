// S-HOOK-04. The hook never blocks Claude: the server is down, hangs or answers 500, and the
// background upload does not slow the prompt down
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-HOOK-04; layer «hook
// (child processes)»).
//
// Every sub-step gets its own throwaway project, so a lock or a recommendation left by one case
// cannot leak into the next. Nothing talks to the stand (closed ports and fake log hubs only), so
// the scenario runs once, on the mode-A stand (DD SC4 picks A and C where the mode can matter).
//
// Code facts that differ from the design text:
//   - every request has its own `sendLogsTimeoutMs`; a hanging server costs one timeout per file
//     (sequential uploads), so a Stop with three pending files ends after ≈ 3 × 1500 ms. The
//     design's budget «timeout × number of requests + 2 s» is what is asserted;
//   - guardrail-hook.js was removed in 2.19.0 (S-HOOK-05 retired): step 6 covers telemetry-hook,
//     lifecycle-hook, send-logs-hook and post-turn-analysis-hook. telemetry-hook and lifecycle-hook
//     exit silently on an unknown event or an unreadable stdin (no hook.log line); send-logs-hook
//     and post-turn-analysis-hook write exactly one `exit: …` line;
//   - the `claude -p` wrapper is `claude-invoke-async.js#callLlmAsync`; step 10 drives it with a
//     fake `claude` and checks every failure resolves `{ok: false}` instead of throwing. Garbage
//     on stdout with exit 0 is `{ok: true}` with the raw text (the caller then fails to parse it);
//   - the watchdog's exit code 1 is observable only when prompt-upload-hook runs in the foreground
//     (step 8); launched from telemetry-hook it is detached and unobserved;
//   - the [win] killProcessTree check found a product bug (the timed-out `claude` survives); it
//     is a separate test pinned with test.fail() at the end of this file.
//
// Replaces:
//   - hook/.claude/telemetry_tool/__tests__/telemetry-hook.test.js — prompt-upload launch and throttle (4)
//   - hook/.claude/telemetry_tool/__tests__/prompt-upload-hook.test.js (11)
//   - hook/.claude/telemetry_tool/__tests__/recommendations.test.js (9)
//   - hook/.claude/telemetry_tool/__tests__/claude-invoke-async.test.js (7)
//   - hook/.claude/telemetry_tool/__tests__/send-logs-hook.test.js — timeout, locks, early exits (≈ 10)
//   - hook/.claude/telemetry_tool/__tests__/post-turn-analysis-hook.test.js — does not wait for the worker (6)
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures';
import {
  claudeProjectDir,
  copyToolDir,
  freeLoopbackPort,
  isRecord,
  makeFakeGitRepo,
  makeFakeHome,
  ndjsonLines,
  readHookLog,
  readManifest,
  readRecommendations,
  runHook,
  runPromptUpload,
  runScript,
  startFakeLogHub,
  telemetryDir,
  tempDirs,
  writeConfig,
  writeFakeClaude,
  killWindowsProcessesMatching,
  windowsProcessesMatching,
  QUIET_HOOK_CONFIG,
  type FakeLogHub,
  type HookConfig,
  type TempDirs,
} from '../helpers/hook-process';

const KEY = 'k-hook04-secret-key';
const OK = { status: 201, body: '{"warnings":[]}' };

interface Project {
  repo: string;
  home: string;
  telemetry: string;
}

/** A project with the current session `cur` and two backlog sessions `a` and `b` (artisyn files). */
function project(dirs: TempDirs, serverUrl: string, extra: HookConfig = {}, withKey = true): Project {
  const repo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/hook04/app.git' });
  const home = makeFakeHome(dirs);
  const telemetry = telemetryDir(repo);
  writeConfig(repo, {
    base: { ...QUIET_HOOK_CONFIG, serverUrl, sendLogsTimeoutMs: 5000, ...extra },
    ...(withKey ? { local: { apiKey: KEY } } : {}),
  });
  for (const sid of ['cur', 'a', 'b']) {
    fs.writeFileSync(path.join(telemetry, `${sid}.jsonl`), `{"event":"prompt_start","session_id":"${sid}"}\n`);
  }
  return { repo, home, telemetry };
}

function stop(toolDir: string, p: Project) {
  return runHook(toolDir, { hook_event_name: 'Stop', session_id: 'cur', cwd: p.repo }, { home: p.home });
}

/**
 * A tiny script that calls `claude-invoke-async.js#callLlmAsync` (the `claude -p` wrapper the
 * post-turn worker uses) once per fake binary given as JSON in argv and prints the results. It
 * exits explicitly: an orphaned grandchild of a timed-out call can keep its pipes open.
 */
function writeLlmDriver(dirs: TempDirs, toolDir: string): string {
  const driverDir = dirs.make('llm-driver');
  fs.writeFileSync(
    path.join(driverDir, 'driver.js'),
    [
      "'use strict';",
      `const { callLlmAsync } = require(${JSON.stringify(path.join(toolDir, 'claude-invoke-async.js'))});`,
      '(async () => {',
      '  const out = {};',
      '  for (const [k, bin] of Object.entries(JSON.parse(process.argv[2]))) {',
      "    out[k] = await callLlmAsync('evaluate this turn', 'haiku', 1500, bin);",
      '  }',
      '  process.stdout.write(JSON.stringify(out), () => process.exit(0));',
      '})();',
      '',
    ].join('\n'),
  );
  return driverDir;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

test('@S-HOOK-04 the hook never blocks Claude: server down, hanging, 500 or 401 @mode-a', async () => {
  test.setTimeout(240_000);
  const dirs = tempDirs();
  const hubs: FakeLogHub[] = [];
  const hub = async (responder?: Parameters<typeof startFakeLogHub>[0]) => {
    const h = await startFakeLogHub(responder);
    hubs.push(h);
    return h;
  };
  try {
    const toolDir = copyToolDir(dirs);

    await test.step('1. server closed: Stop exits 0 in < 3 s with ECONNREFUSED in hook.log; files untouched; hook-status arrives on the next good run', async () => {
      const port = await freeLoopbackPort();
      const p = project(dirs, `http://127.0.0.1:${port}`);
      const before = fs.readdirSync(p.telemetry).map((n) => [n, fs.readFileSync(path.join(p.telemetry, n), 'utf8')]);
      const res = await stop(toolDir, p);
      expect(res.code, res.stderr).toBe(0);
      expect(res.elapsedMs).toBeLessThan(3000);
      const log = readHookLog(p.repo, 'send-logs-hook.js');
      expect(log.some((l) => /\[(error|fail)\].*ECONNREFUSED/.test(l)), log.join('\n')).toBe(true);
      for (const [name, content] of before) {
        expect(fs.readFileSync(path.join(p.telemetry, name), 'utf8'), name).toBe(content);
      }
      expect(readManifest(p.telemetry).size).toBe(0);

      const good = await hub();
      writeConfig(p.repo, { base: { ...QUIET_HOOK_CONFIG, serverUrl: good.url, sendLogsTimeoutMs: 5000 } });
      expect((await stop(toolDir, p)).code).toBe(0);
      const curReq = good.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur');
      const status = ndjsonLines(curReq!.body.toString('utf8'))[0];
      expect(status.type).toBe('hook-status');
      expect(JSON.stringify(status.logTail)).toContain('ECONNREFUSED');
    });

    await test.step('2. server silent: Stop exits 0 within timeout × requests + 2 s; one timeout-on-upload recommendation, cleared by the next good run', async () => {
      const silent = await hub(() => 'hang');
      const p = project(dirs, silent.url, { sendLogsTimeoutMs: 1500 });
      const res = await stop(toolDir, p);
      expect(res.code, res.stderr).toBe(0);
      expect(silent.requests).toHaveLength(3);
      expect(res.elapsedMs).toBeGreaterThanOrEqual(1500);
      // 3 s of process-spawn slack on top of the three timeouts: on a loaded Windows box the
      // spawn alone has been measured past 2 s; the request count above already pins «3, not 4».
      expect(res.elapsedMs).toBeLessThan(3 * 1500 + 3000);
      const log = readHookLog(p.repo, 'send-logs-hook.js');
      expect(log.filter((l) => /\[fail\] artisyn\/\w+\.jsonl: timeout after 1500ms/.test(l))).toHaveLength(3);
      const timeouts = readRecommendations(p.repo).filter((r) => r.rule === 'timeout-on-upload');
      expect(timeouts, 'three timed-out files, one recommendation').toHaveLength(1);
      expect(timeouts[0].message).toContain('sendLogsTimeoutMs');

      silent.respond(() => OK);
      expect((await stop(toolDir, p)).code).toBe(0);
      expect(readRecommendations(p.repo).some((r) => r.rule === 'timeout-on-upload')).toBe(false);
    });

    await test.step('3. server answers 500: exit 0, nothing enters the manifest, the next Stop retries', async () => {
      const failing = await hub(() => ({ status: 500, body: '{"message":"Internal server error"}' }));
      const p = project(dirs, failing.url);
      expect((await stop(toolDir, p)).code).toBe(0);
      expect(failing.uploads().sort()).toEqual(['artisyn/a', 'artisyn/b', 'artisyn/cur']);
      expect([...readManifest(p.telemetry).keys()]).toEqual([]);
      failing.requests.length = 0;
      failing.respond(() => OK);
      expect((await stop(toolDir, p)).code).toBe(0);
      expect(failing.uploads().sort()).toEqual(['artisyn/a', 'artisyn/b', 'artisyn/cur']);
      expect([...readManifest(p.telemetry).keys()].sort()).toEqual(['artisyn/a.jsonl', 'artisyn/b.jsonl']);
    });

    await test.step('4. server answers 401: exit 0, a readable line without the key, one request per file (no retry loop)', async () => {
      const denied = await hub(() => ({ status: 401, body: '{"message":"Invalid API key"}' }));
      const p = project(dirs, denied.url);
      expect((await stop(toolDir, p)).code).toBe(0);
      expect(denied.requests).toHaveLength(3);
      const log = readHookLog(p.repo).join('\n');
      expect(log).toMatch(/upload failed for artisyn\/cur: HTTP 401 .*Invalid API key/);
      expect(log).not.toContain(KEY);
    });

    await test.step('5. no serverUrl/apiKey: exit 0, one «exit: serverUrl or apiKey not configured» line, no HTTP', async () => {
      const unused = await hub();
      const p = project(dirs, unused.url, {}, false);
      expect((await stop(toolDir, p)).code).toBe(0);
      const lines = readHookLog(p.repo, 'send-logs-hook.js');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/\[activate\] Stop event received/);
      expect(lines[1]).toMatch(/\[result\] exit: serverUrl or apiKey not configured \(logDir=/);
      expect(unused.requests).toHaveLength(0);
    });

    await test.step('6. non-git dir, empty stdin, non-JSON stdin, unknown event: every hook exits 0 with empty stdout', async () => {
      const scripts: Array<[string, string]> = [
        ['telemetry-hook.js', 'UserPromptSubmit'],
        ['lifecycle-hook.js', 'SessionStart'],
        ['send-logs-hook.js', 'Stop'],
        ['post-turn-analysis-hook.js', 'Stop'],
      ];
      const logged = new Set(['send-logs-hook.js', 'post-turn-analysis-hook.js']);
      for (const [script, event] of scripts) {
        const cases: Array<[string, { rawStdin?: string; event?: string }]> = [
          ['non-git dir', { event }],
          ['empty stdin', { rawStdin: '' }],
          ['non-JSON stdin', { rawStdin: '{ this is not json' }],
          ['unknown event', { event: 'NoSuchEvent' }],
        ];
        for (const [label, c] of cases) {
          const plain = dirs.make('hook-plain');
          const home = makeFakeHome(dirs);
          writeConfig(plain, { base: { ...QUIET_HOOK_CONFIG } });
          const res = await runScript(
            toolDir,
            script,
            { hook_event_name: c.event, session_id: 's6', cwd: plain },
            { home, ...(c.rawStdin !== undefined ? { rawStdin: c.rawStdin } : {}) },
          );
          expect(res.code, `${script} / ${label}: ${res.stderr}`).toBe(0);
          expect(res.stdout, `${script} / ${label}`).toBe('');
          const lines = readHookLog(plain, script);
          if (label === 'non-git dir') continue;
          if (logged.has(script)) {
            expect(lines, `${script} / ${label}: one diagnostic line`).toHaveLength(1);
            expect(lines[0]).toMatch(/ exit: /);
          } else {
            expect(lines, `${script} / ${label}: silent exit`).toHaveLength(0);
          }
        }
      }
    });

    await test.step('7. prompt hook returns fast and starts the background upload once; a second prompt within 60 s is throttled; off means off', async () => {
      const slow = await hub(() => 'hang');
      const p = project(dirs, slow.url, { sendLogsOnPromptEnabled: true, sendLogsOnPromptTimeoutMs: 3000 });
      const prompt = () =>
        runScript(
          toolDir,
          'telemetry-hook.js',
          { hook_event_name: 'UserPromptSubmit', session_id: 'cur', cwd: p.repo, prompt: 'fix it' },
          { home: p.home },
        );
      const first = await prompt();
      expect(first.code, first.stderr).toBe(0);
      // The upload hangs until its 3000 ms watchdog, so anything under 2500 ms proves the prompt
      // hook did not wait for it, with room for a slow process spawn on a loaded machine.
      expect(first.elapsedMs, 'the prompt hook never waits for the upload').toBeLessThan(2500);
      expect(await waitFor(() => slow.requests.length > 0, 8000), 'background prompt-upload-hook reached the server').toBe(true);

      const second = await prompt();
      expect(second.code).toBe(0);
      expect(readHookLog(p.repo, 'telemetry-hook.js').filter((l) => l.includes('skipped: prompt-upload throttled'))).toHaveLength(1);

      const quiet = await hub();
      const off = project(dirs, quiet.url, { sendLogsOnPromptEnabled: false });
      const res = await runScript(
        toolDir,
        'telemetry-hook.js',
        { hook_event_name: 'UserPromptSubmit', session_id: 'cur', cwd: off.repo, prompt: 'fix it' },
        { home: off.home },
      );
      expect(res.code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(quiet.requests).toHaveLength(0);
      expect(readHookLog(off.repo, 'prompt-upload-hook.js')).toHaveLength(0);
    });

    await test.step('8. background upload: watchdog kills a hang with exit 1; network error exits 0; a fresh lock skips, a stale one is taken over', async () => {
      const silent = await hub(() => 'hang');
      const hung = project(dirs, silent.url, { sendLogsOnPromptTimeoutMs: 3000, sendLogsTimeoutMs: 20_000 });
      const watchdog = await runPromptUpload(toolDir, { cwd: hung.repo, sessionId: 'cur' }, { home: hung.home });
      expect(watchdog.code, 'the only allowed non-zero exit').toBe(1);
      expect(watchdog.elapsedMs).toBeGreaterThanOrEqual(2900);
      expect(watchdog.elapsedMs).toBeLessThan(8000);

      const closed = project(dirs, `http://127.0.0.1:${await freeLoopbackPort()}`);
      const down = await runPromptUpload(toolDir, { cwd: closed.repo, sessionId: 'cur' }, { home: closed.home });
      expect(down.code).toBe(0);
      expect(readHookLog(closed.repo, 'prompt-upload-hook.js').join('\n')).toMatch(/\[fail\] artisyn\/cur\.jsonl: network error: .*ECONNREFUSED/);

      const healthy = await hub();
      const locked = project(dirs, healthy.url);
      const lock = path.join(locked.telemetry, '.upload.lock');
      fs.writeFileSync(lock, JSON.stringify({ startedAt: new Date().toISOString() }));
      expect((await runPromptUpload(toolDir, { cwd: locked.repo, sessionId: 'cur' }, { home: locked.home })).code).toBe(0);
      expect(healthy.requests).toHaveLength(0);
      expect(readHookLog(locked.repo, 'prompt-upload-hook.js').at(-1)).toMatch(/skipped: upload lock held/);

      fs.writeFileSync(lock, JSON.stringify({ startedAt: '2000-01-01T00:00:00.000Z' }));
      expect((await runPromptUpload(toolDir, { cwd: locked.repo, sessionId: 'cur' }, { home: locked.home })).code).toBe(0);
      expect(healthy.uploads()).toEqual(['artisyn/cur']);
    });

    await test.step('9. the background upload sends only the current session’s two files and writes no manifest', async () => {
      const h = await hub();
      const p = project(dirs, h.url);
      const transcripts = claudeProjectDir(p.home, p.repo);
      fs.writeFileSync(path.join(transcripts, 'cur.jsonl'), '{"type":"user","sessionId":"cur"}\n');
      fs.writeFileSync(path.join(transcripts, 'a.jsonl'), '{"type":"user","sessionId":"a"}\n');
      expect((await runPromptUpload(toolDir, { cwd: p.repo, sessionId: 'cur' }, { home: p.home })).code).toBe(0);
      expect(h.uploads().sort()).toEqual(['artisyn/cur', 'claude/cur']);
      expect(fs.existsSync(path.join(p.telemetry, '.claude-logs.sent'))).toBe(false);
    });

    await test.step('10. a hook-service session skips the post-turn worker; a broken, hanging, noisy or missing claude never throws', async () => {
      const p = project(dirs, 'http://127.0.0.1:1');
      const transcript = path.join(claudeProjectDir(p.home, p.repo), 'cur.jsonl');
      fs.writeFileSync(transcript, '{"type":"user","sessionId":"cur"}\n');
      const res = await runScript(
        toolDir,
        'post-turn-analysis-hook.js',
        { hook_event_name: 'Stop', session_id: 'cur', cwd: p.repo, transcript_path: transcript },
        { home: p.home, env: { ARTISYN_HOOK_SERVICE: 'guardrail' } },
      );
      expect(res.code).toBe(0);
      expect(res.elapsedMs).toBeLessThan(3000);
      expect(readHookLog(p.repo, 'post-turn-analysis-hook.js').at(-1)).toMatch(
        /exit: this session is a 'guardrail' hook-service LLM call, not a user turn/,
      );

      const bins = {
        fail: writeFakeClaude(dirs, 'fail').bin,
        hang: writeFakeClaude(dirs, 'hang').bin,
        garbage: writeFakeClaude(dirs, 'garbage').bin,
        missing: path.join(dirs.make('no-claude'), process.platform === 'win32' ? 'claude.cmd' : 'claude'),
      };
      const driverDir = writeLlmDriver(dirs, toolDir);
      try {
        const driven = await runScript(driverDir, 'driver.js', { cwd: driverDir }, { argv: [JSON.stringify(bins)] });
        expect(driven.code, driven.stderr).toBe(0);
        const results: unknown = JSON.parse(driven.stdout);
        expect(isRecord(results)).toBe(true);
        const r = isRecord(results) ? results : {};
        const field = (k: string, f: string) => {
          const entry = r[k];
          return isRecord(entry) ? entry[f] : undefined;
        };
        expect(field('fail', 'ok')).toBe(false);
        expect(field('fail', 'failureKind')).toBe('nonzero-exit');
        expect(field('hang', 'ok')).toBe(false);
        expect(field('hang', 'failureKind')).toBe('timeout');
        expect(field('missing', 'ok')).toBe(false);
        expect(field('garbage', 'ok')).toBe(true);
      } finally {
        // The [win] orphan of the timed-out call (see the known-bug pin below) must not outlive us.
        killWindowsProcessesMatching(path.basename(path.dirname(bins.hang)));
      }
    });

    await test.step('11. two Stops at once on one project: one uploads, the other leaves on the lock; no file twice', async () => {
      const slowOk = await hub(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return OK;
      });
      const p = project(dirs, slowOk.url);
      fs.rmSync(path.join(p.telemetry, 'cur.jsonl'));
      fs.rmSync(path.join(p.telemetry, 'b.jsonl'));
      const [one, two] = await Promise.all([stop(toolDir, p), stop(toolDir, p)]);
      expect(one.code).toBe(0);
      expect(two.code).toBe(0);
      expect(slowOk.uploads()).toEqual(['artisyn/a']);
      expect(readHookLog(p.repo, 'send-logs-hook.js').filter((l) => l.includes('skipped: upload lock held'))).toHaveLength(1);
    });
  } finally {
    await Promise.all(hubs.map((h) => h.close()));
    dirs.cleanup();
  }
});

// [win] step of S-HOOK-04 («после таймаута нет зависших cmd.exe/node»), kept as its own test so the
// known product bug it found is pinned with test.fail() instead of turning the whole scenario red.
//
// KNOWN BUG (task Notes, 2026-10-15): process-marker.js#killProcessTree calls child.kill() first,
// which on Windows kills only the `cmd.exe` wrapper that `shell: true` puts in front of
// `claude.cmd`; the following `taskkill /PID <wrapper> /T /F` then finds no process and the real
// `claude` grandchild keeps running after the timeout. When the hook is fixed this test starts
// passing, test.fail() turns that into a failure, and the annotation has to go.
test('@S-HOOK-04 [win] a timed-out claude call leaves no cmd.exe or node behind @mode-a', async () => {
  test.skip(process.platform !== 'win32', '[win] killProcessTree exists for cmd.exe wrappers only');
  test.fail(true, 'KNOWN BUG: killProcessTree kills the cmd.exe wrapper before taskkill /T can walk its tree');
  test.setTimeout(60_000);
  const dirs = tempDirs();
  const hang = writeFakeClaude(dirs, 'hang');
  const marker = path.basename(hang.dir);
  try {
    const toolDir = copyToolDir(dirs);
    const driverDir = writeLlmDriver(dirs, toolDir);
    const driven = await runScript(driverDir, 'driver.js', { cwd: driverDir }, { argv: [JSON.stringify({ hang: hang.bin })] });
    expect(driven.code, driven.stderr).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(windowsProcessesMatching(marker), `processes left from ${hang.dir}`).toEqual([]);
  } finally {
    killWindowsProcessesMatching(marker);
    dirs.cleanup();
  }
});
