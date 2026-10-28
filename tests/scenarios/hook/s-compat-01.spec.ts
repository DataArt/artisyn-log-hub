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
  claudeProjectDir,
  isRecord,
  makeFakeGitRepo,
  makeFakeHome,
  REPO_ROOT,
  runScript,
  runToken,
  subagentsDir,
  tempDirs,
  writeStandConfig,
  type HookRun,
  type TempDirs,
} from '../helpers/hook-process';
import { ndjson, queueRowCount, sessionRowCount, storedBody } from '../helpers/ingest';
import { uploadOkfSessionTree } from '../helpers/okf';
import { ownRepoId } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { openSession } from '../helpers/session-view';

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
  close(): Promise<void>;
}

/** A loopback proxy in front of the stand that records every log upload and its response. */
async function startStandProxy(standUrl: string): Promise<StandProxy> {
  const target = new URL(standUrl);
  const calls: ProxiedCall[] = [];
  const proxy: StandProxy = { url: '', calls, failChunk: null, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
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

test('@S-COMPAT-01 frozen 1.6.2 and 2.6.1 hooks against the current server @mode-a @mode-c', async ({ api, db, users, stand, page }) => {
  test.setTimeout(240_000);
  const run = runToken();
  const dirs = tempDirs();
  let proxy: StandProxy | undefined;
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
  } finally {
    await proxy?.close();
    dirs.cleanup();
  }
});
