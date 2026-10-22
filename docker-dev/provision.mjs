#!/usr/bin/env node
// provision.mjs — in-container hook provisioning of a log-hub dev sandbox (DD-15 of
// docs/tasks/todo/2026-10-15-claude-dev-container/impl-plan.md, FR-C3).
//
//   node /opt/log-hub-dev/provision.mjs --static   run once by the entrypoint (as dev)
//   node /opt/log-hub-dev/provision.mjs --loop     run by `devctl start provision`
//
// Both modes write only git-ignored files of the worktree, in the installer's formats, and keep
// every key they do not own:
//   - `.artisyn/config/otel-port.json`       {port, allocatedAt}
//   - `.claude/settings.local.json`          the OTEL `env` keys
//   - `.artisyn/config/log-hub.local.json`   apiKey
// Tracked files (`.claude/settings.json`, `.artisyn/config/log-hub.json`) are only read.
//
// Env: SANDBOX_WORKTREE (container worktree path), SANDBOX_NAME, SANDBOX_HOST_EMAIL.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER = 'http://127.0.0.1:3000';
const LOOP_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const PROVISIONED_MARKER = '/run/dev/provisioned';

const worktree = process.env.SANDBOX_WORKTREE;
if (!worktree) {
  console.error('provision: SANDBOX_WORKTREE is not set');
  process.exit(2);
}
const configDir = path.join(worktree, '.artisyn', 'config');
const logHubJsonPath = path.join(configDir, 'log-hub.json');
const logHubLocalPath = path.join(configDir, 'log-hub.local.json');
const otelPortPath = path.join(configDir, 'otel-port.json');
const settingsLocalPath = path.join(worktree, '.claude', 'settings.local.json');

function log(msg) {
  console.log(`[provision ${new Date().toISOString()}] ${msg}`);
}

// A JSON object file, or {} when it is missing. Invalid JSON throws: overwriting it would drop
// keys we do not own.
function readJsonObject(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  if (!text.trim()) return {};
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
  return v;
}

// Atomic write (tmp file + rename), in the installer's format (2-space JSON + newline).
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// --- --static ---------------------------------------------------------------------------------

async function runStatic() {
  const port = Number(readJsonObject(logHubJsonPath).otelReceiverPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${logHubJsonPath} has no valid otelReceiverPort`);
  }

  // Each container has its own loopback, so the tracked port is used as is — no allocation.
  const existingPort = readJsonObject(otelPortPath);
  if (existingPort.port !== port || typeof existingPort.allocatedAt !== 'string') {
    writeJson(otelPortPath, { ...existingPort, port, allocatedAt: new Date().toISOString() });
    log(`wrote ${otelPortPath} (port ${port})`);
  } else {
    log(`${otelPortPath} already has port ${port}`);
  }

  // The worktree's own installer source, through Node's type stripping (otel-env.ts uses erasable
  // syntax only), so the env keys always match the installer of this branch.
  const otelEnvUrl = pathToFileURL(path.join(worktree, 'artisyn-hooks-installer', 'src', 'otel-env.ts')).href;
  const { OTEL_ENV_KEYS } = await import(otelEnvUrl);
  const settings = readJsonObject(settingsLocalPath);
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  writeJson(settingsLocalPath, { ...settings, env: { ...env, ...OTEL_ENV_KEYS(port) } });
  log(`merged the OTEL env keys into ${settingsLocalPath}`);
}

// --- --loop -----------------------------------------------------------------------------------

async function request(method, urlPath, { body, headers = {} } = {}) {
  return fetch(SERVER + urlPath, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function touchMarker() {
  fs.writeFileSync(PROVISIONED_MARKER, new Date().toISOString() + '\n');
}

async function createKey(cookie, name) {
  return request('POST', '/api/v1/api-keys', { body: { name }, headers: { cookie } });
}

// `POST /auth/identify` as `email`; returns the session cookie, or a string with the failure.
async function identify(email) {
  const res = await request('POST', '/api/v1/auth/identify', { body: { email } });
  if (!res.ok) return { error: `identify as ${email} failed (${res.status}: ${(await res.text()).slice(0, 200)})` };
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return cookie ? { cookie } : { error: `identify as ${email} returned no session cookie` };
}

// The legacy e2e suite (tests/e2e/helpers/credentials.ts) logs in as this user and needs it to be
// an admin. On a fresh sandbox DB the first identified user — the developer, above — is the only
// admin, so the developer promotes it once (PATCH /api/v1/users/:id/role). Best effort: a failure
// is logged and retried on the next round, it never blocks provisioning.
const E2E_ADMIN_EMAIL = 'muaddib@arrakis.test';
const E2E_ADMIN_MARKER = '/run/dev/e2e-admin';

async function ensureE2eAdmin(devCookie) {
  if (fs.existsSync(E2E_ADMIN_MARKER)) return null;
  const e2e = await identify(E2E_ADMIN_EMAIL);
  if (e2e.error) return `e2e admin: ${e2e.error}`;
  const me = await request('GET', '/api/v1/auth/me', { headers: { cookie: e2e.cookie } });
  if (!me.ok) return `e2e admin: GET /auth/me failed (${me.status})`;
  const user = await me.json();
  const profile = user?.user ?? user;
  if (profile?.role === 'admin') {
    fs.writeFileSync(E2E_ADMIN_MARKER, new Date().toISOString() + '\n');
    return `e2e admin: ${E2E_ADMIN_EMAIL} is already an admin`;
  }
  if (!Number.isInteger(profile?.id)) return 'e2e admin: GET /auth/me returned no user id';
  const res = await request('PATCH', `/api/v1/users/${profile.id}/role`, {
    body: { role: 'admin' },
    headers: { cookie: devCookie },
  });
  if (!res.ok) return `e2e admin: promoting ${E2E_ADMIN_EMAIL} failed (${res.status}: ${(await res.text()).slice(0, 200)})`;
  fs.writeFileSync(E2E_ADMIN_MARKER, new Date().toISOString() + '\n');
  return `e2e admin: promoted ${E2E_ADMIN_EMAIL} to admin`;
}

// One provisioning round; returns the line to log.
async function round() {
  let health;
  try {
    health = await request('GET', '/api/v1/auth/config');
  } catch (e) {
    return `server not reachable (${e.cause?.code ?? e.name}); skipped`;
  }
  if (health.status !== 200) return `server not healthy (GET /api/v1/auth/config ${health.status}); skipped`;

  const email = (process.env.SANDBOX_HOST_EMAIL || '').trim();
  const local = readJsonObject(logHubLocalPath);
  if (typeof local.apiKey === 'string' && local.apiKey) {
    const probe = await request('POST', '/api/v1/log-echo', { body: {}, headers: { 'X-API-Key': local.apiKey } });
    if (probe.ok) {
      touchMarker();
      if (email && !fs.existsSync(E2E_ADMIN_MARKER)) {
        const dev = await identify(email);
        const note = dev.error ? `e2e admin: ${dev.error}` : await ensureE2eAdmin(dev.cookie);
        if (note) log(note);
      }
      return 'existing apiKey accepted; provisioned';
    }
    log(`existing apiKey rejected (log-echo ${probe.status}); creating a new one`);
  }

  if (!email) return 'SANDBOX_HOST_EMAIL is not set; cannot identify; skipped';
  const ident = await identify(email);
  if (ident.error) return `${ident.error}; skipped`;
  const { cookie } = ident;

  const baseName = `sandbox-${process.env.SANDBOX_NAME || 'dev'}`;
  let created = await createKey(cookie, baseName);
  // The name is taken when the key file was lost but the DB kept the old key.
  if (created.status === 409) created = await createKey(cookie, `${baseName}-${Date.now()}`);
  if (!created.ok) return `creating an API key failed (${created.status}: ${(await created.text()).slice(0, 200)}); skipped`;
  const { key } = await created.json();
  if (typeof key !== 'string' || !key) return 'API key response has no key; skipped';

  writeJson(logHubLocalPath, { ...readJsonObject(logHubLocalPath), apiKey: key });
  touchMarker();
  const note = await ensureE2eAdmin(cookie);
  if (note) log(note);
  return `identified as ${email}, created an API key, wrote ${logHubLocalPath}; provisioned`;
}

async function runLoop() {
  log(`loop started (every ${LOOP_INTERVAL_MS / 1000}s, server ${SERVER})`);
  for (;;) {
    try {
      log(await round());
    } catch (e) {
      log(`round failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
  }
}

const mode = process.argv[2];
if (process.argv.length !== 3 || (mode !== '--static' && mode !== '--loop')) {
  console.error('usage: provision.mjs --static | --loop');
  process.exit(2);
}
try {
  if (mode === '--static') await runStatic();
  else await runLoop();
} catch (e) {
  console.error(`provision ${mode}: ${e.message}`);
  process.exit(1);
}
