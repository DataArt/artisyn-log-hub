// Probe S11 (after probe-s10-settings): a session from `packages/web` of the linked worktree
// `ts-webapp-wt` (created by probe-s10-s11.mjs), given the worktree's settings through
// `--settings <file>`, with ARTISYN_PROJECT_ROOT = the worktree root. Run twice: with the main
// checkout's OTEL port (a 409 owner-mismatch expected while the main receiver is alive) and with a
// fresh port. Records where the session id lands and any owner-mismatch line.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RESULTS_DIR, filesContaining, probeEnv, runClaude, workspace, writeResult } from './probe-lib.mjs';

const ws = workspace();
const main = ws.repoDir('ts-webapp');
const wt = path.join(ws.dir, 'ts-webapp-wt');
const sub = path.join(wt, 'packages', 'web');
const fwd = (p) => p.replace(/\\/g, '/');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const mainPort = readJson(path.join(main, '.artisyn', 'config', 'log-hub.local.json')).otelReceiverPort;

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

function setPort(port) {
  const localCfg = path.join(wt, '.artisyn', 'config', 'log-hub.local.json');
  fs.writeFileSync(localCfg, JSON.stringify({ ...readJson(localCfg), otelReceiverPort: port }, null, 2));
  const settingsFile = path.join(wt, '.claude', 'settings.local.json');
  const s = readJson(settingsFile);
  for (const k of Object.keys(s.env)) if (/ENDPOINT$/.test(k)) s.env[k] = s.env[k].replace(/:\d+\//, `:${port}/`);
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}

function flagSettings(name) {
  const base = readJson(path.join(wt, '.claude', 'settings.json'));
  const local = readJson(path.join(wt, '.claude', 'settings.local.json'));
  const mp = Object.keys(base.extraKnownMarketplaces)[0];
  base.extraKnownMarketplaces[mp].source.path = fwd(path.join(wt, '.artisyn', 'marketplace'));
  const file = path.join(RESULTS_DIR, `${name}-settings.json`);
  fs.writeFileSync(file, JSON.stringify({ ...base, env: local.env }, null, 2));
  return file;
}

async function session(name, port) {
  setPort(port);
  const r = await runClaude({
    name,
    cwd: sub,
    env: probeEnv(ws, { ARTISYN_PROJECT_ROOT: wt }),
    args: ['--model', 'haiku', '--permission-mode', 'bypassPermissions', '--settings', `"${flagSettings(name)}"`],
    prompt: `Run exactly this Bash command: cat "${fwd(wt)}/packages/core/src/index.ts" then say how many exported functions it has.`,
  });
  const init = r.events.find((e) => e.type === 'system' && e.subtype === 'init');
  const sid = init?.session_id ?? '-';
  await new Promise((res) => setTimeout(res, 8000));
  const wtLog = path.join(wt, '.artisyn', 'ai_work_dir', 'hook.log');
  return {
    port,
    exitCode: r.exitCode,
    sessionId: sid,
    plugins: (init?.plugins ?? []).map((p) => `${p.source} ${p.path}`),
    hookEvents: r.events.filter((e) => e.subtype === 'hook_started').map((e) => e.hook_event ?? e.hook_name),
    sidFilesWorktree: filesContaining(path.join(wt, '.artisyn', 'ai_work_dir'), sid),
    sidFilesMain: filesContaining(path.join(main, '.artisyn', 'ai_work_dir'), sid),
    receiverLines: fs.existsSync(wtLog)
      ? fs
          .readFileSync(wtLog, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.includes(sid) && /otel|receiver|409|owner/i.test(l))
          .map((l) => l.slice(0, 240))
          .slice(0, 12)
      : [],
  };
}

const out = {};
out.samePort = await session('s11-same-port-settings', mainPort);
out.freshPort = await session('s11-fresh-port-settings', await freePort());
writeResult('s11', out);
