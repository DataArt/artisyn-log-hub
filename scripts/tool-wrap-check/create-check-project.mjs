#!/usr/bin/env node
/**
 * Creates (or refreshes) the tool-wrapper verification project — a sibling folder outside the
 * repo, by default `<repo>/../loghub-tool-wrap-check/` (DD-26 of task T-26):
 *
 *   node scripts/tool-wrap-check/create-check-project.mjs [--dir <path>] [--claude-home <path>]
 *
 * It writes only the files listed in `generatedFiles()` (fixture tools, run-check.mjs, package.json,
 * check.config.json, README.md, linux/Dockerfile, linux/live-settings.json, .gitignore and the
 * marker `.loghub-tool-wrap-check`) and runs `git init` once. Re-running overwrites those files in
 * place and leaves everything else — `runs/`, `.artisyn/`, anything the owner added — untouched.
 *
 * DD-27 (owner's hard rule): this script deletes nothing, ever, and refuses (exit 1, no writes) when
 * the target is a filesystem root, the home directory, the repo root or one of its ancestors, a path
 * inside the repo, an existing non-directory, or an existing non-empty folder without the marker.
 *
 * Node.js built-ins only; synchronous throughout. Fixture texts come from the hook test helper
 * `hook/.claude/telemetry_tool/__tests__/tool-wrap-fixtures.js`, so the test and the project share
 * one copy. The other generated files live under `scripts/tool-wrap-check/template/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const TEMPLATE_DIR = path.join(SCRIPT_DIR, 'template');
const HOOK_DIR = path.join(REPO_ROOT, 'hook', '.claude', 'telemetry_tool');
const MARKER = '.loghub-tool-wrap-check';
const DEFAULT_DIR_NAME = 'loghub-tool-wrap-check';

const require = createRequire(import.meta.url);
const { FIXTURE_TOOLS } = require(path.join(HOOK_DIR, '__tests__', 'tool-wrap-fixtures.js'));

function parseArgs(argv) {
  const out = { dir: null, claudeHome: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i] || null;
    else if (a === '--claude-home') out.claudeHome = argv[++i] || null;
    else throw new Error(`unknown argument ${a} (usage: --dir <path> --claude-home <path>)`);
  }
  return out;
}

/** Comparable form of a path: resolved, no trailing separator, lower case on Windows. */
function key(p) {
  const r = path.resolve(p).replace(/[\\/]+$/, '') || path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Whether `child` is strictly inside `parent`. */
function isInside(child, parent) {
  const c = key(child);
  const p = key(parent);
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c !== p && c.startsWith(prefix);
}

/**
 * Why the target must not be written (DD-27), or null when it is safe.
 * @param {string} target - resolved path
 * @returns {string|null}
 */
function refusalReason(target) {
  if (key(target) === key(path.parse(target).root)) return 'it is a filesystem root';
  if (key(target) === key(os.homedir())) return 'it is the home directory';
  if (key(target) === key(REPO_ROOT)) return 'it is the repo root';
  if (isInside(REPO_ROOT, target)) return 'it is an ancestor of the repo root';
  if (isInside(target, REPO_ROOT)) return 'it is inside the repo';
  let st = null;
  try {
    st = fs.lstatSync(target);
  } catch {
    return null; // does not exist yet: it will be created
  }
  if (st.isSymbolicLink()) return 'it is a symbolic link';
  if (!st.isDirectory()) return 'it exists and is not a directory';
  const entries = fs.readdirSync(target);
  if (entries.length > 0 && !entries.includes(MARKER)) {
    return `it is a non-empty folder without the ${MARKER} marker (not created by this script)`;
  }
  return null;
}

function template(rel) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, ...rel.split('/')), 'utf8');
}

/**
 * Every file this script writes, as [relative path, content, executable]. Nothing outside this list
 * is ever touched.
 * @param {string} target
 * @param {{ claudeHome: string }} opts
 * @returns {[string, string, boolean][]}
 */
function generatedFiles(target, opts) {
  const files = [];
  for (const [name, spec] of Object.entries(FIXTURE_TOOLS)) {
    files.push([`bin/${name}`, spec.content, spec.executable]);
  }
  files.push(['run-check.mjs', template('run-check.mjs'), true]);
  files.push(['README.md', template('README.md'), false]);
  files.push(['linux/Dockerfile', template('linux/Dockerfile'), false]);
  files.push(['linux/live-settings.json', template('linux/live-settings.json'), false]);
  files.push(['package.json', JSON.stringify({
    name: 'loghub-tool-wrap-check',
    private: true,
    type: 'module',
    description: 'Log Hub tool-wrapper fidelity and live checks (generated; see README.md)',
    scripts: {
      check: 'node run-check.mjs',
      'check:linux': 'node run-check.mjs --linux',
      'check:linux-live': 'node run-check.mjs --live',
    },
  }, null, 2) + '\n', false]);
  files.push(['check.config.json', JSON.stringify({
    repoRoot: REPO_ROOT,
    hookDir: HOOK_DIR,
    fidelityTest: 'hook/.claude/telemetry_tool/__tests__/tool-wrap-fidelity.algo.test.js',
    claudeHome: opts.claudeHome,
    linuxImage: 'loghub-tool-wrap-check:local',
    liveImage: 'log-hub-dev:latest',
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n', false]);
  files.push(['.gitignore', 'runs/\n.artisyn/\n', false]);
  files.push([MARKER, 'Created by the Log Hub repo\'s scripts/tool-wrap-check/create-check-project.mjs.\n'
    + 'The generator only writes into a folder holding this file (or an empty one).\n', false]);
  return files;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const target = path.resolve(args.dir || path.join(REPO_ROOT, '..', DEFAULT_DIR_NAME));
  const claudeHome = path.resolve(args.claudeHome || path.join(REPO_ROOT, 'docker-dev', 'claude-home'));

  const refusal = refusalReason(target);
  if (refusal) {
    process.stderr.write(`create-check-project: refusing to write ${target}: ${refusal}. Nothing was written.\n`);
    process.exit(1);
  }

  const files = generatedFiles(target, { claudeHome });
  fs.mkdirSync(target, { recursive: true });
  // The marker first, so an interrupted run still leaves a folder the next run may refresh.
  for (const [rel, content, executable] of [...files].sort(([a], [b]) => (a === MARKER ? -1 : b === MARKER ? 1 : 0))) {
    const file = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (executable) {
      try {
        fs.chmodSync(file, 0o755);
      } catch {
        // Windows: modes are not kept; Git Bash and Docker Desktop treat the files as executable
      }
    }
  }

  let gitNote = 'git repo already present';
  if (!fs.existsSync(path.join(target, '.git'))) {
    const res = spawnSync('git', ['init', '-q'], { cwd: target, encoding: 'utf8', windowsHide: true });
    gitNote = res.status === 0 ? 'git init done' : `git init failed (${(res.stderr || '').trim() || res.error}) — not required for the checks`;
  }

  process.stdout.write(`Verification project ready: ${target}\n`);
  process.stdout.write(`  ${files.length} generated files written; ${gitNote}\n`);
  process.stdout.write('  next: cd there and run npm run check / check:linux / check:linux-live (see README.md)\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`create-check-project error: ${err && err.message}\n`);
  process.exit(1);
}
