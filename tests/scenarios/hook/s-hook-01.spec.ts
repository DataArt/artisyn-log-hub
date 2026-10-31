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
// Step 4b (2026-10-27 OKF usage tab): the fake hub is an old Log Hub for OKF — it never answers
// `unknownOkfSnapshotId` — and the new hook's upload with the OKF snapshot still succeeds; step 5
// then sees the OKF ref only (FR-10).
//
// Replaces:
//   - hook/.claude/telemetry_tool/__tests__/send-logs-hook.test.js — parentSessionId ×4,
//     workflowRunId ×2, journal, v2 route, current-first order, current/backlog, manifest ×4,
//     SessionEnd ×4, upload lock ×4, hook-status, one-line-per-run logging ×4 (≈ 35)
//   - hook/.claude/telemetry_tool/__tests__/manifest-bounded.test.js (5)
//
// Step 16 (2026-10-30 OTEL tabs, AC-13, old-server half): the 2.29.0 OTEL receiver against a Log
// Hub that predates `POST /api/v2/otel-realtime` (the fake hub answers it 404). One realtime
// batch is tried, the 404 switches the channel off (`rt-disable` in receiver.log) and nothing more
// is sent; the chunk files — spans included — still upload through the regular
// `claude-otel` route, exactly as to any server.
//
// Steps 17–19 (2026-10-30 shared receiver, DD-15/DD-16, AC-C2): the `otel-status` artisyn line
// against a running shared receiver. It is written at the first Stop that has records (here
// `partial`: logs only), again when the state improves (`ok` once metrics arrive) and never after
// `ok`; a session with no record gets one `none` line at SessionEnd. The fake hub stands for an
// old Log Hub: it stores the line untouched and the upload succeeds.
//
// Steps 12–15 cover the ARTISYN_PROJECT_ROOT override (git-context.js / project-root-override.js):
// in a linked worktree it makes the worktree the project root, and it is ignored when unset or
// when it does not contain the cwd.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { test, expect } from '../fixtures';
import {
  claudeProjectDir,
  copyToolDir,
  copyToolDirTo,
  pathWith,
  startSharedReceiver,
  writeFakeClaude,
  writeSharedState,
  makeFakeGitRepo,
  makeFakeHome,
  isRecord,
  ndjsonLines,
  normalizePath,
  readHookLog,
  readManifest,
  runHook,
  runScript,
  startFakeLogHub,
  subagentsDir,
  telemetryDir,
  tempDirs,
  workDir,
  writeConfig,
  writeFakeMcpServer,
  rawRequest,
  runNodeScript,
  startReceiver,
  stopReceiver,
  QUIET_HOOK_CONFIG,
  type ReceiverProcess,
  type FakeLogHub,
  type FakeRequest,
} from '../helpers/hook-process';
import { callLines, otelTurn, spanLines } from '../fixtures/otel/otel-lines';

const API_KEY = 'k-test-123456';
const HARNESS_TYPES = ['harness-snapshot-ref', 'harness-snapshot'];

function line(obj: object): string {
  return `${JSON.stringify(obj)}\n`;
}

/** A request body as text, gunzipped when the hook compressed it. */
function bodyText(req: FakeRequest): string {
  return (req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(req.body) : req.body).toString('utf8');
}

function bodyTypes(req: FakeRequest): string[] {
  return ndjsonLines(req.body.toString('utf8')).map((e) => String(e.type ?? e.event ?? ''));
}

test('@S-HOOK-01 a Stop run uploads the right files in the right order and never twice @mode-a', async () => {
  test.setTimeout(120_000);
  const dirs = tempDirs();
  let hub: FakeLogHub | undefined;
  let oldHub: FakeLogHub | undefined;
  let receiver: ReceiverProcess | undefined;
  let sharedReceiver: ReceiverProcess | undefined;
  let snapshotId = '';
  let okfSnapshotId = '';
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
      // An OKF bundle (2026-10-27 OKF usage tab): the hook sends its snapshot with the cur artisyn.
      fs.mkdirSync(path.join(repo, 'docs', 'kb'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', 'kb', 'index.md'), '---\nokf_version: 1\n---\n# KB\n');
      fs.writeFileSync(path.join(repo, 'docs', 'kb', 'setup.md'), '# Setup\n');
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

    await test.step('4b. new hook → old server: the OKF snapshot rides on cur artisyn, the hub ignores okfSnapshotId (no unknownOkfSnapshotId), the upload still succeeds', async () => {
      // The fake hub answers every upload with a bare `{warnings: []}` — exactly an old Log Hub,
      // which knows neither the OKF query params nor the OKF lines.
      const cur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      const lines = ndjsonLines(cur.body.toString('utf8'));
      const full = lines.find((e) => e.type === 'okf-snapshot');
      expect(full, 'full okf-snapshot line on the first run').toBeDefined();
      okfSnapshotId = String(full!.okfSnapshotId);
      expect(okfSnapshotId).toMatch(/^[0-9a-f]{64}$/);
      expect(lines.find((e) => e.type === 'okf-snapshot-ref')?.okfSnapshotId).toBe(okfSnapshotId);
      expect(Array.isArray(full!.bundles) && (full!.bundles as Array<{ root: string }>).map((b) => b.root)).toEqual(['docs/kb']);
      expect(cur.query.get('okfSnapshotId')).toBe(okfSnapshotId);
      expect(cur.query.get('okfSnapshotFull')).toBe('1');
      const old = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'old')!;
      expect(bodyTypes(old)).not.toContain('okf-snapshot-ref');
      expect(old.query.get('okfSnapshotId')).toBeNull();
      const log = readHookLog(repo, 'send-logs-hook.js');
      expect(log.some((l) => l.includes(`okf: snapshot ${okfSnapshotId.slice(0, 12)} sent`)), log.join('\n')).toBe(true);
      expect(log.filter((l) => /\[result\] done: uploaded=\d+ skipped=\d+ failed=0 /.test(l))).toHaveLength(1);
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
      // FR-10: the same for OKF — ref line only, no okfSnapshotFull.
      expect(curTypes).toContain('okf-snapshot-ref');
      expect(curTypes).not.toContain('okf-snapshot');
      expect(cur.query.get('okfSnapshotId')).toBe(okfSnapshotId);
      expect(cur.query.get('okfSnapshotFull')).toBeNull();
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

    // Steps 12–15: the ARTISYN_PROJECT_ROOT override (a dev sandbox mounts one linked worktree and
    // points the variable at it). A separate fake repo with a linked worktree, each with its own
    // config whose API key tells which config the hook read; a third, unrelated dir has a config
    // too, so reading it would show. The prompt_start line telemetry-hook.js writes carries
    // `git.root`, and the Stop run uploads it in the artisyn body.
    const mainRepo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/hook01/wt.git' });
    const worktree = path.join(dirs.make('hook-wt'), 'wt');
    const elsewhere = dirs.make('hook-elsewhere');
    const KEYS = { main: 'k-main-111111', worktree: 'k-worktree-222222', elsewhere: 'k-elsewhere-333333' };

    /** UserPromptSubmit then Stop for `sid` in the worktree; returns this round's requests. */
    const promptAndStop = async (sid: string, projectRoot: string): Promise<FakeRequest[]> => {
      const env = { ARTISYN_PROJECT_ROOT: projectRoot };
      const input = { session_id: sid, cwd: worktree };
      hub!.requests.length = 0;
      const prompt = await runScript(toolDir, 'telemetry-hook.js', { ...input, hook_event_name: 'UserPromptSubmit', prompt: 'wt' }, { home, env });
      expect(prompt.code, prompt.stderr).toBe(0);
      const stop = await runHook(toolDir, { ...input, hook_event_name: 'Stop' }, { home, env });
      expect(stop.code, stop.stderr).toBe(0);
      return [...hub!.requests];
    };

    /** `git` of the prompt_start line in the artisyn upload of `sid`. */
    const uploadedGit = (requests: FakeRequest[], sid: string): Record<string, unknown> => {
      const artisyn = requests.find((r) => r.type === 'artisyn' && r.sessionId === sid);
      expect(artisyn, `artisyn/${sid} uploaded: ${requests.map((r) => `${r.type}/${r.sessionId}`).join(', ')}`).toBeDefined();
      const promptStart = ndjsonLines(artisyn!.body.toString('utf8')).find((e) => e.event === 'prompt_start');
      expect(promptStart, 'prompt_start line in the artisyn body').toBeDefined();
      const gitInfo = promptStart?.git;
      if (!isRecord(gitInfo)) throw new Error(`prompt_start of ${sid} has no git object: ${JSON.stringify(promptStart)}`);
      return gitInfo;
    };

    await test.step('12. setup: a linked worktree of a fake repo; main repo, worktree and an unrelated dir each with its own config', async () => {
      const add = spawnSync('git', ['worktree', 'add', '-q', '-b', 'sandbox', worktree], { cwd: mainRepo, encoding: 'utf8' });
      expect(add.status, add.stderr).toBe(0);
      writeConfig(mainRepo, { base: { ...QUIET_HOOK_CONFIG, serverUrl: hub!.url, sendLogsTimeoutMs: 5000 }, local: { apiKey: KEYS.main } });
      writeConfig(worktree, { base: { ...QUIET_HOOK_CONFIG, serverUrl: hub!.url, sendLogsTimeoutMs: 5000 }, local: { apiKey: KEYS.worktree } });
      writeConfig(elsewhere, { base: { ...QUIET_HOOK_CONFIG, serverUrl: hub!.url, sendLogsTimeoutMs: 5000 }, local: { apiKey: KEYS.elsewhere } });
    });

    await test.step('13. ARTISYN_PROJECT_ROOT = the worktree → the worktree\'s config and work dir; uploaded git.root == the worktree', async () => {
      const requests = await promptAndStop('wt-override', worktree);
      expect(requests.length).toBeGreaterThan(0);
      for (const r of requests) expect(r.headers['x-api-key']).toBe(KEYS.worktree);
      const gitInfo = uploadedGit(requests, 'wt-override');
      expect(normalizePath(String(gitInfo.root))).toBe(normalizePath(worktree));
      expect(normalizePath(String(gitInfo.worktreeRoot))).toBe(normalizePath(worktree));
      expect(readHookLog(worktree, 'send-logs-hook.js').length).toBeGreaterThan(0);
      expect(fs.existsSync(workDir(mainRepo)), 'nothing written into the main checkout').toBe(false);
    });

    await test.step('14. ARTISYN_PROJECT_ROOT unset → the same worktree resolves to the main fake repo, as before', async () => {
      const requests = await promptAndStop('wt-unset', '');
      expect(requests.length).toBeGreaterThan(0);
      for (const r of requests) expect(r.headers['x-api-key']).toBe(KEYS.main);
      const gitInfo = uploadedGit(requests, 'wt-unset');
      expect(normalizePath(String(gitInfo.root))).toBe(normalizePath(mainRepo));
      expect(normalizePath(String(gitInfo.worktreeRoot))).toBe(normalizePath(worktree));
      expect(readHookLog(mainRepo, 'send-logs-hook.js').length).toBeGreaterThan(0);
    });

    await test.step('15. ARTISYN_PROJECT_ROOT = a dir that does not contain the cwd → ignored, the main fake repo again', async () => {
      const requests = await promptAndStop('wt-foreign', elsewhere);
      expect(requests.length).toBeGreaterThan(0);
      for (const r of requests) expect(r.headers['x-api-key']).toBe(KEYS.main);
      const gitInfo = uploadedGit(requests, 'wt-foreign');
      expect(normalizePath(String(gitInfo.root))).toBe(normalizePath(mainRepo));
      expect(fs.existsSync(workDir(elsewhere)), 'nothing written into the unrelated dir').toBe(false);
    });

    await test.step('16. AC-13 (old server): the receiver tries one realtime batch, gets 404 and goes silent; the chunks (logs and spans) still upload as claude-otel', async () => {
      oldHub = await startFakeLogHub((req) => (req.path === '/api/v2/otel-realtime' ? { status: 404, body: '{"message":"Cannot POST"}' } : { status: 201, body: JSON.stringify({ warnings: [] }) }));
      const repo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/hook01/old-server.git' });
      writeConfig(repo, { base: { ...QUIET_HOOK_CONFIG, serverUrl: oldHub.url, sendLogsTimeoutMs: 5000 }, local: { apiKey: API_KEY } });
      const otelDir = path.join(telemetryDir(repo), 'otel');
      fs.mkdirSync(otelDir, { recursive: true });
      const started = await startReceiver(toolDir, { dir: otelDir, owner: { gitRoot: repo, repo: 'git@git.arrakis.test:scn/hook01/old-server.git' } });
      receiver = started.receiver;
      const sid = 'rt-old-1';
      const turn = otelTurn('hk01', new Date(Date.now() - 6 * 60_000));
      const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] };
      const post = async (route: string, body: object) => {
        const res = await rawRequest(started.port, route, body);
        expect(res.status, `${route}: ${res.body}`).toBe(200);
      };
      const realtime = () => oldHub!.requests.filter((r) => r.path === '/api/v2/otel-realtime');
      await post('/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: callLines(sid, turn).map((l) => l.record) }] }] });
      await post('/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'com.anthropic.claude_code.tracing' }, spans: spanLines(sid, turn).map((l) => l.record) }] }] });
      await expect.poll(() => realtime().length, { timeout: 15_000 }).toBe(1);
      const batch: unknown = JSON.parse(bodyText(realtime()[0]));
      expect(isRecord(batch) && batch.sessionId === sid && batch.batchSeq === 1, 'one batch of this session').toBe(true);
      expect(realtime()[0].headers['x-api-key']).toBe(API_KEY);

      // More data after the 404: it lands in chunk files only.
      await post('/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: callLines('rt-old-2', otelTurn('hk02', new Date())).map((l) => l.record) }] }] });
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      expect(realtime(), 'silence after the 404: no retry, no second session').toHaveLength(1);
      expect(fs.readFileSync(path.join(otelDir, 'receiver.log'), 'utf8')).toMatch(/rt-disable/);
      await stopReceiver(receiver);

      const sweep = await runNodeScript(path.join(toolDir, 'send-logs-hook.js'), repo, null, { home, argv: ['--otel-sweep', '--cwd', repo] });
      expect(sweep.code, sweep.stderr).toBe(0);
      const uploads = oldHub.requests.filter((r) => r.path === '/api/v2/logs');
      expect(new Set(uploads.map((r) => r.type))).toEqual(new Set(['claude-otel']));
      expect(new Set(uploads.map((r) => r.sessionId))).toEqual(new Set([sid, 'rt-old-2']));
      const lines = uploads.filter((r) => r.sessionId === sid).flatMap((r) => ndjsonLines(bodyText(r)));
      expect(lines.filter((l) => l.signal === 'spans')).toHaveLength(Object.keys(turn.spans).length);
      expect(lines.filter((l) => l.signal === 'logs')).toHaveLength(Object.keys(turn.calls).length);
      expect(realtime(), 'the sweep sends no realtime batch either').toHaveLength(1);
    });

    // Steps 17–19 (2026-10-30 shared receiver, DD-15/DD-16): the `otel-status` line. A fake home
    // with the installer's shared state, the hook as a plugin under `~/.claude/plugins/` (so the
    // receiver accepts its send-logs-hook.js as the registered uploader), a shared receiver already
    // running, and the fake hub — an old Log Hub that knows nothing about `otel-status`.
    const shHome = makeFakeHome(dirs);
    const shState = await writeSharedState(shHome);
    const shTool = copyToolDirTo(path.join(shHome, '.claude', 'plugins', 'log-hub-hooks', 'scripts'));
    const shVersion: string = JSON.parse(fs.readFileSync(path.join(shTool, 'version.json'), 'utf8')).version;
    const shRepo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/hook01/shared.git' });
    fs.mkdirSync(path.join(telemetryDir(shRepo), 'otel'), { recursive: true });
    const shEnv = { ARTISYN_MANAGED_SETTINGS_DIR: dirs.make('no-managed'), ...pathWith(writeFakeClaude(dirs, 'fail').dir) };
    const shRun = (event: 'Stop' | 'SessionEnd', sid: string) =>
      runHook(shTool, { hook_event_name: event, session_id: sid, cwd: shRepo }, { home: shHome, env: shEnv });
    const statusLog = (sid: string) => readHookLog(shRepo, 'send-logs-hook.js').filter((l) => l.includes(`[${sid}]`) && l.includes('otel-status state='));
    /** The `otel-status` lines of the latest artisyn upload of `sid`. */
    const uploadedStatus = (sid: string) => {
      const uploads = hub!.requests.filter((r) => r.type === 'artisyn' && r.sessionId === sid);
      expect(uploads.length, `artisyn/${sid} uploaded`).toBeGreaterThan(0);
      return ndjsonLines(bodyText(uploads[uploads.length - 1])).filter((e) => e.type === 'otel-status');
    };
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] };
    const sessionAttr = (sid: string) => [{ key: 'session.id', value: { stringValue: sid } }];

    await test.step('17. otel-status at the first Stop with records: records arrived before the register, the Stop re-arm registers the session, the line says partial (logs only) and rides on the artisyn upload an old hub accepts', async () => {
      writeConfig(shRepo, {
        base: { ...QUIET_HOOK_CONFIG, otelEnabled: true, otelRealtime: false, serverUrl: hub!.url, sendLogsTimeoutMs: 5000 },
        local: { apiKey: API_KEY },
      });
      sharedReceiver = await startSharedReceiver(shTool, { home: shHome, stateDir: shState.stateDir, port: shState.port });
      const logs = await rawRequest(shState.port, '/v1/logs', {
        resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: [{ timeUnixNano: '1735689600000000001', body: { stringValue: 'claude_code.user_prompt' }, attributes: sessionAttr('os-1') }] }] }],
      });
      expect(logs.status).toBe(200);
      hub!.requests.length = 0;
      const stop = await shRun('Stop', 'os-1');
      expect(stop.code, stop.stderr).toBe(0);
      expect(statusLog('os-1'), readHookLog(shRepo).join('\n')).toHaveLength(1);
      expect(statusLog('os-1')[0]).toMatch(/otel-status state=partial reason=not-configured detail=null received=1\/0\/0 phase=stop/);
      const [line] = uploadedStatus('os-1');
      expect(line).toMatchObject({
        sessionId: 'os-1', state: 'partial', reason: 'not-configured', detail: null,
        received: { logs: 1, metrics: 0, spans: 0 }, forward: 'off', hookVersion: shVersion, receiverVersion: shVersion,
      });
      expect(String((line.received as Record<string, unknown>).firstAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // An old hub stores the artisyn file as is: the upload simply succeeds.
      expect(readHookLog(shRepo, 'send-logs-hook.js').filter((l) => /\[result\] done: uploaded=\d+ skipped=\d+ failed=0 /.test(l))).toHaveLength(1);

      expect((await shRun('Stop', 'os-1')).code).toBe(0);
      expect(statusLog('os-1'), 'the same state is not written twice').toHaveLength(1);
    });

    await test.step('18. a late correction: metrics arrive, the next Stop writes a second line with state ok; after ok nothing more is written, not even at SessionEnd', async () => {
      const metrics = await rawRequest(shState.port, '/v1/metrics', {
        resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: 'com.anthropic.claude_code' }, metrics: [{ name: 'claude_code.token.usage', unit: 'tokens', sum: { dataPoints: [{ attributes: sessionAttr('os-1'), asInt: '7', timeUnixNano: '1735689600000000500' }] } }] }] }],
      });
      expect(metrics.status).toBe(200);
      hub!.requests.length = 0;
      expect((await shRun('Stop', 'os-1')).code).toBe(0);
      expect(statusLog('os-1')).toHaveLength(2);
      expect(statusLog('os-1')[1]).toMatch(/otel-status state=ok reason=null detail=null received=1\/1\/0 phase=stop/);
      expect(uploadedStatus('os-1').map((l) => [l.state, l.reason])).toEqual([['partial', 'not-configured'], ['ok', null]]);
      expect((await shRun('SessionEnd', 'os-1')).code).toBe(0);
      expect(statusLog('os-1')).toHaveLength(2);
    });

    await test.step('19. a session that never gets a record: nothing at Stop, one state=none line at SessionEnd, uploaded with zero counts', async () => {
      hub!.requests.length = 0;
      expect((await shRun('Stop', 'os-2')).code).toBe(0);
      expect(statusLog('os-2')).toHaveLength(0);
      expect((await shRun('SessionEnd', 'os-2')).code).toBe(0);
      expect(statusLog('os-2')).toHaveLength(1);
      expect(statusLog('os-2')[0]).toMatch(/otel-status state=none reason=not-configured detail=null received=0\/0\/0 phase=session-end/);
      expect(uploadedStatus('os-2')).toEqual([
        expect.objectContaining({ state: 'none', reason: 'not-configured', received: { logs: 0, metrics: 0, spans: 0, firstAt: null } }),
      ]);
      expect(readHookLog(shRepo, 'send-logs-hook.js').some((l) => /session-end flush done: uploaded=\d+ failed=0/.test(l))).toBe(true);
    });
  } finally {
    await stopReceiver(sharedReceiver);
    await stopReceiver(receiver);
    await oldHub?.close();
    await hub?.close();
    dirs.cleanup();
  }
});
