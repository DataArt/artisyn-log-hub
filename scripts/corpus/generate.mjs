#!/usr/bin/env node
// Monthly session-corpus generator, `npm run corpus:generate` (impl-plan DD I1–I3,
// docs/qaa-overview/scenarios/08-session-corpus.md, tests/corpus/README.md). Run by hand only.
//
//   1. Checks Claude Code is installed and logged in: `claude --version`, then
//      `claude -p "reply OK" --output-format json` (60 s) in the isolated config. Any failure → exit 3
//      "Claude Code is not installed or not logged in" (same contract as DD J1).
//   2. For every scenario of tests/corpus/scenarios/scenarios.json: copies its fixture repo
//      (.claude/skills/big-prod-e2e-test/fixtures/<repo>) into a fresh dir under os.tmpdir() — never
//      inside this repository, whose CLAUDE.md files would leak into the session — makes it a git
//      repo with a fake origin, wires the real hook (hook/.claude/telemetry_tool, recording events
//      only: no upload, no OTEL, no post-turn analysis) through the repo's .claude/settings.json and
//      runs `claude -p` with an isolated CLAUDE_CONFIG_DIR (credentials copied, nothing else).
//   3. Collects the root transcript, the sub-agents (with their .meta.json) and the hook telemetry,
//      scrubs them (run/home paths in every spelling, host name, e-mails, API tokens), refuses to
//      write anything that still leaks, gzips them into tests/corpus/sets/<YYYY-MM>_cc-<ver>/
//      <repo>__<scenario>/ and writes prompts.md and manifest.json (sha256 of every file).
//   4. Writes the "what's new" report (scripts/corpus/diff-format.mjs → tmp/corpus/<set>/whats-new.md).
//
// expected.json is not written here: it is the stand's answer, approved with
// `CORPUS_APPROVE=1 npm run test:scenarios -- --mode a --only corpus` (see tests/corpus/README.md).
//
// Reuses .claude/skills/big-prod-e2e-test/scripts/lib/{proc,preflight,repos,evidence}.mjs.
//
// Usage: npm run corpus:generate -- [--scenarios id,id] [--month YYYY-MM] [--keep]
// Exit codes: 0 set written, 1 a session failed or leaked, 2 usage error, 3 Claude Code not usable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { run, runAsync } from '../../.claude/skills/big-prod-e2e-test/scripts/lib/proc.mjs';
import { childEnv, prepareClaudeConfig } from '../../.claude/skills/big-prod-e2e-test/scripts/lib/preflight.mjs';
import { copyFixture, gitSetup } from '../../.claude/skills/big-prod-e2e-test/scripts/lib/repos.mjs';
import { findTranscripts, parseStream } from '../../.claude/skills/big-prod-e2e-test/scripts/lib/evidence.mjs';
import { FIXTURES_DIR, REMOTE_URL, STORED_URL } from '../../.claude/skills/big-prod-e2e-test/scripts/lib/config.mjs';
import { main as diffFormat } from './diff-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SETS_DIR = path.join(ROOT, 'tests', 'corpus', 'sets');
export const SCENARIOS_FILE = path.join(ROOT, 'tests', 'corpus', 'scenarios', 'scenarios.json');
const HOOK_SOURCE_DIR = path.join(ROOT, 'hook', '.claude', 'telemetry_tool');

export const NOT_LOGGED_IN_EXIT_CODE = 3;
export const NOT_LOGGED_IN_MESSAGE = 'Claude Code is not installed or not logged in';
const LOGIN_CHECK_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 15 * 60_000;

/** E-mail domains that are synthetic by construction and stay as they are. */
export const SYNTHETIC_EMAIL_DOMAINS = ['example.com', 'example.test', 'arrakis.test'];
const SCRUBBED_EMAIL = 'user@arrakis.test';
const SCRUBBED_HOST = 'corpus-host';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const TOKEN_RES = [/sk-ant-[A-Za-z0-9_-]{10,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bAKIA[0-9A-Z]{16}\b/g];

/** Hook events recorded by lifecycle-hook.js; UserPromptSubmit goes to telemetry-hook.js. Stop is left out on purpose. */
const LIFECYCLE_EVENTS = [
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PostToolBatch',
  'StopFailure',
];

// ---------------------------------------------------------------------------------------------
// pure helpers

export function parseArgs(argv) {
  const opts = { scenarios: null, month: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v === '') throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === '--scenarios') opts.scenarios = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--month') {
      opts.month = value();
      if (!/^\d{4}-\d{2}$/.test(opts.month)) throw new Error(`--month must be YYYY-MM, got "${opts.month}"`);
    } else if (arg === '--keep') opts.keep = true;
    else throw new Error(`Unknown argument "${arg}"`);
  }
  return opts;
}

/** `2.1.280 (Claude Code)` → `2.1.280`, or null. */
export function parseClaudeVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(text || '');
  return m ? m[1] : null;
}

export function setName(month, version) {
  return `${month}_cc-${version}`;
}

/** Claude Code's project-folder slug of a path: every non-alphanumeric character becomes `-`. */
export function pathSlug(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Every spelling of `from` a transcript may carry — raw, JSON-escaped backslashes, forward slashes,
 * the project slug — each paired with the same spelling of `to`. Longest first.
 */
export function pathPairs(from, to) {
  const variants = (p) => {
    const fwd = p.replace(/\\/g, '/');
    return [p, p.replace(/\\/g, '\\\\'), fwd, pathSlug(p)];
  };
  const a = variants(from);
  const b = variants(to);
  const pairs = a.map((v, i) => [v, b[i]]);
  return pairs.filter(([f], i) => f && pairs.findIndex(([g]) => g === f) === i).sort((x, y) => y[0].length - x[0].length);
}

/**
 * Builds the scrubber of one run. `paths` maps local paths (longest-prefix first matters, so the run
 * root goes before the home dir) to their neutral replacement; the host name and e-mails outside
 * SYNTHETIC_EMAIL_DOMAINS are replaced too, and API tokens are redacted.
 */
export function makeScrubber({ paths, hostname }) {
  const pairs = [];
  for (const [from, to] of paths) pairs.push(...pathPairs(from, to));
  pairs.sort((x, y) => y[0].length - x[0].length);
  const hostRe = hostname && hostname.length >= 4 ? new RegExp(hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  return (text) => {
    let out = text.split('\n').map(scrubSkillListing).join('\n');
    for (const [from, to] of pairs) out = out.split(from).join(to);
    if (hostRe) out = out.replace(hostRe, SCRUBBED_HOST);
    out = out.replace(EMAIL_RE, (whole, domain) => (SYNTHETIC_EMAIL_DOMAINS.includes(domain.toLowerCase()) ? whole : SCRUBBED_EMAIL));
    for (const re of TOKEN_RES) out = out.replace(re, '<redacted-token>');
    return out;
  };
}

/** Skill namespace of the skills an organisation provisions to its Claude accounts. */
export const ACCOUNT_SKILL_PREFIX = 'anthropic-skills:';

/**
 * Drops the account-provisioned skills (`anthropic-skills:*`, the logged-in organisation's own
 * skills, which the isolated config cannot switch off) from a `skill_listing` attachment line: its
 * `names`, its `content` entries and `skillCount`. Every other line is returned unchanged.
 */
export function scrubSkillListing(line) {
  if (!line.includes('"skill_listing"') || !line.includes(ACCOUNT_SKILL_PREFIX)) return line;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return line;
  }
  const att = row && row.attachment;
  if (!att || att.type !== 'skill_listing') return line;
  if (Array.isArray(att.names)) att.names = att.names.filter((n) => !String(n).startsWith(ACCOUNT_SKILL_PREFIX));
  // The listing text appears in `attachment.content` and again in the row's `rendered[].content`.
  const filterText = (text) => {
    const kept = [];
    let drop = false;
    for (const l of text.split('\n')) {
      if (l.startsWith('- ')) drop = l.startsWith(`- ${ACCOUNT_SKILL_PREFIX}`);
      if (!drop) kept.push(l);
    }
    return kept.join('\n');
  };
  const walk = (v) => {
    if (typeof v === 'string') return v.includes(ACCOUNT_SKILL_PREFIX) ? filterText(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) if (k !== 'names') v[k] = walk(v[k]);
    }
    return v;
  };
  walk(row);
  if (typeof att.skillCount === 'number' && Array.isArray(att.names)) att.skillCount = att.names.length;
  return JSON.stringify(row);
}

/** What still leaks after scrubbing: each needle found (case-insensitive), as a short label. */
export function findLeaks(text, needles) {
  const lower = text.toLowerCase();
  return needles.filter((n) => n && lower.includes(n.toLowerCase()));
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Project `.claude/settings.json` hooks that run the real hook from `toolDir`. */
export function hookSettings(toolDir) {
  const cmd = (script) => ({ type: 'command', command: `node "${path.join(toolDir, script).replace(/\\/g, '/')}"` });
  const hooks = { UserPromptSubmit: [{ hooks: [cmd('telemetry-hook.js')] }] };
  for (const event of LIFECYCLE_EVENTS) hooks[event] = [{ hooks: [cmd('lifecycle-hook.js')] }];
  return { hooks };
}

// ---------------------------------------------------------------------------------------------
// steps

function log(msg) {
  process.stderr.write(`[corpus] ${msg}\n`);
}

/** Exit-3 check of DD J1. Returns the Claude Code version. */
async function checkClaude(env, cwd) {
  let version;
  try {
    version = parseClaudeVersion(run('claude --version', [], { shell: true, timeoutMs: LOGIN_CHECK_TIMEOUT_MS, env }).stdout);
  } catch (err) {
    throw Object.assign(new Error(`claude --version failed: ${err.message}`), { notLoggedIn: true });
  }
  if (!version) throw Object.assign(new Error('claude --version printed no version'), { notLoggedIn: true });
  const res = await runAsync('claude -p --output-format json', [], {
    cwd,
    env,
    input: 'reply OK',
    shell: true,
    timeoutMs: LOGIN_CHECK_TIMEOUT_MS,
  });
  let ok = false;
  try {
    const parsed = JSON.parse(res.stdout || '');
    ok = res.exitCode === 0 && parsed && parsed.is_error !== true;
  } catch {
    ok = false;
  }
  if (!ok) {
    const detail = res.timedOut ? 'timed out' : `exit ${res.exitCode}: ${(res.stdout || res.stderr || '').trim().slice(0, 300)}`;
    throw Object.assign(new Error(`claude -p "reply OK" failed (${detail})`), { notLoggedIn: true });
  }
  return version;
}

function prepareRepo(scenario, runRoot, toolDir) {
  const dir = path.join(runRoot, scenario.id, scenario.repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  copyFixture(path.join(FIXTURES_DIR, scenario.repo), dir);
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  const existing = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, `${JSON.stringify({ ...existing, ...hookSettings(toolDir) }, null, 2)}\n`);
  const configDir = path.join(dir, '.artisyn', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'log-hub.json'),
    `${JSON.stringify({ otelEnabled: false, sendLogsOnPromptEnabled: false }, null, 2)}\n`,
  );
  gitSetup(dir, REMOTE_URL(scenario.repo));
  // The hook's own files are not part of the fixture the session works on.
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.artisyn/\n');
  return dir;
}

async function runSession(scenario, repoDir, env, stateDir) {
  const streamFile = path.join(stateDir, `${scenario.id}.stream.jsonl`);
  const stderrFile = path.join(stateDir, `${scenario.id}.stderr.log`);
  const command = [
    'claude',
    '-p',
    '--model',
    scenario.model,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
  ].join(' ');
  const res = await runAsync(command, [], {
    cwd: repoDir,
    env,
    input: scenario.prompt,
    shell: true,
    timeoutMs: SESSION_TIMEOUT_MS,
    stdoutFile: streamFile,
    stderrFile,
  });
  const stream = parseStream(fs.readFileSync(streamFile, 'utf8').split(/\r?\n/));
  if (res.timedOut) throw new Error(`${scenario.id}: timed out after ${SESSION_TIMEOUT_MS / 1000}s`);
  if (res.exitCode !== 0) throw new Error(`${scenario.id}: claude -p exited with ${res.exitCode} (see ${stderrFile})`);
  if (!stream.sessionId) throw new Error(`${scenario.id}: no session_id in the stream-json output`);
  return stream.sessionId;
}

function gz(text) {
  return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
}

/** Collects, scrubs and writes one session. Returns its manifest entry. */
function collectSession({ scenario, sessionId, repoDir, configDir, outDir, scrub, needles, files }) {
  const transcripts = findTranscripts(configDir, sessionId);
  if (!transcripts) throw new Error(`${scenario.id}: no transcript of ${sessionId} under ${configDir}`);
  const entryDir = `${scenario.repo}__${scenario.id}`;
  const base = path.join(outDir, entryDir);
  const pending = [];
  const add = (rel, text) => {
    const clean = scrub(text.replace(/\r\n/g, '\n'));
    const leaks = findLeaks(clean, needles);
    if (leaks.length) throw new Error(`${scenario.id}/${rel}: still contains ${leaks.join(', ')} after scrubbing`);
    pending.push([rel, rel.endsWith('.gz') ? gz(clean) : Buffer.from(clean, 'utf8')]);
  };

  add('session.jsonl.gz', fs.readFileSync(transcripts.main, 'utf8'));
  for (const file of transcripts.subagents) {
    const id = path.basename(file, '.jsonl');
    add(`subagents/${id}.jsonl.gz`, fs.readFileSync(file, 'utf8'));
    const meta = path.join(path.dirname(file), `${id}.meta.json`);
    if (fs.existsSync(meta)) add(`subagents/${id}.meta.json`, fs.readFileSync(meta, 'utf8'));
  }
  const hookFile = path.join(repoDir, '.artisyn', 'ai_work_dir', 'telemetry', `${sessionId}.jsonl`);
  const hook = fs.existsSync(hookFile);
  if (hook) add('hook/artisyn.jsonl.gz', fs.readFileSync(hookFile, 'utf8'));
  else log(`${scenario.id}: no hook telemetry at ${hookFile} — the set has none for this session`);
  add(
    'prompts.md',
    `# ${entryDir}\n\nModel: \`${scenario.model}\`. Repository: fixture \`${scenario.repo}\`.\n\nPrompt (stdin of \`claude -p\`):\n\n> ${scenario.prompt}\n`,
  );

  for (const [rel, buf] of pending) {
    const dest = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    files[`${entryDir}/${rel}`] = sha256(buf);
  }
  return {
    dir: entryDir,
    repo: scenario.repo,
    scenario: scenario.id,
    model: scenario.model,
    sessionId,
    repoUrl: STORED_URL(scenario.repo),
    subagents: transcripts.subagents.length,
    hook,
  };
}

function gitHead() {
  try {
    return run('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).stdout.trim();
  } catch {
    return 'unknown';
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`corpus:generate: ${err.message}\nUsage: npm run corpus:generate -- [--scenarios id,id] [--month YYYY-MM] [--keep]\n`);
    return 2;
  }
  const all = JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8')).scenarios;
  const scenarios = opts.scenarios ? all.filter((s) => opts.scenarios.includes(s.id)) : all;
  const unknown = (opts.scenarios || []).filter((id) => !all.some((s) => s.id === id));
  if (unknown.length || scenarios.length === 0) {
    process.stderr.write(`corpus:generate: unknown or no scenarios: ${unknown.join(', ') || '(none selected)'}\n`);
    return 2;
  }

  // Long form of the temp dir: Windows may hand out an 8.3 short path that transcripts spell long.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artisyn-corpus-'));
  const runRoot = fs.realpathSync.native(tmpRoot);
  const runPaths = { claudeConfigDir: path.join(runRoot, '_claude-config') };
  const stateDir = path.join(runRoot, '_state');
  fs.mkdirSync(stateDir, { recursive: true });
  let outDir = null;
  try {
    let env;
    let version;
    try {
      prepareClaudeConfig(runPaths);
      env = childEnv(runPaths);
      version = await checkClaude(env, runRoot);
    } catch (err) {
      process.stderr.write(`corpus:generate: ${NOT_LOGGED_IN_MESSAGE} (${err.message})\n`);
      return NOT_LOGGED_IN_EXIT_CODE;
    }

    const month = opts.month ?? new Date().toISOString().slice(0, 7);
    const set = setName(month, version);
    outDir = path.join(SETS_DIR, set);
    if (fs.existsSync(outDir)) {
      process.stderr.write(`corpus:generate: ${path.relative(ROOT, outDir)} already exists — delete it first to regenerate\n`);
      outDir = null;
      return 2;
    }
    log(`set ${set}, run dir ${runRoot}`);

    const toolDir = path.join(runRoot, '_hook', 'telemetry_tool');
    fs.cpSync(HOOK_SOURCE_DIR, toolDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}__tests__`) });
    const hookVersion = JSON.parse(fs.readFileSync(path.join(HOOK_SOURCE_DIR, 'version.json'), 'utf8')).version;

    const home = os.homedir();
    const neutralRoot = process.platform === 'win32' ? 'C:\\corpus' : '/corpus';
    const neutralHome = process.platform === 'win32' ? 'C:\\Users\\corpus-user' : '/home/corpus-user';
    const shortRoot = path.resolve(tmpRoot);
    const pathsToScrub = [[runRoot, neutralRoot], [home, neutralHome]];
    if (shortRoot !== runRoot) pathsToScrub.unshift([shortRoot, neutralRoot]);
    const scrub = makeScrubber({ paths: pathsToScrub, hostname: os.hostname() });
    const user = os.userInfo().username;
    const needles = [runRoot, home, home.replace(/\\/g, '/'), pathSlug(home), 'artisyn-corpus-', ACCOUNT_SKILL_PREFIX, os.hostname(), `\\${user}\\`, `/${user}/`];

    const files = {};
    const sessions = [];
    const failures = [];
    for (const scenario of scenarios) {
      try {
        log(`${scenario.id}: ${scenario.repo}, ${scenario.model}`);
        const repoDir = prepareRepo(scenario, runRoot, toolDir);
        const sessionId = await runSession(scenario, repoDir, env, stateDir);
        sessions.push(
          collectSession({ scenario, sessionId, repoDir, configDir: runPaths.claudeConfigDir, outDir, scrub, needles, files }),
        );
        log(`${scenario.id}: session ${sessionId} collected`);
      } catch (err) {
        failures.push(`${scenario.id}: ${err.message}`);
        log(`${scenario.id}: FAILED — ${err.message}`);
      }
    }
    if (failures.length) {
      process.stderr.write(`corpus:generate: ${failures.length} session(s) failed; nothing kept:\n- ${failures.join('\n- ')}\n`);
      fs.rmSync(outDir, { recursive: true, force: true });
      outDir = null;
      return 1;
    }

    const manifest = {
      set,
      generatedAt: new Date().toISOString(),
      claudeCodeVersion: version,
      hookVersion,
      os: `${process.platform}-${process.arch}`,
      generatorCommit: gitHead(),
      models: [...new Set(scenarios.map((s) => s.model))].sort(),
      sessions,
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`wrote ${path.relative(ROOT, outDir)} (${sessions.length} sessions)`);
    diffFormat([set]);
    log('next: review tmp/corpus/<set>/whats-new.md, approve the format and the snapshot (tests/corpus/README.md)');
    return 0;
  } finally {
    if (opts.keep) log(`kept run dir ${runRoot}`);
    else fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`corpus:generate error: ${err.stack || err.message}\n`);
      process.exit(1);
    },
  );
}
