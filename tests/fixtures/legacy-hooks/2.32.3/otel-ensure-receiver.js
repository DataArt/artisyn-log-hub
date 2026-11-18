#!/usr/bin/env node
'use strict';
/**
 * Claude Code user-level `SessionStart` hook — keep the per-user OTEL receiver alive (DD-21).
 *
 * Installed only when the user chose `proxy` for a foreign OTLP collector: then the receiver is the
 * only path to that collector, so it must run for every Claude Code session, including sessions in
 * repos without the Log Hub hook. The installer copies this file to
 * `~/.artisyn/otel/bin/otel-ensure-receiver.js` and adds to `~/.claude/settings.json`:
 *
 *   hooks.SessionStart[{hooks:[{type:'command',
 *     command:'node "<home>/.artisyn/otel/bin/otel-ensure-receiver.js"', timeout:5}]}]
 *
 * Steps:
 *   1. read `port.json` and `token` from `~/.artisyn/otel/`;
 *   2. `POST /artisyn/hello` with a `ENSURE_HELLO_TIMEOUT_MS` timeout and verify the HMAC proof;
 *   3. if nothing answers, spawn `bin/otel-receiver.js` with the shared argv (DD-7), detached and
 *      hidden;
 *   4. exit 0, silently.
 *
 * An answer that fails the proof (a foreign process, another user's receiver) is left alone: a
 * spawned receiver could not bind the port anyway.
 *
 * Standalone on purpose — Node built-ins only, no `require` of any hook module: it runs from `bin/`,
 * next to nothing but the receiver copy. `ownerHash` and the proof check therefore duplicate
 * `user-state.js` and `otel-register.js`; keep them identical.
 *
 * Never prints, never fails the session: every path ends in exit code 0.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// The user hook must not delay session start: a live receiver answers hello in milliseconds.
// Twin of `HELLO_TIMEOUT_MS` (2000) in `otel-register.js`, shorter on purpose.
const ENSURE_HELLO_TIMEOUT_MS = 500;

// Twins: `SHARED_IDLE_TIMEOUT_MS` in `otel-receiver.js`/`otel-register.js`, `DEFAULT_MAX_BODY_BYTES`
// in `otel-receiver.js`.
const SHARED_IDLE_TIMEOUT_MS = 600000;
const DEFAULT_MAX_BODY_BYTES = 8388608;

// Hard stop well inside the hook's 5 s timeout, whatever happens.
const HARD_EXIT_MS = 3000;

const HELLO_PATH = '/artisyn/hello';
const RECEIVER_SCRIPT = 'otel-receiver.js';
const TOKEN_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]+$/;

/**
 * Normalized home dir, as in `user-state.js` `normalizeForKey`.
 * @param {string} value
 * @param {string} [platform]
 * @returns {string}
 */
function normalizeForKey(value, platform = process.platform) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let resolved = impl.resolve(String(value)).replace(/\\/g, '/');
  if (resolved.length > 1 && !/^[A-Za-z]:\/$/.test(resolved)) resolved = resolved.replace(/\/+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Twin of `user-state.js` `ownerHash`.
 * @param {string} home
 * @param {string} [platform]
 * @returns {string}
 */
function ownerHash(home, platform = process.platform) {
  return crypto.createHash('sha256').update(normalizeForKey(home, platform)).digest('hex');
}

/**
 * `HMAC(token, "srv\n"+clientNonce+"\n"+serverNonce)` hex (DD-9).
 * @param {string} token
 * @param {string} clientNonce
 * @param {string} serverNonce
 * @returns {string}
 */
function computeHelloProof(token, clientNonce, serverNonce) {
  return crypto.createHmac('sha256', token).update(`srv\n${clientNonce}\n${serverNonce}`).digest('hex');
}

/**
 * Constant-time check of a hello answer's proof.
 * @param {string} token
 * @param {string} clientNonce
 * @param {*} answer - the parsed hello body
 * @returns {boolean}
 */
function helloProofValid(token, clientNonce, answer) {
  if (!answer || typeof answer !== 'object') return false;
  const { serverNonce, proof } = answer;
  if (typeof serverNonce !== 'string' || !serverNonce || typeof proof !== 'string' || !HEX_RE.test(proof)) return false;
  const expected = Buffer.from(computeHelloProof(token, clientNonce, serverNonce), 'hex');
  const actual = Buffer.from(proof, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * The DD-7 shared launch argv.
 * @param {{ home: string, stateDir: string, port: number }} p
 * @returns {string[]}
 */
function buildSharedArgv(p) {
  return [
    '--shared',
    '--owner-home', p.home,
    '--state-dir', p.stateDir,
    '--port', String(p.port),
    '--idle-timeout-ms', String(SHARED_IDLE_TIMEOUT_MS),
    '--max-body-bytes', String(DEFAULT_MAX_BODY_BYTES),
  ];
}

/**
 * The env twins of `buildSharedArgv`.
 * @param {{ home: string, stateDir: string, port: number }} p
 * @returns {Record<string, string>}
 */
function buildSharedEnv(p) {
  return {
    ARTISYN_OTEL_SHARED: '1',
    ARTISYN_OTEL_OWNER_HOME: p.home,
    ARTISYN_OTEL_STATE_DIR: p.stateDir,
    ARTISYN_OTEL_PORT: String(p.port),
    ARTISYN_OTEL_IDLE_TIMEOUT_MS: String(SHARED_IDLE_TIMEOUT_MS),
    ARTISYN_OTEL_MAX_BODY_BYTES: String(DEFAULT_MAX_BODY_BYTES),
  };
}

/**
 * @param {string} stateDir
 * @returns {number|null}
 */
function readPort(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'port.json'), 'utf8'));
    const port = Number(parsed && parsed.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} stateDir
 * @returns {string|null}
 */
function readToken(stateDir) {
  try {
    const value = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
    return TOKEN_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * POST the hello. Resolves `'ok'` (valid proof), `'foreign'` (something answered but failed the
 * check) or `'none'` (nothing answered).
 * @param {number} port
 * @param {string} token
 * @param {string} home
 * @returns {Promise<'ok'|'foreign'|'none'>}
 */
function hello(port, token, home) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const clientNonce = crypto.randomBytes(16).toString('hex');
    const body = JSON.stringify({ clientNonce, ownerHash: ownerHash(home) });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: HELLO_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: ENSURE_HELLO_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return done('foreign');
        try {
          const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done(helloProofValid(token, clientNonce, answer) ? 'ok' : 'foreign');
        } catch {
          done('foreign');
        }
      });
      res.on('error', () => done('foreign'));
    });
    req.on('timeout', () => {
      req.destroy();
      done('none');
    });
    req.on('error', () => done('none'));
    req.end(body);
  });
}

/**
 * Spawn the `bin/` receiver copy detached, hidden, with a neutral cwd.
 * @param {string} script
 * @param {{ home: string, stateDir: string, port: number }} p
 */
function spawnReceiver(script, p) {
  const child = childProcess.spawn(process.execPath, [script, ...buildSharedArgv(p)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: os.tmpdir(),
    env: Object.assign({}, process.env, buildSharedEnv(p)),
  });
  child.on('error', () => { /* silent by contract */ });
  child.unref();
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const home = os.homedir();
  const stateDir = path.join(home, '.artisyn', 'otel');
  const port = readPort(stateDir);
  const token = readToken(stateDir);
  if (!port || !token) return;
  const outcome = await hello(port, token, home);
  if (outcome !== 'none') return;
  const script = path.join(stateDir, 'bin', RECEIVER_SCRIPT);
  if (!fs.existsSync(script)) return;
  spawnReceiver(script, { home, stateDir, port });
}

if (require.main === module) {
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
  // stdin (the SessionStart payload) is not needed; never let it keep the process alive.
  try { process.stdin.destroy(); } catch { /* ignore */ }
  main().then(() => process.exit(0), () => process.exit(0));
}

module.exports = {
  ENSURE_HELLO_TIMEOUT_MS,
  SHARED_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  normalizeForKey,
  ownerHash,
  computeHelloProof,
  helloProofValid,
  buildSharedArgv,
  buildSharedEnv,
};
