// Shared helpers for the big-test probes. Reuses the big-prod-e2e-test skill libs, so the probes
// spawn `claude -p` and the installer exactly the way the real run does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFixture, gitSetup } from '../../../.claude/skills/big-prod-e2e-test/scripts/lib/repos.mjs';
import { runAsync } from '../../../.claude/skills/big-prod-e2e-test/scripts/lib/proc.mjs';
import { childEnv, prepareClaudeConfig } from '../../../.claude/skills/big-prod-e2e-test/scripts/lib/preflight.mjs';
import { FIXTURES_DIR, REMOTE_URL, gitRoot } from '../../../.claude/skills/big-prod-e2e-test/scripts/lib/config.mjs';

export const POC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(POC_DIR, 'results');
export const STATIC_DIR = path.join(POC_DIR, 'static');
const WORKSPACE_FILE = path.join(RESULTS_DIR, 'workspace.json');

/** KEY=VALUE pairs from the ignored `.env` (server URL and API key of the probe user). */
export function readDotEnv() {
  const out = {};
  const file = path.join(POC_DIR, '.env');
  if (!fs.existsSync(file)) throw new Error(`${file} missing: see README "How to run"`);
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The probe workspace (outside the git root), created by setup.mjs. */
export function workspace() {
  if (!fs.existsSync(WORKSPACE_FILE)) throw new Error('run setup.mjs first');
  const ws = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'));
  return { ...ws, repoDir: (repo) => path.join(ws.dir, repo) };
}

export function createWorkspace() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const dir = path.resolve(gitRoot(), '..', `big_test_probes-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const claudeConfigDir = path.join(dir, '_claude-config');
  prepareClaudeConfig({ claudeConfigDir });
  const ws = { dir, claudeConfigDir };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(WORKSPACE_FILE, `${JSON.stringify(ws, null, 2)}\n`);
  return { ...ws, repoDir: (repo) => path.join(dir, repo) };
}

export function probeEnv(ws, extra = {}) {
  return { ...childEnv({ claudeConfigDir: ws.claudeConfigDir }), ...extra };
}

export function createRepo(ws, repo, name = repo) {
  const dir = ws.repoDir(name);
  copyFixture(path.join(FIXTURES_DIR, repo), dir);
  gitSetup(dir, REMOTE_URL(name));
  return dir;
}

export async function installHook(ws, dir, tgz, env) {
  const { POC_SERVER_URL, POC_API_KEY } = readDotEnv();
  // A bare Windows path ("<drive>:/…/x.tgz") makes npx hang with no output; a file: URL works everywhere.
  const cmd = `npx --yes "${pathToFileURL(tgz).href}" install --server-url ${POC_SERVER_URL} --api-key ${POC_API_KEY}`;
  const started = Date.now();
  const res = await runAsync(cmd, [], { cwd: dir, env, shell: true, timeoutMs: 300000 });
  return { exitCode: res.exitCode, ms: Date.now() - started, stdout: res.stdout, stderr: res.stderr };
}

/**
 * One `claude -p` run like sessions.mjs runAttempt: a joined `shell: true` command string, the
 * prompt on stdin, stream-json to a file. Returns { exitCode, ms, streamFile, events }.
 */
export async function runClaude({ name, cwd, env, args, prompt, timeoutMs = 600000 }) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const streamFile = path.join(RESULTS_DIR, `${name}.stream.jsonl`);
  const stderrFile = path.join(RESULTS_DIR, `${name}.stderr.log`);
  const command = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', ...args].join(' ');
  const started = Date.now();
  const res = await runAsync(command, [], { cwd, env, input: prompt, shell: true, timeoutMs, stdoutFile: streamFile, stderrFile });
  const events = fs
    .readFileSync(streamFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { command, exitCode: res.exitCode, timedOut: res.timedOut, ms: Date.now() - started, streamFile, events };
}

/** Main transcript lines of a session under the isolated config dir. */
export function transcriptLines(ws, sid) {
  const projects = path.join(ws.claudeConfigDir, 'projects');
  for (const slug of fs.readdirSync(projects)) {
    const file = path.join(projects, slug, `${sid}.jsonl`);
    if (fs.existsSync(file)) {
      return {
        file,
        lines: fs
          .readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      };
    }
  }
  return { file: null, lines: [] };
}

/** Every file under `dir` whose content contains `needle` (relative paths). */
export function filesContaining(dir, needle) {
  const hits = [];
  const walk = (abs) => {
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p, 'utf8').includes(needle)) hits.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return hits;
}

export function writeResult(name, value) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log(JSON.stringify(value, null, 2));
  return file;
}
