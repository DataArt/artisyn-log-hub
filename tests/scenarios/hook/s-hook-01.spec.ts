// S-HOOK-01. A full Stop run: what exactly goes to the server, in which order, and what is not
// sent again (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-HOOK-01; layer
// «hook (child processes)»).
//
// The hook runs from a copy of hook/.claude/telemetry_tool against a fake log hub (always 201
// `{warnings: []}`), in a throwaway git repo with a throwaway HOME. Nothing here talks to the
// stand, so the auth mode is irrelevant: the scenario runs once, on the mode-A stand (DD SC4
// picks A and C for scenarios whose behaviour can differ by mode; this one cannot).
//
// Code facts that differ from the design text:
//   - a project agent is `.claude/agents/<name>/AGENT.md`, not `.claude/agents/<name>.md`;
//   - the current session's artisyn file is uploaded on EVERY Stop (its body carries this run's
//     hook-status, so its on-disk size cannot say whether it changed). Steps 5 and 6 therefore see
//     `artisyn/cur` next to the file that changed;
//   - the last line of a run is `done: uploaded=N skipped=S failed=F total=T target=<origin>`; the
//     `uploaded N KB … in K request(s)` form is the per-file line;
//   - a sub-agent's manifest key is `claude-subagent/<root session>/<agent file>`.
//
// Replaces:
//   - hook/.claude/telemetry_tool/__tests__/send-logs-hook.test.js — parentSessionId ×4,
//     workflowRunId ×2, journal, v2 route, current-first order, current/backlog, manifest ×4,
//     SessionEnd ×4, upload lock ×4, hook-status, one-line-per-run logging ×4 (≈ 35)
//   - hook/.claude/telemetry_tool/__tests__/manifest-bounded.test.js (5)
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures';
import {
  claudeProjectDir,
  copyToolDir,
  makeFakeGitRepo,
  makeFakeHome,
  ndjsonLines,
  readHookLog,
  readManifest,
  runHook,
  startFakeLogHub,
  subagentsDir,
  telemetryDir,
  tempDirs,
  writeConfig,
  writeFakeMcpServer,
  QUIET_HOOK_CONFIG,
  type FakeLogHub,
  type FakeRequest,
} from '../helpers/hook-process';

const API_KEY = 'k-test-123456';
const HARNESS_TYPES = ['harness-snapshot-ref', 'harness-snapshot'];

function line(obj: object): string {
  return `${JSON.stringify(obj)}\n`;
}

function bodyTypes(req: FakeRequest): string[] {
  return ndjsonLines(req.body.toString('utf8')).map((e) => String(e.type ?? e.event ?? ''));
}

test('@S-HOOK-01 a Stop run uploads the right files in the right order and never twice @mode-a', async () => {
  test.setTimeout(120_000);
  const dirs = tempDirs();
  let hub: FakeLogHub | undefined;
  let snapshotId = '';
  try {
    hub = await startFakeLogHub();
    const toolDir = copyToolDir(dirs);
    const repo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/hook01/app.git' });
    const home = makeFakeHome(dirs);
    const telemetry = telemetryDir(repo);
    const project = claudeProjectDir(home, repo);
    const agents = subagentsDir(home, repo, 'cur');
    const wfDir = path.join(agents, 'workflows', 'wf_abc');
    const run = (event: 'Stop' | 'SessionEnd') =>
      runHook(toolDir, { hook_event_name: event, session_id: 'cur', cwd: repo }, { home });

    await test.step('setup: temp-project with config, sessions cur and old, sub-agents, a workflow and a harness', async () => {
      writeConfig(repo, {
        base: { ...QUIET_HOOK_CONFIG, serverUrl: hub!.url, sendLogsTimeoutMs: 5000 },
        local: { apiKey: API_KEY },
      });
      fs.writeFileSync(path.join(telemetry, 'cur.jsonl'), line({ event: 'prompt_start', session_id: 'cur', prompt: 'hi' }));
      fs.writeFileSync(path.join(telemetry, 'old.jsonl'), line({ event: 'prompt_start', session_id: 'old', prompt: 'old' }));
      fs.writeFileSync(path.join(project, 'cur.jsonl'), line({ type: 'user', sessionId: 'cur' }));
      fs.writeFileSync(path.join(project, 'old.jsonl'), line({ type: 'user', sessionId: 'old' }));
      fs.writeFileSync(path.join(agents, 'agent-a1.jsonl'), line({ type: 'user', agent: 'a1' }));
      fs.writeFileSync(path.join(agents, 'agent-a1.meta.json'), JSON.stringify({ parentAgentId: 'p9' }));
      fs.writeFileSync(path.join(agents, 'agent-b2.jsonl'), line({ type: 'user', agent: 'b2' }));
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, 'agent-w1.jsonl'), line({ type: 'user', agent: 'w1' }));
      fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), line({ type: 'result' }));
      fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# rules\n');
      fs.mkdirSync(path.join(repo, '.claude', 'skills', 'hello'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Says hi.\n---\nbody\n');
      fs.mkdirSync(path.join(repo, '.claude', 'agents', 'rev'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'agents', 'rev', 'AGENT.md'), '---\nname: rev\ndescription: Reviews.\n---\nbody\n');
      const mcp = writeFakeMcpServer(repo);
      fs.writeFileSync(
        path.join(repo, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'fake-mcp': { command: process.execPath, args: [mcp] } } }),
      );
    });

    await test.step('1. Stop for session cur → exit code 0', async () => {
      const res = await run('Stop');
      expect(res.code, res.stderr).toBe(0);
    });

    await test.step('2. every request is POST /api/v2/logs with X-API-Key, type and sessionId; none goes to /api/v1/logs', async () => {
      expect(hub!.requests.length).toBeGreaterThan(0);
      for (const r of hub!.requests) {
        expect(`${r.method} ${r.path}`).toBe('POST /api/v2/logs');
        expect(r.headers['x-api-key']).toBe(API_KEY);
        expect(r.type, 'type param').toBeTruthy();
        expect(r.sessionId, 'sessionId param').toBeTruthy();
      }
      expect(hub!.requests.some((r) => r.path.startsWith('/api/v1/'))).toBe(false);
    });

    await test.step('3. order and linkage: cur transcripts first, cur artisyn last; parentSessionId, workflowRunId, no journal', async () => {
      const order = hub!.uploads();
      expect(new Set(order)).toEqual(
        new Set([
          'claude/cur',
          'claude-subagent/agent-a1',
          'claude-subagent/agent-b2',
          'claude-subagent/agent-w1',
          'claude/old',
          'artisyn/old',
          'artisyn/cur',
        ]),
      );
      expect(order.length, `no file twice: ${order.join(', ')}`).toBe(7);
      const firstOld = Math.min(order.indexOf('claude/old'), order.indexOf('artisyn/old'));
      for (const cur of ['claude/cur', 'claude-subagent/agent-a1', 'claude-subagent/agent-b2', 'claude-subagent/agent-w1']) {
        expect(order.indexOf(cur), `${cur} before any old file: ${order.join(', ')}`).toBeLessThan(firstOld);
      }
      expect(order[order.length - 1]).toBe('artisyn/cur');

      const bySid = (sid: string) => hub!.requests.find((r) => r.sessionId === sid)!;
      expect(bySid('agent-a1').query.get('parentSessionId')).toBe('agent-p9');
      expect(bySid('agent-b2').query.get('parentSessionId')).toBe('cur');
      expect(bySid('agent-w1').query.get('workflowRunId')).toBe('wf_abc');
      expect(bySid('agent-a1').query.get('workflowRunId')).toBeNull();
      expect(bySid('agent-b2').query.get('workflowRunId')).toBeNull();
      expect(hub!.requests.some((r) => r.sessionId === 'journal')).toBe(false);
    });

    await test.step('4. cur artisyn body starts with hook-status and alone carries the harness; old has neither', async () => {
      const cur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      const old = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'old')!;
      const status = ndjsonLines(cur.body.toString('utf8'))[0];
      expect(status.type).toBe('hook-status');
      expect(typeof status.hookVersion).toBe('string');
      expect(Array.isArray(status.logTail)).toBe(true);
      expect(status.nonUploadableLogs).toEqual([]);
      expect(Array.isArray(status.recommendations)).toBe(true);
      const curTypes = bodyTypes(cur);
      for (const t of HARNESS_TYPES) expect(curTypes, t).toContain(t);
      const oldTypes = bodyTypes(old);
      expect(oldTypes).not.toContain('hook-status');
      for (const t of HARNESS_TYPES) expect(oldTypes, t).not.toContain(t);

      // DD-7: the id is unknown on this first run (no harness-state.json yet), so the query
      // carries snapshotFull=1 alongside the full harness-snapshot line.
      const snapshotLine = ndjsonLines(cur.body.toString('utf8')).find((e) => e.type === 'harness-snapshot')!;
      snapshotId = String(snapshotLine.snapshotId);
      expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);
      expect(cur.query.get('snapshotId')).toBe(snapshotId);
      expect(cur.query.get('snapshotFull')).toBe('1');
    });

    await test.step('5. second Stop, cur transcript grew: only cur artisyn and the grown transcript go out', async () => {
      // Claude Code appends `turn_duration` after the Stop hook fires — the usual reason it grows.
      fs.appendFileSync(path.join(project, 'cur.jsonl'), line({ type: 'system', subtype: 'turn_duration' }));
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.uploads().sort()).toEqual(['artisyn/cur', 'claude/cur']);

      // DD-6/DD-7: the id is now known, so this run sends only the ref — no full snapshot, no
      // snapshotFull query param — but the same snapshotId.
      const cur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      const curTypes = bodyTypes(cur);
      expect(curTypes).toContain('harness-snapshot-ref');
      expect(curTypes).not.toContain('harness-snapshot');
      expect(cur.query.get('snapshotId')).toBe(snapshotId);
      expect(cur.query.get('snapshotFull')).toBeNull();
    });

    await test.step('5b. the hub reports the snapshot unknown → the next Stop resends the full harness-snapshot (DD-21)', async () => {
      hub!.respond((req) => {
        if (req.type === 'artisyn' && req.sessionId === 'cur') {
          return { status: 201, body: JSON.stringify({ warnings: [], unknownSnapshotId: snapshotId }) };
        }
        return { status: 201, body: JSON.stringify({ warnings: [] }) };
      });
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      // The id was still known locally when this run built its request, so it still sent ref-only —
      // the server's unknownSnapshotId answer only takes effect on the NEXT run.
      const firstRunCur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      expect(bodyTypes(firstRunCur)).not.toContain('harness-snapshot');
      expect(firstRunCur.query.get('snapshotId')).toBe(snapshotId);

      hub!.respond(() => ({ status: 201, body: JSON.stringify({ warnings: [] }) }));
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      const secondRunCur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      const secondRunTypes = bodyTypes(secondRunCur);
      expect(secondRunTypes).toContain('harness-snapshot-ref');
      expect(secondRunTypes).toContain('harness-snapshot');
      expect(secondRunCur.query.get('snapshotId')).toBe(snapshotId);
      expect(secondRunCur.query.get('snapshotFull')).toBe('1');
    });

    await test.step('6. a line appended to the old transcript → exactly that file (plus the always-sent cur artisyn)', async () => {
      fs.appendFileSync(path.join(project, 'old.jsonl'), line({ type: 'assistant', sessionId: 'old' }));
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.uploads().sort()).toEqual(['artisyn/cur', 'claude/old']);
    });

    await test.step('7. SessionEnd for cur → only its artisyn and claude files; manifest untouched; lock released', async () => {
      const manifestBefore = fs.readFileSync(path.join(telemetry, '.claude-logs.sent'), 'utf8');
      hub!.requests.length = 0;
      expect((await run('SessionEnd')).code).toBe(0);
      expect(hub!.uploads().sort()).toEqual(['artisyn/cur', 'claude/cur']);
      expect(fs.readFileSync(path.join(telemetry, '.claude-logs.sent'), 'utf8')).toBe(manifestBefore);
      expect(fs.existsSync(path.join(telemetry, '.upload.lock'))).toBe(false);
    });

    await test.step('8. old transcript deleted → its manifest entry is pruned, an unresolved namespace keeps its entries', async () => {
      // OTEL is off, so the claude-otel root is never enumerated: its entries must survive a prune.
      fs.appendFileSync(path.join(telemetry, '.claude-logs.sent'), 'claude-otel/s9/0001.jsonl 42\n');
      expect(readManifest(telemetry).has('claude/old.jsonl')).toBe(true);
      fs.rmSync(path.join(project, 'old.jsonl'));
      expect((await run('Stop')).code).toBe(0);
      const manifest = readManifest(telemetry);
      expect(manifest.has('claude/old.jsonl')).toBe(false);
      expect(manifest.get('claude-otel/s9/0001.jsonl')).toBe(42);
      expect(manifest.has('claude/cur.jsonl')).toBe(true);
      expect(readHookLog(repo, 'send-logs-hook.js').some((l) => /manifest prune: removed=1 /.test(l))).toBe(true);
    });

    await test.step('9. a fresh .upload.lock → Stop logs «skipped: upload lock held», sends nothing, exits 0; a stale one is taken over', async () => {
      const lock = path.join(telemetry, '.upload.lock');
      fs.writeFileSync(lock, JSON.stringify({ startedAt: new Date().toISOString() }));
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.requests).toHaveLength(0);
      expect(readHookLog(repo, 'send-logs-hook.js').at(-1)).toMatch(/\[result\] skipped: upload lock held/);

      // Default sendLogsOnPromptTimeoutMs is 60 s, so a lock older than 120 s is stale.
      fs.writeFileSync(lock, JSON.stringify({ startedAt: '2000-01-01T00:00:00.000Z' }));
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.uploads()).toContain('artisyn/cur');
      expect(fs.existsSync(lock)).toBe(false);
    });

    await test.step('10. Stop waits for a busy lock only ~2 s; SessionEnd waits it out (lock freed after 1.5 s → upload happens)', async () => {
      const lock = path.join(telemetry, '.upload.lock');
      fs.writeFileSync(lock, JSON.stringify({ startedAt: new Date().toISOString() }));
      hub!.requests.length = 0;
      const stop = await run('Stop');
      expect(stop.code).toBe(0);
      expect(stop.elapsedMs, 'Stop gives up on a busy lock quickly').toBeLessThan(4000);
      expect(hub!.requests).toHaveLength(0);

      fs.writeFileSync(lock, JSON.stringify({ startedAt: new Date().toISOString() }));
      const ending = run('SessionEnd');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      fs.rmSync(lock);
      const end = await ending;
      expect(end.code).toBe(0);
      expect(end.elapsedMs).toBeGreaterThanOrEqual(1500);
      expect(hub!.uploads().sort()).toEqual(['artisyn/cur', 'claude/cur']);
    });

    await test.step('11. hook.log: an activate line per run and a closing line with the counters', async () => {
      const lines = readHookLog(repo, 'send-logs-hook.js');
      // Runs above: steps 1, 5, 5b (×2), 6, 7, 8, 9 (×2), 10 (×2) = 11.
      expect(lines.filter((l) => /\[activate\] (Stop|SessionEnd) event received/.test(l))).toHaveLength(11);
      expect(lines.filter((l) => /\[result\] done: uploaded=\d+ skipped=\d+ failed=0 total=\d+ target=http:\/\/127\.0\.0\.1:\d+/.test(l)).length).toBe(7);
      expect(lines.some((l) => /claude\/cur\.jsonl: uploaded \d+ KB uncompressed in 1 request$/.test(l))).toBe(true);
      expect(lines.some((l) => /session-end flush done: uploaded=2 failed=0 total=2/.test(l))).toBe(true);
    });
  } finally {
    await hub?.close();
    dirs.cleanup();
  }
});
