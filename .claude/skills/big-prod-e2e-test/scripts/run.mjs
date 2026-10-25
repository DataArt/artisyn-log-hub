#!/usr/bin/env node
// Big reproducible pre-prod e2e test — the orchestrator.
//
//   node .claude/skills/big-prod-e2e-test/scripts/run.mjs [--keep]
//
// Runs phases P0–P12 in order, rewrites `_report/report.json`, `index.md` and `index.html` after every
// phase and once more after teardown, and exits 0 (PASS), 1 (FAIL) or 2 (any infra failure).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_MD_REPO, DB_PORT, FC_REPO, FC_SCENARIO, GENERATED_CLAUDE_MD, LEGACY_LOG_HUB_JSON, LEGACY_OWNER, LEGACY_REPO, MODELS,
  PREV_HOOK_VERSION, PREV_INSTALLER_VERSION, PREV_RELEASE_REF, REPOS, REPO_NAMES, REMOTE_URL, RESTAMP_WAIT_MS, STAND_HOST,
  STAND_URL, STORED_URL, TEAMS, TIMEOUTS, USERS, USER_ORDER, FIXTURES_DIR, POSTGRES_IMAGE, gitRoot, runStamp, resolveRun,
} from './lib/config.mjs';
import { run, runAsync } from './lib/proc.mjs';
import { createApiClient } from './lib/api.mjs';
import {
  createReport, exitCodeFor, recordAc, recordCase, recordInfra, recordSession, recordVisibility, writeReport,
} from './lib/report.mjs';
import { ensureMcpDb, warmMcpServer } from './lib/mcpdb.mjs';
import { runFileCategories } from './lib/filecategories.mjs';
import {
  checkPortsFree, checkTools, childEnv, compareDevPorts, dockerfileBaseImages, isListening, prePullBaseImages, prepareClaudeConfig,
  snapshotDevPorts,
} from './lib/preflight.mjs';
import { assertDown, buildImage, down, downCommand, killOtelReceivers, saveAppLogs, up, waitReady } from './lib/stand.mjs';
import { createRepos, findClaudeMd, listFiles, mapFixturePath, seedLegacyLogHub } from './lib/repos.mjs';
import {
  acceptConsent, assertRole, getOneLiner, launch, newUserContext, redactOneLiner, signup,
} from './lib/browser.mjs';
import { checkLocalConfig, installHook } from './lib/hooks.mjs';
import { buildPrevInstaller, installPrevHook } from './lib/legacy.mjs';
import { judgeNodeMatrix, runNodeLtsMatrix } from './lib/node-lts.mjs';
import { aiWorkDirHasSession, prepareWorktree } from './lib/worktree.mjs';
import { acceptInvite, createTeam, invite, linkRepo, openTeam, setTransparent } from './lib/teams.mjs';
import { SESSION_STATUS, needsVerification, runScenario } from './lib/sessions.mjs';
import { VERIFY_STATUS, applyScriptedJudgements, verifySession } from './lib/verify.mjs';
import { VISIBILITY_ROWS, runVisibility } from './lib/visibility.mjs';
import { LEGACY_SCENARIO, SCENARIOS } from './scenarios.mjs';

const USAGE = 'usage: node .claude/skills/big-prod-e2e-test/scripts/run.mjs [--keep]';
const MODEL_ALIASES = Object.freeze(['sonnet', 'haiku', 'opus']);
const NOT_INGESTED = SESSION_STATUS.notIngested;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which phases contribute to each AC row; used to flag rows not fully evaluated. */
const AC_PHASES = Object.freeze({
  'FR-2': ['P1'],
  'FR-3': ['P0', 'P11'],
  'FR-4': ['P2', 'P11'],
  'FR-5': ['P2', 'P4'],
  'FR-6': ['P3'],
  'FR-7': ['P4', 'P5', 'P10'],
  'FR-7a': ['P6'],
  'FR-8': ['P8'],
  'FR-9': ['P9'],
  'FR-9b': ['P10'],
  'FR-FC1': ['P9b'],
  'FR-FC2': ['P9b'],
  'FR-10': ['P11'],
  'FR-11': ['P12'],
  'FR-LC': ['P5'],
  'FR-UP': ['P5'],
  'FR-OLD': ['P5b', 'P9'],
  'FR-NODE': ['P5c'],
  'FR-WT': ['P8'],
});

/** The repo whose run-dir copy goes through the FR-12 upgrade (a committed pre-split log-hub.json). */
const UPGRADE_REPO = 'java-lib';
/** The repo whose linked worktree S11 runs in (Design Decision 20). */
const WORKTREE_REPO = 'ts-webapp';
/** Every session the run knows: S1–S11 plus the legacy-hook session L1. */
const ALL_SCENARIOS = Object.freeze([...SCENARIOS, LEGACY_SCENARIO]);
const NOT_RUN_LEGACY = 'fail: legacy hook not installed';

// ---- CLI ----------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { keep: false };
  for (const arg of argv) {
    if (arg === '--keep') opts.keep = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument "${arg}"\n${USAGE}`);
  }
  return opts;
}

// ---- Logging ------------------------------------------------------------------------------------

let logFile = null;
function log(step, msg) {
  const line = `[${step}] ${msg}`;
  process.stdout.write(`${line}\n`);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* the log file is a convenience only */
    }
  }
}
const logger = (step) => (msg) => log(step, msg);

/** One readable line for the report: no ANSI codes, no Playwright "Call log:" dump, bounded. */
export function shortError(err) {
  const text = String(err && err.message ? err.message : err)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\nCall log:/)[0]
    .trim();
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

// ---- Shared run context ---------------------------------------------------------------------------

const ctx = {
  opts: { keep: false },
  report: null,
  runPaths: null,
  env: null,
  state: null,
  devPortsBefore: null,
  gitStatusBefore: null,
  browser: null,
  pages: {},
  results: {},
  mcpDb: null,
  acParts: new Map(),
  phasesRun: new Set(),
  tornDown: false,
};

function saveReport() {
  if (!ctx.report || !ctx.runPaths || !fs.existsSync(ctx.runPaths.runDir)) return;
  try {
    writeReport(ctx.report, ctx.runPaths.reportDir);
  } catch (err) {
    log('report', `could not write the report: ${err.message}`);
  }
}

function saveState() {
  if (!ctx.state || !ctx.runPaths) return;
  fs.mkdirSync(ctx.runPaths.stateDir, { recursive: true });
  fs.writeFileSync(ctx.runPaths.runStateFile, `${JSON.stringify(ctx.state, null, 2)}\n`);
}

/** Adds one phase's part to an AC row and re-records the combined row (fail if any part failed). */
function ac(id, phase, ok, detail) {
  const parts = ctx.acParts.get(id) ?? [];
  const i = parts.findIndex((p) => p.phase === phase && p.detail === detail);
  if (i >= 0) parts.splice(i, 1);
  parts.push({ phase, ok: Boolean(ok), detail });
  ctx.acParts.set(id, parts);
  const status = parts.every((p) => p.ok) ? 'pass' : 'fail';
  recordAc(ctx.report, id, status, parts.map((p) => `${p.phase}: ${p.ok ? '' : 'FAIL — '}${p.detail}`).join('; '));
}

/** Marks every AC row whose contributing phases did not all run as failed ("not evaluated"). */
function finalizeAcRows() {
  for (const [id, phases] of Object.entries(AC_PHASES)) {
    const missing = phases.filter((p) => !(ctx.acParts.get(id) ?? []).some((x) => x.phase === p));
    for (const p of missing) ac(id, p, false, 'not evaluated (phase skipped or crashed)');
  }
  const order = Object.keys(AC_PHASES);
  ctx.report.acChecks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

async function phase(id, step, fn) {
  log(step, `${id} started`);
  const started = Date.now();
  ctx.phasesRun.add(id);
  try {
    const detail = await fn();
    if (step && !id.match(/^P(8|9|9b|10|11)$/)) recordInfra(ctx.report, step, 'pass', null, detail ?? null);
    log(step, `${id} done in ${Math.round((Date.now() - started) / 1000)}s${detail ? ` — ${detail}` : ''}`);
  } finally {
    saveReport();
  }
}

// ---- P0 preflight ---------------------------------------------------------------------------------

function gitStatusPaths(root) {
  const res = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, allowFail: true });
  if (res.status !== 0) return null;
  return res.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim());
}

/**
 * Pre-pulls the stand's base images (the root Dockerfile's FROM images + POSTGRES_IMAGE) that are
 * not local from the public ECR mirror, so Docker Hub's anonymous 429 cannot stop P1/P2. A failure
 * is only a warning: the build may still pull the image itself.
 */
function prePullImages(step, root) {
  let images = [];
  try {
    images = dockerfileBaseImages(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'));
  } catch (err) {
    log(step, `warning: cannot read the Dockerfile for base images (${err.message})`);
  }
  if (!images.includes(POSTGRES_IMAGE)) images.push(POSTGRES_IMAGE);
  for (const r of prePullBaseImages(images)) {
    log(step, `${r.action === 'failed' ? 'warning: pre-pull failed for' : 'base image'} ${r.image}: ${r.action === 'failed' ? '' : `${r.action} — `}${r.detail}`);
  }
}

async function p0Preflight() {
  const step = 'preflight';
  const tools = checkTools();
  log(step, `tools ok (chromium ${tools.chromium})`);
  await checkPortsFree();
  log(step, 'stand ports 3001 / 5433 are free');
  ctx.devPortsBefore = await snapshotDevPorts();
  log(step, `dev ports before: ${JSON.stringify(ctx.devPortsBefore)}`);

  const root = gitRoot();
  prePullImages(step, root);
  ctx.gitStatusBefore = gitStatusPaths(root);
  let runPaths = resolveRun(runStamp(), root);
  while (fs.existsSync(runPaths.runDir)) {
    await sleep(RESTAMP_WAIT_MS);
    runPaths = resolveRun(runStamp(), root);
  }
  fs.mkdirSync(runPaths.runDir, { recursive: true });
  for (const d of [runPaths.stateDir, runPaths.sessionsDir, runPaths.verifyDir, runPaths.reportDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  ctx.runPaths = runPaths;
  logFile = path.join(runPaths.stateDir, 'run.log');
  Object.assign(ctx.report, { stamp: runPaths.stamp, runDir: runPaths.runDir, image: runPaths.imageRef });
  log(step, `run dir: ${runPaths.runDir}`);
  log(step, `report: ${runPaths.indexHtml} (also index.md)`);

  const expectedDir = path.resolve(root, '..', path.basename(runPaths.runDir));
  ac('FR-3', 'P0', fs.existsSync(runPaths.runDir) && expectedDir === runPaths.runDir, `run dir ${runPaths.runDir}`);

  const creds = prepareClaudeConfig(runPaths);
  ctx.env = childEnv(runPaths);
  log(step, `isolated Claude config at ${creds.dir} (credentials from ${creds.mode === 'env' ? creds.keys.join(', ') : creds.source})`);

  // S7's MCP target: additive only — never dropped, the user removes it by hand if ever.
  const db = await ensureMcpDb();
  ctx.mcpDb = db;
  log(step, `MCP test database ${db.masked} (${db.created ? 'created' : 'already there'}, ${db.rows} products; from ${db.source})`);
  const warm = await warmMcpServer(db.url, { cwd: runPaths.verifyDir, logFile: path.join(runPaths.stateDir, 'mcp-warmup.log') });
  if (warm.timedOut) throw new Error('warming the Postgres MCP server package (npx -y) timed out');
  log(step, `Postgres MCP server package ready (exit ${warm.exitCode})`);
  return `run dir ${runPaths.runDir}`;
}

// ---- P1 build / P2 stand ---------------------------------------------------------------------------

async function p1Build() {
  try {
    const r = await buildImage(ctx.runPaths.stamp, { root: ctx.runPaths.gitRoot, logFile: ctx.runPaths.standUpLog });
    ac('FR-2', 'P1', true, `${r.imageRef} is ${r.architecture}; artisyn-log-hub:latest unchanged (${r.latestBefore})`);
    return `${r.imageRef} (${r.architecture})`;
  } catch (err) {
    if (err.result) {
      ac('FR-2', 'P1', false, `${err.message} (arch ${err.result.architecture}, latest ${err.result.latestBefore} → ${err.result.latestAfter})`);
    }
    throw err;
  }
}

async function p2Stand() {
  up(ctx.runPaths);
  log('stand', `compose project ${ctx.runPaths.composeProject} is up, waiting for ${STAND_URL}`);
  const body = await waitReady({ runPaths: ctx.runPaths });
  ac('FR-5', 'P2', body.mode === 'password', `auth/config → ${JSON.stringify(body)}`);
  const dbOk = await isListening(DB_PORT, STAND_HOST);
  ac('FR-4', 'P2', dbOk, `auth/config answers on ${STAND_URL}; ${STAND_HOST}:${DB_PORT} ${dbOk ? 'accepts' : 'refuses'} TCP`);
  if (!dbOk) throw new Error(`stand db port ${STAND_HOST}:${DB_PORT} does not accept TCP`);
  return `${STAND_URL} ready (mode ${body.mode})`;
}

// ---- P3 repos ---------------------------------------------------------------------------------------

function expectedHarnessFiles(repo) {
  const dir = path.join(FIXTURES_DIR, repo, 'dot-claude');
  if (!fs.existsSync(dir)) return [];
  return listFiles(dir).map((rel) => mapFixturePath(path.join('dot-claude', rel)));
}

/** FR-4a: the run-dir copy of CLAUDE_MD_REPO gets a generated CLAUDE.md in its fixture commit. */
function writeGeneratedClaudeMd(repo, dir) {
  if (repo === CLAUDE_MD_REPO) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), GENERATED_CLAUDE_MD);
}

/**
 * FR-6 (P3) CLAUDE.md part: no fixture source carries a CLAUDE.md, only CLAUDE_MD_REPO's run-dir
 * copy has one, and its content is GENERATED_CLAUDE_MD. Returns the problem lines.
 */
function claudeMdProblems(repos) {
  const problems = [];
  const inFixtures = findClaudeMd(FIXTURES_DIR);
  if (inFixtures.length) problems.push(`fixture sources carry CLAUDE.md: ${inFixtures.join(', ')}`);
  for (const repo of repos) {
    const found = findClaudeMd(ctx.runPaths.repoDir(repo));
    if (repo !== CLAUDE_MD_REPO) {
      if (found.length) problems.push(`${repo} has ${found.join(', ')}`);
      continue;
    }
    const file = path.join(ctx.runPaths.repoDir(repo), 'CLAUDE.md');
    const extra = found.filter((rel) => rel !== 'CLAUDE.md');
    if (extra.length) problems.push(`${repo} has extra ${extra.join(', ')}`);
    if (!fs.existsSync(file)) problems.push(`${repo} has no generated CLAUDE.md`);
    else if (fs.readFileSync(file, 'utf8') !== GENERATED_CLAUDE_MD) problems.push(`${repo}/CLAUDE.md differs from GENERATED_CLAUDE_MD`);
  }
  return problems;
}

async function p3Repos() {
  const created = createRepos(ctx.runPaths, { beforeCommit: writeGeneratedClaudeMd });
  // FR-12: the upgrade repo gets the pre-split log-hub.json as a second, tracked commit.
  const upgradeHead = seedLegacyLogHub(ctx.runPaths.repoDir(UPGRADE_REPO), LEGACY_LOG_HUB_JSON);
  log('repos', `${UPGRADE_REPO}: legacy log-hub.json committed (${upgradeHead.slice(0, 8)})`);
  const legacy = createRepos(ctx.runPaths, { repos: [LEGACY_REPO] });
  const allRepos = [...REPO_NAMES, LEGACY_REPO];

  const problems = [];
  for (const repo of allRepos) {
    const dir = ctx.runPaths.repoDir(repo);
    if (!fs.existsSync(path.join(dir, '.git'))) problems.push(`${repo} has no .git`);
    for (const rel of expectedHarnessFiles(repo)) {
      if (!fs.existsSync(path.join(dir, rel))) problems.push(`${repo} is missing ${rel}`);
    }
  }
  if (created.length !== REPO_NAMES.length) problems.push(`${created.length}/${REPO_NAMES.length} repos created`);
  if (legacy.length !== 1) problems.push(`${LEGACY_REPO} not created`);
  problems.push(...claudeMdProblems(allRepos));
  const harness = created.map((r) => `${r.repo}: ${r.harnessFiles.length ? r.harnessFiles.join(', ') : 'no harness'}`).join('; ');
  ac(
    'FR-6',
    'P3',
    problems.length === 0,
    problems.length
      ? problems.join('; ')
      : `${allRepos.length} git repos; no fixture source has a CLAUDE.md; only ${CLAUDE_MD_REPO} has the generated CLAUDE.md (content matches); ${harness}`,
  );

  ctx.state.repos = Object.fromEntries(
    [...created, ...legacy].map((r) => [
      r.repo,
      {
        owner: r.repo === LEGACY_REPO ? LEGACY_OWNER : REPOS[r.repo],
        dir: r.dir,
        remoteUrl: r.remoteUrl,
        storedUrl: STORED_URL(r.repo),
        repoId: null,
      },
    ]),
  );
  if (problems.length) throw new Error(problems.join('; '));
  return `${created.length + legacy.length} repos`;
}

// ---- P4 onboarding --------------------------------------------------------------------------------

async function p4Onboarding() {
  const step = 'onboarding';
  ctx.browser = await launch();
  const roleProblems = [];
  let u1LoginOk = false;
  for (const key of USER_ORDER) {
    const user = USERS[key];
    const { context, page } = await newUserContext(ctx.browser);
    ctx.pages[key] = { context, page };
    const s = await signup(page, user);
    const consent = await acceptConsent(page);
    log(step, `${key} ${user.email} signed up (logged in via ${s.loggedInVia}${consent ? ', consent accepted' : ''})`);

    const entry = { email: user.email, password: user.password, role: user.role };
    try {
      await assertRole(user.email, user.password, user.role);
      if (key === 'U1') u1LoginOk = true;
    } catch (err) {
      roleProblems.push(err.message);
    }
    if (key !== 'admin') {
      const one = await getOneLiner(page);
      entry.apiKey = one.apiKey;
      entry.installCommand = one.command;
      log(step, `${key} one-liner: ${redactOneLiner(one.command)}`);
      if (one.serverUrl.replace(/\/+$/, '') !== STAND_URL) {
        throw new Error(`${key} one-liner points at ${one.serverUrl}, expected ${STAND_URL}`);
      }
    }
    ctx.state.users[key] = entry;
  }
  ac('FR-5', 'P4', u1LoginOk, u1LoginOk ? 'U1 signed up and logged in with no verification step' : 'U1 login failed');
  ac(
    'FR-7',
    'P4',
    roleProblems.length === 0,
    roleProblems.length ? roleProblems.join('; ') : 'admin has role admin; U1–U3 have role user',
  );
  saveState();
  if (roleProblems.length) throw new Error(roleProblems.join('; '));
  return `${USER_ORDER.length} users onboarded`;
}

// ---- P5 hooks ---------------------------------------------------------------------------------------

async function p5Hooks() {
  const done = [];
  try {
    for (const repo of REPO_NAMES) {
      const owner = ctx.state.users[REPOS[repo]];
      const res = await installHook(ctx.runPaths.repoDir(repo), owner.installCommand, ctx.env, {
        logFile: ctx.runPaths.installerLog(repo),
      });
      for (const w of res.warnings) log('hooks', `${repo} installer warning: ${w}`);
      log('hooks', `${repo}: hook installed for ${owner.email}`);
      done.push(repo);
    }
  } finally {
    const ok = done.length === REPO_NAMES.length;
    ac('FR-7', 'P5', ok, `hook installed in ${done.length}/${REPO_NAMES.length} repos${ok ? '' : ` (${done.join(', ') || 'none'})`}`);
  }

  // FR-11: a fresh install keeps the per-machine values in log-hub.local.json only.
  const lcProblems = [];
  const lcFiles = [];
  for (const repo of REPO_NAMES.filter((r) => r !== UPGRADE_REPO)) {
    const res = checkLocalConfig(ctx.runPaths.repoDir(repo));
    lcFiles.push(configFilesDetail(repo, res));
    for (const p of res.problems) lcProblems.push(`${repo}: ${p}`);
  }
  ac('FR-LC', 'P5', lcProblems.length === 0, `${lcProblems.length ? `${lcProblems.join('; ')}; ` : ''}${lcFiles.join('; ')}`);

  // FR-12: the current installer over a committed pre-split log-hub.json (serverUrl may stay there).
  const up = checkLocalConfig(ctx.runPaths.repoDir(UPGRADE_REPO), { legacy: true });
  ac(
    'FR-UP',
    'P5',
    up.ok,
    `${up.ok ? '' : `${up.problems.map((p) => `${UPGRADE_REPO}: ${p}`).join('; ')}; `}${configFilesDetail(UPGRADE_REPO, up)}`,
  );

  // S11's linked worktree, with its own hook state and OTEL port (Design Decision 20).
  try {
    ctx.state.worktree = await prepareWorktree(ctx.runPaths, WORKTREE_REPO);
    log('hooks', `${WORKTREE_REPO} worktree at ${ctx.state.worktree.dir} (OTEL port ${ctx.state.worktree.port})`);
  } catch (err) {
    ctx.state.worktree = { dir: null, port: null, error: shortError(err) };
    log('hooks', `${WORKTREE_REPO} worktree could not be prepared — ${err.message}`);
  }
  saveState();
  return `${done.length} hooks${ctx.state.worktree.dir ? ', worktree ready' : `, worktree FAILED (${ctx.state.worktree.error})`}`;
}

/** `<repo>: log-hub.json <json>, log-hub.local.json <json>` — the FR-LC / FR-UP evidence. */
function configFilesDetail(repo, res) {
  return `${repo}: log-hub.json ${JSON.stringify(res.base)}, log-hub.local.json ${JSON.stringify(res.local)}`;
}

// ---- P5b legacy hook --------------------------------------------------------------------------------

/**
 * FR-13: builds the previous-release installer from git and installs it into LEGACY_REPO with
 * LEGACY_OWNER's API key. A failure is recorded as FR-OLD (P5b) and never stops the run — L1 is
 * then not run.
 */
async function p5bLegacyHook() {
  const step = 'legacy-hook';
  try {
    const owner = ctx.state.users[LEGACY_OWNER];
    if (!owner?.apiKey) throw new Error(`infra: install: no API key for ${LEGACY_OWNER} in run state`);
    const built = await buildPrevInstaller(ctx.runPaths);
    log(step, `built ${PREV_RELEASE_REF}: installer ${built.installerVersion}, hook ${built.hookVersion} (${built.tgz})`);
    await installPrevHook(ctx.runPaths.repoDir(LEGACY_REPO), built.tgz, owner.apiKey, ctx.env, {
      logFile: ctx.runPaths.installerLog(LEGACY_REPO),
    });
    ctx.state.legacyHook = { tgz: built.tgz, installerVersion: built.installerVersion, hookVersion: built.hookVersion };
    saveState();
    const detail = `${PREV_RELEASE_REF} installer ${built.installerVersion} / hook ${built.hookVersion} installed into ${LEGACY_REPO} for ${owner.email}`;
    ac('FR-OLD', 'P5b', true, detail);
    return detail;
  } catch (err) {
    const msg = shortError(err);
    const detail = /^infra:/.test(msg) ? msg : `infra: ${msg}`;
    ac('FR-OLD', 'P5b', false, `${PREV_RELEASE_REF} (installer ${PREV_INSTALLER_VERSION}, hook ${PREV_HOOK_VERSION}): ${detail}`);
    log(step, `legacy hook not installed, L1 will not run — ${err.message}`);
    return `legacy hook not installed (${detail})`;
  }
}

/** The repo whose installed plugin P5c runs on every Node LTS (any P5 repo ships the same build). */
const NODE_LTS_REPO = 'js-cli';

/**
 * FR-NODE: the plugin this run installed, on every current Node.js LTS line (plus the engines
 * floor), in Docker: hook algorithm tests and a hook smoke in a CommonJS, an ESM and a
 * package.json-less repo. Never stops the run; a failure is recorded as FR-NODE (P5c).
 */
async function p5cNodeLts() {
  const step = 'node-lts';
  const pluginDir = path.join(ctx.runPaths.repoDir(NODE_LTS_REPO), '.artisyn', 'marketplace', 'plugins', 'log-hub-hooks');
  try {
    if (!fs.existsSync(path.join(pluginDir, 'scripts', 'version.json'))) {
      throw new Error(`no installed plugin in ${NODE_LTS_REPO} (${pluginDir})`);
    }
    const hookVersion = JSON.parse(fs.readFileSync(path.join(pluginDir, 'scripts', 'version.json'), 'utf8')).version;
    const out = await runNodeLtsMatrix({
      pluginDir,
      gitRoot: ctx.runPaths.gitRoot,
      resultFile: path.join(ctx.runPaths.stateDir, 'node-lts.json'),
      log: logger(step),
    });
    const verdict = judgeNodeMatrix(out.rows);
    const nodes = out.rows.map((r) => r.node || r.tag).join(', ');
    const source = out.scheduleError ? `fallback tags, schedule.json unavailable: ${out.scheduleError}` : 'live lines from schedule.json';
    const detail = verdict.ok
      ? `hook ${hookVersion} on ${nodes} (${source}): algo tests + smoke in cjs / esm / no-package.json repos, ${verdict.cells} cells pass`
      : `hook ${hookVersion} on ${nodes} (${source}): ${verdict.problems.join('; ')}`;
    ac('FR-NODE', 'P5c', verdict.ok, detail);
    return verdict.ok ? `${verdict.cells} cells pass on ${nodes}` : `${verdict.problems.length} problem(s), see FR-NODE`;
  } catch (err) {
    const detail = `infra: ${shortError(err)}`;
    ac('FR-NODE', 'P5c', false, detail);
    log(step, `Node LTS matrix not run — ${err.message}`);
    return `not run (${detail})`;
  }
}

/** True when P5b installed the legacy hook, so L1 can run. */
function legacyHookReady() {
  return (ctx.acParts.get('FR-OLD') ?? []).some((p) => p.phase === 'P5b' && p.ok);
}

// ---- P6 teams ---------------------------------------------------------------------------------------

async function checkTeamsApi() {
  const problems = [];
  for (const [name, def] of Object.entries(TEAMS)) {
    const owner = USERS[def.owner];
    const member = USERS[def.member];
    const api = createApiClient(STAND_URL);
    await api.login(owner.email, owner.password);
    const teams = await api.getJson('/api/v1/teams');
    const team = Array.isArray(teams) ? teams.find((t) => t.name === name) : null;
    if (!team) {
      problems.push(`${name}: not in GET /api/v1/teams for ${owner.email}`);
      continue;
    }
    if (team.accessMode !== def.accessMode) problems.push(`${name}: accessMode ${team.accessMode}, expected ${def.accessMode}`);
    const members = await api.getJson(`/api/v1/teams/${team.id}/members`);
    const m = Array.isArray(members) ? members.find((x) => x.email === member.email) : null;
    if (!m) problems.push(`${name}: ${member.email} is not a member`);
    else {
      if (m.isOwner || m.isManager || m.isAdlcTrainer) {
        problems.push(`${name}: ${member.email} has unexpected flags owner=${m.isOwner} manager=${m.isManager} trainer=${m.isAdlcTrainer}`);
      }
      if (!m.disclosureAcknowledgedAt) problems.push(`${name}: ${member.email} has no disclosureAcknowledgedAt`);
    }
    const repos = await api.getJson(`/api/v1/teams/${team.id}/repositories`);
    const urls = (Array.isArray(repos) ? repos.map((r) => r.repoUrl) : []).sort();
    const want = def.repos.map((r) => STORED_URL(r)).sort();
    if (JSON.stringify(urls) !== JSON.stringify(want)) problems.push(`${name}: repos ${urls.join(', ') || 'none'}, expected ${want.join(', ')}`);
  }
  return problems;
}

async function p6Teams() {
  const step = 'teams';
  for (const [name, def] of Object.entries(TEAMS)) {
    const ownerPage = ctx.pages[def.owner].page;
    const memberPage = ctx.pages[def.member].page;
    const { teamId } = await createTeam(ownerPage, name);
    log(step, `${name}: created (#${teamId}) by ${def.owner}`);
    if (def.accessMode === 'transparent') {
      await setTransparent(ownerPage);
      log(step, `${name}: access mode set to transparent`);
    }
    await invite(ownerPage, USERS[def.member].email);
    log(step, `${name}: invited ${def.member}`);
    await acceptInvite(memberPage, name, { email: USERS[def.member].email });
    log(step, `${name}: ${def.member} accepted`);
    await openTeam(ownerPage, teamId, name);
    for (const repo of def.repos) {
      await linkRepo(ownerPage, REMOTE_URL(repo));
      log(step, `${name}: linked ${repo}`);
    }
    ctx.state.teams[name] = { id: teamId, owner: def.owner, member: def.member, accessMode: def.accessMode, repos: [...def.repos] };
    saveState();
  }
  const problems = await checkTeamsApi();
  ac('FR-7a', 'P6', problems.length === 0, problems.length ? problems.join('; ') : 'both teams have the expected mode, member and repos');
  // The onboarding/team contexts are no longer needed; visibility opens fresh ones.
  for (const { context } of Object.values(ctx.pages)) await context.close().catch(() => {});
  ctx.pages = {};
  if (problems.length) throw new Error(problems.join('; '));
  return `${Object.keys(TEAMS).length} teams`;
}

// ---- P7 smoke ---------------------------------------------------------------------------------------

async function p7Smoke() {
  const command = ['claude', '-p', '--model', MODELS.verify, '--output-format', 'json', '--strict-mcp-config'].join(' ');
  const res = await runAsync(command, [], {
    cwd: ctx.runPaths.verifyDir,
    env: ctx.env,
    input: 'Reply with OK',
    shell: true,
    timeoutMs: TIMEOUTS.smokeMs,
    stdoutFile: ctx.runPaths.smokeStdout,
    stderrFile: ctx.runPaths.smokeStderr,
  });
  if (res.timedOut) throw new Error(`smoke claude -p timed out after ${TIMEOUTS.smokeMs / 1000}s`);
  if (res.exitCode !== 0) throw new Error(`smoke claude -p exited with ${res.exitCode} (see ${ctx.runPaths.smokeStderr})`);
  let out = null;
  try {
    out = JSON.parse(fs.readFileSync(ctx.runPaths.smokeStdout, 'utf8'));
  } catch {
    throw new Error(`smoke claude -p printed no JSON (see ${ctx.runPaths.smokeStdout})`);
  }
  if (out.is_error) throw new Error(`smoke claude -p returned an error: ${String(out.result).slice(0, 300)}`);
  return `isolated claude -p answered "${String(out.result ?? '').trim().slice(0, 40)}"`;
}

// ---- P8 sessions ------------------------------------------------------------------------------------

function sessionRow(scenario, r, extra = {}) {
  return {
    id: scenario.id,
    title: scenario.title,
    repo: scenario.repo,
    owner: r?.owner ?? USERS[scenario.owner].email,
    model: r?.expected?.model ?? scenario.model,
    status: r?.status ?? 'fail: session error',
    attempts: r?.attempts ?? [],
    isolation: r?.isolation,
    error: r?.error ?? null,
    checks: scenario.verifyChecks,
    // Per-field verdict outcomes (pass|fail|skipped) for the report; absent until P9 verified it.
    fields: r?.verdict?.fields ?? null,
    ...extra,
  };
}

/** Runs one scenario (never throws), stores and records its result. */
async function runOneSession(scenario, step) {
  let r;
  try {
    const opts = { log: logger(step), mcpDbUrl: ctx.mcpDb?.url ?? null };
    if (scenario.useWorktree) {
      const wt = ctx.state.worktree;
      if (!wt?.dir) throw new Error(`no linked worktree for ${scenario.repo}: ${wt?.error ?? 'P5 did not prepare it'}`);
      opts.rootDir = wt.dir;
    }
    r = await runScenario(scenario, ctx.runPaths, ctx.env, opts);
  } catch (err) {
    r = { id: scenario.id, status: 'fail: session error', attempts: [], error: err.message, expected: null };
    log(step, `${scenario.id}: crashed — ${err.message}`);
  }
  ctx.results[scenario.id] = r;
  recordSession(ctx.report, sessionRow(scenario, r));
  saveReport();
  return r;
}

/**
 * FR-WT (Design Decision 21): the S11 session is in the worktree's ai_work_dir/hook.log and not in
 * the main checkout's. Runs right after S11, before any later main-checkout session could sweep
 * the worktree transcript.
 */
function checkWorktreeOverride(scenario, r) {
  const sid = r?.expected?.session_id ?? null;
  const wtDir = ctx.state.worktree?.dir ?? null;
  const mainDir = ctx.runPaths.repoDir(scenario.repo);
  if (!sid || !wtDir) {
    ac('FR-WT', 'P8', false, `${scenario.id}: ${!wtDir ? `no worktree (${ctx.state.worktree?.error ?? 'not prepared'})` : `no session id (${r?.status ?? 'did not run'})`}`);
    return;
  }
  const inWt = aiWorkDirHasSession(wtDir, sid);
  const inMain = aiWorkDirHasSession(mainDir, sid);
  ac(
    'FR-WT',
    'P8',
    inWt && !inMain,
    `${scenario.id} session ${sid}: ${inWt ? 'in' : 'NOT in'} the worktree ai_work_dir/hook.log, ${inMain ? 'ALSO in' : 'not in'} the main ${scenario.repo} hook.log`,
  );
}

async function p8Sessions() {
  const step = 'sessions';
  for (const scenario of SCENARIOS) {
    const r = await runOneSession(scenario, step);
    if (scenario.useWorktree) checkWorktreeOverride(scenario, r);
  }

  // L1: the legacy-hook session, only when P5b installed the previous-release hook.
  if (legacyHookReady()) {
    await runOneSession(LEGACY_SCENARIO, step);
  } else {
    const r = { id: LEGACY_SCENARIO.id, status: NOT_RUN_LEGACY, attempts: [], error: 'P5b did not install the legacy hook', expected: null };
    ctx.results[LEGACY_SCENARIO.id] = r;
    recordSession(ctx.report, sessionRow(LEGACY_SCENARIO, r));
    saveReport();
    log(step, `${LEGACY_SCENARIO.id}: not run — the legacy hook is not installed`);
  }

  // FR-8: fixed-format expected params, model/harness coverage and isolation — S1–S11 only, L1 is
  // judged through FR-OLD.
  const problems = [];
  const aliases = new Set();
  const covered = { subagent: false, skill: false, workflow: false, rule: false, mcp: false };
  for (const scenario of SCENARIOS) {
    const file = ctx.runPaths.expectedFile(scenario.id);
    let exp = null;
    try {
      exp = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      problems.push(`${scenario.id}: no expected.json`);
    }
    if (exp) {
      if (!exp.session_id) problems.push(`${scenario.id}: expected.json has no session_id`);
      for (const a of MODEL_ALIASES) if (String(exp.model ?? '').includes(a)) aliases.add(a);
      if (exp.subagents > 0) covered.subagent = true;
      if (exp.skills?.length) covered.skill = true;
      if (exp.workflows?.length) covered.workflow = true;
      if (exp.rules?.length) covered.rule = true;
      if (exp.mcp?.length) covered.mcp = true;
    }
    const iso = ctx.results[scenario.id]?.isolation;
    if (!iso || iso.status !== 'pass') problems.push(`${scenario.id}: isolation ${iso ? `${iso.status} — ${iso.detail}` : 'not checked'}`);
  }
  const missingAliases = MODEL_ALIASES.filter((a) => !aliases.has(a));
  if (missingAliases.length) problems.push(`models not covered: ${missingAliases.join(', ')}`);
  const missingKinds = Object.entries(covered).filter(([, v]) => !v).map(([k]) => k);
  if (missingKinds.length) problems.push(`harness kinds not exercised: ${missingKinds.join(', ')}`);
  ac(
    'FR-8',
    'P8',
    problems.length === 0,
    problems.length
      ? problems.join('; ')
      : `${SCENARIOS[0].id}–${SCENARIOS[SCENARIOS.length - 1].id}: ${SCENARIOS.length} expected.json files; models sonnet/haiku/opus; subagent, skill, workflow, rule and MCP exercised; isolation pass`,
  );
}

// ---- P9 ingestion + verification -------------------------------------------------------------------

function writeResult(id, r) {
  const { expected, ...result } = r;
  fs.writeFileSync(ctx.runPaths.resultFile(id), `${JSON.stringify(result, null, 2)}\n`);
}

async function p9Verify() {
  const step = 'verify';
  const apis = new Map();
  const apiFor = async (ownerKey) => {
    if (!apis.has(ownerKey)) {
      const api = createApiClient(STAND_URL);
      await api.login(USERS[ownerKey].email, USERS[ownerKey].password);
      apis.set(ownerKey, api);
    }
    return apis.get(ownerKey);
  };

  const verdictProblems = [];
  let reached = 0;
  for (const scenario of ALL_SCENARIOS) {
    const r = ctx.results[scenario.id];
    if (!r || !needsVerification(r) || !r.expected?.session_id) {
      log(step, `${scenario.id}: skipped (${r?.status ?? 'did not run'})`);
      continue;
    }
    const extra = {};
    try {
      const api = await apiFor(scenario.owner);
      log(step, `${scenario.id}: waiting for ingestion of ${r.expected.session_id}`);
      const { rid } = await api.waitForIngestion({
        rid: ctx.state.repos[scenario.repo]?.repoId ?? null,
        storedUrl: STORED_URL(scenario.repo),
        sid: r.expected.session_id,
        expectedSubagents: r.expected.subagents,
      });
      ctx.state.repos[scenario.repo].repoId = rid;
      saveState();
      reached++;
      // FR-5: the OTEL cost reaches the server after the transcript; a timeout only makes cost `skipped`.
      if (scenario.verifyChecks.includes('cost')) {
        const t = await api.waitForTelemetry({ rid, sid: r.expected.session_id });
        r.telemetryCost = t.telemetryCost;
        log(step, `${scenario.id}: telemetry cost ${t.timedOut ? `not reported in time (${t.last})` : `$${t.telemetryCost}`}`);
      }
      const v = await verifySession(scenario, r.expected, rid, scenario.owner, ctx.runPaths, ctx.env, {
        isolation: r.isolation,
        priorStatus: r.status,
        log: logger(step),
      });
      // verifySession already applies them; idempotent, kept here so the orchestrator owns the rule.
      if (v.verdict) applyScriptedJudgements(v.verdict, r.expected);
      r.status = v.status;
      r.verdict = v.verdict;
      if (v.error) r.error = v.error;
      extra.evidence = v.evidence;
      extra.mismatches = v.mismatches;
      if (v.status === VERIFY_STATUS.verifierError || !v.verdict) verdictProblems.push(`${scenario.id}: ${v.error ?? 'no verdict'}`);
    } catch (err) {
      if (err.code === 'NOT_INGESTED') {
        r.status = NOT_INGESTED;
        r.error = err.message;
      } else {
        reached++;
        r.status = VERIFY_STATUS.verifierError;
        r.error = err.message;
        verdictProblems.push(`${scenario.id}: ${err.message}`);
      }
      log(step, `${scenario.id}: ${r.status} — ${err.message}`);
    }
    writeResult(scenario.id, r);
    recordSession(ctx.report, sessionRow(scenario, r, extra));
    saveReport();
  }
  ac(
    'FR-9',
    'P9',
    verdictProblems.length === 0,
    verdictProblems.length ? verdictProblems.join('; ') : `${reached} verified session(s) have a valid verdict`,
  );

  // FR-13: the session recorded by the previous-release hook is ingested and verified.
  const l1 = ctx.results[LEGACY_SCENARIO.id];
  const l1Status = l1?.status ?? 'did not run';
  ac(
    'FR-OLD',
    'P9',
    l1Status === VERIFY_STATUS.pass,
    `${PREV_RELEASE_REF} (installer ${PREV_INSTALLER_VERSION}, hook ${PREV_HOOK_VERSION}): ${LEGACY_SCENARIO.id} ${l1Status}${l1?.error ? ` — ${shortError(l1.error)}` : ''}`,
  );
}

// ---- P9b file categories ----------------------------------------------------------------------------

async function p9bFileCategories() {
  const step = 'file-categories';
  if (!ctx.browser) ctx.browser = await launch();
  const r = ctx.results[FC_SCENARIO];
  const ownerKey = REPOS[FC_REPO];
  const sessionId = r?.expected?.session_id ?? null;
  // The expected stats come from the verified session's own main transcript (the attempt that
  // produced it), with the repo dir as the root its Read paths are made relative to.
  const attempt = (r?.attempts ?? []).find((a) => a && a.session_id === sessionId && a.transcript);
  const out = await runFileCategories({
    browser: ctx.browser,
    owner: { email: USERS[ownerKey].email, password: USERS[ownerKey].password },
    repoId: ctx.state.repos[FC_REPO]?.repoId ?? null,
    sessionId,
    transcriptFile: attempt?.transcript ?? null,
    repoRoots: [ctx.runPaths.repoDir(FC_REPO)],
    fcDir: ctx.runPaths.fcDir,
    log: logger(step),
  });
  recordCase(ctx.report, out.case);
  for (const a of out.ac) ac(a.id, 'P9b', a.ok, a.detail);
  log(step, `FC: ${out.case.status} — ${out.case.detail}`);
}

// ---- P10 visibility ---------------------------------------------------------------------------------

async function p10Visibility() {
  const step = 'visibility';
  if (!ctx.browser) ctx.browser = await launch();
  const sessions = ALL_SCENARIOS.map((s) => ctx.results[s.id]).filter(Boolean);
  try {
    const { rows, acCheck } = await runVisibility(ctx.browser, ctx.state, sessions, {
      visibilityDir: ctx.runPaths.visibilityDir,
      log: logger(step),
    });
    for (const row of rows) recordVisibility(ctx.report, row);
    ac('FR-7', 'P10', acCheck.status === 'pass', acCheck.detail);
  } catch (err) {
    log(step, `visibility crashed — ${err.message}`);
    for (const def of VISIBILITY_ROWS) {
      if (!ctx.report.visibility.some((v) => v.id === def.id)) {
        recordVisibility(ctx.report, { id: def.id, viewer: def.viewer, view: def.view, status: 'fail', detail: `not evaluated: ${err.message}` });
      }
    }
    ac('FR-7', 'P10', false, `owner visibility not evaluated: ${err.message}`);
  }
  const ids = new Set(ctx.report.visibility.map((v) => v.id));
  const missing = VISIBILITY_ROWS.map((r) => r.id).filter((id) => !ids.has(id));
  ac('FR-9b', 'P10', missing.length === 0, missing.length ? `rows missing: ${missing.join(', ')}` : `rows ${visibilityRange()} evaluated`);
}

// ---- P11 final AC checks ----------------------------------------------------------------------------

async function p11Final() {
  const after = await snapshotDevPorts();
  const cmp = compareDevPorts(ctx.devPortsBefore, after);
  ac(
    'FR-4',
    'P11',
    cmp.equal,
    cmp.equal
      ? `dev ports unchanged ${JSON.stringify(after)}`
      : `dev ports changed: ${cmp.diff.map((d) => `${d.port} ${d.before}→${d.after}`).join(', ')}`,
  );

  const now = gitStatusPaths(ctx.runPaths.gitRoot);
  if (now === null || ctx.gitStatusBefore === null) {
    ac('FR-3', 'P11', false, 'git status --porcelain failed');
  } else {
    const before = new Set(ctx.gitStatusBefore);
    const added = now.filter((p) => !before.has(p));
    ac('FR-3', 'P11', added.length === 0, added.length ? `new paths in the git root: ${added.join(', ')}` : 'no new path in the git root');
  }

  // FR-10 is checked on the index.md written right now, before the final rewrite.
  saveReport();
  let md = '';
  try {
    md = fs.readFileSync(ctx.runPaths.indexMd, 'utf8');
  } catch {
    md = '';
  }
  const ids = [...completenessIds(), ...NEW_AC_IDS];
  const absent = ids.filter((id) => !md.includes(id));
  ac(
    'FR-10',
    'P11',
    md !== '' && absent.length === 0,
    md === ''
      ? 'index.md not written'
      : absent.length
        ? `index.md lacks ${absent.join(', ')}`
        : `index.md lists ${SCENARIOS[0].id}–${SCENARIOS[SCENARIOS.length - 1].id}, ${LEGACY_SCENARIO.id}, FC, ${visibilityRange()} and ${NEW_AC_IDS.join(', ')}`,
  );
}

/** AC rows added by this run's new checks; each must appear in index.md (Design Decision 22). */
const NEW_AC_IDS = Object.freeze(['FR-LC', 'FR-UP', 'FR-OLD', 'FR-WT', 'FR-NODE']);

/** Sessions, the FC case and the V rows that index.md must name (FR-10). */
function completenessIds() {
  return [...ALL_SCENARIOS.map((s) => s.id), 'FC', ...VISIBILITY_ROWS.map((r) => r.id)];
}

/** "V1–V8": the first and last visibility row ids. */
function visibilityRange() {
  return `${VISIBILITY_ROWS[0].id}–${VISIBILITY_ROWS[VISIBILITY_ROWS.length - 1].id}`;
}

// ---- P12 teardown -------------------------------------------------------------------------------------

/** Synchronous so it can also run from a signal handler. Never throws. */
function teardown() {
  if (ctx.tornDown) return;
  ctx.tornDown = true;
  const step = 'teardown';
  if (!ctx.report) return;
  ctx.phasesRun.add('P12');
  const rp = ctx.runPaths;
  try {
    if (rp) {
      const killed = killOtelReceivers(rp.runDir);
      if (killed.length) log(step, `killed otel-receiver pid(s) ${killed.join(', ')}`);
    }
    if (!rp || !fs.existsSync(rp.composeFile)) {
      recordInfra(ctx.report, step, 'pass', null, 'nothing to tear down (stand was never started)');
      ac('FR-11', 'P12', true, 'no stand was started');
    } else if (ctx.opts.keep) {
      recordInfra(ctx.report, step, 'pass', null, 'kept');
      ac('FR-11', 'P12', true, `kept (--keep): ${STAND_URL}; stop with ${downCommand(rp)}`);
      log(step, `stand kept at ${STAND_URL}; stop it with: ${downCommand(rp)}`);
    } else {
      saveAppLogs(rp);
      down(rp);
      assertDown(rp);
      recordInfra(ctx.report, step, 'pass', null, `compose project ${rp.composeProject} is down`);
      ac('FR-11', 'P12', true, `compose project ${rp.composeProject} has no containers`);
      log(step, `compose project ${rp.composeProject} is down`);
    }
  } catch (err) {
    recordInfra(ctx.report, step, 'fail', shortError(err));
    ac('FR-11', 'P12', false, shortError(err));
    log(step, `FAILED — ${err.message}`);
  }
  finalizeAcRows();
  ctx.report.finishedAt = new Date().toISOString();
  saveReport();
}

// ---- main -----------------------------------------------------------------------------------------

const INFRA_PHASES = [
  ['P0', 'preflight', p0Preflight],
  ['P1', 'build', p1Build],
  ['P2', 'stand', p2Stand],
  ['P3', 'repos', p3Repos],
  ['P4', 'onboarding', p4Onboarding],
  ['P5', 'hooks', p5Hooks],
  ['P5b', 'legacy-hook', p5bLegacyHook],
  ['P5c', 'node-lts', p5cNodeLts],
  ['P6', 'teams', p6Teams],
  ['P7', 'smoke', p7Smoke],
];

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  ctx.opts = opts;
  ctx.report = createReport({ keep: opts.keep });
  ctx.state = { stamp: null, standUrl: STAND_URL, composeProject: null, imageTag: null, users: {}, repos: {}, teams: {} };
  ctx.results = {};

  const onSignal = (sig) => {
    log('run', `received ${sig}, tearing down`);
    recordInfra(ctx.report, 'interrupted', 'fail', `received ${sig}`);
    teardown();
    process.exit(2);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    let infraOk = true;
    for (const [id, step, fn] of INFRA_PHASES) {
      try {
        await phase(id, step, async () => {
          const detail = await fn();
          if (id === 'P0') {
            Object.assign(ctx.state, {
              stamp: ctx.runPaths.stamp,
              composeProject: ctx.runPaths.composeProject,
              imageTag: ctx.runPaths.imageRef,
            });
          }
          return detail;
        });
      } catch (err) {
        recordInfra(ctx.report, step, 'fail', shortError(err));
        log(step, `FAILED — ${err.stack || err.message}`);
        log('run', 'infra failure: skipping sessions, verification and visibility');
        saveReport();
        infraOk = false;
        break;
      }
    }
    if (infraOk) {
      await phase('P8', 'sessions', p8Sessions);
      await phase('P9', 'verify', p9Verify);
      await phase('P9b', 'file-categories', p9bFileCategories);
      await phase('P10', 'visibility', p10Visibility);
      await phase('P11', 'final', p11Final);
    }
  } catch (err) {
    // Only an orchestrator bug reaches here: P8–P11 handle their own per-case failures.
    recordInfra(ctx.report, 'orchestrator', 'fail', shortError(err));
    log('run', `orchestrator error — ${err.stack || err.message}`);
  } finally {
    if (ctx.browser) await ctx.browser.close().catch(() => {});
    teardown();
  }

  const code = exitCodeFor(ctx.report);
  log('run', `overall ${ctx.report.overall} — exit ${code}`);
  if (ctx.runPaths) {
    log('run', `report: ${ctx.runPaths.indexHtml} (also index.md)`);
    log('run', `image kept: docker image rm ${ctx.runPaths.imageRef}`);
  }
  return code;
}

// Run only when executed directly, never on import (unit tests may import parseArgs).
const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err.stack || err.message}\n`);
      process.exit(2);
    },
  );
}
