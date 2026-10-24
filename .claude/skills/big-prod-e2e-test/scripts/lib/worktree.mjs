// S11: a linked git worktree of a test repo with its own hook install state and its own OTEL
// receiver port (Design Decisions 20, 21). Everything lives under the run-dir.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { run } from './proc.mjs';
import { LOG_HUB_LOCAL_CONFIG_REL } from './hooks.mjs';

export const WORKTREE_BRANCH = 'big-test-wt';
export const AI_WORK_DIR_REL = path.join('.artisyn', 'ai_work_dir');
// The hook log that names every session the hook handled in that checkout (PoC 2026-10-23).
export const HOOK_LOG_REL = path.join(AI_WORK_DIR_REL, 'hook.log');
const OTEL_ENDPOINT_KEY_RE = /ENDPOINT$/;

/** A port nobody listens on right now (net.createServer().listen(0)). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`worktree: ${src} missing in the main checkout`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Recursive copy of `src` into `dest`; entries named in `skip` (at any depth) are left out. */
function copyTree(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d, skip);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** Replaces the port of every OTEL `*ENDPOINT` value in a settings `env` with `port`. */
export function rewriteOtelPort(env, port) {
  const out = { ...(env || {}) };
  for (const key of Object.keys(out)) {
    if (OTEL_ENDPOINT_KEY_RE.test(key) && typeof out[key] === 'string') {
      out[key] = out[key].replace(/:\d+(?=\/|$)/, `:${port}`);
    }
  }
  return out;
}

/**
 * Creates the linked worktree `runPaths.worktreeDir` of `repo` (Design Decision 20):
 *   1. `git -C <repoDir> worktree add -q -b big-test-wt <worktreeDir>`;
 *   2. copies `.claude/settings.json`, `.claude/settings.local.json` and the whole `.artisyn/`
 *      tree (minus `ai_work_dir`, including `config/log-hub.local.json`) from the main checkout;
 *   3. allocates a fresh free port and writes it into the worktree's `log-hub.local.json`
 *      `otelReceiverPort` and every OTEL endpoint in its `settings.local.json` `env` — a copied
 *      port would hit the main receiver's 409 owner-mismatch and send the records to the main
 *      checkout.
 * Returns { dir, port }.
 */
export async function prepareWorktree(runPaths, repo = 'ts-webapp') {
  const main = runPaths.repoDir(repo);
  const dir = runPaths.worktreeDir;
  if (fs.existsSync(dir)) throw new Error(`worktree dir already exists: ${dir}`);
  run('git', ['-C', main, 'worktree', 'add', '-q', '-b', WORKTREE_BRANCH, dir], { cwd: runPaths.runDir });

  // The checkout has no `.claude/` when the fixture tracks nothing under it (ts-webapp).
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  for (const name of ['settings.json', 'settings.local.json']) {
    copyFile(path.join(main, '.claude', name), path.join(dir, '.claude', name));
  }
  const artisynSrc = path.join(main, '.artisyn');
  if (!fs.existsSync(artisynSrc)) throw new Error(`worktree: ${artisynSrc} missing in the main checkout`);
  copyTree(artisynSrc, path.join(dir, '.artisyn'), new Set([path.basename(AI_WORK_DIR_REL)]));
  // Untracked in the main checkout, so copy it explicitly even if the tree copy changes.
  copyFile(path.join(main, LOG_HUB_LOCAL_CONFIG_REL), path.join(dir, LOG_HUB_LOCAL_CONFIG_REL));

  const port = await freePort();
  const localCfg = path.join(dir, LOG_HUB_LOCAL_CONFIG_REL);
  writeJson(localCfg, { ...readJson(localCfg), otelReceiverPort: port });
  const settingsFile = path.join(dir, '.claude', 'settings.local.json');
  const settings = readJson(settingsFile);
  writeJson(settingsFile, { ...settings, env: rewriteOtelPort(settings.env, port) });
  return { dir, port };
}

/** True iff `<dir>/.artisyn/ai_work_dir/hook.log` mentions session `sid` (Design Decision 21). */
export function aiWorkDirHasSession(dir, sid) {
  if (!sid) return false;
  try {
    return fs.readFileSync(path.join(dir, HOOK_LOG_REL), 'utf8').includes(sid);
  } catch {
    return false;
  }
}
