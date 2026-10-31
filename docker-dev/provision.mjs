#!/usr/bin/env node
// provision.mjs — in-container hook provisioning of a log-hub dev sandbox (DD-15 of
// docs/tasks/todo/2026-10-15-claude-dev-container/impl-plan.md, FR-C3).
//
//   node /opt/log-hub-dev/provision.mjs --static   run once by the entrypoint (as dev)
//   node /opt/log-hub-dev/provision.mjs --loop     run by `devctl start provision`
//
// Both modes write only git-ignored files of the worktree, in the installer's formats, and keep
// every key they do not own:
//   - `.claude/settings.local.json`          the OTEL `env` keys (+ `OTEL_RESOURCE_ATTRIBUTES`)
//   - `.artisyn/config/log-hub.local.json`   serverUrl, otelReceiverPort (--static), apiKey (--loop)
// `--static` also writes the per-OS-user OTEL state the shared receiver needs (hook 2.30.0+),
// inside the container only:
//   - `~/.artisyn/otel/port.json`            {version:1, port, allocatedAt} — `SANDBOX_OTEL_PORT`
//   - `~/.artisyn/otel/token`                the receiver's shared secret, created when missing
//   - `$CLAUDE_CONFIG_DIR/settings.json`     the user-scope OTEL `env` keys (Claude Code 2.1.282+
//                                            reads telemetry keys only there)
// and deletes a leftover pre-2.30.0 `.artisyn/config/otel-port.json`.
// Tracked files (`.claude/settings.json`, `.artisyn/config/log-hub.json`) are only read.
//
// Env: SANDBOX_WORKTREE (container worktree path), SANDBOX_NAME, SANDBOX_HOST_EMAIL,
// CLAUDE_CONFIG_DIR (the shared Claude profile).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER = 'http://127.0.0.1:3000';
// The hook's own config: the sandbox client URL and the hook's `OTEL_FALLBACK_PORT`.
const SANDBOX_SERVER_URL = 'http://localhost:5173';
// Fixed on purpose: each container has its own loopback, and every sandbox shares one Claude
// profile (`CLAUDE_CONFIG_DIR`), so the user-scope endpoints must name the same port everywhere.
const SANDBOX_OTEL_PORT = 25317;
// A loopback OTLP endpoint — the only kind provisioning treats as its own (an Artisyn receiver).
const LOOPBACK_OTLP_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/v1\/(?:logs|metrics|traces)$/;
const LOOP_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const PROVISIONED_MARKER = '/run/dev/provisioned';

const worktree = process.env.SANDBOX_WORKTREE;
if (!worktree) {
  console.error('provision: SANDBOX_WORKTREE is not set');
  process.exit(2);
}
const configDir = path.join(worktree, '.artisyn', 'config');
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

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Imports one of the worktree's own installer modules through Node's type stripping (they use
// erasable syntax only), so the formats always match the installer of this branch. `null` when the
// branch predates the module (a worktree made before hook 2.30.0).
async function importInstallerModule(name) {
  const file = path.join(worktree, 'artisyn-hooks-installer', 'src', name);
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

// Claude Code's user-level settings file: `$CLAUDE_CONFIG_DIR/settings.json` when set (always, in
// a sandbox: the shared profile), else `~/.claude/settings.json`.
function userSettingsPath() {
  const custom = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  return path.join(custom || path.join(os.homedir(), '.claude'), 'settings.json');
}

// The per-OS-user shared-receiver state (DD-4 of
// docs/tasks/todo/2026-10-30-otel-shared-receiver/impl-plan.md): `port.json` and `token` in the
// container's own `~/.artisyn/otel/` (the container home is not mounted from the host). Returns
// false when this branch has no shared receiver (no `user-state.ts`).
async function writeSharedReceiverState(port, userState) {
  if (!userState) {
    log('this worktree\'s installer has no shared OTEL receiver (pre-2.30.0 branch); skipped ~/.artisyn/otel');
    return false;
  }
  const existing = userState.readPortFile();
  if (existing?.port !== port) {
    userState.writePortFile(port);
    log(`wrote ${userState.stateFilePath('port')} (port ${port})`);
  } else {
    log(`${userState.stateFilePath('port')} already has port ${port}`);
  }
  if (userState.readOrCreateToken() === null) {
    log(`could not create or read ${userState.stateFilePath('token')} — the shared receiver will not start`);
  }
  return true;
}

// Merges the user-scope OTEL keys into the shared profile's settings.json. Every sandbox writes the
// same values (fixed port), so this is idempotent across sandboxes. A collector the developer set
// there themselves (a non-loopback endpoint) is left alone, and so is a file that does not parse
// or whose `env` is not an object — logged, never fatal. Returns the user `env` as it now stands.
function writeUserOtelEnv(desired) {
  const file = userSettingsPath();
  let settings;
  try {
    settings = readJsonObject(file);
  } catch (e) {
    log(`${file} is not valid JSON (${e.message}); left untouched, OTEL keys not written to the user scope`);
    return {};
  }
  if (settings.env !== undefined && !isPlainObject(settings.env)) {
    log(`${file} has a non-object "env"; left untouched, OTEL keys not written to the user scope`);
    return {};
  }
  const env = settings.env ?? {};
  const foreign = Object.keys(desired).filter(
    (k) => k.endsWith('_ENDPOINT') && typeof env[k] === 'string' && env[k] && !LOOPBACK_OTLP_ENDPOINT_RE.test(env[k]),
  );
  if (foreign.length > 0) {
    log(`${file} points ${foreign.join(', ')} at a collector of your own; left untouched`);
    return env;
  }
  const next = { ...env, ...desired };
  if (Object.keys(desired).every((k) => env[k] === desired[k])) {
    log(`${file} already has the OTEL env keys`);
    return env;
  }
  writeJson(file, { ...settings, env: next });
  log(`merged the OTEL env keys into ${file}`);
  return next;
}

async function runStatic() {
  // Each container has its own loopback, so a fixed port is fine — no allocation.
  const port = SANDBOX_OTEL_PORT;

  // The pre-2.30.0 per-project port store; the installer deletes it too.
  if (fs.existsSync(otelPortPath)) {
    fs.unlinkSync(otelPortPath);
    log(`deleted the legacy ${otelPortPath}`);
  }

  // `serverUrl` resolves to the sandbox client inside the container (its Vite proxy forwards /api).
  // `otelReceiverPort` stays: hooks before 2.30.0 (and the 2.30.0 fallback without `port.json`) read it.
  writeJson(logHubLocalPath, { ...readJsonObject(logHubLocalPath), serverUrl: SANDBOX_SERVER_URL, otelReceiverPort: port });
  log(`wrote serverUrl ${SANDBOX_SERVER_URL} and otelReceiverPort ${port} into ${logHubLocalPath}`);

  const otelEnv = await importInstallerModule('otel-env.ts');
  if (!otelEnv) throw new Error('the worktree has no artisyn-hooks-installer/src/otel-env.ts');
  const userState = await importInstallerModule('user-state.ts');
  const shared = await writeSharedReceiverState(port, userState);
  const userEnv = shared ? writeUserOtelEnv(otelEnv.OTEL_ENV_KEYS(port)) : {};

  // The local mirror, read by Claude Code before 2.1.282. With the shared receiver it also carries
  // the `artisyn.repo` resource attribute (the user value carried over, as the installer does).
  const settings = readJsonObject(settingsLocalPath);
  const env = isPlainObject(settings.env) ? settings.env : {};
  const mirror = { ...env, ...otelEnv.OTEL_ENV_KEYS(port) };
  if (shared && typeof otelEnv.buildResourceAttributes === 'function') {
    const key = otelEnv.OTEL_RESOURCE_ATTRIBUTES_KEY;
    mirror[key] = otelEnv.buildResourceAttributes(userEnv[key], env[key], userState.repoKey(worktree));
  }
  writeJson(settingsLocalPath, { ...settings, env: mirror });
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
