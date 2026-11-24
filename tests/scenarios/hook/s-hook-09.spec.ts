// S-HOOK-09. The main end-to-end scenario: the installed hook, the real server, the session in
// the UI (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-HOOK-09; layer
// UI+API; no mode in the design → A and C, DD SC4).
//
// The hook is the BUILT plugin, not the source: the plugin archive is taken from the stand's own
// `GET /static/artisyn-hooks-installer.tgz` and extracted over a throwaway project, and every hook
// runs exactly as its `hooks/hooks.json` registers it (`node ${CLAUDE_PLUGIN_ROOT}/scripts/…`). A
// fake `claude` heads PATH, so the post-turn worker the Stop hook spawns can never reach a real one.
//
// Code facts that differ from the design text:
//   - the installer's own steps (config conversion, settings merge, `claude plugin` activation)
//     are S-INST-01's; here the project config is written directly (`writeStandConfig`);
//   - the guardrail PreToolUse hook was removed in 2.19.0; since 2.27.0 the plugin registers
//     exactly one PreToolUse entry again — matcher `PowerShell`, `tool-wrap-powershell.js` (the
//     Tools/MCP PowerShell wrapper, 2026-06-19-mcp-invocation-log-tab DD-14) — so the design's
//     «PreToolUse Read» step asserts that no Read (or any other non-PowerShell) PreToolUse exists;
//   - a project agent is `.claude/agents/<name>/AGENT.md`. The server keeps skills, MCP servers and
//     MCP tools in `harness_elements` (the Harness Usage report), but no agents: the agent is
//     checked in the stored artisyn log's `agent-definitions` event;
//   - the hook-status of a Stop is assembled before that run's server warnings arrive, so a
//     recommendation reaches the server one Stop after the hook records it, and leaves it one Stop
//     after the hook drops it (step 11 runs two Stops each way);
//   - `?v=` baselines are written to `latest-hook-version.json` in the stand bundle's
//     `public/static`; the scenario removes that file before and after, so other scenarios see the
//     bundled `installer-version.json` as the latest version;
//   - the «no visible window» check is the design's single grep step: no `.vbs` in the plugin,
//     `windowsHide: true` in its launcher, and no `artisyn-hidden-launch-*` file in TEMP.
//
// Upload skip (hook 3.2.0, 2026-11-23-session-logs-streaming DD-26): step 5 also checks the current
// session's artisyn goes out on every Stop while the unchanged transcript does not; step 5d that a
// transcript SessionEnd sent is recorded in both manifests, so the next Stop skips it. Sent uploads
// are counted by `upload_queue_measurements` rows — a processed queue row is deleted.
//
// OKF v0.3 support (hook 3.1.0, 2026-11-19): the KB index starts with a 1 KB `description` before
// `okf_version` (detected only with the 8 KB front-matter window); step 4b checks the stored bundle
// fields (`okfVersion` / `title` / `description` capped at 200 chars) and per-file `meta`, and the
// 4-element `[mtimeMs, size, sha256, meta]` entries of `okf-state.json`; step 5 that an unchanged
// run leaves `okf-state.json` untouched; step 5b that a legacy 3-element entry is refilled once.
//
// Replaces:
//   - server/test/hook-state.e2e-spec.ts (11)
//   - tests/e2e/hook-state.spec.ts (2)
//   - server/test/logs-hook-status.e2e-spec.ts (5)
//   - server/src/logs/hook-state.service.spec.ts (2)
//   - hook/.claude/telemetry_tool/__tests__/send-logs-hook.test.js — harness, MCP probe, context prepends (≈ 15)
//   - hook/.claude/telemetry_tool/__tests__/skill-catalog.test.js (12, through the result on the server)
//   - hook/.claude/telemetry_tool/__tests__/no-visible-window.test.js, spawn-hidden.test.js (7 → one grep step)
//   - server/test/installer.e2e-spec.ts — `?v=` baseline (4)
//   - server/test/model-pricing.e2e-spec.ts — public access (1)
//   - client/src/viewer/__tests__/components/HookStatePage.test.tsx — status card, log tail (part)
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Pool } from 'pg';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  claudeProjectDir,
  freeLoopbackPort,
  installBuiltPlugin,
  isRecord,
  makeFakeGitRepo,
  makeFakeHome,
  pathWith,
  pluginHookCommands,
  QUIET_HOOK_CONFIG,
  readHookLog,
  readRecommendations,
  runPluginEvent,
  runToken,
  STAND_STATIC_DIR,
  subagentsDir,
  telemetryDir,
  tempDirs,
  workDir,
  writeFakeClaude,
  writeConfig,
  writeFakeMcpServer,
  writeStandConfig,
  type HookInput,
} from '../helpers/hook-process';
import { ndjson, postLogs, storedBody } from '../helpers/ingest';
import { ownRepoId, rangeAround } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { logTurns, openSession, summaryTile, usd4 } from '../helpers/session-view';
import { skipNewUserNudge } from '../helpers/teams';

const PROMPT = 'fix the login bug';
/** Body text of the org-synced `greet` skill — never sent (metadata only). */
const GREET_BODY = 'H09-GREET-BODY-MARKER: say hello to the whole team.';
/** A 1 KB bundle description (OKF v0.3): stored capped at 200 chars. */
const KB_DESCRIPTION = 'Chain KB: '.padEnd(1024, 'd');

interface SnapshotGitEntry {
  name?: string;
  path: string;
  source?: string;
  body?: string;
  gitStatus?: string;
}

interface SessionRow {
  sessionId: string;
  gitBranch?: string;
  userEmail?: string;
  totalCost?: number | null;
}

interface HookState {
  hookVersion: string;
  latestVersion: string | null;
  outdated: boolean;
  lastActivity: string | null;
  logTail: string[];
  recommendations: Array<{ rule: string; message: string }>;
  errors: string[];
}

interface HarnessRow {
  kind: string;
  name: string;
  mcpServer: string | null;
  mcpConnected: boolean | null;
}

/** Hook 3.1.0 per-file front-matter metadata, as sent in the okf-snapshot (DD-H3). */
interface OkfFileMeta {
  frontMatter: boolean;
  hasGenerated: boolean;
  hasTimestamp: boolean;
  type?: string;
  status?: string;
  superseded_by?: string;
  stale_after?: string;
}

/** `<workDir>/okf-state.json`: the hook's OKF known-ids list and content-hash cache. */
interface OkfStateFile {
  knownSnapshotIds: string[];
  hashCache?: { treeKey: string; files: Record<string, unknown[]> };
}

function okfStatePath(repoDir: string): string {
  return path.join(workDir(repoDir), 'okf-state.json');
}

function readOkfState(repoDir: string): OkfStateFile {
  return JSON.parse(fs.readFileSync(okfStatePath(repoDir), 'utf8')) as OkfStateFile;
}

function readVersion(file: string): string {
  const parsed: { version: string } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed.version;
}

async function hookState(user: ScenarioUser, repoId: number): Promise<HookState> {
  const res = await user.api.get(`/api/v1/repositories/${repoId}/hook-state`);
  expect(res.status(), 'GET hook-state').toBe(200);
  return (await res.json()) as HookState;
}

/**
 * Uploads of one log of the session the server has finished with (any outcome): one
 * `upload_queue_measurements` row each. The queue row itself is deleted once processed, so the
 * measurement is the durable trace of a sent upload (written right after that delete — poll it).
 */
async function uploadsMeasured(db: Pool, sessionId: string, logType = 'claude'): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM upload_queue_measurements WHERE session_id = $1 AND log_type = $2',
    [sessionId, logType],
  );
  return Number(rows[0].n);
}

test('@S-HOOK-09 the installed hook reaches the real server and the session shows up in the UI @mode-a @mode-c', async ({
  api,
  db,
  stand,
  users,
  page,
}) => {
  test.setTimeout(300_000);
  const run = runToken();
  const dirs = tempDirs();
  const latestFile = path.join(STAND_STATIC_DIR, 'latest-hook-version.json');
  const resetBaseline = () => fs.rmSync(latestFile, { force: true });
  const sid = `h09-${run}`;
  const agentFile = `agent-${run}a1`;
  const remote = `git@git.arrakis.test:e2e/${run}/chain.git`;
  const repoUrl = `https://git.arrakis.test/e2e/${run}/chain`;
  try {
    resetBaseline();
    const owner = await users.user('user', { label: 'h09-owner' });
    const key = await createApiKey(owner.api);
    const repo = makeFakeGitRepo(dirs, { remote, branch: 'feature/chain', userName: 'Jane Dev' });
    const home = makeFakeHome(dirs);
    const fakeClaude = writeFakeClaude(dirs, 'ok');
    const env = pathWith(fakeClaude.dir);
    const transcript = path.join(claudeProjectDir(home, repo), `${sid}.jsonl`);

    const plugin = await test.step('setup (with design step 2): the built plugin from the stand’s installer, config on the stand, harness, transcript and sub-agent', async () => {
      const root = await installBuiltPlugin(stand.url, repo);
      // OKF (FR-9): `notes/**` is excluded, so of the two bundles below only docs/kb is sent.
      writeStandConfig(repo, stand.url, key.key, { okf: { exclude: ['notes/**'] } });
      // OKF v0.3 (hook 3.1.0): a 1 KB `description` comes before `okf_version` — past the old 512 B
      // window, inside the 8 KB one — and the article carries v0.3 front matter.
      for (const [rel, text] of [
        ['docs/kb/index.md', `---\ntitle: Chain KB\ndescription: ${KB_DESCRIPTION}\nokf_version: "0.3"\n---\n# Chain KB\n`],
        [
          'docs/kb/login-flow.md',
          '---\ntype: Article\nstatus: deprecated\nsuperseded_by: login-v2.md # replaced\ngenerated:\n  by: h09\n  at: 2026-11-19T00:00:00Z\n---\n# Login flow\n',
        ],
        ['notes/kb/index.md', '---\nokf_version: 1\n---\n# Private notes\n'],
        ['notes/kb/draft.md', '# Draft\n'],
      ] as const) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), text);
        // Older than the hook's 2 s "racy file" guard, so the content-hash cache keeps them.
        const old = new Date(Date.now() - 60 * 60_000);
        fs.utimesSync(path.join(repo, rel), old, old);
      }
      fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# chain project rules\n');
      // Git status per harness file (hook 2.28.0, step 4c): CLAUDE.md is tracked, CLAUDE.local.md
      // ignored, the hello skill and the rev agent stay untracked.
      execFileSync('git', ['add', 'CLAUDE.md'], { cwd: repo, stdio: 'ignore' });
      fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), '# chain local notes\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'CLAUDE.local.md\n');
      // An org-synced skill in the fake home: only its name and size reach the snapshot.
      const synced = path.join(home, '.claude', 'skills', 'synced', 'org-1', 'greet');
      fs.mkdirSync(synced, { recursive: true });
      fs.writeFileSync(path.join(synced, 'SKILL.md'), `---\nname: greet\ndescription: Greets the team.\n---\n${GREET_BODY}\n`);
      fs.mkdirSync(path.join(repo, '.claude', 'skills', 'hello'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Greets.\n---\nSay hello.\n');
      fs.mkdirSync(path.join(repo, '.claude', 'agents', 'rev'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'agents', 'rev', 'AGENT.md'), '---\nname: rev\ndescription: Reviews code.\n---\nReview.\n');
      const mcp = writeFakeMcpServer(repo);
      fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'fake-mcp': { command: process.execPath, args: [mcp] } } }));

      const t0 = Date.now() - 10 * 60_000;
      const at = (s: number) => new Date(t0 + s * 1000).toISOString();
      const file = path.join(repo, 'src', 'login.ts');
      const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
      fs.writeFileSync(
        transcript,
        ndjson([
          { type: 'user', uuid: 'u1', sessionId: sid, timestamp: at(0), cwd: repo, gitBranch: 'feature/chain', message: { role: 'user', content: PROMPT } },
          {
            type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: sid, timestamp: at(5),
            message: { id: `msg-${run}-1`, role: 'assistant', model: 'claude-sonnet-4-6', usage: usage(1200, 300),
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] },
          },
          {
            type: 'user', uuid: 'u1r', parentUuid: 'a1', sessionId: sid, timestamp: at(6),
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'The file has been updated.' }] },
            toolUseResult: { filePath: file, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
          },
          {
            type: 'assistant', uuid: 'a2', parentUuid: 'u1r', sessionId: sid, timestamp: at(10),
            message: { id: `msg-${run}-2`, role: 'assistant', model: 'claude-sonnet-4-6', usage: usage(1500, 120),
              content: [{ type: 'text', text: 'Fixed the login bug.' }] },
          },
          { type: 'user', uuid: 'u2', parentUuid: 'a2', sessionId: sid, timestamp: at(60), message: { role: 'user', content: 'thanks, now add a test' } },
          {
            type: 'assistant', uuid: 'a3', parentUuid: 'u2', sessionId: sid, timestamp: at(70),
            message: { id: `msg-${run}-3`, role: 'assistant', model: 'claude-sonnet-4-6', usage: usage(1800, 90),
              content: [{ type: 'text', text: 'Test added.' }] },
          },
        ]),
      );
      fs.writeFileSync(
        path.join(subagentsDir(home, repo, sid), `${agentFile}.jsonl`),
        ndjson([
          { type: 'user', uuid: 'sa-u1', sessionId: sid, isSidechain: true, timestamp: at(20), message: { role: 'user', content: 'review the fix' } },
          {
            type: 'assistant', uuid: 'sa-a1', parentUuid: 'sa-u1', sessionId: sid, isSidechain: true, timestamp: at(30),
            message: { id: `msg-${run}-sa`, role: 'assistant', model: 'claude-sonnet-4-6', usage: usage(400, 200), content: [{ type: 'text', text: 'Looks good.' }] },
          },
        ]),
      );
      return root;
    });
    const pluginVersion = readVersion(path.join(plugin, 'scripts', 'version.json'));
    const fire = async (input: Omit<HookInput, 'cwd' | 'session_id'>) => {
      const runs = await runPluginEvent(plugin, { session_id: sid, cwd: repo, ...input }, { home, env });
      for (const r of runs) expect(r.code, `${String(input.hook_event_name)}: ${r.stderr}`).toBe(0);
      return runs;
    };

    await test.step('1. hooks of the installed plugin in session order: SessionStart → UserPromptSubmit → (PreToolUse only for PowerShell) → PostToolUse Edit → Stop', async () => {
      expect(readVersion(path.join(STAND_STATIC_DIR, 'installer-version.json')), 'bundled plugin = installer version').toBe(pluginVersion);
      await fire({ hook_event_name: 'SessionStart', source: 'startup' });
      await fire({ hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
      // The guardrail was removed in 2.19.0; the only PreToolUse entry is the PowerShell tool
      // wrapper (2.27.0), so an Edit / Read call runs no PreToolUse hook at all.
      const hooksJson = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')) as {
        hooks: Record<string, Array<{ matcher?: string }>>;
      };
      expect(
        (hooksJson.hooks.PreToolUse ?? []).map((g) => g.matcher),
        'exactly one PreToolUse entry, matcher PowerShell',
      ).toEqual(['PowerShell']);
      const preToolUse = pluginHookCommands(plugin, 'PreToolUse');
      expect(preToolUse, 'one command in it').toHaveLength(1);
      expect(preToolUse[0].args.join(' ')).toMatch(/tool-wrap-powershell\.js$/);
      await fire({
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_use_id: 'toolu_1',
        tool_input: { file_path: path.join(repo, 'src', 'login.ts'), old_string: 'a', new_string: 'b' },
        tool_response: { filePath: path.join(repo, 'src', 'login.ts'), structuredPatch: [{ lines: ['-a', '+b'] }] },
      });
      const stopRuns = await fire({ hook_event_name: 'Stop', transcript_path: transcript });
      expect(stopRuns, 'send-logs-hook and post-turn-analysis-hook').toHaveLength(2);
    });

    const repoId = await test.step('3. within 10 s: repository chain, the session of the key owner on feature/chain', async () => {
      await waitForQueueIdle(db, owner.id, { timeoutMs: 10_000 });
      const id = await ownRepoId(owner.api, repoUrl);
      const res = await owner.api.get(`/api/v1/repositories/${id}/sessions`);
      expect(res.status()).toBe(200);
      const row = ((await res.json()) as SessionRow[]).find((s) => s.sessionId === sid);
      expect(row, 'the hook session is listed').toBeTruthy();
      expect(row!.userEmail).toBe(owner.email);
      expect(row!.gitBranch).toBe('feature/chain');
      return id;
    });

    await test.step('4. UI and API: list row and Summary cost agree, Logs shows the prompt, the sub-agent is a child, the harness arrived once', async () => {
      const rows = (await (await owner.api.get(`/api/v1/repositories/${repoId}/sessions`)).json()) as SessionRow[];
      const cost = rows.find((s) => s.sessionId === sid)!.totalCost;
      expect(typeof cost === 'number' && cost > 0, `totalCost ${String(cost)}`).toBe(true);
      await openSession(page, owner, repoId, sid);
      await expect(page.getByTestId('session-item-cost').first()).toContainText(usd4(cost!));
      await expect(summaryTile(page, 'Cost')).toContainText(usd4(cost!));
      await openSession(page, owner, repoId, sid, { tab: 'logs' });
      await expect(logTurns(page).first()).toContainText(PROMPT);

      const parent = await db.query<{ parent_session_id: string | null }>(
        'SELECT parent_session_id FROM sessions WHERE session_id = $1',
        [agentFile],
      );
      expect(parent.rows[0]?.parent_session_id, 'sub-agent hangs under the root session').toBe(sid);

      const report = await owner.api.get(`/api/v1/repositories/${repoId}/reports/harness-usage?${rangeAround(new Date())}`);
      expect(report.status()).toBe(200);
      const harness = ((await report.json()) as { rows: HarnessRow[] }).rows;
      const named = (kind: string, name: string) => harness.filter((r) => r.kind === kind && r.name === name);
      expect(named('skill', 'hello')).toHaveLength(1);
      expect(named('mcp', 'fake-mcp')).toHaveLength(1);
      expect(named('mcp', 'fake-mcp')[0].mcpConnected).toBe(true);
      expect(named('tool', 'fake_tool')).toHaveLength(1);
      expect(named('tool', 'fake_tool')[0].mcpServer).toBe('fake-mcp');
      // DD-9: the full harness-snapshot the hook sent on its first Stop is stored once, keyed by
      // the uploading owner, and the session is bound to it.
      const snap = await db.query<{ snapshot_id: string; body: { agents: Array<{ name: string }> } }>(
        'SELECT snapshot_id, body FROM harness_snapshots WHERE user_id = $1',
        [owner.id],
      );
      expect(snap.rows, 'one harness_snapshots row for the owner').toHaveLength(1);
      expect(snap.rows[0].body.agents.map((a) => a.name), 'the project agent rev is in the snapshot').toContain('rev');
      const bound = await db.query<{ harness_snapshot_id: string | null }>(
        'SELECT harness_snapshot_id FROM sessions WHERE session_id = $1',
        [sid],
      );
      expect(bound.rows[0]?.harness_snapshot_id, 'the session is bound to that snapshot').toBe(snap.rows[0].snapshot_id);

      await openSession(page, owner, repoId, sid, { tab: 'harness-usage' });
      await expect(page.getByTestId('harness-usage-tab')).toBeVisible();
      await expect(page.getByTestId('harness-element-row').filter({ hasText: 'Edit' })).toHaveCount(1);
    });

    const okfSnapshotId = await test.step('4b. OKF: the first upload stored the full okf-snapshot — docs/kb only, notes/** excluded — and bound the session to it', async () => {
      const snap = await db.query<{
        snapshot_id: string;
        body: {
          bundles: Array<{
            root: string;
            index: string;
            okfVersion?: string;
            title?: string;
            description?: string;
            files: Array<{ path: string; hash: string; size: number; meta?: OkfFileMeta }>;
          }>;
        };
      }>('SELECT snapshot_id, body FROM okf_snapshots WHERE user_id = $1', [owner.id]);
      expect(snap.rows, 'one okf_snapshots row for the owner').toHaveLength(1);
      const { snapshot_id: id, body } = snap.rows[0];
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(body.bundles.map((b) => b.root), 'okf.exclude drops the notes bundle (FR-9)').toEqual(['docs/kb']);
      expect(body.bundles[0].index).toBe('docs/kb/index.md');
      expect(body.bundles[0].files.map((f) => f.path).sort()).toEqual(['docs/kb/index.md', 'docs/kb/login-flow.md']);
      // OKF v0.3 (hook 3.1.0): detected despite the 1 KB description first; the bundle fields
      // (quotes stripped, 200-char cap) and every file's front-matter `meta` are stored.
      expect(body.bundles[0].okfVersion).toBe('0.3');
      expect(body.bundles[0].title).toBe('Chain KB');
      expect(body.bundles[0].description).toBe(KB_DESCRIPTION.slice(0, 200));
      const metaOf = (p: string) => body.bundles[0].files.find((f) => f.path === p)?.meta;
      expect(metaOf('docs/kb/index.md')).toEqual({ frontMatter: true, hasGenerated: false, hasTimestamp: false });
      expect(metaOf('docs/kb/login-flow.md'), 'nested `generated.by` is not a top-level key; the # comment is cut').toEqual({
        frontMatter: true,
        hasGenerated: true,
        hasTimestamp: false,
        type: 'Article',
        status: 'deprecated',
        superseded_by: 'login-v2.md',
      });
      // okf-state.json: the content-hash cache entries are [mtimeMs, size, sha256, meta].
      const cache = readOkfState(repo).hashCache;
      expect(cache, 'the hook keeps a content-hash cache').toBeDefined();
      for (const f of body.bundles[0].files) {
        const entry = cache?.files[f.path];
        expect(entry, f.path).toHaveLength(4);
        expect(entry?.[1], f.path).toBe(f.size);
        expect(entry?.[2], f.path).toBe(f.hash);
        expect(entry?.[3], f.path).toEqual(f.meta);
      }
      const bound = await db.query<{ okf_snapshot_id: string | null }>('SELECT okf_snapshot_id FROM sessions WHERE session_id = $1', [sid]);
      expect(bound.rows[0]?.okf_snapshot_id, 'the root session is bound to that snapshot').toBe(id);
      const log = readHookLog(repo, 'send-logs-hook.js');
      expect(log.filter((l) => l.includes(`okf: snapshot ${id.slice(0, 12)} sent`)), 'the full snapshot went out once').toHaveLength(1);
      return id;
    });

    await test.step('4c. harness snapshot carries git status and org-synced skills', async () => {
      const snap = await db.query<{
        body: { skills: SnapshotGitEntry[]; agents: SnapshotGitEntry[]; systemContext: { files: SnapshotGitEntry[] } | null };
      }>('SELECT body FROM harness_snapshots WHERE user_id = $1', [owner.id]);
      expect(snap.rows).toHaveLength(1);
      const { skills, agents, systemContext } = snap.rows[0].body;
      const fileStatus = (p: string) => systemContext?.files.find((f) => f.path === p)?.gitStatus;
      expect(fileStatus('CLAUDE.md'), 'git add CLAUDE.md').toBe('tracked');
      expect(fileStatus('CLAUDE.local.md'), '.gitignore lists CLAUDE.local.md').toBe('ignored');
      const hello = skills.find((s) => s.name === 'hello');
      expect(hello?.source).toBe('project');
      expect(hello?.gitStatus, 'the project skill is not added to git').toBe('untracked');
      expect(agents.find((a) => a.name === 'rev')?.gitStatus).toBe('untracked');

      const greet = skills.filter((s) => s.name === 'greet');
      expect(greet, 'the org-synced skill, once, under its bare name').toHaveLength(1);
      expect(greet[0].source).toBe('org-synced');
      expect(greet[0].path, 'the org folder name is masked').toBe('~/.claude/skills/synced/<org>/greet/SKILL.md');
      expect(greet[0].body, 'metadata only: no skill text').toBe('');
      expect(greet[0].gitStatus).toBe('outside-repo');
      expect(JSON.stringify(snap.rows[0].body), 'the org folder name and the skill text never leave the machine').not.toMatch(/org-1|H09-GREET-BODY-MARKER/);

      // The server leaves org-synced entries out of the skill inventory (no false "never used" row).
      const elements = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM harness_elements WHERE repo_id = $1 AND name = 'greet'",
        [repoId],
      );
      expect(Number(elements.rows[0].n), 'no harness_elements row for greet').toBe(0);
    });

    await test.step('5. a second Stop without changes: no harness duplicates, no new claude upload', async () => {
      const claudeBefore = await uploadsMeasured(db, sid);
      const artisynBefore = await uploadsMeasured(db, sid, 'artisyn');
      const elements = await db.query<{ n: string }>('SELECT count(*) AS n FROM harness_elements WHERE repo_id = $1', [repoId]);
      const okfStateBefore = fs.readFileSync(okfStatePath(repo), 'utf8');
      await fire({ hook_event_name: 'Stop', transcript_path: transcript });
      // OKF v0.3 DD-H6: every cache entry was a hit (no KB file re-read), so okf-state.json is
      // not rewritten at all — not even its `updatedAt`.
      expect(fs.readFileSync(okfStatePath(repo), 'utf8'), 'an unchanged run leaves okf-state.json as it was').toBe(okfStateBefore);
      await waitForQueueIdle(db, owner.id, { timeoutMs: 10_000 });
      // The current artisyn goes last in a run, so once it is measured the run's transcripts are too.
      await expect.poll(() => uploadsMeasured(db, sid, 'artisyn'), { message: 'the current artisyn is sent on every Stop' }).toBe(artisynBefore + 1);
      expect(await uploadsMeasured(db, sid), 'unchanged transcript is not re-sent').toBe(claudeBefore);
      const after = await db.query<{ n: string }>('SELECT count(*) AS n FROM harness_elements WHERE repo_id = $1', [repoId]);
      expect(after.rows[0].n).toBe(elements.rows[0].n);
      const artisyn = (await storedBody(db, sid, 'artisyn')) ?? [];
      // DD-6/DD-7: the id is already known, so this Stop sends only harness-snapshot-ref — the
      // full harness-snapshot line (sent on the very first Stop) is never repeated.
      expect(artisyn.filter((e) => isRecord(e) && e.type === 'harness-snapshot').length, 'full snapshot sent only once').toBeLessThanOrEqual(1);
      const snapCount = await db.query<{ n: string }>('SELECT count(*) AS n FROM harness_snapshots WHERE user_id = $1', [owner.id]);
      expect(Number(snapCount.rows[0].n), 'no new harness_snapshots row from an unchanged harness').toBe(1);
      const logs = (await (await owner.api.get(`/api/v1/repositories/${repoId}/sessions/${sid}/logs`)).json()) as {
        harnessSnapshot?: unknown;
      };
      expect(logs.harnessSnapshot, 'GET logs still returns the harness snapshot').toBeTruthy();
      // FR-10: the OKF id is known now, so this Stop sent only okf-snapshot-ref — no new full
      // snapshot, no second okf_snapshots row, the binding unchanged.
      const okfLog = readHookLog(repo, 'send-logs-hook.js');
      expect(okfLog.filter((l) => l.includes(`okf: snapshot ${okfSnapshotId.slice(0, 12)} sent`)), 'still one full send').toHaveLength(1);
      expect(okfLog.some((l) => l.includes(`okf: snapshot ${okfSnapshotId.slice(0, 12)} known`)), 'the second Stop sent the ref only').toBe(true);
      const okfCount = await db.query<{ n: string }>('SELECT count(*) AS n FROM okf_snapshots WHERE user_id = $1', [owner.id]);
      expect(Number(okfCount.rows[0].n)).toBe(1);
      const okfBound = await db.query<{ okf_snapshot_id: string | null }>('SELECT okf_snapshot_id FROM sessions WHERE session_id = $1', [sid]);
      expect(okfBound.rows[0]?.okf_snapshot_id).toBe(okfSnapshotId);
    });

    await test.step('5b. OKF v0.3 DD-H6: a legacy 3-element cache entry (hook < 3.1.0) is a miss — the file is re-read once and the entry gets its meta back; the snapshot id is unchanged', async () => {
      const state = readOkfState(repo);
      const files = state.hashCache?.files ?? {};
      const before = JSON.stringify(files);
      for (const k of Object.keys(files)) files[k] = files[k].slice(0, 3);
      fs.writeFileSync(okfStatePath(repo), JSON.stringify({ ...state, version: 1 }));
      await fire({ hook_event_name: 'Stop', transcript_path: transcript });
      await waitForQueueIdle(db, owner.id, { timeoutMs: 10_000 });
      const after = readOkfState(repo).hashCache?.files ?? {};
      for (const entry of Object.values(after)) expect(entry).toHaveLength(4);
      expect(JSON.stringify(after), 'the refilled entries equal the 3.1.0 ones').toBe(before);
      const okfLog = readHookLog(repo, 'send-logs-hook.js');
      expect(okfLog.filter((l) => l.includes(`okf: snapshot ${okfSnapshotId.slice(0, 12)} sent`)), 'same id: still one full send').toHaveLength(1);
      const okfCount = await db.query<{ n: string }>('SELECT count(*) AS n FROM okf_snapshots WHERE user_id = $1', [owner.id]);
      expect(Number(okfCount.rows[0].n)).toBe(1);
    });

    await test.step('5c. a backlog session (its own upload never landed) re-uploaded by a later Stop is bound to the OKF snapshot too, via the ref only', async () => {
      const backlogSid = `${sid}-b`;
      const ownFirst = fs.readFileSync(path.join(telemetryDir(repo), `${sid}.jsonl`), 'utf8').split('\n')[0];
      fs.writeFileSync(path.join(telemetryDir(repo), `${backlogSid}.jsonl`), `${ownFirst.split(sid).join(backlogSid)}\n`);
      await fire({ hook_event_name: 'Stop', transcript_path: transcript });
      await waitForQueueIdle(db, owner.id, { timeoutMs: 10_000 });
      const bound = await db.query<{ okf_snapshot_id: string | null }>('SELECT okf_snapshot_id FROM sessions WHERE session_id = $1', [backlogSid]);
      expect(bound.rows[0]?.okf_snapshot_id, 'the backlog session is bound to the current snapshot').toBe(okfSnapshotId);
      const okfLog = readHookLog(repo, 'send-logs-hook.js');
      expect(okfLog.filter((l) => l.includes(`okf: snapshot ${okfSnapshotId.slice(0, 12)} sent`)), 'known id: still one full send').toHaveLength(1);
      const okfCount = await db.query<{ n: string }>('SELECT count(*) AS n FROM okf_snapshots WHERE user_id = $1', [owner.id]);
      expect(Number(okfCount.rows[0].n)).toBe(1);
    });

    await test.step('5d. DD-26: the transcript grows, SessionEnd sends it and records it in both manifests; the next Stop does not send it again', async () => {
      // Claude Code appends `turn_duration` after the Stop hook fires — no tokens, no cost.
      fs.appendFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString(), durationMs: 1000 })}\n`);
      const before = await uploadsMeasured(db, sid);
      await fire({ hook_event_name: 'SessionEnd', reason: 'other' });
      await expect.poll(() => uploadsMeasured(db, sid), { message: 'SessionEnd sent the grown transcript' }).toBe(before + 1);
      const key = `claude/${sid}.jsonl`;
      const v2 = JSON.parse(fs.readFileSync(path.join(telemetryDir(repo), '.claude-logs.sent.v2'), 'utf8')) as {
        entries: Record<string, { size: number; mtimeMs: number }>;
      };
      expect(v2.entries[key], 'SessionEnd recorded the transcript in the v2 manifest').toEqual(
        expect.objectContaining({ size: fs.statSync(transcript).size, mtimeMs: fs.statSync(transcript).mtimeMs }),
      );
      const v1 = fs.readFileSync(path.join(telemetryDir(repo), '.claude-logs.sent'), 'utf8');
      expect(v1.split(/\r?\n/), 'and in the old manifest').toContain(`${key} ${fs.statSync(transcript).size}`);

      const artisynBefore = await uploadsMeasured(db, sid, 'artisyn');
      await fire({ hook_event_name: 'Stop', transcript_path: transcript });
      await expect.poll(() => uploadsMeasured(db, sid, 'artisyn')).toBe(artisynBefore + 1);
      expect(await uploadsMeasured(db, sid), 'the SessionEnd-recorded transcript is not re-sent').toBe(before + 1);
    });

    await test.step('6. Installed Hooks page: version = plugin version.json, up to date, no issue badge', async () => {
      const state = await hookState(owner, repoId);
      expect(state.hookVersion).toBe(pluginVersion);
      expect(state.latestVersion).toBe(pluginVersion);
      expect(state.outdated).toBe(false);
      const list = (await (await owner.api.get('/api/v1/repositories/hooks')).json()) as Array<{ id: number; issueCount: number; outdated: boolean }>;
      const entry = list.find((r) => r.id === repoId);
      expect(entry?.outdated).toBe(false);
      expect(entry?.issueCount).toBe((state.errors.length > 0 ? 1 : 0) + state.recommendations.length);
      await skipNewUserNudge(page.context());
      await owner.signIn(page);
      await page.goto(`/#/repos/${repoId}/hook-state`);
      await expect(page.getByText('Hook up to date')).toBeVisible();
      await expect(page.getByText(`Installed version ${pluginVersion}`)).toBeVisible();
    });

    await test.step('7. hook downgraded to 0.0.1 → «Hook outdated», issues counted, log tail with highlighted problem lines, upgrade command with ?v=', async () => {
      fs.writeFileSync(path.join(plugin, 'scripts', 'version.json'), JSON.stringify({ version: '0.0.1' }));
      // A file the hook cannot repair leaves [warn]/[fail] lines in the log tail.
      fs.writeFileSync(path.join(telemetryDir(repo), `${sid}-torn.jsonl`), '{"torn\n');
      await fire({ hook_event_name: 'Stop', transcript_path: transcript });
      await waitForQueueIdle(db, owner.id, { timeoutMs: 10_000 });
      const state = await hookState(owner, repoId);
      expect(state.hookVersion).toBe('0.0.1');
      expect(state.outdated).toBe(true);
      expect(state.errors.length).toBeGreaterThan(0);
      const list = (await (await owner.api.get('/api/v1/repositories/hooks')).json()) as Array<{ id: number; issueCount: number }>;
      expect(list.find((r) => r.id === repoId)?.issueCount).toBe(1 + 1 + state.recommendations.length);

      await page.goto(`/#/repos/${repoId}/hook-state`);
      await page.reload();
      await expect(page.getByText(/^Hook outdated/)).toBeVisible();
      await expect(page.getByText(`Installed version 0.0.1 • Latest version ${pluginVersion}`)).toBeVisible();
      await expect(page.locator('pre div', { hasText: '[fail]' }).first()).toHaveClass(/text-red-400/);
      await expect(page.locator('pre div', { hasText: '[warn]' }).first()).toHaveClass(/text-amber-400/);
      await expect(page.getByRole('button', { name: 'Copy upgrade cmd' })).toHaveAttribute(
        'title',
        `npx "${stand.url}/static/artisyn-hooks-installer.tgz?v=${pluginVersion}" upgrade`,
      );
    });

    await test.step('8. baseline: ?v=9.9.9 then ?v=1.0.0 → the maximum wins; ?v=<script> and ?v=abc still download and change nothing', async () => {
      const download = async (v: string) => {
        const res = await api.get('/static/artisyn-hooks-installer.tgz', { params: { v } });
        expect(res.status(), `?v=${v}`).toBe(200);
        return (await res.body()).length;
      };
      const size = await download('9.9.9');
      expect(await download('1.0.0')).toBe(size);
      expect((await hookState(owner, repoId)).latestVersion).toBe('9.9.9');
      expect(await download('<script>alert(1)</script>')).toBe(size);
      expect(await download('abc')).toBe(size);
      expect((await hookState(owner, repoId)).latestVersion).toBe('9.9.9');
      resetBaseline();
      expect((await hookState(owner, repoId)).latestVersion).toBe(pluginVersion);
    });

    await test.step('9. an upload without hook-status keeps the known state; a hook-status with a broken timestamp never yields «Invalid Date»', async () => {
      const before = await hookState(owner, repoId);
      const prompt = (sessionId: string) => ({
        event: 'prompt_start',
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        prompt: 'manual upload',
        git: { repo: remote, branch: 'feature/chain' },
      });
      const plain = await postLogs(api, key.key, { sessionId: `${sid}-curl`, type: 'artisyn' }, ndjson([prompt(`${sid}-curl`)]));
      expect(plain.status()).toBe(201);
      await waitForQueueIdle(db, owner.id);
      const kept = await hookState(owner, repoId);
      expect(kept.hookVersion).toBe(before.hookVersion);
      expect(kept.logTail).toEqual(before.logTail);

      const status = {
        type: 'hook-status',
        hookVersion: '0.0.1',
        timestamp: 'not-a-date',
        logTail: ['2026-10-14T10:00:00.000Z [send-logs-hook.js] [-] [result] manual'],
        nonUploadableLogs: [],
        recommendations: [],
      };
      const odd = await postLogs(api, key.key, { sessionId: `${sid}-odd`, type: 'artisyn' }, ndjson([status, prompt(`${sid}-odd`)]));
      expect(odd.status()).toBe(201);
      await waitForQueueIdle(db, owner.id);
      const state = await hookState(owner, repoId);
      expect(state.lastActivity === null || !Number.isNaN(Date.parse(state.lastActivity))).toBe(true);
      await page.goto(`/#/repos/${repoId}/hook-state`);
      await page.reload();
      await expect(page.getByText('Hook State', { exact: true })).toBeVisible();
      await expect(page.getByText('Invalid Date')).toHaveCount(0);
    });

    await test.step('10. another user sees neither the repository nor its hook state', async () => {
      const other = await users.user('user', { label: 'h09-b' });
      expect((await other.api.get(`/api/v1/repositories/${repoId}/hook-state`)).status()).toBe(403);
      const repos = (await (await other.api.get('/api/v1/repositories')).json()) as Array<{ id: number }>;
      expect(repos.some((r) => r.id === repoId)).toBe(false);
    });

    await test.step('11. broken-upload-file: recorded after a failed upload, shown in the UI, gone after the admin clears the queue', async () => {
      const broken = await postLogs(api, key.key, { sessionId: `${sid}-broken`, type: 'claude' }, '{"broken\n');
      expect(broken.status()).toBe(201);
      await waitForQueueIdle(db, owner.id, { allowFailed: true });
      for (let i = 0; i < 2; i += 1) {
        await fire({ hook_event_name: 'Stop', transcript_path: transcript });
        await waitForQueueIdle(db, owner.id, { allowFailed: true });
      }
      expect(readRecommendations(repo).some((r) => r.rule === 'broken-upload-file')).toBe(true);
      expect((await hookState(owner, repoId)).recommendations.map((r) => r.rule)).toContain('broken-upload-file');
      await page.goto(`/#/repos/${repoId}/hook-state`);
      await page.reload();
      await expect(page.getByText('rule: broken-upload-file')).toBeVisible();

      const admin = await users.user('admin', { label: 'h09-admin' });
      expect((await admin.api.delete('/api/v1/admin/upload-queue/failed')).status()).toBe(200);
      for (let i = 0; i < 2; i += 1) {
        await fire({ hook_event_name: 'Stop', transcript_path: transcript });
        await waitForQueueIdle(db, owner.id);
      }
      expect(readRecommendations(repo).some((r) => r.rule === 'broken-upload-file')).toBe(false);
      expect((await hookState(owner, repoId)).recommendations.map((r) => r.rule)).not.toContain('broken-upload-file');
      await page.reload();
      await expect(page.getByText('rule: broken-upload-file')).toHaveCount(0);
    });

    await test.step('12. GET /api/v1/model-pricing without a session → 200 and a non-empty table', async () => {
      const res = await api.get('/api/v1/model-pricing');
      expect(res.status()).toBe(200);
      const body: unknown = await res.json();
      const size = Array.isArray(body) ? body.length : isRecord(body) ? Object.keys(body).length : 0;
      expect(size).toBeGreaterThan(0);
    });

    await test.step('13. Node.js advisory (hook 3.0.0, DD-15/DD-16): SessionStart on Node 20.11.0 with otelEnabled and no OTEL exporter env prints ONE JSON object whose systemMessage holds the OTEL warning and the Node warning; a second SessionStart shows no Node warning (24 h throttle); 26.13.1 shows none', async () => {
      // Its own repo and home, so the throttle file and step 1's SessionStart do not interfere. No
      // port.json in the home → the legacy per-project receiver, on a free port with a 2 s idle
      // timeout, so the receiver the announce spawns exits by itself.
      const nRepo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:e2e/${run}/node-check.git` });
      const nHome = makeFakeHome(dirs);
      const nPlugin = await installBuiltPlugin(stand.url, nRepo);
      writeConfig(nRepo, {
        base: { ...QUIET_HOOK_CONFIG, otelEnabled: true, otelReceiverPort: await freeLoopbackPort(), otelReceiverIdleTimeoutMs: 2000 },
      });
      // Blank (= not set) whatever OTEL exporter env the runner itself carries.
      const noOtelEnv: Record<string, string> = {};
      for (const name of Object.keys(process.env)) if (name.startsWith('OTEL_')) noOtelEnv[name] = '';
      for (const name of ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'CLAUDE_CODE_ENABLE_TELEMETRY']) noOtelEnv[name] = '';
      const sessionStart = async (sessionId: string, nodeVersion: string) => {
        const runs = await runPluginEvent(
          nPlugin,
          { hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId, cwd: nRepo },
          { home: nHome, env: { ...env, ...noOtelEnv, ARTISYN_NODE_VERSION_OVERRIDE: nodeVersion } },
        );
        for (const r of runs) expect(r.code, r.stderr).toBe(0);
        const printed = runs.map((r) => r.stdout.trim()).filter(Boolean);
        expect(printed.length, `at most one hook prints: ${printed.join(' | ')}`).toBeLessThanOrEqual(1);
        if (printed.length === 0) return null;
        // The whole stdout is one JSON object (Claude Code parses it as such).
        const parsed: unknown = JSON.parse(printed[0]);
        if (!isRecord(parsed)) throw new Error(`SessionStart stdout is not a JSON object: ${printed[0]}`);
        expect(Object.keys(parsed)).toEqual(['systemMessage']);
        return String(parsed.systemMessage);
      };
      const nodeWarning = /Log Hub: Node\.js \S+ (is end-of-life|misses the .+ security fixes)/;

      const first = await sessionStart(`h09n1-${run}`, '20.11.0');
      expect(first, 'the first SessionStart warns').not.toBeNull();
      const parts = String(first).split('\n\n');
      expect(parts, String(first)).toHaveLength(2);
      expect(parts[0]).toMatch(/^Artisyn log-hub: OTEL telemetry of this session will be lost/);
      expect(parts[1]).toBe('Log Hub: Node.js 20.11.0 is end-of-life — upgrade to Node.js 22.23.5, 24.22.3 or 26.13.1 or newer. Log Hub hooks keep working.');
      const state: unknown = JSON.parse(fs.readFileSync(path.join(nHome, '.artisyn', 'node-check.json'), 'utf8'));
      expect(state).toMatchObject({ nodeVersion: '20.11.0' });

      const second = await sessionStart(`h09n2-${run}`, '20.11.0');
      expect(second ?? '', 'throttled: no Node warning within 24 h').not.toMatch(nodeWarning);
      expect(second ?? '', 'the OTEL warning is not throttled').toMatch(/OTEL telemetry of this session will be lost/);

      const patched = await sessionStart(`h09n3-${run}`, '26.13.1');
      expect(patched ?? '', 'a patched Node gets no warning').not.toMatch(nodeWarning);
      expect(readHookLog(nRepo, 'lifecycle-hook.js').filter((l) => l.includes('node-version warning shown'))).toHaveLength(1);
    });

    await test.step('no visible window: no .vbs in the plugin, windowsHide in its launcher, no hidden-launch files in TEMP', async () => {
      const files = fs.readdirSync(path.join(plugin, 'scripts'));
      expect(files.filter((n) => n.toLowerCase().endsWith('.vbs'))).toEqual([]);
      expect(fs.readFileSync(path.join(plugin, 'scripts', 'spawn-hidden.js'), 'utf8')).toMatch(/windowsHide:\s*true/);
      if (process.platform === 'win32') {
        expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('artisyn-hidden-launch-'))).toEqual([]);
      }
    });
  } finally {
    resetBaseline();
    dirs.cleanup();
  }
});
