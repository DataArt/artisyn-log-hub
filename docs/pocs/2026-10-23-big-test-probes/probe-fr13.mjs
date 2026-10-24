// Probe FR-13: build the previous-release installer from PREV_RELEASE_REF outside the git root
// (git archive → npm ci --ignore-scripts → old build-hooks-installer.js --static-dir), time each
// step, install the old tgz into a throwaway repo against the current server, and check one
// haiku session's plugin source against ALLOWED_PLUGIN_SOURCE_RE.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ALLOWED_PLUGIN_SOURCE_RE, gitRoot } from '../../../.claude/skills/big-prod-e2e-test/scripts/lib/config.mjs';
import { createRepo, filesContaining, installHook, probeEnv, runClaude, workspace, writeResult } from './probe-lib.mjs';

const REF = '25146c8';
const ws = workspace();
const srcDir = path.join(ws.dir, '_prev-src');
const hookDir = path.join(ws.dir, '_prev-hook');
const out = { ref: REF, steps: {} };

function step(name, fn) {
  const started = Date.now();
  const res = fn();
  out.steps[name] = { ms: Date.now() - started, status: res.status, tail: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split(/\r?\n/).slice(-4) };
  if (res.status !== 0) {
    writeResult('fr13', out);
    throw new Error(`${name} failed`);
  }
}

fs.rmSync(srcDir, { recursive: true, force: true });
fs.mkdirSync(srcDir, { recursive: true });
const sh = (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
// git archive piped into tar: one shell pipeline, so the tar never touches the git root
step('gitArchive', () => sh(`git -C "${gitRoot()}" archive --format=tar ${REF} | tar -x -C "${srcDir.replace(/\\/g, '/')}"`, ws.dir));
step('npmCi', () => sh('npm ci --ignore-scripts --no-audit --no-fund', srcDir));
step('build', () => sh(`node scripts/build-hooks-installer.js --static-dir "${hookDir}"`, srcDir));

out.installerVersionJson = JSON.parse(fs.readFileSync(path.join(hookDir, 'installer-version.json'), 'utf8'));
out.installerPackageVersion = JSON.parse(
  spawnSync('git', ['-C', gitRoot(), 'show', `${REF}:artisyn-hooks-installer/package.json`], { encoding: 'utf8' }).stdout,
).version;
out.tgzFiles = fs.readdirSync(hookDir);

const env = probeEnv(ws);
const dir = createRepo(ws, 'js-cli', 'legacy-hook');
const inst = await installHook(ws, dir, path.join(hookDir, 'artisyn-hooks-installer.tgz'), env);
const text = `${inst.stdout}\n${inst.stderr}`;
out.install = {
  exitCode: inst.exitCode,
  ms: inst.ms,
  hooksInstalled: text.includes('Hooks installed'),
  warnings: text.split(/\r?\n/).filter((l) => /warn/i.test(l)).slice(0, 5),
  configFiles: fs.readdirSync(path.join(dir, '.artisyn', 'config')),
  logHubJson: JSON.parse(fs.readFileSync(path.join(dir, '.artisyn', 'config', 'log-hub.json'), 'utf8')),
  settingsFiles: fs.readdirSync(path.join(dir, '.claude')),
};
out.install.logHubJson.apiKey &&= '<redacted>';

const r = await runClaude({
  name: 'fr13-session',
  cwd: dir,
  env,
  args: ['--model', 'haiku', '--permission-mode', 'bypassPermissions'],
  prompt: 'Read `bin/cli.js` and say in one sentence what it prints.',
});
const init = r.events.find((e) => e.type === 'system' && e.subtype === 'init');
await new Promise((res) => setTimeout(res, 10000));
const plugins = (init?.plugins ?? []).map((p) => ({ source: p.source, version: p.version }));
out.session = {
  exitCode: r.exitCode,
  sessionId: init?.session_id,
  plugins,
  pluginSourceMatches: plugins.filter((p) => !/@builtin$/.test(p.source)).map((p) => ({ source: p.source, matches: ALLOWED_PLUGIN_SOURCE_RE.test(p.source) })),
  hookEvents: r.events.filter((e) => e.subtype === 'hook_started').map((e) => e.hook_event ?? e.hook_name),
  sidFiles: filesContaining(path.join(dir, '.artisyn', 'ai_work_dir'), init?.session_id ?? '-'),
  uploadLines: fs.existsSync(path.join(dir, '.artisyn', 'ai_work_dir', 'hook.log'))
    ? fs
        .readFileSync(path.join(dir, '.artisyn', 'ai_work_dir', 'hook.log'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => /uploaded|upload failed|\b4\d\d\b/.test(l))
        .map((l) => l.slice(0, 220))
        .slice(0, 8)
    : [],
};
writeResult('fr13', out);
