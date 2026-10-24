// Probe S10/S11: `claude -p` started from `packages/web` of ts-webapp (S10), then from the same
// subdirectory of a linked worktree with ARTISYN_PROJECT_ROOT = the worktree root (S11): first with
// the copied OTEL port (does the receiver answer 409?), then with a freshly allocated port.
// Records whether project settings and the plugin load, and which ai_work_dir file holds the sid.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { run } from '../../../.claude/skills/big-prod-e2e-test/scripts/lib/proc.mjs';
import { filesContaining, probeEnv, runClaude, transcriptLines, workspace, writeResult } from './probe-lib.mjs';

const ws = workspace();
const main = ws.repoDir('ts-webapp');
const wt = path.join(ws.dir, 'ts-webapp-wt');
const fwd = (p) => p.replace(/\\/g, '/');
const promptFor = (root) =>
  `Run exactly this Bash command: cat "${fwd(root)}/packages/core/src/index.ts" ` +
  'then say how many exported functions it has.';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function copyTree(src, dest, skip) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d, skip);
    } else fs.copyFileSync(s, d);
  }
}

function setPort(root, port) {
  const localCfg = path.join(root, '.artisyn', 'config', 'log-hub.local.json');
  const cfg = JSON.parse(fs.readFileSync(localCfg, 'utf8'));
  cfg.otelReceiverPort = port;
  fs.writeFileSync(localCfg, `${JSON.stringify(cfg, null, 2)}\n`);
  const settings = path.join(root, '.claude', 'settings.local.json');
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  for (const k of Object.keys(s.env)) {
    if (/ENDPOINT$/.test(k)) s.env[k] = s.env[k].replace(/:\d+\//, `:${port}/`);
  }
  fs.writeFileSync(settings, `${JSON.stringify(s, null, 2)}\n`);
}

async function session(name, root, env) {
  const r = await runClaude({
    name,
    cwd: path.join(root, 'packages', 'web'),
    env,
    args: ['--model', 'haiku', '--permission-mode', 'bypassPermissions'],
    prompt: promptFor(root),
  });
  const init = r.events.find((e) => e.type === 'system' && e.subtype === 'init');
  const sid = init?.session_id;
  const { lines } = transcriptLines(ws, sid);
  // give the async Stop-hook upload a moment to write its log lines
  await new Promise((res) => setTimeout(res, 8000));
  return {
    exitCode: r.exitCode,
    ms: r.ms,
    sessionId: sid,
    cwd: init?.cwd,
    transcriptCwd: lines[0]?.cwd ?? null,
    plugins: (init?.plugins ?? []).map((p) => p.source ?? p.name),
    hookEvents: r.events.filter((e) => e.type === 'system' && e.subtype === 'hook_started').map((e) => e.hook_event ?? e.hook_name),
    sidFiles: {
      main: filesContaining(path.join(main, '.artisyn', 'ai_work_dir'), sid),
      worktree: filesContaining(path.join(wt, '.artisyn', 'ai_work_dir'), sid),
      subdir: filesContaining(path.join(root, 'packages', 'web', '.artisyn'), sid),
    },
    ownerMismatch: {
      main: filesContaining(path.join(main, '.artisyn', 'ai_work_dir'), 'owner-mismatch'),
      worktree: filesContaining(path.join(wt, '.artisyn', 'ai_work_dir'), 'owner-mismatch'),
    },
  };
}

const out = {};
out.s10 = await session('s10', main, probeEnv(ws));

// S11: linked worktree + copies of the untracked installer files (as the plan's prepareWorktree)
run('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'big-test-wt', wt]);
fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
for (const f of ['settings.json', 'settings.local.json']) {
  const src = path.join(main, '.claude', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(wt, '.claude', f));
}
fs.mkdirSync(path.join(wt, '.artisyn'), { recursive: true });
copyTree(path.join(main, '.artisyn'), path.join(wt, '.artisyn'), (n) => n === 'ai_work_dir');
out.worktreeStatus = run('git', ['-C', wt, 'status', '--porcelain']).stdout.trim().split(/\r?\n/);

const wtEnv = probeEnv(ws, { ARTISYN_PROJECT_ROOT: wt });
out.s11SamePort = await session('s11-same-port', wt, wtEnv);
const port = await freePort();
setPort(wt, port);
out.s11FreshPort = { port, ...(await session('s11-fresh-port', wt, wtEnv)) };
writeResult('s10-s11', out);
