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
// Steps 6b–6e (2026-11-23-session-logs-streaming, hook 3.2.0, DD-24/25/26): `.claude-logs.sent.v2`
// is written next to the old manifest with the read size, the pre-read mtime and the upload-params
// hash; a same-bytes mtime change and a late `.meta.json` re-send the file; a `failedUploads` entry
// in the hub's answer drops that key from both manifests, so the next Stop re-sends it. Step 7's
// SessionEnd records the session's own transcript in both manifests — at the size already there,
// so the old manifest's bytes stay the same.
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
// Steps 10–10b (2026-11-18 receiver upload queue, hook 3.0.0): a SessionEnd no longer waits a
// busy upload lock out (20 s before); after LOCK_WAIT_SESSION_END_MS = 800 it leaves a job in
// `~/.artisyn/upload/queue/`. With a fresh uploader heartbeat it only writes the job and returns
// (DD-1: `elapsedMs <= 500` in the `queued` line, < 1 s wall); `--run-job <job>` is what the shared
// receiver then spawns. A busy-lock SessionEnd is asserted on its logged wait (< 1 s) — its wall
// time adds the Node start-up, measured ≈ 1.1 s. Steps 18–19 wait for the shared receiver to run
// their SessionEnd job, since that receiver now holds the uploader role.
//
// Steps 11b–11d (same task, phase 2): a `Stop` under a fresh fake heartbeat only writes a `stop`
// job; two such jobs coalesce into one `--run-job` full scan with the same harness snapshot id as an
// in-process `Stop`. A 25 h old job goes to `failed/`, is reported in the next in-process `Stop`'s
// `hook-status` (`uploadQueue.failedJobs`, the `upload-jobs-failed` recommendation) and cleared by
// that run. With a stale heartbeat a `Stop` takes over a stuck job (DD-11).
//
// Steps 20–27 (2026-11-24 traffic optimization, hook 3.3.0): append uploads. A grown `claude` /
// `claude-subagent` log whose append state (`appendBytes` / `appendLines` / `appendSha256` in
// `.claude-logs.sent.v2`) still matches sends only its new complete lines to
// `POST /api/v2/logs/append?startLine=<n>` (FR-1/2/3, blank and torn prefix lines, a loopback
// delta never gzipped); every fallback trigger ends in a full upload of the whole file (FR-6);
// a 404 / 413 from the append route writes `append-off.json` and the next Stop is full; artisyn,
// tool-calls and a sub-agent with new `.meta.json` params stay on the full route (FR-10). Since
// 3.3.0 an unchanged transcript re-read by a scan (step 6c), a SessionEnd (step 7) or a job
// (step 10b) finds nothing to append and sends no request for it.
//
// Steps 12–15 cover the ARTISYN_PROJECT_ROOT override (git-context.js / project-root-override.js):
// in a linked worktree it makes the worktree the project root, and it is ignored when unset or
// when it does not contain the cwd.
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
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
  type FakeReply,
} from '../helpers/hook-process';
import { callLines, otelTurn, spanLines } from '../fixtures/otel/otel-lines';

const API_KEY = 'k-test-123456';
const HARNESS_TYPES = ['harness-snapshot-ref', 'harness-snapshot'];

/** One `.claude-logs.sent.v2` entry (DD-26). */
interface V2Entry {
  size: number;
  mtimeMs: number;
  paramsSha256: string;
  fp?: string;
}

/** DD-26 `paramsSha256`: sha256 of the JSON list [type, sessionId, parent, workflowRunId, description, phase]. */
function paramsHash(list: string[]): string {
  return createHash('sha256').update(JSON.stringify(list), 'utf8').digest('hex');
}

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
  test.setTimeout(300_000);
  const dirs = tempDirs();
  let hub: FakeLogHub | undefined;
  let oldHub: FakeLogHub | undefined;
  let appendHub: FakeLogHub | undefined;
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
      fs.writeFileSync(path.join(agents, 'agent-a1.meta.json'), JSON.stringify({ parentAgentId: 'p9', description: '   ' }));
      fs.writeFileSync(path.join(agents, 'agent-b2.jsonl'), line({ type: 'user', agent: 'b2' }));
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, 'agent-w1.jsonl'), line({ type: 'user', agent: 'w1' }));
      fs.writeFileSync(
        path.join(wfDir, 'agent-w1.meta.json'),
        JSON.stringify({ agentType: 'workflow-subagent', description: 'chunk-6-Tests', workflowPhase: 'Implement' }),
      );
      fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), line({ type: 'result' }));
      fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# rules\n');
      // An OKF bundle (2026-10-27 OKF usage tab): the hook sends its snapshot with the artisyn uploads.
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
      // Agent meta labels from .meta.json: W1 carries description + phase; a1's whitespace-only
      // description is dropped by the hook's sanitiser, so its query has neither param.
      expect(bySid('agent-w1').query.get('agentDescription')).toBe('chunk-6-Tests');
      expect(bySid('agent-w1').query.get('workflowPhase')).toBe('Implement');
      expect(bySid('agent-a1').query.get('agentDescription')).toBeNull();
      expect(bySid('agent-a1').query.get('workflowPhase')).toBeNull();
      expect(bySid('agent-b2').query.get('agentDescription')).toBeNull();
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

    await test.step('4b. new hook → old server: the OKF snapshot rides on the artisyn uploads (full line once, then the ref), the hub ignores okfSnapshotId (no unknownOkfSnapshotId), the upload still succeeds', async () => {
      // The fake hub answers every upload with a bare `{warnings: []}` — exactly an old Log Hub,
      // which knows neither the OKF query params nor the OKF lines.
      // Since hook 3.1.0 a backlog session's artisyn body carries the OKF lines too. `artisyn/old`
      // goes out before `artisyn/cur` (step 3), so it delivers the full line and cur sends the ref.
      const old = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'old')!;
      const oldLines = ndjsonLines(old.body.toString('utf8'));
      const full = oldLines.find((e) => e.type === 'okf-snapshot');
      expect(full, 'full okf-snapshot line on the first artisyn upload of the run').toBeDefined();
      okfSnapshotId = String(full!.okfSnapshotId);
      expect(okfSnapshotId).toMatch(/^[0-9a-f]{64}$/);
      expect(oldLines.find((e) => e.type === 'okf-snapshot-ref')?.okfSnapshotId).toBe(okfSnapshotId);
      expect(Array.isArray(full!.bundles) && (full!.bundles as Array<{ root: string }>).map((b) => b.root)).toEqual(['docs/kb']);
      expect(old.query.get('okfSnapshotId')).toBe(okfSnapshotId);
      expect(old.query.get('okfSnapshotFull')).toBe('1');
      // The harness pair never rides on a backlog upload.
      expect(old.query.get('snapshotId')).toBeNull();
      const cur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      const curLines = ndjsonLines(cur.body.toString('utf8'));
      expect(curLines.find((e) => e.type === 'okf-snapshot-ref')?.okfSnapshotId).toBe(okfSnapshotId);
      expect(curLines.some((e) => e.type === 'okf-snapshot'), 'the full line goes out once per run').toBe(false);
      expect(cur.query.get('okfSnapshotId')).toBe(okfSnapshotId);
      expect(cur.query.get('okfSnapshotFull')).toBeNull();
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

    // Steps 6b–6e (2026-11-23-session-logs-streaming, DD-25/DD-26): the v2 manifest next to the old one.
    const v2Path = path.join(telemetry, '.claude-logs.sent.v2');
    const readV2 = () => (JSON.parse(fs.readFileSync(v2Path, 'utf8')) as { version: number; entries: Record<string, V2Entry> });
    const oldTranscript = path.join(project, 'old.jsonl');

    await test.step('6b. the v2 manifest holds every key of the old one with the same size, the pre-read mtime and the params hash; every upload asks for feedback and carries the body hash', async () => {
      const v1 = readManifest(telemetry);
      const v2 = readV2();
      expect(v2.version).toBe(2);
      expect(Object.keys(v2.entries).sort()).toEqual([...v1.keys()].sort());
      for (const [k, size] of v1) expect(v2.entries[k].size, k).toBe(size);
      // Hook 3.3.0: a claude log also carries its append state — here the whole file (step 6
      // appended its second line), so bytes = size, lines = 2 and the hash of every byte.
      const oldBytes = fs.readFileSync(oldTranscript);
      expect(v2.entries['claude/old.jsonl']).toEqual({
        size: fs.statSync(oldTranscript).size,
        mtimeMs: fs.statSync(oldTranscript).mtimeMs,
        paramsSha256: paramsHash(['claude', 'old', '', '', '', '']),
        appendBytes: oldBytes.length,
        appendLines: 2,
        appendSha256: createHash('sha256').update(oldBytes).digest('hex'),
      });
      for (const e of Object.values(v2.entries)) expect(e.paramsSha256).toMatch(/^[0-9a-f]{64}$/);
      // The last run's requests (step 6): DD-25 / DD-24 query params.
      expect(hub!.requests.find((r) => r.sessionId === 'old')?.query.get('contentSha256')).toMatch(/^[0-9a-f]{64}$/);
      for (const r of hub!.requests) {
        expect(r.query.get('uploadFeedback'), `${r.type}/${r.sessionId}`).toBe('1');
        const declared = r.query.get('contentSha256');
        if (declared !== null) expect(declared, `${r.type}/${r.sessionId}`).toBe(createHash('sha256').update(bodyText(r), 'utf8').digest('hex'));
      }
    });

    await test.step('6c. only the mtime of the old transcript changes (same bytes) → the file is read again, but its append state finds no new line, so nothing is sent; the new mtime is recorded, then skipped', async () => {
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(oldTranscript, later, later);
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      // Hook 3.3.0 (Design Decision 20, step 4): `none` — no request, the entry gets the new mtime.
      expect(hub!.uploads()).toEqual(['artisyn/cur']);
      expect(readV2().entries['claude/old.jsonl'].mtimeMs).toBe(fs.statSync(oldTranscript).mtimeMs);
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.uploads()).toEqual(['artisyn/cur']);
    });

    await test.step('6d. a .meta.json written after the sub-agent was sent changes its upload params → sent again with the label', async () => {
      fs.writeFileSync(path.join(agents, 'agent-b2.meta.json'), JSON.stringify({ description: 'late label' }));
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.uploads().sort()).toEqual(['artisyn/cur', 'claude-subagent/agent-b2']);
      const b2 = hub!.requests.find((r) => r.sessionId === 'agent-b2')!;
      expect(b2.query.get('agentDescription')).toBe('late label');
      expect(b2.query.get('parentSessionId')).toBe('cur');
    });

    await test.step('6e. the hub reports a failed upload (`failedUploads`) → its entry leaves both manifests and the next Stop sends it again', async () => {
      hub!.respond((req) =>
        req.type === 'artisyn' && req.sessionId === 'cur'
          ? { status: 201, body: JSON.stringify({ warnings: [], failedUploads: [{ sessionId: 'old', type: 'claude' }] }) }
          : { status: 201, body: JSON.stringify({ warnings: [] }) },
      );
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.uploads()).toEqual(['artisyn/cur']);
      expect(readManifest(telemetry).has('claude/old.jsonl'), readHookLog(repo, 'send-logs-hook.js').slice(-12).join('\n')).toBe(false);
      expect(readV2().entries['claude/old.jsonl']).toBeUndefined();
      expect(readManifest(telemetry).has('artisyn/old.jsonl'), 'only the reported type is forgotten').toBe(true);
      expect(readHookLog(repo, 'send-logs-hook.js').some((l) => l.includes('server reported failed uploads — will re-send: claude/old.jsonl'))).toBe(true);

      hub!.respond(() => ({ status: 201, body: JSON.stringify({ warnings: [] }) }));
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      expect(hub!.uploads().sort()).toEqual(['artisyn/cur', 'claude/old']);
      expect(readManifest(telemetry).get('claude/old.jsonl')).toBe(fs.statSync(oldTranscript).size);
      expect(readV2().entries['claude/old.jsonl']?.size).toBe(fs.statSync(oldTranscript).size);
    });

    await test.step('7. SessionEnd for cur → only its artisyn file (its unchanged transcript has nothing to append); manifest untouched; lock released', async () => {
      const manifestBefore = fs.readFileSync(path.join(telemetry, '.claude-logs.sent'), 'utf8');
      hub!.requests.length = 0;
      expect((await run('SessionEnd')).code).toBe(0);
      // Hook 3.3.0: the own transcript goes through the append path, which finds no new line.
      expect(hub!.uploads().sort()).toEqual(['artisyn/cur']);
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

    // Steps 10–10b (2026-11-18 receiver upload queue, hook 3.0.0): the per-user upload queue
    // `~/.artisyn/upload/queue/` of the fake home. No receiver runs here; a fresh uploader heartbeat
    // is faked by writing `heartbeat.json` (DD-6), and step 10b runs the job the way the receiver does.
    const uploadState = path.join(home, '.artisyn', 'upload');
    const queueDir = path.join(uploadState, 'queue');
    const queuedJobs = () => (fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((n) => n.endsWith('.json')).sort() : []);
    const SESSION_END_JOB = /^cur_\d{8}T\d{9}Z_session-end_\d+-[0-9a-f]{4}\.json$/;
    let handOffJob = '';

    await test.step('10. Stop waits for a busy lock only ~2 s; SessionEnd on a busy lock gives up after 0.8 s and leaves a job; with a fresh uploader heartbeat SessionEnd only writes a job (DD-3 name, no API key) and returns at once', async () => {
      const lock = path.join(telemetry, '.upload.lock');
      fs.writeFileSync(lock, JSON.stringify({ startedAt: new Date().toISOString() }));
      hub!.requests.length = 0;
      const stop = await run('Stop');
      expect(stop.code).toBe(0);
      expect(stop.elapsedMs, 'Stop gives up on a busy lock quickly').toBeLessThan(4000);
      expect(hub!.requests).toHaveLength(0);

      // SessionEnd fallback (no heartbeat): LOCK_WAIT_SESSION_END_MS = 800, then a job instead of an upload.
      fs.writeFileSync(lock, JSON.stringify({ startedAt: new Date().toISOString() }));
      const end = await run('SessionEnd');
      expect(end.code, end.stderr).toBe(0);
      // The wait itself is < 1 s; the wall time adds the Node start-up (≈ 0.3 s, more on a loaded runner).
      expect(end.elapsedMs, 'SessionEnd no longer waits a busy lock out').toBeLessThan(2500);
      expect(hub!.requests).toHaveLength(0);
      const fallbackLine = readHookLog(repo, 'send-logs-hook.js').at(-1) ?? '';
      const fallback = /\[result\] queued \(fallback\): lock busy job=(\S+) \(waited (\d+)ms/.exec(fallbackLine);
      expect(fallback, fallbackLine).not.toBeNull();
      expect(Number(fallback![2])).toBeLessThan(1000);
      expect(queuedJobs()).toEqual([fallback![1]]);
      expect(fallback![1]).toMatch(SESSION_END_JOB);
      fs.rmSync(lock);
      // Not run here: step 10b runs the hand-off job below.
      fs.rmSync(path.join(queueDir, fallback![1]));

      // A fresh heartbeat of an uploader-role receiver → the hand-off path: one job, no upload.
      fs.mkdirSync(uploadState, { recursive: true });
      const heartbeat = path.join(uploadState, 'heartbeat.json');
      fs.writeFileSync(heartbeat, JSON.stringify({
        schema: 1, pid: process.pid, version: '3.0.0', capabilities: ['shared', 'upload-queue-v1'],
        uploadContract: 1, listening: true, startedAt: new Date().toISOString(), ts: Date.now(),
      }));
      const handOff = await run('SessionEnd');
      fs.rmSync(heartbeat);
      expect(handOff.code, handOff.stderr).toBe(0);
      expect(handOff.elapsedMs, 'DD-1: the hand-off returns in well under a second').toBeLessThan(1000);
      expect(hub!.requests).toHaveLength(0);
      const jobs = queuedJobs();
      expect(jobs).toHaveLength(1);
      handOffJob = jobs[0];
      expect(handOffJob).toMatch(SESSION_END_JOB);
      const queuedLine = readHookLog(repo, 'send-logs-hook.js').at(-1) ?? '';
      const queued = /\[result\] queued: job=(\S+) elapsedMs=(\d+)/.exec(queuedLine);
      expect(queued, queuedLine).not.toBeNull();
      expect(queued![1]).toBe(handOffJob);
      expect(Number(queued![2]), 'DD-1 elapsedMs bound').toBeLessThanOrEqual(500);

      const raw = fs.readFileSync(path.join(queueDir, handOffJob), 'utf8');
      expect(raw, 'the job never carries the API key').not.toContain(API_KEY);
      const job: unknown = JSON.parse(raw);
      if (!isRecord(job)) throw new Error(`job is not an object: ${raw}`);
      expect(job).not.toHaveProperty('apiKey');
      expect(job).toMatchObject({
        schema: 1, sessionId: 'cur', trigger: 'session-end', uploaderContract: 1, hookEvent: 'SessionEnd',
        attempts: 0, nextAttemptAt: null, lastError: null,
      });
      expect(normalizePath(String(job.cwd))).toBe(normalizePath(repo));
      expect(normalizePath(String(job.telemetryDir))).toBe(normalizePath(telemetry));
      expect(normalizePath(String(job.uploader))).toBe(normalizePath(path.join(toolDir, 'send-logs-hook.js')));
    });

    await test.step('10b. send-logs-hook.js --run-job <job> (what the receiver spawns): uploads cur artisyn (the unchanged transcript appends nothing), exits 0, deletes the job and its claim; a copy of the same job run again uploads the same files', async () => {
      const jobPath = path.join(queueDir, handOffJob);
      const copy = fs.readFileSync(jobPath);
      const jobCwd = dirs.make('run-job-cwd');
      const runJob = () => runNodeScript(path.join(toolDir, 'send-logs-hook.js'), jobCwd, null, { home, argv: ['--run-job', jobPath] });
      for (const attempt of ['first', 'copy']) {
        if (attempt === 'copy') fs.writeFileSync(jobPath, copy);
        hub!.requests.length = 0;
        const res = await runJob();
        expect(res.code, `${attempt}: ${res.stderr}`).toBe(0);
        expect(hub!.uploads().sort(), attempt).toEqual(['artisyn/cur']);
        expect(hub!.requests.every((r) => r.headers['x-api-key'] === API_KEY), 'the key comes from the repo config').toBe(true);
        expect(fs.existsSync(jobPath), `${attempt}: job deleted`).toBe(false);
        expect(fs.existsSync(`${jobPath}.claim`), `${attempt}: claim deleted`).toBe(false);
        expect(fs.existsSync(path.join(telemetry, '.upload.lock')), `${attempt}: lock released`).toBe(false);
      }
      const lines = readHookLog(repo, 'send-logs-hook.js');
      expect(lines.filter((l) => l.includes(`run-job start: ${handOffJob}`))).toHaveLength(2);
      expect(lines.filter((l) => l.includes(`run-job done: ${handOffJob}`))).toHaveLength(2);
    });

    await test.step('11. hook.log: an activate line per run and a closing line with the counters', async () => {
      const lines = readHookLog(repo, 'send-logs-hook.js');
      // Hook runs above: steps 1, 5, 5b (×2), 6, 6c (×2), 6d, 6e (×2), 7, 8, 9 (×2), 10 (×3) = 17;
      // the two --run-job runs of step 10b log «run-job start», not an event line. A closing
      // `done:` line comes from every full Stop scan: 1, 5, 5b ×2, 6, 6c ×2, 6d, 6e ×2, 8, 9 = 12.
      expect(lines.filter((l) => /\[activate\] (Stop|SessionEnd) event received/.test(l))).toHaveLength(17);
      expect(lines.filter((l) => /\[result\] done: uploaded=\d+ skipped=\d+ failed=0 total=\d+ target=http:\/\/127\.0\.0\.1:\d+/.test(l)).length).toBe(12);
      expect(lines.some((l) => /claude\/cur\.jsonl: uploaded \d+ KB uncompressed in 1 request$/.test(l))).toBe(true);
      // Step 7's in-process SessionEnd and step 10b's two job runs; step 10's SessionEnds flush nothing.
      // The transcript is one of the two files but has nothing to append (hook 3.3.0), so uploaded=1.
      expect(lines.filter((l) => /session-end flush done: uploaded=1 failed=0 total=2/.test(l))).toHaveLength(3);
    });

    // Steps 11b–11d (2026-11-18 receiver upload queue, phase 2): `stop` jobs, coalescing, `failed/`
    // and the stuck-job takeover, still on the main repo and the fake home of steps 10–10b.
    const heartbeatFile = path.join(uploadState, 'heartbeat.json');
    const failedDir = path.join(uploadState, 'failed');
    const STOP_JOB = /^cur_(\d{8}T\d{9}Z)_stop_\d+-[0-9a-f]{4}\.json$/;
    const fakeHeartbeat = () => {
      fs.mkdirSync(uploadState, { recursive: true });
      fs.writeFileSync(heartbeatFile, JSON.stringify({
        schema: 1, pid: process.pid, version: '3.0.0', capabilities: ['shared', 'upload-queue-v1'],
        uploadContract: 1, listening: true, startedAt: new Date().toISOString(), ts: Date.now(),
      }));
    };
    /** One Stop under a fresh fake heartbeat: it only writes a `stop` job (DD-7) and returns its name. */
    const handOffStop = async (): Promise<string> => {
      const before = new Set(queuedJobs());
      fakeHeartbeat();
      const res = await run('Stop').finally(() => fs.rmSync(heartbeatFile, { force: true }));
      expect(res.code, res.stderr).toBe(0);
      expect(res.elapsedMs, 'DD-1: the hand-off returns in well under a second').toBeLessThan(1000);
      const added = queuedJobs().filter((n) => !before.has(n));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(STOP_JOB);
      const queuedLine = readHookLog(repo, 'send-logs-hook.js').at(-1) ?? '';
      const queued = /\[result\] queued: job=(\S+) elapsedMs=(\d+)/.exec(queuedLine);
      expect(queued, queuedLine).not.toBeNull();
      expect(queued![1]).toBe(added[0]);
      expect(Number(queued![2]), 'DD-1 elapsedMs bound').toBeLessThanOrEqual(500);
      return added[0];
    };
    const runJobFile = (name: string) =>
      runNodeScript(path.join(toolDir, 'send-logs-hook.js'), dirs.make('run-job-cwd'), null, { home, argv: ['--run-job', path.join(queueDir, name)] });
    /** The `hook-status` line of the latest cur artisyn upload. */
    const lastHookStatus = (): Record<string, unknown> => {
      const uploads = hub!.requests.filter((r) => r.type === 'artisyn' && r.sessionId === 'cur');
      expect(uploads.length, 'artisyn/cur uploaded').toBeGreaterThan(0);
      const status = ndjsonLines(uploads[uploads.length - 1].body.toString('utf8')).find((e) => e.type === 'hook-status');
      if (!status) throw new Error('no hook-status line in the cur artisyn upload');
      return status;
    };
    const recommendationRules = (status: Record<string, unknown>) =>
      (Array.isArray(status.recommendations) ? status.recommendations : []).map((r) => (isRecord(r) ? r.rule : null));
    const doneLines = () => readHookLog(repo, 'send-logs-hook.js').filter((l) => /\[result\] done: uploaded=\d+ /.test(l));

    await test.step('11b. Stop with a fresh uploader heartbeat writes a stop job and sends nothing; two stop jobs of the repo coalesce into one --run-job run (both deleted, one done: line) whose artisyn upload carries the same harness snapshot id as an in-process Stop', async () => {
      hub!.requests.length = 0;
      const first = await handOffStop();
      const second = await handOffStop();
      expect(hub!.requests, 'a hand-off Stop makes no HTTP request').toHaveLength(0);
      for (const name of [first, second]) {
        const raw = fs.readFileSync(path.join(queueDir, name), 'utf8');
        expect(raw).not.toContain(API_KEY);
        expect(JSON.parse(raw)).toMatchObject({ schema: 1, sessionId: 'cur', trigger: 'stop', hookEvent: 'Stop', attempts: 0 });
      }

      const doneBefore = doneLines().length;
      const res = await runJobFile(first);
      expect(res.code, res.stderr).toBe(0);
      expect(queuedJobs(), 'both stop jobs deleted').toEqual([]);
      expect(fs.readdirSync(queueDir).filter((n) => n.endsWith('.claim')), 'no claim left').toEqual([]);
      expect(hub!.uploads().filter((u) => u === 'artisyn/cur'), 'one full scan for both jobs').toHaveLength(1);
      const lines = readHookLog(repo, 'send-logs-hook.js');
      expect(lines.some((l) => l.includes(`run-job coalesced 2 stop jobs: ${first}, ${second}`)), lines.join('\n')).toBe(true);
      expect(lines.some((l) => l.includes(`run-job done: ${first}`))).toBe(true);
      expect(lines.some((l) => l.includes(`run-job start: ${second}`)), 'the coalesced job is not run on its own').toBe(false);
      expect(doneLines().length - doneBefore, 'one done: line').toBe(1);
      const jobStatus = lastHookStatus();
      expect(jobStatus.uploadQueue).toEqual({ mode: 'job', stuckTakenOver: 0, failedJobs: 0 });
      const jobCur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      expect(jobCur.query.get('snapshotId')).toBe(snapshotId);

      // The same repo state uploaded by an in-process Stop (no heartbeat) carries the same id.
      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      const inProcessCur = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === 'cur')!;
      expect(inProcessCur.query.get('snapshotId')).toBe(jobCur.query.get('snapshotId'));
      expect(lastHookStatus().uploadQueue).toEqual({ mode: 'in-process', stuckTakenOver: 0, failedJobs: 0 });
    });

    await test.step('11c. a job created 25 h ago goes to failed/ without an upload; the next in-process Stop reports failedJobs 1 and the upload-jobs-failed recommendation, then clears failed/; the Stop after that has neither', async () => {
      const name = await handOffStop();
      const jobPath = path.join(queueDir, name);
      const job: unknown = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      if (!isRecord(job)) throw new Error('job is not an object');
      fs.writeFileSync(jobPath, JSON.stringify({ ...job, createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }));
      hub!.requests.length = 0;
      const res = await runJobFile(name);
      expect(res.code, 'DD-5 permanent').toBe(11);
      expect(hub!.requests).toHaveLength(0);
      expect(queuedJobs()).toEqual([]);
      const failed: unknown = JSON.parse(fs.readFileSync(path.join(failedDir, name), 'utf8'));
      expect(failed).toMatchObject({ sessionId: 'cur', trigger: 'stop', failedReason: 'over-age' });
      expect(readHookLog(repo, 'send-logs-hook.js').some((l) => l.includes(`job failed: ${name} reason=over-age`))).toBe(true);

      expect((await run('Stop')).code).toBe(0);
      const status = lastHookStatus();
      expect(status.uploadQueue).toEqual({ mode: 'in-process', stuckTakenOver: 0, failedJobs: 1 });
      expect(recommendationRules(status)).toContain('upload-jobs-failed');
      expect(fs.readdirSync(failedDir).filter((n) => n.endsWith('.json')), 'a done full scan clears failed/').toEqual([]);
      expect(readHookLog(repo, 'send-logs-hook.js').some((l) => l.includes('failed jobs cleared: 1'))).toBe(true);

      hub!.requests.length = 0;
      expect((await run('Stop')).code).toBe(0);
      const after = lastHookStatus();
      expect(after.uploadQueue).toEqual({ mode: 'in-process', stuckTakenOver: 0, failedJobs: 0 });
      expect(recommendationRules(after)).not.toContain('upload-jobs-failed');
    });

    await test.step('11d. with a stale heartbeat, a Stop takes over a stuck job (name backdated past JOB_STUCK_MS) under the upload lock: «stuck jobs taken over: 1», the job is gone and hook-status says stuckTakenOver 1', async () => {
      const name = await handOffStop();
      // Ten minutes old by its name (JOB_STUCK_MS = 5 min), no claim.
      const backdatedTs = new Date(Date.now() - 10 * 60_000).toISOString().replace(/[-:.]/g, '');
      const backdated = name.replace(STOP_JOB.exec(name)![1], backdatedTs);
      fs.renameSync(path.join(queueDir, name), path.join(queueDir, backdated));
      // A stale heartbeat: a dead uploader's last write.
      fs.writeFileSync(heartbeatFile, JSON.stringify({
        schema: 1, pid: process.pid, version: '3.0.0', capabilities: ['shared', 'upload-queue-v1'],
        uploadContract: 1, listening: true, startedAt: new Date().toISOString(), ts: Date.now() - 60_000,
      }));
      hub!.requests.length = 0;
      try {
        expect((await run('Stop')).code).toBe(0);
      } finally {
        fs.rmSync(heartbeatFile, { force: true });
      }
      const lines = readHookLog(repo, 'send-logs-hook.js');
      expect(lines.some((l) => l.includes(`stuck jobs taken over: 1 (${backdated})`)), lines.join('\n')).toBe(true);
      expect(queuedJobs()).toEqual([]);
      expect(fs.readdirSync(queueDir).filter((n) => n.endsWith('.claim'))).toEqual([]);
      expect(lastHookStatus().uploadQueue).toEqual({ mode: 'in-process', stuckTakenOver: 1, failedJobs: 0 });
      expect(fs.existsSync(path.join(telemetry, '.upload.lock')), 'lock released').toBe(false);
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
    // Hook 3.0.0: the shared receiver holds the uploader role of shHome, so a Stop or a SessionEnd
    // hands its upload off as a job (DD-7) and the receiver runs it with `--run-job` — wait until it
    // is done.
    const shQueue = path.join(shHome, '.artisyn', 'upload', 'queue');
    const shQueueDrained = async () => {
      await expect
        .poll(() => (fs.existsSync(shQueue) ? fs.readdirSync(shQueue).filter((n) => n.endsWith('.json') || n.endsWith('.claim')) : []), { timeout: 20_000 })
        .toEqual([]);
    };
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] };
    const sessionAttr = (sid: string) => [{ key: 'session.id', value: { stringValue: sid } }];

    await test.step('17. otel-status at the first Stop with records: records arrived before the register, a lifecycle re-arm registers the session (a Stop handed off to the uploader re-arms nothing, DD-7), the line says partial (logs only) and rides on the artisyn upload an old hub accepts', async () => {
      writeConfig(shRepo, {
        base: { ...QUIET_HOOK_CONFIG, otelEnabled: true, otelRealtime: false, serverUrl: hub!.url, sendLogsTimeoutMs: 5000 },
        local: { apiKey: API_KEY },
      });
      sharedReceiver = await startSharedReceiver(shTool, { home: shHome, stateDir: shState.stateDir, port: shState.port });
      const logs = await rawRequest(shState.port, '/v1/logs', {
        resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: [{ timeUnixNano: '1735689600000000001', body: { stringValue: 'claude_code.user_prompt' }, attributes: sessionAttr('os-1') }] }] }],
      });
      expect(logs.status).toBe(200);
      // Hook 3.0.0: with an uploader up, the Stop only writes a job, so the session is registered by
      // the lifecycle hook's re-arm, as on any tool event of a real turn.
      const rearm = await runScript(shTool, 'lifecycle-hook.js', { hook_event_name: 'PostToolUse', session_id: 'os-1', cwd: shRepo }, { home: shHome, env: shEnv });
      expect(rearm.code, rearm.stderr).toBe(0);
      hub!.requests.length = 0;
      const stop = await shRun('Stop', 'os-1');
      expect(stop.code, stop.stderr).toBe(0);
      await shQueueDrained();
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
      await shQueueDrained();
      expect(statusLog('os-1'), 'the same state is not written twice').toHaveLength(1);
    });

    await test.step('18. a late correction: metrics arrive, the next Stop writes a second line with state ok; after ok nothing more is written, not even at SessionEnd', async () => {
      const metrics = await rawRequest(shState.port, '/v1/metrics', {
        resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: 'com.anthropic.claude_code' }, metrics: [{ name: 'claude_code.token.usage', unit: 'tokens', sum: { dataPoints: [{ attributes: sessionAttr('os-1'), asInt: '7', timeUnixNano: '1735689600000000500' }] } }] }] }],
      });
      expect(metrics.status).toBe(200);
      hub!.requests.length = 0;
      expect((await shRun('Stop', 'os-1')).code).toBe(0);
      await shQueueDrained();
      expect(statusLog('os-1')).toHaveLength(2);
      expect(statusLog('os-1')[1]).toMatch(/otel-status state=ok reason=null detail=null received=1\/1\/0 phase=stop/);
      expect(uploadedStatus('os-1').map((l) => [l.state, l.reason])).toEqual([['partial', 'not-configured'], ['ok', null]]);
      expect((await shRun('SessionEnd', 'os-1')).code).toBe(0);
      await shQueueDrained();
      expect(statusLog('os-1')).toHaveLength(2);
    });

    await test.step('19. a session that never gets a record: nothing at Stop, one state=none line at SessionEnd, uploaded with zero counts', async () => {
      hub!.requests.length = 0;
      expect((await shRun('Stop', 'os-2')).code).toBe(0);
      await shQueueDrained();
      expect(statusLog('os-2')).toHaveLength(0);
      expect((await shRun('SessionEnd', 'os-2')).code).toBe(0);
      await shQueueDrained();
      expect(statusLog('os-2')).toHaveLength(1);
      expect(statusLog('os-2')[0]).toMatch(/otel-status state=none reason=not-configured detail=null received=0\/0\/0 phase=session-end/);
      expect(uploadedStatus('os-2')).toEqual([
        expect.objectContaining({ state: 'none', reason: 'not-configured', received: { logs: 0, metrics: 0, spans: 0, firstAt: null } }),
      ]);
      expect(readHookLog(shRepo, 'send-logs-hook.js').some((l) => /session-end flush done: uploaded=\d+ failed=0/.test(l))).toBe(true);
    });

    // Steps 20–27 (2026-11-24 traffic optimization, hook 3.3.0, Design Decisions 14–21): append
    // uploads of `claude` / `claude-subagent` logs. A repo, a home and a fake hub of their own, so
    // every request below is one these steps caused.
    /** A hub that also speaks the chunk protocol: `complete` on the last chunk, as the server answers. */
    const okReply = (req: FakeRequest): FakeReply => {
      const chunk = req.query.get('chunkIndex');
      if (chunk === null) return { status: 201, body: JSON.stringify({ warnings: [] }) };
      const last = Number(chunk) === Number(req.query.get('totalChunks')) - 1;
      return { status: 201, body: JSON.stringify(last ? { complete: true, warnings: [] } : { complete: false }) };
    };
    appendHub = await startFakeLogHub(okReply);
    const apRepo = makeFakeGitRepo(dirs, { remote: 'git@git.arrakis.test:scn/hook01/append.git' });
    const apHome = makeFakeHome(dirs);
    const apTelemetry = telemetryDir(apRepo);
    const apProject = claudeProjectDir(apHome, apRepo);
    const APPEND_PATH = '/api/v2/logs/append';
    /** One Stop of `sid`; hook.log and the hub's request list then hold only this Stop's lines and requests. */
    const apStop = async (sid: string) => {
      appendHub!.requests.length = 0;
      fs.rmSync(path.join(workDir(apRepo), 'hook.log'), { force: true });
      const res = await runHook(toolDir, { hook_event_name: 'Stop', session_id: sid, cwd: apRepo }, { home: apHome });
      expect(res.code, res.stderr).toBe(0);
    };
    const apLog = () => readHookLog(apRepo, 'send-logs-hook.js');
    const transcriptOf = (sid: string) => path.join(apProject, `${sid}.jsonl`);
    const claudeReqs = (sid: string, type = 'claude') => appendHub!.requests.filter((r) => r.type === type && r.sessionId === sid);
    const appendReqs = (sid: string, type = 'claude') => claudeReqs(sid, type).filter((r) => r.path === APPEND_PATH);
    const v2Of = (key: string) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(apTelemetry, '.claude-logs.sent.v2'), 'utf8')) as { entries: Record<string, V2Entry & { appendBytes?: number; appendLines?: number; appendSha256?: string }> };
      return parsed.entries[key];
    };
    /** The records the server keeps of an NDJSON text: non-blank lines that parse. */
    const records = (text: string): Array<Record<string, unknown>> =>
      text.split('\n').flatMap((l) => {
        if (l.trim() === '') return [];
        try {
          const v: unknown = JSON.parse(l);
          return isRecord(v) ? [v] : [];
        } catch {
          return [];
        }
      });
    /** This Stop sent `sid`'s whole file on the full route (one request or its chunks). */
    const expectFullUpload = (sid: string) => {
      const full = claudeReqs(sid).filter((r) => r.path === '/api/v2/logs');
      expect(full.length, `a full upload of ${sid}: ${appendHub!.requests.map((r) => `${r.path} ${r.type}/${r.sessionId}`).join(', ')}`).toBeGreaterThan(0);
      expect(records(full.map(bodyText).join('')), `${sid}: the whole file`).toEqual(records(fs.readFileSync(transcriptOf(sid), 'utf8')));
    };
    /** The one append request of `sid` this Stop made: its start line and exact body. */
    const expectOneAppend = (sid: string, startLine: number, body: string, type = 'claude') => {
      const reqs = appendReqs(sid, type);
      expect(reqs, `one append of ${sid}`).toHaveLength(1);
      expect(claudeReqs(sid, type).filter((r) => r.path !== APPEND_PATH), 'no full upload next to it').toEqual([]);
      const req = reqs[0];
      expect(req.query.get('startLine')).toBe(String(startLine));
      expect(req.headers['content-encoding'], 'a loopback hub never gets gzip').toBeUndefined();
      expect(req.body.toString('utf8')).toBe(body);
      expect(req.body.length).toBe(Buffer.byteLength(body));
      expect(req.query.get('contentSha256')).toBe(createHash('sha256').update(body, 'utf8').digest('hex'));
      expect(req.query.get('uploadFeedback')).toBe('1');
      expect(req.headers['x-api-key']).toBe(API_KEY);
      return req;
    };
    /** The `appended …` hook.log line of this key with its exact byte count. */
    const appendedLine = (key: string, recordsSent: number, startLine: number, bytes: number) =>
      `${key}: appended ${recordsSent} lines from line ${startLine}: ${bytes} B uncompressed`;

    const BIG = 'append-5mb';
    const bigLine = (i: number) => line({ type: 'user', sessionId: BIG, i, pad: 'x'.repeat(1000) });

    await test.step('20. setup and FR-1 baseline: a 5 MB transcript goes out whole (chunked, full route) and leaves an append state covering every byte and line', async () => {
      writeConfig(apRepo, {
        base: { ...QUIET_HOOK_CONFIG, serverUrl: appendHub!.url, sendLogsTimeoutMs: 5000 },
        local: { apiKey: API_KEY },
      });
      const rows: string[] = [];
      for (let i = 0; i < 5000; i += 1) rows.push(bigLine(i));
      fs.writeFileSync(transcriptOf(BIG), rows.join(''));
      const size = fs.statSync(transcriptOf(BIG)).size;
      expect(size).toBeGreaterThan(5 * 1024 * 1024);
      await apStop(BIG);
      expect(appendHub!.requests.every((r) => r.path === '/api/v2/logs'), 'no append state yet: the full route only').toBe(true);
      expect(claudeReqs(BIG).length, 'over CHUNK_SIZE_BYTES: chunks').toBeGreaterThan(1);
      expectFullUpload(BIG);
      expect(apLog().some((l) => l.includes(`claude/${BIG}.jsonl: append not used`)), 'no fallback line for a first upload (no-state)').toBe(false);
      const entry = v2Of(`claude/${BIG}.jsonl`);
      expect(entry).toMatchObject({ size, appendBytes: size, appendLines: 5000 });
      expect(entry.appendSha256).toBe(createHash('sha256').update(fs.readFileSync(transcriptOf(BIG))).digest('hex'));
    });

    await test.step('21. FR-1/FR-2: 20 lines added to the 5 MB transcript → one request to /api/v2/logs/append carrying only them (startLine 5000); hook.log byte count = the delta, not the file', async () => {
      const added = Array.from({ length: 20 }, (_, k) => bigLine(5000 + k)).join('');
      fs.appendFileSync(transcriptOf(BIG), added);
      await apStop(BIG);
      expect(appendHub!.requests, 'the append is the only request of this Stop').toHaveLength(1);
      expectOneAppend(BIG, 5000, added);
      const deltaBytes = Buffer.byteLength(added);
      expect(deltaBytes).toBeLessThan(fs.statSync(transcriptOf(BIG)).size / 100);
      const log = apLog();
      expect(log.some((l) => l.endsWith(appendedLine(`claude/${BIG}.jsonl`, 20, 5000, deltaBytes))), log.slice(-6).join('\n')).toBe(true);
      expect(v2Of(`claude/${BIG}.jsonl`)).toMatchObject({ appendBytes: fs.statSync(transcriptOf(BIG)).size, appendLines: 5020 });
    });

    await test.step('21b. FR-3: a last line without its newline is held back — the next Stop sends it once complete', async () => {
      const complete = Array.from({ length: 3 }, (_, k) => bigLine(5020 + k)).join('');
      const partial = `{"type":"user","sessionId":"${BIG}","i":5023,`;
      fs.appendFileSync(transcriptOf(BIG), complete + partial);
      await apStop(BIG);
      expectOneAppend(BIG, 5020, complete);
      expect(apLog().some((l) => l.endsWith(appendedLine(`claude/${BIG}.jsonl`, 3, 5020, Buffer.byteLength(complete))))).toBe(true);

      const rest = '"pad":"late"}\n';
      fs.appendFileSync(transcriptOf(BIG), rest);
      await apStop(BIG);
      expectOneAppend(BIG, 5023, partial + rest);
      expect(v2Of(`claude/${BIG}.jsonl`)).toMatchObject({ appendBytes: fs.statSync(transcriptOf(BIG)).size, appendLines: 5024 });
    });

    await test.step('22. FR-1: growth that holds no record (blank lines only) sends nothing; the state still moves past the new bytes', async () => {
      fs.appendFileSync(transcriptOf(BIG), '\n   \n');
      await apStop(BIG);
      expect(appendHub!.requests, 'no log request at all').toEqual([]);
      expect(v2Of(`claude/${BIG}.jsonl`)).toMatchObject({ appendBytes: fs.statSync(transcriptOf(BIG)).size, appendLines: 5024 });
    });

    const BT = 'blank-torn';
    const btLine = (n: number, pad = '') => line({ type: 'assistant', sessionId: BT, n, ...(pad ? { pad } : {}) });

    await test.step('23. FR-4: a blank and a torn line in the uploaded prefix still give the append path (startLine counts records only); FR-9a: a 20,000-byte delta to the loopback hub goes uncompressed', async () => {
      fs.writeFileSync(transcriptOf(BT), [btLine(0), btLine(1), btLine(2), '\n', '{"type":"user","torn":\n', btLine(3), btLine(4)].join(''));
      await apStop(BT);
      expectFullUpload(BT);
      expect(records(bodyText(claudeReqs(BT)[0])), 'the torn line is dropped, five records go').toHaveLength(5);
      expect(v2Of(`claude/${BT}.jsonl`)).toMatchObject({ appendBytes: fs.statSync(transcriptOf(BT)).size, appendLines: 5 });

      const two = btLine(5) + btLine(6);
      fs.appendFileSync(transcriptOf(BT), two);
      await apStop(BT);
      expectOneAppend(BT, 5, two);

      // One record of exactly 20,000 bytes with its newline: above APPEND_GZIP_MIN_BYTES, but loopback.
      const base = btLine(7, 'P');
      const big = btLine(7, 'P'.repeat(1 + 20_000 - Buffer.byteLength(base)));
      expect(Buffer.byteLength(big)).toBe(20_000);
      fs.appendFileSync(transcriptOf(BT), big);
      await apStop(BT);
      expectOneAppend(BT, 7, big);
      expect(apLog().some((l) => l.endsWith(appendedLine(`claude/${BT}.jsonl`, 1, 7, 20_000))), apLog().slice(-4).join('\n')).toBe(true);
    });

    // Step 24: FR-6, one Stop per fallback trigger on a small transcript. Each ends in a full upload
    // of the whole file, which leaves a fresh append state for the next trigger.
    const FB = 'fallback-01';
    let fbN = 0;
    const growFb = (n = 1) => {
      for (let k = 0; k < n; k += 1) fs.appendFileSync(transcriptOf(FB), line({ type: 'user', sessionId: FB, n: fbN++ }));
    };
    const fbKey = `claude/${FB}.jsonl`;
    /** One Stop of FB that must take the full upload for `reason` after `appendAttempts` append requests. */
    const fallbackStop = async (reason: string | null, appendAttempts: number) => {
      await apStop(FB);
      expect(appendReqs(FB), `${reason}: append attempts`).toHaveLength(appendAttempts);
      expectFullUpload(FB);
      const newLines = apLog();
      const fallbackLines = newLines.filter((l) => l.includes(`${fbKey}: append not used (`));
      if (reason === null) expect(fallbackLines).toEqual([]);
      else expect(fallbackLines.map((l) => l.slice(l.indexOf(fbKey))), newLines.join('\n')).toEqual([`${fbKey}: append not used (${reason}) — full upload`]);
      const size = fs.statSync(transcriptOf(FB)).size;
      expect(v2Of(fbKey), `${reason}: a fresh append state after the full upload`).toMatchObject({ size, appendBytes: size, appendLines: records(fs.readFileSync(transcriptOf(FB), 'utf8')).length });
      return newLines;
    };

    await test.step('24. FR-6: every fallback trigger (no state, shorter file, edited line, failedUploads entry, 5xx, timeout, over-budget tail, pending chunked upload) ends in a full upload of the whole file', async () => {
      // No state: the first upload of the file.
      growFb(5);
      await fallbackStop(null, 0);

      // A shorter file (rewritten with fewer lines).
      const firstThree = fs.readFileSync(transcriptOf(FB), 'utf8').split('\n').slice(0, 3).join('\n') + '\n';
      fs.writeFileSync(transcriptOf(FB), firstThree);
      await fallbackStop('shorter', 0);

      // An edited, already uploaded line of the same length: the prefix hash changed.
      fs.writeFileSync(transcriptOf(FB), fs.readFileSync(transcriptOf(FB), 'utf8').replace('"n":0', '"n":9'));
      await fallbackStop('hash-changed', 0);

      // The append answer names this very file in failedUploads (Design Decision 19).
      growFb();
      appendHub!.respond((req) =>
        req.path === APPEND_PATH
          ? { status: 201, body: JSON.stringify({ warnings: [], failedUploads: [{ sessionId: FB, type: 'claude' }] }) }
          : okReply(req),
      );
      const fed = await fallbackStop('failed-feedback', 1);
      expect(fed.some((l) => l.includes(`${fbKey}: appended 1 lines from line `)), 'the append itself went through first').toBe(true);

      // A 5xx from the append route.
      growFb();
      appendHub!.respond((req) => (req.path === APPEND_PATH ? { status: 500, body: '{"message":"boom"}' } : okReply(req)));
      await fallbackStop('http-500', 1);

      // A timeout (sendLogsTimeoutMs = 5000).
      growFb();
      appendHub!.respond((req) => (req.path === APPEND_PATH ? 'hang' : okReply(req)));
      await fallbackStop('timeout', 1);
      appendHub!.respond(okReply);

      // A tail over APPEND_MAX_PLAIN_BYTES (512,000): never sent to the append route.
      for (let k = 0; k < 2; k += 1) fs.appendFileSync(transcriptOf(FB), line({ type: 'user', sessionId: FB, n: fbN++, pad: 'y'.repeat(300_000) }));
      await fallbackStop('over-budget', 0);

      // A pending chunked upload of the file in `.claude-logs.pending`.
      growFb();
      const pending = path.join(apTelemetry, '.claude-logs.pending');
      fs.writeFileSync(pending, JSON.stringify({
        version: 2,
        entries: { [fbKey]: { uploadId: 'pending-upload-1', totalSize: 10, totalChunks: 1, nextChunkIndex: 0, slices: [{ s: 0, e: 10, enc: 'identity' }] } },
      }));
      try {
        await fallbackStop('pending-chunked', 0);
      } finally {
        fs.rmSync(pending, { force: true });
      }

      // With nothing wrong any more, the next growth appends again.
      growFb();
      await apStop(FB);
      expect(appendReqs(FB)).toHaveLength(1);
      expect(claudeReqs(FB).filter((r) => r.path !== APPEND_PATH)).toEqual([]);
    });

    const SCOPE = 'scope-0001';
    const scopeAgents = subagentsDir(apHome, apRepo, SCOPE);
    const scopeCalls = path.join(workDir(apRepo), 'tool-wrap', SCOPE, 'calls');
    const writeCall = (id: string) => {
      fs.mkdirSync(scopeCalls, { recursive: true });
      fs.writeFileSync(path.join(scopeCalls, `${id}.jsonl`), line({ type: 'start', startedAtMs: Date.now(), tool: 'terraform', capture: 'meta' }));
    };
    const routesOf = (type: string, sid: string) => claudeReqs(sid, type).map((r) => r.path);

    await test.step('25. FR-10: artisyn, tool-calls and a sub-agent whose .meta.json changed stay on /api/v2/logs; the claude transcript appends, and the sub-agent appends again (with its label) once its params are stable', async () => {
      fs.writeFileSync(transcriptOf(SCOPE), line({ type: 'user', sessionId: SCOPE, n: 0 }) + line({ type: 'assistant', sessionId: SCOPE, n: 1 }));
      fs.writeFileSync(path.join(apTelemetry, `${SCOPE}.jsonl`), line({ event: 'prompt_start', session_id: SCOPE, prompt: 'scope' }));
      fs.writeFileSync(path.join(scopeAgents, 'agent-m1.jsonl'), line({ type: 'user', agent: 'm1' }));
      writeCall(`${Date.now()}-1-aaaa`);
      await apStop(SCOPE);
      expect(appendHub!.requests.filter((r) => r.path === APPEND_PATH), 'first upload of everything: full route').toEqual([]);
      expect(routesOf('tool-calls', SCOPE), 'the tool-calls upload').toEqual(['/api/v2/logs']);

      fs.appendFileSync(transcriptOf(SCOPE), line({ type: 'assistant', sessionId: SCOPE, n: 2 }));
      fs.appendFileSync(path.join(apTelemetry, `${SCOPE}.jsonl`), line({ event: 'prompt_start', session_id: SCOPE, prompt: 'again' }));
      fs.appendFileSync(path.join(scopeAgents, 'agent-m1.jsonl'), line({ type: 'assistant', agent: 'm1' }));
      fs.writeFileSync(path.join(scopeAgents, 'agent-m1.meta.json'), JSON.stringify({ description: 'late label' }));
      writeCall(`${Date.now()}-1-bbbb`);
      await apStop(SCOPE);
      expect(routesOf('claude', SCOPE)).toEqual([APPEND_PATH]);
      expect(routesOf('artisyn', SCOPE)).toEqual(['/api/v2/logs']);
      expect(routesOf('tool-calls', SCOPE)).toEqual(['/api/v2/logs']);
      expect(routesOf('claude-subagent', 'agent-m1'), 'new upload params from .meta.json: a full upload').toEqual(['/api/v2/logs']);
      expect(claudeReqs('agent-m1', 'claude-subagent')[0].query.get('agentDescription')).toBe('late label');
      expect(records(bodyText(claudeReqs('agent-m1', 'claude-subagent')[0]))).toHaveLength(2);

      const third = line({ type: 'assistant', agent: 'm1', n: 3 });
      fs.appendFileSync(path.join(scopeAgents, 'agent-m1.jsonl'), third);
      await apStop(SCOPE);
      const sub = expectOneAppend('agent-m1', 2, third, 'claude-subagent');
      expect(sub.query.get('agentDescription'), 'the append carries the same labels').toBe('late label');
      expect(sub.query.get('parentSessionId')).toBe(SCOPE);
      expect(routesOf('artisyn', SCOPE), 'the current session artisyn file still goes whole').toEqual(['/api/v2/logs']);
    });

    const appendOffFile = path.join(apTelemetry, 'append-off.json');
    const readAppendOff = (): Record<string, number> => JSON.parse(fs.readFileSync(appendOffFile, 'utf8')) as Record<string, number>;

    for (const status of [404, 413]) {
      await test.step(`${status === 404 ? '26' : '27'}. FR-6: the hub answers ${status} on /api/v2/logs/append (an old server) → a full upload, append-off.json turns the route off for 1 h for this server, and the next Stop is full without trying it`, async () => {
        fs.rmSync(appendOffFile, { force: true });
        growFb();
        appendHub!.respond((req) => (req.path === APPEND_PATH ? { status, body: '{"message":"Cannot POST /api/v2/logs/append"}' } : okReply(req)));
        const t0 = Date.now();
        await fallbackStop('route-missing', 1);
        // Written by append-upload.js, so it is not among the send-logs-hook.js lines.
        const lines = readHookLog(apRepo);
        const origin = new URL(appendHub!.url).origin;
        expect(lines.filter((l) => l.includes(`append route not available on ${origin} (HTTP ${status}) — append uploads off for 1 h`)), lines.join('\n')).toHaveLength(1);
        const off = readAppendOff();
        expect(Object.keys(off)).toEqual([appendHub!.url.replace(/\/+$/, '')]);
        expect(off[appendHub!.url.replace(/\/+$/, '')]).toBeGreaterThanOrEqual(t0 + 3_600_000);

        appendHub!.respond(okReply);
        growFb();
        await fallbackStop('append-off', 0);
      });
    }
    fs.rmSync(appendOffFile, { force: true });
  } finally {
    await stopReceiver(sharedReceiver);
    await stopReceiver(receiver);
    await oldHub?.close();
    await appendHub?.close();
    await hub?.close();
    dirs.cleanup();
  }
});
