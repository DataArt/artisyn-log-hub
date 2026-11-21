// S-COMPAT-01. Old hooks against the new server
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-COMPAT-01; layer API; no
// mode in the design → A and C, DD SC4).
//
// The «frozen clients» are the real hook scripts of two historical versions, frozen once by
// `scripts/scenarios/freeze-legacy-hook.mjs` into tests/fixtures/legacy-hooks/<ver>/ (FROZEN.json
// names the commit). They run unchanged, from a throwaway copy, as Claude Code would run them:
// UserPromptSubmit (`telemetry-hook.js`) then Stop (`send-logs-hook.js`). Expectations follow
// impl-plan DD SC5, which overrides the design text:
//   - 1.6.2 — the last version before 1.7.0. It uploads only to `POST /api/v1/logs`, which the
//     server no longer has (DD SC3): every upload is a 404, and the hook fails OPEN — exit 0
//     within its timeout, every file counted as failed (`done: … failed=N`, N > 0), the manifest
//     untouched so nothing is lost locally, and nothing reaches the server;
//   - 2.6.1 — the last version before 2.8.0 (there is no 2.7.x in the history of version.json):
//     its v2 uploads succeed — single requests, sub-agents with their parents and workflow run,
//     a hook-status older than the baseline («outdated»), and the chunked form of that version
//     (900 KB chunks, `uploadId`/`chunkIndex`/`totalChunks`, `totalSize` on chunk 0) including a
//     resume from `.claude-logs.pending` after a failed chunk.
//
// Code facts that differ from the design text:
//   - the design's three hand-written clients (`legacy-1.6.0`, `-1.8.0`, `-2.7.0`) became the two
//     real frozen hooks above (DD SC5), so steps 1–3 (v1 201/400) are now «v1 is gone, the old
//     hook fails open», and steps 4–6 run on 2.6.1;
//   - step 7 (`perToolDetailSupported` in `mcp-config`) is not exercised: 2.6.1's MCP config
//     shape is covered by its harness upload being accepted, the per-tool contract is
//     S-HOOK-09's;
//   - step 9's «snapshot» is the response form each frozen client depends on, asserted inline:
//     201 + JSON `{warnings: []}` for a single request, `{complete: false}` then
//     `{complete: true, warnings: [...]}` for chunks.
//
// Steps 10–11 (2026-10-27 OKF usage tab, FR-2, FR-14): 2.6.1 predates the OKF snapshot AND the
// `git.root` field, so its session is never bound (`okf_snapshot_id` null) and the KB article its
// agent read cannot be made repo-relative — the OKF tab is the empty state. A hook between the
// two (root sent, no snapshot; no frozen copy exists) is uploaded inline with helpers/okf.ts: its
// read counts with «partial data», and the OKF tab shows the «update the hook» banner.
// Step 11b (2026-11-19 OKF v0.3): the previous released hook (3.0.0) sends a snapshot without
// front-matter metadata — the OKF tab renders as before, with no metadata chips or hints.
//
// Steps 12–13 (2026-10-30 OTEL tabs, AC-10 / AC-11):
//   - 2.28.0 — the last hook without OTEL traces and the realtime channel. Its real Stop uploads
//     the transcript, and its `--otel-sweep` run (what the 2.28.0 receiver launches on a quiet
//     minute) ships the OTEL chunk the receiver wrote: `signal:"logs"` lines only, no
//     `hookVersion` field. The OTEL tabs show the full chart and the hidden breakdown, the
//     waterfall's place says «No traces — upgrade the hook», and the slow banner names the hook;
//   - 1.6.2 never reaches the server (steps 1–3) and 2.6.1 predates OTEL in the project config
//     (its OTEL is off): the 2.6.1 session and its repository show the OTEL empty state, every
//     other session view is unchanged.
//
// Steps 14–15 (2026-10-30 shared receiver, AC-A3, DD-22): 2.28.0 is also the last per-project-
// receiver hook. Next to a running shared receiver (current hook, fake home with port.json and
// token) it keeps re-arming and registering on its own `otelReceiverPort`; pointed at the shared
// port by a stale config, its unauthenticated register and shutdown get 401, the shared receiver
// stays up, and its own receiver launched there exits 0 on EADDRINUSE.
//
// Steps 16–17 (2026-11-18 receiver upload queue, hook 3.0.0): 2.32.3 — the last hook before the
// upload job queue — on the same repo and the same user as a 3.0.0 hook:
//   - 16: the frozen 2.32.3 `Stop`, the 3.0.0 `prompt-upload-hook.js` and a 3.0.0 `--run-job`
//     started together share the per-repo `.upload.lock`: a recording proxy that holds each log
//     upload 500 ms never sees two in flight, the losers skip (or exit 12, busy), and a retry gets
//     every session onto the server;
//   - 17: the frozen 2.32.3 `otel-receiver.js` holds the shared port and writes no heartbeat. A
//     3.0.0 `Stop` therefore uploads in-process and spawns its own 3.0.0 receiver, which takes the
//     uploader role queue-only (port busy); the next `Stop` hands off a job and that receiver runs
//     it. The detached 3.0.0 receiver is killed through its `uploader.lock` pid at the end.
//
// Replaces:
//   - server/test/upload-queue.e2e-spec.ts — «v1 unmodified» (1)
//   - server/test/logs.e2e-spec.ts — empty-response checks (2)
//   - server/src/logs/artisyn-extractor.spec.ts — «old hook compatibility» (≈ 3)
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  authedRequest,
  claudeProjectDir,
  copyToolDir,
  copyToolDirTo,
  freeLoopbackPort,
  isRecord,
  makeFakeGitRepo,
  makeFakeHome,
  rawRequest,
  readHookLog,
  REPO_ROOT,
  runNodeScript,
  runPromptUpload,
  runScript,
  runToken,
  sharedHello,
  spawnReceiver,
  startSharedReceiver,
  stopReceiver,
  subagentsDir,
  tempDirs,
  waitForExit,
  waitForPort,
  writeConfig,
  writeSharedState,
  writeStandConfig,
  type HookRun,
  type ReceiverProcess,
  type TempDirs,
} from '../helpers/hook-process';
import { ndjson, queueRowCount, sessionRowCount, storedBody } from '../helpers/ingest';
import { uploadOkfSessionTree } from '../helpers/okf';
import { callLines, chunkBody, floor5m, otelTurn, transcriptBodies } from '../fixtures/otel/otel-lines';
import { repoFacts, sessionOtel, waitForOtelProjected } from '../helpers/otel';
import { ownRepoId } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { openSession, selectSessionTab } from '../helpers/session-view';

const LEGACY_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'legacy-hooks');
const PROMPT = 'compat: fix the old bug';

interface Frozen {
  commit: string;
  version: string;
}

/** A throwaway copy of a frozen hook (the fixture itself is never written to). */
function copyFrozenHook(dirs: TempDirs, version: string): { toolDir: string; frozen: Frozen } {
  const src = path.join(LEGACY_DIR, version);
  const frozen = JSON.parse(fs.readFileSync(path.join(src, 'FROZEN.json'), 'utf8')) as Frozen;
  const toolDir = dirs.make(`legacy-${version}`);
  fs.cpSync(src, toolDir, { recursive: true, filter: (p) => path.basename(p) !== 'FROZEN.json' });
  return { toolDir, frozen };
}

function hookLogLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

/** `done: uploaded=… skipped=… failed=… total=…` of the last Stop in a hook.log. */
function lastDone(lines: string[]): { uploaded: number; failed: number; total: number } {
  const done = [...lines].reverse().find((l) => l.includes('done: uploaded='));
  const m = done?.match(/uploaded=(\d+) skipped=\d+ failed=(\d+) total=(\d+)/);
  if (!m) throw new Error(`no «done:» line in hook.log:\n${lines.join('\n')}`);
  return { uploaded: Number(m[1]), failed: Number(m[2]), total: Number(m[3]) };
}

function transcriptLines(sid: string, branch: string, cwd: string, turns: number, padBytes = 0): object[] {
  const t0 = Date.now() - 30 * 60_000;
  const rows: object[] = [];
  for (let i = 0; i < turns; i += 1) {
    const at = (s: number) => new Date(t0 + (i * 60 + s) * 1000).toISOString();
    rows.push({ type: 'user', uuid: `u${i}`, sessionId: sid, timestamp: at(0), cwd, gitBranch: branch, message: { role: 'user', content: i === 0 ? PROMPT : `turn ${i}` } });
    rows.push({
      type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, sessionId: sid, timestamp: at(5),
      message: {
        id: `msg-${sid}-${i}`, role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100 + i, output_tokens: 20 },
        content: [{ type: 'text', text: padBytes > 0 ? 'x'.repeat(padBytes) : `answer ${i}` }],
      },
    });
  }
  return rows;
}

interface ProxiedCall {
  query: URLSearchParams;
  status: number;
  contentType: string;
  body: string;
}

interface StandProxy {
  url: string;
  calls: ProxiedCall[];
  /** When set, a chunk with this `chunkIndex` is answered 500 without reaching the stand. */
  failChunk: string | null;
  /** Each log upload (`…/logs`) is held this long before it is forwarded (default 0). */
  delayMs: number;
  /** The most log uploads that were in flight at the same time (step 16: the upload lock). */
  maxInFlight: number;
  close(): Promise<void>;
}

/** A loopback proxy in front of the stand that records every log upload and its response. */
async function startStandProxy(standUrl: string): Promise<StandProxy> {
  const target = new URL(standUrl);
  const calls: ProxiedCall[] = [];
  const proxy: StandProxy = { url: '', calls, failChunk: null, delayMs: 0, maxInFlight: 0, close: async () => undefined };
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    const isUpload = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.endsWith('/logs');
    if (isUpload) {
      inFlight += 1;
      proxy.maxInFlight = Math.max(proxy.maxInFlight, inFlight);
      res.on('close', () => {
        inFlight -= 1;
      });
    }
    const forward = () => {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      if (proxy.failChunk !== null && query.get('chunkIndex') === proxy.failChunk) {
        calls.push({ query, status: 500, contentType: 'application/json', body: '{"message":"injected"}' });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"message":"injected"}');
        return;
      }
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: target.host, 'content-length': String(body.length) };
      const upstream = http.request(
        { host: target.hostname, port: target.port, path: req.url, method: req.method, headers, agent: false },
        (up) => {
          const out: Buffer[] = [];
          up.on('data', (c: Buffer) => out.push(c));
          up.on('end', () => {
            const text = Buffer.concat(out).toString('utf8');
            calls.push({ query, status: up.statusCode ?? 0, contentType: String(up.headers['content-type'] ?? ''), body: text });
            res.writeHead(up.statusCode ?? 502, up.headers);
            res.end(text);
          });
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    };
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (isUpload && proxy.delayMs > 0) setTimeout(forward, proxy.delayMs);
      else forward();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('proxy has no TCP address');
  proxy.url = `http://127.0.0.1:${addr.port}`;
  proxy.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return proxy;
}

function expectRunOk(run: HookRun, what: string): void {
  expect(run.code, `${what}: ${run.stderr}`).toBe(0);
}

/** `<home>/.artisyn/upload` — the per-user upload queue state of hook 3.0.0 (DD-2). */
function uploadStateDir(home: string): string {
  return path.join(home, '.artisyn', 'upload');
}

/** Job files (no claims, no temp files) in `<home>/.artisyn/upload/queue/`. */
function queuedJobs(home: string): string[] {
  const dir = path.join(uploadStateDir(home), 'queue');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.') && (n.endsWith('.json') || n.endsWith('.claim'))).sort() : [];
}

function readJsonOrNull(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A fresh uploader heartbeat (DD-6), as if a 3.0.0 receiver held the uploader role. */
function writeFakeHeartbeat(home: string): string {
  const file = path.join(uploadStateDir(home), 'heartbeat.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: 1, pid: process.pid, version: '3.0.0', capabilities: ['shared', 'upload-queue-v1'],
    uploadContract: 1, listening: true, startedAt: new Date().toISOString(), ts: Date.now(),
  }));
  return file;
}

/**
 * Best effort: kill the receiver that holds `<home>/.artisyn/upload/uploader.lock` — one a hook run
 * spawned detached (DD-7), so the scenario has no handle on it.
 */
function killUploaderOf(home: string | undefined): void {
  if (!home) return;
  const lock = readJsonOrNull(path.join(uploadStateDir(home), 'uploader.lock'));
  if (!lock || typeof lock.pid !== 'number' || lock.pid === process.pid) return;
  try {
    process.kill(lock.pid);
  } catch {
    // already gone
  }
}

test('@S-COMPAT-01 frozen 1.6.2, 2.6.1 and 2.28.0 hooks against the current server @mode-a @mode-c', async ({ api, db, users, stand, page }) => {
  test.setTimeout(360_000);
  const run = runToken();
  const dirs = tempDirs();
  let proxy: StandProxy | undefined;
  let lockProxy: StandProxy | undefined;
  let shared: ReceiverProcess | undefined;
  let legacyReceiver: ReceiverProcess | undefined;
  let legacyShared: ReceiverProcess | undefined;
  let queueHome: string | undefined;
  try {
    const owner = await users.user('user', { label: 'compat-owner' });
    const key = await createApiKey(owner.api);

    await test.step('1–3. 1.6.2 (v1 only): every upload is a 404, the hook fails open, nothing reaches the server', async () => {
      const { toolDir, frozen } = copyFrozenHook(dirs, '1.6.2');
      expect(frozen.version).toBe('1.6.2');
      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:compat/${run}/v16.git` });
      const home = makeFakeHome(dirs);
      const sid = `c16-${run}`;
      fs.writeFileSync(path.join(toolDir, '.env'), `SERVER_URL=${stand.url}\nSEND_LOGS_TIMEOUT_MS=5000\nCTX_PROJECT=compat\n`);
      fs.writeFileSync(path.join(toolDir, '.env.local'), `API_KEY=${key.key}\n`);
      fs.writeFileSync(path.join(claudeProjectDir(home, repo), `${sid}.jsonl`), ndjson(transcriptLines(sid, 'main', repo, 1)));

      const prompt = await runScript(toolDir, 'telemetry-hook.js', { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: repo, prompt: PROMPT }, { home });
      expectRunOk(prompt, 'UserPromptSubmit');
      const telemetry = path.join(repo, '.ai_work_dir', 'telemetry');
      expect(fs.existsSync(path.join(telemetry, `${sid}.jsonl`)), '1.6.2 writes its own telemetry dir').toBe(true);

      const stop = await runScript(toolDir, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: sid, cwd: repo }, { home, timeoutMs: 20_000 });
      expectRunOk(stop, 'Stop');
      expect(stop.elapsedMs, 'a 404 is answered at once — no waiting out the timeout').toBeLessThan(15_000);

      const log = hookLogLines(path.join(repo, '.ai_work_dir', 'hook.log'));
      const fails = log.filter((l) => l.includes('[fail]'));
      expect(fails.length, log.join('\n')).toBeGreaterThan(0);
      expect(log.some((l) => l.includes('HTTP 404')), 'the log names the 404').toBe(true);
      const done = lastDone(log);
      expect(done.failed).toBeGreaterThan(0);
      expect(done.uploaded).toBe(0);
      expect(done.failed).toBe(done.total);
      expect(fs.existsSync(path.join(telemetry, '.claude-logs.sent')) ? fs.readFileSync(path.join(telemetry, '.claude-logs.sent'), 'utf8').trim() : '', 'nothing marked as sent, so nothing is lost locally').toBe('');

      expect(await sessionRowCount(db, sid)).toBe(0);
      expect(await queueRowCount(db, sid)).toBe(0);
      const v1 = await api.post('/api/v1/logs', {
        params: { type: 'artisyn', sessionId: sid },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data: ndjson([{ event: 'prompt_start', session_id: sid, prompt: PROMPT }]),
      });
      expect(v1.status(), 'the request 1.6.2 sends').toBe(404);
    });

    const v26 = await test.step('setup 2.6.1: frozen hook, project config on the stand through a recording proxy, a session with nested and workflow sub-agents', async () => {
      const { toolDir, frozen } = copyFrozenHook(dirs, '2.6.1');
      expect(frozen.version).toBe('2.6.1');
      proxy = await startStandProxy(stand.url);
      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:compat/${run}/v26.git`, branch: 'feature/compat' });
      const home = makeFakeHome(dirs);
      writeStandConfig(repo, proxy.url, key.key);
      const sid = `c26-${run}`;
      // The main agent also reads a KB article (step 10): 2.6.1 sends no repo root, so the server
      // cannot place the read in the repository and stores no OKF row for it.
      const kbRead = [
        {
          type: 'assistant', uuid: 'kb-a', parentUuid: 'a1', sessionId: sid, timestamp: new Date(Date.now() - 25 * 60_000).toISOString(), cwd: repo,
          message: { id: `msg-${sid}-kb`, role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 50, output_tokens: 5 },
            content: [{ type: 'tool_use', id: 'toolu_kb_1', name: 'Read', input: { file_path: path.join(repo, 'docs', 'kb', 'guide.md') } }] },
        },
        {
          type: 'user', uuid: 'kb-r', parentUuid: 'kb-a', sessionId: sid, timestamp: new Date(Date.now() - 25 * 60_000 + 1000).toISOString(), cwd: repo,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_kb_1', content: '# Guide\n'.repeat(50) }] },
        },
      ];
      fs.writeFileSync(path.join(claudeProjectDir(home, repo), `${sid}.jsonl`), ndjson([...transcriptLines(sid, 'feature/compat', repo, 2), ...kbRead]));
      const agents = subagentsDir(home, repo, sid);
      const sub = (agentId: string) => ndjson([
        { type: 'user', uuid: `${agentId}-u`, sessionId: sid, isSidechain: true, timestamp: new Date(Date.now() - 20 * 60_000).toISOString(), message: { role: 'user', content: 'sub task' } },
        { type: 'assistant', uuid: `${agentId}-a`, parentUuid: `${agentId}-u`, sessionId: sid, isSidechain: true, timestamp: new Date(Date.now() - 19 * 60_000).toISOString(),
          message: { id: `msg-${agentId}`, role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'done' }] } },
      ]);
      const outer = `agent-${run}o1`;
      const inner = `agent-${run}i1`;
      const plain = `agent-${run}p1`;
      fs.writeFileSync(path.join(agents, `${outer}.jsonl`), sub(outer));
      fs.writeFileSync(path.join(agents, `${inner}.jsonl`), sub(inner));
      fs.writeFileSync(path.join(agents, `${inner}.meta.json`), JSON.stringify({ parentAgentId: `${run}o1` }));
      fs.writeFileSync(path.join(agents, `${plain}.jsonl`), sub(plain));
      const wfDir = path.join(agents, 'workflows', `wf_${run}`);
      fs.mkdirSync(wfDir, { recursive: true });
      const wfAgent = `agent-${run}w1`;
      fs.writeFileSync(path.join(wfDir, `${wfAgent}.jsonl`), sub(wfAgent));
      return { toolDir, repo, home, sid, outer, inner, plain, wfAgent, wfRun: `wf_${run}` };
    });

    const fire = async (event: 'UserPromptSubmit' | 'Stop') => {
      const script = event === 'Stop' ? 'send-logs-hook.js' : 'telemetry-hook.js';
      const r = await runScript(v26.toolDir, script, { hook_event_name: event, session_id: v26.sid, cwd: v26.repo, prompt: PROMPT }, { home: v26.home, timeoutMs: 30_000 });
      expectRunOk(r, event);
      return r;
    };
    const hookLog = () => hookLogLines(path.join(v26.repo, '.artisyn', 'ai_work_dir', 'hook.log'));

    await test.step('6. 2.6.1 uploads by v2: the session, its repository and branch, sub-agents under their parents, the workflow run', async () => {
      await fire('UserPromptSubmit');
      await fire('Stop');
      const done = lastDone(hookLog());
      expect(done.failed, hookLog().join('\n')).toBe(0);
      expect(done.uploaded).toBeGreaterThanOrEqual(6);
      await waitForQueueIdle(db, owner.id);

      const repoId = await ownRepoId(owner.api, `https://git.arrakis.test/compat/${run}/v26`);
      const list = (await (await owner.api.get(`/api/v1/repositories/${repoId}/sessions`)).json()) as Array<{ sessionId: string; gitBranch?: string; userEmail?: string }>;
      const row = list.find((s) => s.sessionId === v26.sid);
      expect(row, 'the 2.6.1 session is listed').toBeTruthy();
      expect(row!.gitBranch).toBe('feature/compat');
      expect(row!.userEmail).toBe(owner.email);

      const parents = await db.query<{ session_id: string; parent_session_id: string | null; workflow_run_id: string | null }>(
        'SELECT session_id, parent_session_id, workflow_run_id FROM sessions WHERE session_id = ANY($1)',
        [[v26.outer, v26.inner, v26.plain, v26.wfAgent]],
      );
      const by = new Map(parents.rows.map((r) => [r.session_id, r]));
      expect(by.get(v26.outer)?.parent_session_id, 'no meta → the root session').toBe(v26.sid);
      expect(by.get(v26.plain)?.parent_session_id).toBe(v26.sid);
      expect(by.get(v26.inner)?.parent_session_id, 'meta parentAgentId → the parent agent').toBe(v26.outer);
      expect(by.get(v26.wfAgent)?.parent_session_id).toBe(v26.sid);
      expect(by.get(v26.wfAgent)?.workflow_run_id).toBe(v26.wfRun);

      // 2.6.1 predates the agent meta labels (agentDescription / workflowPhase upload params):
      // its workflow agent is stored with both columns NULL, and /logs reports null for both.
      const meta = await db.query<{ agent_description: string | null; workflow_phase: string | null }>(
        'SELECT agent_description, workflow_phase FROM sessions WHERE session_id = $1',
        [v26.wfAgent],
      );
      expect(meta.rows).toHaveLength(1);
      expect(meta.rows[0].agent_description).toBeNull();
      expect(meta.rows[0].workflow_phase).toBeNull();
      const logsRes = await owner.api.get(`/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(v26.sid)}/logs`);
      expect(logsRes.status()).toBe(200);
      const logs = (await logsRes.json()) as { subagents?: Array<{ sessionId: string; agentDescription?: string | null; workflowPhase?: string | null }> };
      const wfSub = (logs.subagents ?? []).find((s) => s.sessionId === v26.wfAgent);
      expect(wfSub, 'the 2.6.1 workflow agent is in /logs subagents').toBeTruthy();
      expect(wfSub!.agentDescription).toBeNull();
      expect(wfSub!.workflowPhase).toBeNull();

      // 2.6.1 predates the harness-snapshot lines (DD-1): it never sends snapshotId, so the
      // session is never bound to one.
      const bound = await db.query<{ harness_snapshot_id: string | null }>(
        'SELECT harness_snapshot_id FROM sessions WHERE session_id = $1',
        [v26.sid],
      );
      expect(bound.rows[0]?.harness_snapshot_id).toBeNull();
    });

    await test.step('9. response form of a single v2 request: 201, JSON, {warnings: [...]} — what 2.6.1 parses', async () => {
      const singles = proxy!.calls.filter((c) => !c.query.has('chunkIndex'));
      expect(singles.length).toBeGreaterThan(0);
      for (const c of singles) {
        expect(c.status).toBe(201);
        expect(c.contentType).toMatch(/application\/json/);
        const body: unknown = JSON.parse(c.body);
        expect(isRecord(body) && Array.isArray(body.warnings), c.body).toBe(true);
      }
    });

    await test.step('8. the hook-status of 2.6.1 is below the baseline: hook state «outdated», ingest unaffected', async () => {
      const repoId = await ownRepoId(owner.api, `https://git.arrakis.test/compat/${run}/v26`);
      const res = await owner.api.get(`/api/v1/repositories/${repoId}/hook-state`);
      expect(res.status()).toBe(200);
      const state = (await res.json()) as { hookVersion: string; outdated: boolean };
      expect(state.hookVersion).toBe('2.6.1');
      expect(state.outdated).toBe(true);
      const hooks = (await (await owner.api.get('/api/v1/repositories/hooks')).json()) as Array<{ id: number; outdated: boolean }>;
      expect(hooks.find((r) => r.id === repoId)?.outdated).toBe(true);
    });

    await test.step('10. 2.6.1 sends no OKF snapshot and no repo root: okf_snapshot_id stays null, its KB read is not counted (FR-2), the OKF tab is the empty state', async () => {
      const bound = await db.query<{ okf_snapshot_id: string | null }>(
        'SELECT okf_snapshot_id FROM sessions WHERE session_id = $1',
        [v26.sid],
      );
      expect(bound.rows[0]?.okf_snapshot_id).toBeNull();
      const repoId = await ownRepoId(owner.api, `https://git.arrakis.test/compat/${run}/v26`);
      const res = await owner.api.get(`/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(v26.sid)}/okf-usage`);
      expect(res.status()).toBe(200);
      const usage = (await res.json()) as { hasSnapshot: boolean; verdict: unknown; readTop: unknown[] };
      expect(usage).toMatchObject({ hasSnapshot: false, verdict: null, readTop: [] });
      await openSession(page, owner, repoId, v26.sid, { tab: 'okf' });
      await expect(page.getByTestId('okf-empty')).toContainText('No OKF knowledge base');
    });

    await test.step('11. a pre-OKF hook that does send the repo root (2.8 … 2.25): unbound session, the KB read counts, «partial data» and the «update the hook» banner (FR-14)', async () => {
      // No frozen hook of that range exists; its upload shape is the current one minus the OKF
      // lines and query params, which is exactly helpers/okf.ts with `snapshot: null`.
      const sid = `c25-${run}`;
      const repoUrl = `https://git.arrakis.test/compat/${run}/pre-okf`;
      await uploadOkfSessionTree(
        api,
        key.key,
        { sessionId: sid, repoUrl, snapshot: null, actions: [{ read: 'docs/kb/guide.md', bytes: 400 }] },
        { db, userId: owner.id },
      );
      const bound = await db.query<{ okf_snapshot_id: string | null }>('SELECT okf_snapshot_id FROM sessions WHERE session_id = $1', [sid]);
      expect(bound.rows[0]?.okf_snapshot_id).toBeNull();
      const repoId = await ownRepoId(owner.api, repoUrl);
      const res = await owner.api.get(`/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sid)}/okf-usage`);
      expect(res.status()).toBe(200);
      const usage = (await res.json()) as { hasSnapshot: boolean; verdict: { level: string; qualifiers: string[] } | null; readTop: Array<{ path: string }> };
      expect(usage.hasSnapshot).toBe(false);
      expect(usage.verdict).toMatchObject({ level: 'ok', qualifiers: ['partial_data'] });
      expect(usage.readTop.map((r) => r.path)).toEqual(['docs/kb/guide.md']);

      await openSession(page, owner, repoId, sid, { tab: 'okf' });
      const banner = page.getByTestId('okf-no-snapshot');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('Update the Log Hub hook');
      await expect(page.getByTestId('okf-verdict-card')).toContainText('partial data — no KB snapshot');
      await expect(page.getByTestId('okf-tree-row').filter({ hasText: 'guide.md' })).toHaveCount(1);
      await banner.getByRole('button', { name: 'How to update' }).click();
      await expect(page).toHaveURL(/#\/api-keys/);
    });

    await test.step('11b. OKF v0.3 (2026-11-19): the previous released hook (3.0.0) sends a snapshot without front-matter metadata — the OKF tab works as before, with no title, version chip, advice line or chip (FR-9)', async () => {
      // 3.0.0's okf-snapshot is the current shape minus the optional bundle fields and the
      // per-file `meta`, which is exactly helpers/okf.ts without them.
      const sid = `c30-${run}`;
      const repoUrl = `https://git.arrakis.test/compat/${run}/okf-30`;
      await uploadOkfSessionTree(
        api,
        key.key,
        {
          sessionId: sid,
          repoUrl,
          snapshot: { bundles: [{ root: 'docs/kb', files: ['docs/kb/guide.md', 'docs/kb/old.md'] }] },
          actions: [{ read: 'docs/kb/index.md', bytes: 300 }, { read: 'docs/kb/guide.md', bytes: 400 }],
        },
        { db, userId: owner.id },
      );
      const repoId = await ownRepoId(owner.api, repoUrl);
      const res = await owner.api.get(`/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sid)}/okf-usage`);
      expect(res.status()).toBe(200);
      const usage = (await res.json()) as {
        hasSnapshot: boolean;
        bundles: Array<Record<string, unknown>>;
        tree: Array<{ children?: Array<Record<string, unknown>> }>;
      };
      expect(usage.hasSnapshot).toBe(true);
      expect(usage.bundles).toHaveLength(1);
      for (const k of ['title', 'description', 'okfVersion', 'newerFormatHint', 'articlesWithHints', 'hintReasons']) {
        expect(usage.bundles[0], `no ${k} without hook metadata`).not.toHaveProperty(k);
      }
      for (const node of usage.tree.flatMap((n) => n.children ?? [])) {
        for (const k of ['deprecated', 'supersededBy', 'pastStaleAfter', 'formatHints']) expect(node).not.toHaveProperty(k);
      }

      await openSession(page, owner, repoId, sid, { tab: 'okf' });
      await expect(page.getByTestId('session-okf-tab')).toBeVisible();
      await expect(page.getByTestId('okf-bundle-card')).toContainText('docs/kb');
      await expect(page.getByTestId('okf-tree-row').filter({ hasText: 'guide.md' })).toHaveCount(1);
      for (const id of [
        'okf-bundle-title',
        'okf-bundle-version',
        'okf-bundle-can-improve',
        'okf-bundle-newer-format',
        'okf-tree-bundle-newer-format',
        'okf-tree-bundle-can-improve',
        'okf-deprecated-chip',
        'okf-past-stale-after',
        'okf-can-improve',
      ]) {
        await expect(page.getByTestId(id), id).toHaveCount(0);
      }
    });

    const v228 = await test.step('12. AC-10: frozen 2.28.0 — Stop uploads the transcript, its --otel-sweep ships the OTEL logs chunk; the OTEL tabs show chart and hidden breakdown, «No traces — upgrade the hook» instead of the waterfall, no error', async () => {
      const { toolDir, frozen } = copyFrozenHook(dirs, '2.28.0');
      expect(frozen.version).toBe('2.28.0');
      const repoUrl = `https://git.arrakis.test/compat/${run}/v228`;
      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:compat/${run}/v228.git` });
      const home = makeFakeHome(dirs);
      writeStandConfig(repo, stand.url, key.key);
      const sid = `c228-${run}`;
      const tag = `k${run}`;
      const turn = otelTurn(tag, floor5m(new Date(Date.now() - 30 * 60_000)));
      const { claude } = transcriptBodies({ sessionId: sid, prompt: PROMPT, repoUrls: [repoUrl], branch: 'main', at: new Date(Date.now() - 31 * 60_000), requestIds: turn.transcriptRequestIds });
      fs.writeFileSync(path.join(claudeProjectDir(home, repo), `${sid}.jsonl`), claude);
      const prompt = await runScript(toolDir, 'telemetry-hook.js', { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: repo, prompt: PROMPT }, { home });
      expectRunOk(prompt, '2.28.0 UserPromptSubmit');
      expectRunOk(await runScript(toolDir, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: sid, cwd: repo }, { home, timeoutMs: 30_000 }), '2.28.0 Stop');

      // What the 2.28.0 receiver writes: one chunk per OTLP request, logs only, no hookVersion.
      const otelDir = path.join(repo, '.artisyn', 'ai_work_dir', 'telemetry', 'otel', sid);
      fs.mkdirSync(otelDir, { recursive: true });
      fs.writeFileSync(path.join(otelDir, `${Date.now()}-0.jsonl`), chunkBody(callLines(sid, turn, { hookVersion: null })));
      const sweep = await runNodeScript(path.join(toolDir, 'send-logs-hook.js'), repo, null, { home, argv: ['--otel-sweep', '--cwd', repo], timeoutMs: 30_000 });
      expectRunOk(sweep, '2.28.0 --otel-sweep');
      expect(fs.readdirSync(otelDir), 'the uploaded chunk is deleted').toEqual([]);
      await waitForQueueIdle(db, owner.id);
      await waitForOtelProjected(db, sid);

      const repoId = await ownRepoId(owner.api, repoUrl);
      const snap = await sessionOtel(owner, repoId, sid);
      expect(snap.status).toMatchObject({ hasOtel: true, hasSpans: false, slowUpdates: true, slowReason: 'old-hook', otelHookVersion: null });
      expect(Number(snap.kpis?.totalCostUsdMicros)).toBe(turn.totalMicros);
      expect(Number(snap.kpis?.hiddenCostUsdMicros)).toBe(turn.hiddenMicros);
      expect(snap.spans).toEqual([]);
      const facts = await repoFacts(owner, repoId);
      expect(facts).toMatchObject({ hasOtel: true, slowUpdates: true, hookVersion: '2.28.0' });

      await openSession(page, owner, repoId, sid, { tab: 'otel' });
      const tab = page.getByTestId('session-otel-tab');
      await expect(tab.getByTestId('otel-cost-chart')).toBeVisible();
      await expect(tab.getByTestId('otel-hidden-bars')).toContainText('prompt_suggestion');
      await expect(tab.getByTestId('otel-empty-B')).toContainText('No traces — upgrade the hook');
      await expect(tab.getByTestId('otel-slow-banner')).toHaveAttribute('data-reason', 'old-hook');
      await expect(tab.getByText('Could not load OTEL data.')).toHaveCount(0);
      return { sid, repoId, totalMicros: turn.totalMicros };
    });

    await test.step('12a. AC-8 (2026-11-03 otel-cost-attribution): the 2.28.0 OTEL lines carry no attribution and no account — each new stack-by is one «not reported» bucket equal to the total, the session route returns plan: null, and the UI shows no Account row, plan note, plan chip or plan mix', async () => {
      for (const stackBy of ['skill', 'mcpServer', 'effort', 'speed']) {
        const facts = await repoFacts(owner, v228.repoId, { stackBy });
        expect(new Set(facts.buckets.map((b) => b.key)), `repository stackBy=${stackBy}`).toEqual(new Set(['']));
        expect(facts.buckets.reduce((n, b) => n + Number(b.costUsdMicros), 0), `repository stackBy=${stackBy}`).toBe(v228.totalMicros);
        const session = await sessionOtel(owner, v228.repoId, v228.sid, { stackBy });
        expect(new Set(session.buckets.map((b) => b.key)), `session stackBy=${stackBy}`).toEqual(new Set(['']));
        expect(session.buckets.reduce((n, b) => n + Number(b.costUsdMicros), 0), `session stackBy=${stackBy}`).toBe(v228.totalMicros);
      }
      expect((await sessionOtel(owner, v228.repoId, v228.sid)).plan).toBeNull();
      const facts = await repoFacts(owner, v228.repoId);
      expect(facts.planMix?.every((r) => r.plan === null), 'no session reports a plan').toBe(true);

      await openSession(page, owner, v228.repoId, v228.sid, { tab: 'otel' });
      const tab = page.getByTestId('session-otel-tab');
      await expect(tab.getByTestId('otel-kpi-total')).toBeVisible({ timeout: 20_000 });
      await expect(tab.getByTestId('session-otel-account')).toHaveCount(0);
      await expect(tab.getByTestId('session-otel-plan-note')).toHaveCount(0);
      await expect(tab.getByTestId('otel-kpi-plan-chip')).toHaveCount(0);
      await page.goto(`/#/repos/${v228.repoId}?mtab=otel`);
      await page.reload();
      await expect(page.getByTestId('repo-otel-tab').getByTestId('otel-kpi-total')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('otel-plan-mix')).toHaveCount(0);
    });

    await test.step('13. AC-11: 1.6.2 reached nothing (steps 1–3); the 2.6.1 session, recorded with OTEL off, shows the OTEL empty state in its session and repository tabs, and its other views are unchanged', async () => {
      const repoId = await ownRepoId(owner.api, `https://git.arrakis.test/compat/${run}/v26`);
      const snap = await sessionOtel(owner, repoId, v26.sid);
      expect(snap.status.hasOtel).toBe(false);
      expect(snap.calls).toEqual([]);
      expect((await repoFacts(owner, repoId)).hasOtel).toBe(false);
      await openSession(page, owner, repoId, v26.sid, { tab: 'otel' });
      // 2.6.1 reports no otel-status: the generic `no-status` reason panel (shared-receiver task, DD-31).
      await expect(page.getByTestId('otel-reason-panel')).toContainText('No OTEL data for this session');
      await expect(page.getByTestId('otel-reason-status-line')).toHaveCount(0);
      await selectSessionTab(page, 'summary');
      await expect(page.getByTestId('summary-executive-band')).toBeVisible();
      await selectSessionTab(page, 'logs');
      await expect(page.locator('[data-turn-index]').first()).toBeVisible();
      await page.goto(`/#/repos/${repoId}?mtab=otel`);
      // 0 of M sessions with OTEL: the `reason` variant, dominated by the old hook's `no-status`.
      const repoEmpty = page.getByTestId('otel-empty-reason');
      await expect(repoEmpty).toHaveAttribute('data-reason', 'no-status');
      await expect(repoEmpty).toContainText(/No OTEL data in this period \(0 of \d+ sessions?\)/);
    });

    await test.step('4–5. a 1.5 MB transcript in 900 KB chunks: chunk 1 fails, the next Stop resumes from .claude-logs.pending and the server assembles it byte for byte', async () => {
      const bigSid = `c26big-${run}`;
      const rows = transcriptLines(bigSid, 'feature/compat', v26.repo, 30, 50_000);
      const bigFile = path.join(claudeProjectDir(v26.home, v26.repo), `${bigSid}.jsonl`);
      fs.writeFileSync(bigFile, ndjson(rows));
      const size = fs.statSync(bigFile).size;
      expect(size).toBeGreaterThan(900 * 1024);
      expect(size).toBeLessThan(1800 * 1024);
      const pendingFile = path.join(v26.repo, '.artisyn', 'ai_work_dir', 'telemetry', '.claude-logs.pending');

      proxy!.failChunk = '1';
      const before = proxy!.calls.length;
      await fire('Stop');
      const first = proxy!.calls.slice(before).filter((c) => c.query.get('sessionId') === bigSid);
      expect(first.map((c) => `${c.query.get('chunkIndex')}:${c.status}`)).toEqual(['0:201', '1:500']);
      const chunk0 = first[0];
      expect(chunk0.query.get('totalChunks')).toBe('2');
      expect(chunk0.query.get('totalSize')).toBe(String(size));
      expect(chunk0.query.get('uploadId')).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(chunk0.body)).toEqual({ complete: false });
      expect(fs.readFileSync(pendingFile, 'utf8'), 'the acked chunk is recorded for resume').toContain(chunk0.query.get('uploadId')!);
      expect(lastDone(hookLog()).failed).toBe(1);

      proxy!.failChunk = null;
      const mid = proxy!.calls.length;
      await fire('Stop');
      const second = proxy!.calls.slice(mid).filter((c) => c.query.get('sessionId') === bigSid);
      expect(second.map((c) => `${c.query.get('chunkIndex')}:${c.status}`), 'the resumed upload replays the recorded chunk, then finishes').toEqual(['0:201', '1:201']);
      for (const c of second) expect(c.query.get('uploadId')).toBe(chunk0.query.get('uploadId'));
      const final: unknown = JSON.parse(second[1].body);
      expect(isRecord(final) && final.complete === true && Array.isArray(final.warnings), second[1].body).toBe(true);
      expect(lastDone(hookLog()).failed).toBe(0);
      expect(fs.readFileSync(pendingFile, 'utf8').includes(chunk0.query.get('uploadId')!), 'pending record cleared').toBe(false);

      await waitForQueueIdle(db, owner.id);
      const stored = (await storedBody(db, bigSid, 'claude')) ?? [];
      expect(stored).toHaveLength(rows.length);
      expect(stored[0]).toEqual(rows[0]);
      expect(stored[stored.length - 1]).toEqual(rows[rows.length - 1]);
    });

    // Steps 14–15 (2026-10-30 shared receiver, AC-A3, DD-22): a user who upgraded one repo keeps
    // frozen 2.28.0 in another. Nothing here talks to the stand.
    const current = copyToolDir(dirs);
    const legacyHook = copyFrozenHook(dirs, '2.28.0').toolDir;
    const shHome = makeFakeHome(dirs);
    const shState = await writeSharedState(shHome);
    const shAuth = { token: shState.token, home: shHome };
    const sharedLog = () => fs.readFileSync(path.join(shState.stateDir, 'receiver.log'), 'utf8');
    const legacyConfig = (port: number) => ({ base: { otelEnabled: true, sendLogsOnPromptEnabled: false, otelReceiverPort: port, otelReceiverIdleTimeoutMs: 5000 } });

    await test.step('14. AC-A3: frozen 2.28.0 keeps its own per-project port next to a running shared receiver — its Stop re-arms and registers there, never on the shared port, and changes neither port', async () => {
      shared = await startSharedReceiver(current, { home: shHome, stateDir: shState.stateDir, port: shState.port });
      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:compat/${run}/v228-port.git` });
      const otelDir = path.join(repo, '.artisyn', 'ai_work_dir', 'telemetry', 'otel');
      fs.mkdirSync(otelDir, { recursive: true });
      const legacyPort = await freeLoopbackPort();
      legacyReceiver = spawnReceiver(legacyHook, { port: legacyPort, dir: otelDir, owner: { gitRoot: repo, repo: `git@git.arrakis.test:compat/${run}/v228-port.git` }, idleTimeoutMs: 30_000 });
      await waitForPort(legacyPort);
      writeConfig(repo, legacyConfig(legacyPort));
      const configBefore = fs.readFileSync(path.join(repo, '.artisyn', 'config', 'log-hub.json'), 'utf8');
      const portFileBefore = fs.readFileSync(path.join(shState.stateDir, 'port.json'), 'utf8');

      // The home has the shared port.json — 2.28.0 never reads it (FR-A11).
      expectRunOk(await runScript(legacyHook, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: `c228p-${run}`, cwd: repo }, { home: shHome, timeoutMs: 30_000 }), '2.28.0 Stop');
      const log = readHookLog(repo);
      expect(log.some((l) => l.includes(`otel receiver re-armed on 127.0.0.1:${legacyPort}`)), log.join('\n')).toBe(true);
      expect(log.some((l) => l.includes(`:${shState.port}`)), 'the shared port is never used').toBe(false);
      expect(sharedLog()).not.toMatch(/auth-reject|register /);
      expect(fs.readFileSync(path.join(repo, '.artisyn', 'config', 'log-hub.json'), 'utf8')).toBe(configBefore);
      expect(fs.readFileSync(path.join(shState.stateDir, 'port.json'), 'utf8')).toBe(portFileBefore);
      // Its own receiver still serves it.
      const owner = { gitRoot: repo, repo: `git@git.arrakis.test:compat/${run}/v228-port.git` };
      expect((await rawRequest(legacyPort, '/artisyn/register', { sessionId: 'p1', ...owner })).status).toBe(200);
      expect(legacyReceiver.exitCode()).toBeUndefined();
    });

    await test.step('15. DD-22: a legacy register and shutdown on the shared port (a stale otelReceiverPort) → 401, the shared receiver stays up; the frozen receiver launched on that port exits 0 (EADDRINUSE)', async () => {
      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:compat/${run}/v228-stale.git` });
      writeConfig(repo, legacyConfig(shState.port));
      expectRunOk(await runScript(legacyHook, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: `c228s-${run}`, cwd: repo }, { home: shHome, timeoutMs: 30_000 }), '2.28.0 Stop on the shared port');
      await expect.poll(() => sharedLog().includes('auth-reject route=/artisyn/register reason=missing-header'), { timeout: 5000 }).toBe(true);

      const owner = { gitRoot: repo, repo: `git@git.arrakis.test:compat/${run}/v228-stale.git` };
      const register = await rawRequest(shState.port, '/artisyn/register', { sessionId: 'stale-1', ...owner });
      expect(register.status).toBe(401);
      expect(register.json).toEqual({ error: 'unauthorized' });
      const shutdown = await rawRequest(shState.port, '/artisyn/shutdown', { gitRoot: repo, sessionId: 'stale-1' });
      expect(shutdown.status).toBe(401);
      expect(sharedLog()).toContain('auth-reject route=/artisyn/shutdown reason=missing-header');

      const loser = spawnReceiver(legacyHook, { port: shState.port, dir: path.join(repo, '.artisyn', 'ai_work_dir', 'telemetry', 'otel'), owner, idleTimeoutMs: 5000 });
      expect(await waitForExit(loser), 'EADDRINUSE is the normal second-receiver path').toBe(0);

      expect(shared!.exitCode(), 'the shared receiver is still running').toBeUndefined();
      const hello = await sharedHello(shState.port, shAuth);
      expect(hello.res.status).toBe(200);
      expect(hello.proofValid).toBe(true);
      expect((await authedRequest(shState.port, '/artisyn/session-status', { sessionId: 'stale-1' }, shAuth)).json).toMatchObject({ registered: false });
    });

    // Steps 16–17 (2026-11-18 receiver upload queue): frozen 2.32.3 next to hook 3.0.0.
    const legacy232 = copyFrozenHook(dirs, '2.32.3');
    const hook3Version = (dir: string) => String(readJsonOrNull(path.join(dir, 'version.json'))?.version);

    await test.step('16. one repo, one user: the frozen 2.32.3 Stop, the 3.0.0 prompt-upload-hook.js and a 3.0.0 --run-job started together never upload at the same time (the shared .upload.lock); the losers skip or exit 12 (busy), and after a retry every session reaches the server', async () => {
      expect(legacy232.frozen.version).toBe('2.32.3');
      const hook3 = copyToolDir(dirs);
      expect(hook3Version(hook3)).toMatch(/^3\./);
      lockProxy = await startStandProxy(stand.url);
      lockProxy.delayMs = 500;
      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:compat/${run}/v232-lock.git` });
      const home = makeFakeHome(dirs);
      writeStandConfig(repo, lockProxy.url, key.key, { sendLogsTimeoutMs: 15_000 });
      const telemetry = path.join(repo, '.artisyn', 'ai_work_dir', 'telemetry');
      fs.mkdirSync(telemetry, { recursive: true });
      const sids = { legacy: `c232s-${run}`, prompt: `c30p-${run}`, job: `c30j-${run}` };
      for (const sid of Object.values(sids)) {
        fs.writeFileSync(path.join(claudeProjectDir(home, repo), `${sid}.jsonl`), ndjson(transcriptLines(sid, 'main', repo, 1)));
        fs.writeFileSync(path.join(telemetry, `${sid}.jsonl`), ndjson([{ event: 'prompt_start', session_id: sid, prompt: PROMPT }]));
      }

      // The 3.0.0 job: a Stop under a fresh (faked) uploader heartbeat only queues it (DD-7).
      const heartbeat = writeFakeHeartbeat(home);
      const handOff = await runScript(hook3, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: sids.job, cwd: repo }, { home }).finally(() => fs.rmSync(heartbeat, { force: true }));
      expectRunOk(handOff, '3.0.0 hand-off Stop');
      const [job] = queuedJobs(home);
      expect(job).toMatch(new RegExp(`^${sids.job}_\\d{8}T\\d{9}Z_stop_\\d+-[0-9a-f]{4}\\.json$`));
      expect(lockProxy.calls, 'a hand-off Stop uploads nothing').toHaveLength(0);
      const jobPath = path.join(uploadStateDir(home), 'queue', job);
      const runJob = () => runNodeScript(path.join(hook3, 'send-logs-hook.js'), dirs.make('run-job-cwd'), null, { home, argv: ['--run-job', jobPath], timeoutMs: 90_000 });

      const [legacyStop, prompt, jobRun] = await Promise.all([
        runScript(legacy232.toolDir, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: sids.legacy, cwd: repo }, { home, timeoutMs: 90_000 }),
        runPromptUpload(hook3, { cwd: repo, sessionId: sids.prompt }, { home, timeoutMs: 90_000 }),
        runJob(),
      ]);
      expectRunOk(legacyStop, '2.32.3 Stop');
      expectRunOk(prompt, '3.0.0 prompt-upload-hook.js');
      expect([0, 12], `--run-job exit: ${jobRun.stderr}`).toContain(jobRun.code);
      expect(lockProxy.calls.length, 'the runs uploaded something').toBeGreaterThan(0);
      expect(lockProxy.maxInFlight, 'never two uploads at once: the lock is honoured across 2.32.3 and 3.0.0').toBe(1);
      const log = readHookLog(repo);
      const skipped = log.filter((l) => l.includes('skipped: upload lock held')).length;
      expect(skipped + (jobRun.code === 12 ? 1 : 0), `someone lost the race:\n${log.join('\n')}`).toBeGreaterThan(0);

      // Retry what lost: a busy job is left untouched for the receiver's retry, and the next 2.32.3
      // Stop's full scan picks up whatever the skipped runs left.
      if (jobRun.code === 12) {
        expect(queuedJobs(home), 'exit 12 leaves the job and no claim').toEqual([job]);
        expectRunOk(await runJob(), '--run-job retry');
      }
      expect(queuedJobs(home), 'the job is done and deleted').toEqual([]);
      expectRunOk(await runScript(legacy232.toolDir, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: sids.legacy, cwd: repo }, { home, timeoutMs: 90_000 }), '2.32.3 Stop retry');
      expect(lockProxy.maxInFlight).toBe(1);
      expect(lockProxy.calls.every((c) => c.status === 201), lockProxy.calls.map((c) => `${c.status} ${c.body}`).join('\n')).toBe(true);
      expect(fs.existsSync(path.join(telemetry, '.upload.lock')), 'the lock is released').toBe(false);
      expect(readHookLog(repo, 'send-logs-hook.js').some((l) => l.includes(`run-job done: ${job}`))).toBe(true);

      await waitForQueueIdle(db, owner.id);
      for (const sid of Object.values(sids)) {
        expect(await sessionRowCount(db, sid), `${sid} reached the server`).toBe(1);
        expect(await storedBody(db, sid, 'claude'), `${sid} transcript stored`).toHaveLength(2);
      }
    });

    await test.step('17. the frozen 2.32.3 otel-receiver.js is the shared receiver (no heartbeat): a 3.0.0 Stop uploads in-process and spawns a 3.0.0 receiver that goes queue-only (port busy, uploader role); the next 3.0.0 Stop queues a job and that receiver uploads it', async () => {
      const home = makeFakeHome(dirs);
      queueHome = home;
      const state = await writeSharedState(home);
      // The 3.0.0 hook as a plugin under the fake home, so its receiver accepts its send-logs-hook.js as a job's uploader.
      const hook3 = copyToolDirTo(path.join(home, '.claude', 'plugins', 'log-hub-hooks', 'scripts'));
      expect(hook3Version(hook3)).toMatch(/^3\./);
      legacyShared = await startSharedReceiver(legacy232.toolDir, { home, stateDir: state.stateDir, port: state.port });
      const heartbeatFile = path.join(uploadStateDir(home), 'heartbeat.json');
      const legacyHello = await sharedHello(state.port, { token: state.token, home });
      expect(legacyHello.proofValid, 'the 2.32.3 receiver serves the shared port').toBe(true);
      expect(fs.existsSync(heartbeatFile), '2.32.3 writes no uploader heartbeat').toBe(false);

      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:compat/${run}/v232-queue.git` });
      writeStandConfig(repo, stand.url, key.key, { sendLogsTimeoutMs: 15_000 });
      const sid = `c232q-${run}`;
      const transcript = path.join(claudeProjectDir(home, repo), `${sid}.jsonl`);
      fs.writeFileSync(transcript, ndjson(transcriptLines(sid, 'main', repo, 1)));
      const stop = () => runScript(hook3, 'send-logs-hook.js', { hook_event_name: 'Stop', session_id: sid, cwd: repo }, { home, timeoutMs: 60_000 });

      // No fresh heartbeat → in-process Stop (DD-7), plus a receiver spawn for the queue.
      expectRunOk(await stop(), '3.0.0 Stop without an uploader');
      const firstLog = readHookLog(repo, 'send-logs-hook.js');
      expect(firstLog.some((l) => /\[result\] done: uploaded=\d+ skipped=\d+ failed=0/.test(l)), firstLog.join('\n')).toBe(true);
      expect(firstLog.some((l) => l.includes('receiver: spawned for upload queue')), firstLog.join('\n')).toBe(true);
      expect(firstLog.some((l) => l.includes('queued:')), 'nothing queued yet').toBe(false);
      await waitForQueueIdle(db, owner.id);
      expect(await storedBody(db, sid, 'claude')).toHaveLength(2);

      // The spawned 3.0.0 receiver finds the port held by 2.32.3 and keeps the uploader role queue-only (DD-8).
      await expect
        .poll(() => {
          const hb = readJsonOrNull(heartbeatFile);
          return hb && hb.pid !== legacyShared!.child.pid ? hb.listening : undefined;
        }, { timeout: 15_000 })
        .toBe(false);
      const hb = readJsonOrNull(heartbeatFile)!;
      expect(hb).toMatchObject({ schema: 1, version: hook3Version(hook3), uploadContract: 1, listening: false });
      expect(hb.capabilities).toContain('upload-queue-v1');
      expect(readJsonOrNull(path.join(uploadStateDir(home), 'uploader.lock'))).toMatchObject({ pid: hb.pid });
      expect(fs.readFileSync(path.join(state.stateDir, 'receiver.log'), 'utf8')).toContain(`queue-only: port ${state.port} busy`);
      expect(legacyShared.exitCode(), 'the 2.32.3 receiver keeps the port').toBeUndefined();

      // A second turn; the next Stop sees the fresh heartbeat and only queues a job.
      fs.writeFileSync(transcript, ndjson(transcriptLines(sid, 'main', repo, 2)));
      const handOff = await stop();
      expectRunOk(handOff, '3.0.0 hand-off Stop');
      const queuedLine = readHookLog(repo, 'send-logs-hook.js').find((l) => l.includes('[result] queued: job='));
      const job = /queued: job=(\S+)/.exec(queuedLine ?? '')?.[1];
      expect(job, readHookLog(repo).join('\n')).toMatch(new RegExp(`^${sid}_\\d{8}T\\d{9}Z_stop_\\d+-[0-9a-f]{4}\\.json$`));

      // The queue-only receiver runs it: the job is deleted and the second turn is on the server.
      await expect.poll(() => queuedJobs(home), { timeout: 30_000 }).toEqual([]);
      await expect
        .poll(() => readHookLog(repo, 'send-logs-hook.js').some((l) => l.includes(`run-job done: ${job}`)), { timeout: 15_000 })
        .toBe(true);
      expect(fs.readFileSync(path.join(state.stateDir, 'receiver.log'), 'utf8')).toContain(`job-done job=${job}`);
      await waitForQueueIdle(db, owner.id);
      expect(await storedBody(db, sid, 'claude'), 'the queued upload reached the server').toHaveLength(4);
      expect(legacyShared.exitCode(), 'the 2.32.3 receiver is still up').toBeUndefined();
    });
  } finally {
    killUploaderOf(queueHome);
    await stopReceiver(shared);
    await stopReceiver(legacyReceiver);
    await stopReceiver(legacyShared);
    await proxy?.close();
    await lockProxy?.close();
    dirs.cleanup();
  }
});
