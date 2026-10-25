// Constants and per-run paths for the big pre-prod e2e test.
// Every other module reads its fixed values from here so they are stated exactly once.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// <repo>/.claude/skills/big-prod-e2e-test/scripts/lib → <repo>
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..', '..');
export const SKILL_DIR = path.resolve(here, '..', '..');
export const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
export const FIXTURES_DIR = path.join(SKILL_DIR, 'fixtures');
export const PROMPTS_DIR = path.join(SCRIPTS_DIR, 'prompts');

// Run identity: the UTC moment the run started, `YYYYMMDD-HHMMSS` — 15 characters,
// lexicographically sortable, safe in file, image-tag and compose-project names.
export const RUN_STAMP_RE = /^\d{8}-\d{6}$/;
export function runStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export const APP_PORT = 3001;
export const DB_PORT = 5433;
export const STAND_HOST = '127.0.0.1';
export const STAND_URL = `http://localhost:${APP_PORT}`;
export const DEV_PORTS = Object.freeze([3000, 5432, 5173]);

export const IMAGE_REPO = 'artisyn-log-hub';
export const COMPOSE_PROJECT_PREFIX = 'log-hub-big-test-';
export const POSTGRES_IMAGE = 'postgres:18.2-alpine';
export const RUN_DIR_PREFIX = 'log_hub_big_test-';

export const IMAGE_TAG = (stamp) => `big-test-${stamp}`;
export const IMAGE_REF = (stamp) => `${IMAGE_REPO}:${IMAGE_TAG(stamp)}`;
export const COMPOSE_PROJECT = (stamp) => `${COMPOSE_PROJECT_PREFIX}${stamp}`;

export const USERS = Object.freeze({
  admin: Object.freeze({ email: 'big-test-admin@example.com', password: 'BigTest!2026-Admin-Pass', role: 'admin' }),
  U1: Object.freeze({ email: 'big-test-u1@example.com', password: 'BigTest!2026-U1-Pass', role: 'user' }),
  U2: Object.freeze({ email: 'big-test-u2@example.com', password: 'BigTest!2026-U2-Pass', role: 'user' }),
  U3: Object.freeze({ email: 'big-test-u3@example.com', password: 'BigTest!2026-U3-Pass', role: 'user' }),
});

// Onboarding order: admin first (the first signup becomes admin), then U1..U3.
export const USER_ORDER = Object.freeze(['admin', 'U1', 'U2', 'U3']);

// repo name → owner key in USERS
export const REPOS = Object.freeze({
  'node-service': 'U1',
  'ts-webapp': 'U1',
  'java-lib': 'U1',
  'js-cli': 'U2',
  'dotnet-api': 'U3',
});
export const REPO_NAMES = Object.freeze(Object.keys(REPOS));

export const REMOTE_URL = (repo) => `https://example.test/big-test/${repo}.git`;
// What the server stores in repoUrl after normalizeRepoUrl strips `.git`.
export const STORED_URL = (repo) => `https://example.test/big-test/${repo}`;

export const TEAMS = Object.freeze({
  'T-restricted': Object.freeze({
    owner: 'U1',
    member: 'U2',
    accessMode: 'restricted',
    repos: Object.freeze(['node-service', 'js-cli']),
  }),
  'T-transparent': Object.freeze({
    owner: 'U2',
    member: 'U3',
    accessMode: 'transparent',
    repos: Object.freeze(['js-cli', 'dotnet-api']),
  }),
});

const MIN = 60 * 1000;
export const TIMEOUTS = Object.freeze({
  buildMs: 30 * MIN,
  standReadyMs: 3 * MIN,
  installerMs: 5 * MIN,
  sessionMs: 15 * MIN,
  verifierMs: 10 * MIN,
  smokeMs: 2 * MIN,
});

export const MAX_SESSION_ATTEMPTS = 3;

// Per-role models for the skill's own Claude calls, editable without touching code (models.json).
export const MODELS_FILE = path.join(SKILL_DIR, 'models.json');
export const MODEL_ROLES = Object.freeze(['analysis', 'verify']);

export function loadModels(file = MODELS_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const models = {};
  for (const role of MODEL_ROLES) {
    const value = raw[role];
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9.\-[\]]*$/i.test(value)) {
      throw new Error(`${file}: "${role}" must be a model alias or id, got ${JSON.stringify(value)}`);
    }
    models[role] = value;
  }
  return Object.freeze(models);
}

export const MODELS = loadModels();
export const VERIFIER_MODEL = MODELS.verify;
export const PLAYWRIGHT_MCP_PKG = '@playwright/mcp@latest';
export const READY_POLL_MS = 2000;
export const INGEST_POLL_MS = 5000;
export const INGEST_TIMEOUT_MS = 300000;
export const RESTAMP_WAIT_MS = 1000;
export const PROMPT_PREFIX_LEN = 40;

export const GLOBAL_HARNESS_DIRS = Object.freeze([
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.claude', 'commands'),
]);

// The installer names each repo's marketplace `artisyn-<8 hex>`; `artisyn` is the legacy shared name.
export const ALLOWED_PLUGIN_SOURCE_RE = /^log-hub-hooks@artisyn(-[0-9a-f]{8})?$/;
export const BUILTIN_PLUGIN_SOURCE_RE = /@builtin$/;

export const SESSION_EXTRA_ARGS = Object.freeze(['--strict-mcp-config']);

// S7: an MCP server talking to a dedicated test database on the developer's local Postgres.
// The database is created additively and never dropped; the admin URL comes from
// env BIG_TEST_MCP_PG_URL, else from the repo's own server/.env DATABASE_URL.
export const MCP_DB_NAME = 'big_test_mcp';
export const MCP_DB_URL_ENV = 'BIG_TEST_MCP_PG_URL';
export const MCP_SERVER_NAME = 'big-test-pg';
export const MCP_SERVER_PKG = '@modelcontextprotocol/server-postgres';
export const MCP_SEED_ROWS = Object.freeze([
  Object.freeze({ id: 1, name: 'Widget', price: '9.99' }),
  Object.freeze({ id: 2, name: 'Gadget', price: '24.50' }),
  Object.freeze({ id: 3, name: 'Doohickey', price: '3.75' }),
]);
export const MCP_WARMUP_MS = 3 * 60 * 1000;

// File categories (phase P9b): set through the UI on FC_REPO by its owner, then checked against
// FC_SCENARIO's per-category read stats. Patterns are JS regexps on repo-relative paths.
export const FC_REPO = 'dotnet-api';
export const FC_SCENARIO = 'S7';
export const FC_CATEGORIES = Object.freeze([
  Object.freeze({ name: 'sources', patterns: Object.freeze(['^src/']) }),
  Object.freeze({ name: 'tests', patterns: Object.freeze(['^tests/']) }),
]);
export const FC_STATS_TIMEOUT_MS = 60000;
export const MODEL_DATE_SUFFIX_RE = /-\d{8}$/;
// Login steps of every verifier run; per-check calls and screenshots are added on top.
export const VERIFIER_TOOL_BUDGET_BASE = 4;
// How long to wait for a session's OTEL telemetry cost to reach the server before cost is skipped.
export const TELEMETRY_WAIT_MS = 120000;

// Legacy hook (FR-13): the previous release, built from git and installed into LEGACY_REPO.
export const PREV_RELEASE_REF = '25146c8';
export const PREV_INSTALLER_VERSION = '1.0.69';
export const PREV_HOOK_VERSION = '2.21.1';
export const LEGACY_REPO = 'legacy-hook';
export const LEGACY_OWNER = 'U3';

// Upgrade (FR-12): the pre-split log-hub.json committed into a repo before the current installer runs.
export const LEGACY_LOG_HUB_JSON = Object.freeze({ serverUrl: STAND_URL, otelReceiverPort: 4318 });

// FR-4a: a CLAUDE.md written into the run-dir copy of CLAUDE_MD_REPO (never into the fixture).
export const CLAUDE_MD_REPO = 'js-cli';
export const GENERATED_CLAUDE_MD =
  '# js-cli\n\nSmall Node.js CLI used by the Log Hub pre-prod test. Source lives in lib/, the entry point in bin/.\n';
export const OTEL_RECEIVER_MARKER = 'otel-receiver.js';
export const ENV_SCRUB_RE = /^(CLAUDE|ANTHROPIC_|OTEL_|ARTISYN_)/;
export const ENV_PASSTHROUGH = Object.freeze(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

/** Absolute git top-level of this repo (normalised to the platform's separators). */
export function gitRoot(cwd = REPO_ROOT) {
  const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return path.resolve(out.trim());
}

/** Every path of one run. `root` defaults to the git root. */
export function resolveRun(stamp, root = gitRoot()) {
  if (!RUN_STAMP_RE.test(stamp)) {
    throw new Error(`run stamp must match YYYYMMDD-HHMMSS, got "${stamp}"`);
  }
  const runDir = path.resolve(root, '..', `${RUN_DIR_PREFIX}${stamp}`);
  const logHubDir = path.join(runDir, '_log_hub');
  const stateDir = path.join(runDir, '_state');
  const sessionsDir = path.join(stateDir, 'sessions');
  const verifyDir = path.join(runDir, '_verify');
  const reportDir = path.join(runDir, '_report');

  return {
    stamp,
    gitRoot: path.resolve(root),
    runDir,
    composeProject: COMPOSE_PROJECT(stamp),
    imageTag: IMAGE_TAG(stamp),
    imageRef: IMAGE_REF(stamp),

    logHubDir,
    composeFile: path.join(logHubDir, 'docker-compose.yml'),
    envFile: path.join(logHubDir, '.env'),
    dataDir: path.join(logHubDir, 'data'),

    claudeConfigDir: path.join(runDir, '_claude-config'),

    stateDir,
    runStateFile: path.join(stateDir, 'run-state.json'),
    sessionsDir,
    smokeStdout: path.join(stateDir, 'smoke.stdout.json'),
    smokeStderr: path.join(stateDir, 'smoke.stderr.log'),
    standUpLog: path.join(stateDir, 'stand-up.log'),
    appContainerLog: path.join(stateDir, 'app-container.log'),
    installerLog: (repo) => path.join(stateDir, `installer-${repo}.log`),
    expectedFile: (id) => path.join(sessionsDir, `${id}.expected.json`),
    resultFile: (id) => path.join(sessionsDir, `${id}.result.json`),
    attemptStream: (id, n) => path.join(sessionsDir, `${id}.attempt-${n}.stream.jsonl`),
    attemptStderr: (id, n) => path.join(sessionsDir, `${id}.attempt-${n}.stderr.log`),
    verifyStdout: (id) => path.join(sessionsDir, `${id}.verify.stdout.json`),
    verifyStderr: (id) => path.join(sessionsDir, `${id}.verify.stderr.log`),

    verifyDir,
    mcpConfig: (id) => path.join(verifyDir, `mcp-${id}.json`),
    sessionMcpConfig: (id) => path.join(verifyDir, `mcp-session-${id}.json`),
    sessionSettings: (id) => path.join(verifyDir, `settings-${id}.json`),
    fcDir: path.join(reportDir, 'FC'),

    reportDir,
    reportJson: path.join(reportDir, 'report.json'),
    indexMd: path.join(reportDir, 'index.md'),
    indexHtml: path.join(reportDir, 'index.html'),
    reportSessionDir: (id) => path.join(reportDir, id),
    verdictFile: (id) => path.join(reportDir, id, 'verdict.json'),
    visibilityDir: path.join(reportDir, 'visibility'),

    repoDir: (repo) => path.join(runDir, repo),
    prevSrcDir: path.join(runDir, '_prev-src'),
    prevHookDir: path.join(runDir, '_prev-hook'),
    worktreeDir: path.join(runDir, 'ts-webapp-wt'),
  };
}
