// Creates the probe workspace next to the git root (never inside it): an isolated
// CLAUDE_CONFIG_DIR plus throwaway copies of the js-cli and ts-webapp fixtures, each with the
// current hook installed from static/artisyn-hooks-installer.tgz.
import path from 'node:path';
import { STATIC_DIR, createRepo, createWorkspace, installHook, probeEnv, writeResult } from './probe-lib.mjs';

const ws = createWorkspace();
const env = probeEnv(ws);
const tgz = path.join(STATIC_DIR, 'artisyn-hooks-installer.tgz');
const out = { workspace: ws.dir, installs: {} };
for (const repo of ['js-cli', 'ts-webapp']) {
  const dir = createRepo(ws, repo);
  const res = await installHook(ws, dir, tgz, env);
  out.installs[repo] = { exitCode: res.exitCode, ms: res.ms, installed: /Hooks installed/.test(res.stdout + res.stderr) };
  if (res.exitCode !== 0) console.error(res.stdout, res.stderr);
}
writeResult('setup', out);
