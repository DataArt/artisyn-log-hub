// Preflight for the big pre-prod e2e test (phase P0): required tools, free stand ports, the
// dev-port snapshot and the isolated Claude config + child env.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  APP_PORT, DB_PORT, DEV_PORTS, ENV_PASSTHROUGH, ENV_SCRUB_RE, REPO_ROOT,
} from './config.mjs';
import { run, which } from './proc.mjs';

const REQUIRED_TOOLS = Object.freeze(['docker', 'git', 'claude', 'npx', 'node']);
const BUILD_PLATFORM = 'linux/amd64';
const PROBE_TIMEOUT_MS = 1000;

/**
 * Checks every external tool the run needs. Throws one error listing everything missing.
 * Returns { tools: {name: path}, chromium: <executable path> }.
 */
export function checkTools() {
  const tools = {};
  const problems = [];
  for (const name of REQUIRED_TOOLS) {
    const found = which(name);
    if (found) tools[name] = found;
    else problems.push(`"${name}" is not on PATH`);
  }

  if (tools.docker) {
    // Same check as scripts/release.js assertPlatformsBuildable: the active buildx builder must
    // advertise the target platform, or the build dies mid-way with "exec format error".
    try {
      const { stdout } = run('docker', ['buildx', 'inspect', '--bootstrap'], { timeoutMs: 120000 });
      if (!stdout.includes(BUILD_PLATFORM)) {
        problems.push(`the active docker buildx builder does not list ${BUILD_PLATFORM}`);
      }
    } catch (err) {
      problems.push(`cannot inspect the docker buildx builder — is Docker running? (${err.message})`);
    }
  }

  let chromiumPath = null;
  try {
    const require = createRequire(path.join(REPO_ROOT, 'package.json'));
    const { chromium } = require('@playwright/test');
    chromiumPath = chromium.executablePath();
    if (!chromiumPath || !fs.existsSync(chromiumPath)) {
      problems.push(`Playwright chromium is not installed (expected at ${chromiumPath}); run "npx playwright install chromium"`);
    }
  } catch (err) {
    problems.push(`cannot load @playwright/test from the repo root node_modules (${err.message})`);
  }

  if (problems.length > 0) {
    throw new Error(`preflight tool check failed:\n- ${problems.join('\n- ')}`);
  }
  return { tools, chromium: chromiumPath };
}

// ---- base-image pre-pull ------------------------------------------------------------------------
// Docker Hub's anonymous pull limit (HTTP 429) once killed a run in P1 on `FROM node:…-slim`. P0
// pulls every missing official base image from the public ECR mirror of the Docker library
// instead and tags it with its Docker Hub name, so the build and compose find it locally.

const ECR_LIBRARY_MIRROR = 'public.ecr.aws/docker/library';
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Pure: the external base images of a Dockerfile's `FROM` lines, in order, without duplicates.
 * Skips `--platform=…`-style flags, references to an earlier stage (`FROM build AS x`),
 * `scratch` and images built from an ARG (`$…`).
 */
export function dockerfileBaseImages(text) {
  const stages = new Set();
  const images = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const tokens = raw.trim().split(/\s+/);
    if (!tokens[0] || tokens[0].toUpperCase() !== 'FROM') continue;
    const args = tokens.slice(1).filter((t) => !t.startsWith('--'));
    const image = args[0];
    const earlierStage = Boolean(image) && stages.has(image.toLowerCase());
    if (args.length >= 3 && args[1].toUpperCase() === 'AS') stages.add(args[2].toLowerCase());
    if (!image || earlierStage || image.includes('$') || image.toLowerCase() === 'scratch') continue;
    if (!images.includes(image)) images.push(image);
  }
  return images;
}

/**
 * Pure: the public ECR mirror ref of an official Docker library image (`node:22-slim` →
 * `public.ecr.aws/docker/library/node:22-slim`, no tag → `:latest`); null for anything with a
 * registry or namespace (`a/b`, `ghcr.io/…`) or a digest, which is not mirrored.
 */
export function mirrorImageRef(image) {
  if (typeof image !== 'string' || !image || image.includes('/') || image.includes('@')) return null;
  const [name, tag = 'latest', ...rest] = image.split(':');
  if (!name || !tag || rest.length) return null;
  return `${ECR_LIBRARY_MIRROR}/${name}:${tag}`;
}

/**
 * For every image not present locally (`docker image inspect`), pulls its mirror
 * (`--platform linux/amd64`) and `docker tag`s it to the original name. Never throws: a failure
 * is reported per image so the caller can warn — the build may still find the image itself.
 * Returns [{ image, action: 'present' | 'pulled' | 'not mirrored' | 'failed', detail }].
 */
export function prePullBaseImages(images, { runner = run } = {}) {
  const out = [];
  for (const image of images) {
    const inspect = (() => {
      try {
        return runner('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { allowFail: true, timeoutMs: 60000 });
      } catch (err) {
        return { status: -1, stderr: err.message };
      }
    })();
    if (inspect.status === 0) {
      out.push({ image, action: 'present', detail: 'already local' });
      continue;
    }
    const mirror = mirrorImageRef(image);
    if (!mirror) {
      out.push({ image, action: 'not mirrored', detail: 'not an official library image; left to the build' });
      continue;
    }
    try {
      runner('docker', ['pull', '--platform', BUILD_PLATFORM, mirror], { timeoutMs: PULL_TIMEOUT_MS });
      runner('docker', ['tag', mirror, image], { timeoutMs: 60000 });
      out.push({ image, action: 'pulled', detail: `pulled ${mirror} (${BUILD_PLATFORM}) and tagged it ${image}` });
    } catch (err) {
      // The command line plus the last stderr line (e.g. the 429), not the whole tail.
      const lines = String(err.message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const reason = lines.length > 1 ? `${lines[0]} ${lines[lines.length - 1]}` : lines[0] ?? 'unknown error';
      out.push({ image, action: 'failed', detail: `${mirror}: ${reason}` });
    }
  }
  return out;
}

function busyMessage(port) {
  return `port ${port} is busy — free it or stop the other stand; nothing was stopped`;
}

function tryListen(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => reject(err));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve());
    });
  });
}

/**
 * Throws `port <n> is busy …` when any port cannot be bound on 127.0.0.1 or 0.0.0.0.
 * Never stops or touches whatever holds the port.
 */
export async function checkPortsFree(ports = [APP_PORT, DB_PORT], hosts = ['127.0.0.1', '0.0.0.0']) {
  for (const port of ports) {
    for (const host of hosts) {
      try {
        await tryListen(port, host);
      } catch (err) {
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          throw new Error(busyMessage(port));
        }
        throw new Error(`cannot probe port ${port} on ${host}: ${err && err.message}`);
      }
    }
  }
}

/** Resolves true when something accepts a TCP connection on host:port. Never rejects. */
export function isListening(port, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Listening state of the dev ports, observed only. A port counts as
 * listening when it accepts on IPv4 or IPv6 loopback (vite may bind only `::1`).
 * Returns { [port]: boolean }.
 */
export async function snapshotDevPorts(ports = DEV_PORTS) {
  const snapshot = {};
  for (const port of ports) {
    snapshot[port] = (await isListening(port, '127.0.0.1')) || (await isListening(port, '::1'));
  }
  return snapshot;
}

/** Compares two dev-port snapshots. Returns { equal, diff: [{port, before, after}] }. */
export function compareDevPorts(before, after) {
  const ports = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const diff = ports
    .filter((p) => Boolean(before?.[p]) !== Boolean(after?.[p]))
    .map((p) => ({ port: Number(p), before: Boolean(before?.[p]), after: Boolean(after?.[p]) }));
  return { equal: diff.length === 0, diff };
}

function envCredentialKeys(env) {
  return ENV_PASSTHROUGH.filter((k) => typeof env[k] === 'string' && env[k] !== '');
}

/**
 * Creates `_claude-config/` holding only `settings.json` (`{}`) and — unless env credentials are
 * set — a copy of `~/.claude/.credentials.json`. Throws when neither source exists.
 * Returns { dir, mode: 'env'|'file', keys?, source? }.
 */
export function prepareClaudeConfig(runPaths, { env = process.env, home = os.homedir() } = {}) {
  const dir = runPaths.claudeConfigDir;
  const keys = envCredentialKeys(env);
  const credentialsSrc = path.join(home, '.claude', '.credentials.json');
  if (keys.length === 0 && !fs.existsSync(credentialsSrc)) {
    throw new Error(
      `no Claude credentials: set ${ENV_PASSTHROUGH.join(' or ')}, or log in with "claude" so that ${credentialsSrc} exists`,
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  if (keys.length > 0) return { dir, mode: 'env', keys };

  fs.copyFileSync(credentialsSrc, path.join(dir, '.credentials.json'));
  return { dir, mode: 'file', source: credentialsSrc };
}

/**
 * Environment for every `claude` and installer child: the parent env minus every
 * key matching ENV_SCRUB_RE (CLAUDE…, ANTHROPIC_…, OTEL_…, ARTISYN_…), plus the credential pass-through keys that were set,
 * plus CLAUDE_CONFIG_DIR pointing at the run's isolated config.
 */
export function childEnv(runPaths, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ENV_SCRUB_RE.test(key)) continue;
    env[key] = value;
  }
  for (const key of envCredentialKeys(base)) env[key] = base[key];
  env.CLAUDE_CONFIG_DIR = runPaths.claudeConfigDir;
  return env;
}
