// The disposable stand: an amd64 image built from the working tree, a
// generated compose project on 127.0.0.1:3001/5433, readiness
// and teardown.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_PORT, DB_PORT, IMAGE_REF, IMAGE_REPO, OTEL_RECEIVER_MARKER, POSTGRES_IMAGE, READY_POLL_MS,
  STAND_HOST, STAND_URL, TIMEOUTS, gitRoot,
} from './config.mjs';
import { killTree, run, runAsync } from './proc.mjs';

const IS_WIN = process.platform === 'win32';
const EXPECTED_ARCH = 'amd64';
const LATEST_REF = `${IMAGE_REPO}:latest`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appendLog(file, title, text) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n===== ${title} (${new Date().toISOString()}) =====\n${text || ''}\n`);
}

/** Image id of `artisyn-log-hub:latest`, or the string "absent". */
export function latestImageId() {
  const res = run('docker', ['image', 'inspect', '--format', '{{.Id}}', LATEST_REF], { allowFail: true });
  return res.status === 0 ? res.stdout.trim() : 'absent';
}

/** `{{.Architecture}}` of a local image, e.g. "amd64". */
export function imageArchitecture(ref) {
  return run('docker', ['image', 'inspect', '--format', '{{.Architecture}}', ref]).stdout.trim();
}

/**
 * Builds `artisyn-log-hub:big-test-<stamp>` for linux/amd64 from the git root and asserts both
 * FR-2 conditions: the image is amd64 and `:latest` was left untouched.
 * Resolves { imageRef, commit, architecture, latestBefore, latestAfter, archOk, latestUnchanged }.
 * Throws (with `err.result` set when the build itself succeeded) on any failure.
 */
export async function buildImage(stamp, { root = gitRoot(), logFile, timeoutMs = TIMEOUTS.buildMs } = {}) {
  const imageRef = IMAGE_REF(stamp);
  const commitRes = run('git', ['rev-parse', 'HEAD'], { cwd: root, allowFail: true });
  const commit = commitRes.status === 0 ? commitRes.stdout.trim() : 'unknown';
  const latestBefore = latestImageId();

  const args = [
    'buildx', 'build',
    '--platform', 'linux/amd64',
    '--build-arg', `GIT_COMMIT=${commit}`,
    '--build-arg', `RELEASE_STAMP=${stamp}`,
    '-t', imageRef,
    '--load',
    '.',
  ];
  const res = await runAsync('docker', args, { cwd: root, timeoutMs });
  appendLog(logFile, `docker ${args.join(' ')}`, `${res.stdout}\n${res.stderr}`);
  if (res.timedOut) throw new Error(`docker build timed out after ${Math.round(timeoutMs / 60000)} min`);
  if (res.exitCode !== 0) {
    const tail = (res.stderr || res.stdout).trim().split(/\r?\n/).slice(-20).join('\n');
    throw new Error(`docker build exited with ${res.exitCode}:\n${tail}`);
  }

  const architecture = imageArchitecture(imageRef);
  const latestAfter = latestImageId();
  const result = {
    imageRef,
    commit,
    architecture,
    latestBefore,
    latestAfter,
    archOk: architecture === EXPECTED_ARCH,
    latestUnchanged: latestBefore === latestAfter,
  };
  const problems = [];
  if (!result.archOk) problems.push(`image architecture is "${architecture}", expected "${EXPECTED_ARCH}"`);
  if (!result.latestUnchanged) problems.push(`${LATEST_REF} changed during the build (${latestBefore} → ${latestAfter})`);
  if (problems.length > 0) {
    const err = new Error(problems.join('; '));
    err.result = result;
    throw err;
  }
  return result;
}

/**
 * docker-compose.yml for the stand, modelled on release-template/docker-compose.yml: run image,
 * no container_name/restart, ports bound to 127.0.0.1 only, bind mounts under ./data.
 * Accepts either a full image ref or a bare tag of IMAGE_REPO.
 */
export function renderCompose(imageTag) {
  const image = imageTag.includes(':') ? imageTag : `${IMAGE_REPO}:${imageTag}`;
  return `services:
  db:
    image: ${POSTGRES_IMAGE}
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: \${POSTGRES_DB:-a-log}
      PGDATA: /var/lib/postgresql/data/pgdata
    volumes:
      - \${LOG_HUB_DATA_DIR:?set LOG_HUB_DATA_DIR in .env}/pgdata:/var/lib/postgresql/data
    ports:
      - "${STAND_HOST}:${DB_PORT}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-postgres}"]
      interval: 5s
      timeout: 5s
      retries: 10

  app:
    image: ${image}
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER:-postgres}:\${POSTGRES_PASSWORD}@db:5432/\${POSTGRES_DB:-a-log}
      SESSION_SECRET: \${SESSION_SECRET:?set SESSION_SECRET in .env}
      COOKIE_SECURE: \${COOKIE_SECURE:-false}
      TRUST_PROXY: \${TRUST_PROXY:-false}
      AUTH_MODE: \${AUTH_MODE:-password}
      # The image runs NODE_ENV=production, where AUTH_MODE=password refuses to start without it.
      PUBLIC_BASE_URL: \${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL in .env}
    ports:
      - "${STAND_HOST}:${APP_PORT}:3000"
    volumes:
      - \${LOG_HUB_DATA_DIR:?set LOG_HUB_DATA_DIR in .env}/upload-queue:/app/dist/upload-queue
      - \${LOG_HUB_DATA_DIR:?set LOG_HUB_DATA_DIR in .env}/logs:/app/dist/logs
`;
}

/** .env for the stand with fresh random secrets (pattern scripts/release.js generateReleaseEnv). */
export function renderEnv() {
  return [
    'LOG_HUB_DATA_DIR=./data',
    'POSTGRES_USER=postgres',
    'POSTGRES_DB=a-log',
    `POSTGRES_PASSWORD=${crypto.randomBytes(24).toString('hex')}`,
    `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    'AUTH_MODE=password',
    `PUBLIC_BASE_URL=${STAND_URL}`,
    'COOKIE_SECURE=false',
    'TRUST_PROXY=false',
    '',
  ].join('\n');
}

function composeArgs(runPaths, ...rest) {
  return ['compose', '-p', runPaths.composeProject, '-f', runPaths.composeFile, '--env-file', runPaths.envFile, ...rest];
}

/** The exact `docker compose … down` command line, for the report. */
export function downCommand(runPaths) {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return ['docker', ...composeArgs(runPaths, 'down')].map(q).join(' ');
}

/** Writes docker-compose.yml, .env and the data dirs under `_log_hub/`. */
export function writeStandFiles(runPaths) {
  fs.mkdirSync(runPaths.logHubDir, { recursive: true });
  for (const sub of ['pgdata', 'upload-queue', 'logs']) {
    fs.mkdirSync(path.join(runPaths.dataDir, sub), { recursive: true });
  }
  fs.writeFileSync(runPaths.composeFile, renderCompose(runPaths.imageRef));
  fs.writeFileSync(runPaths.envFile, renderEnv());
}

/** Generates the stand files and runs `docker compose -p … up -d`. Output goes to stand-up.log. */
export function up(runPaths) {
  writeStandFiles(runPaths);
  const args = composeArgs(runPaths, 'up', '-d');
  // The first run may still have to pull the postgres image, so allow the build budget here.
  const res = run('docker', args, { cwd: runPaths.logHubDir, allowFail: true, timeoutMs: TIMEOUTS.buildMs });
  appendLog(runPaths.standUpLog, `docker ${args.join(' ')}`, `${res.stdout}\n${res.stderr}`);
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout).trim().split(/\r?\n/).slice(-20).join('\n');
    throw new Error(`docker compose up exited with ${res.status}:\n${tail}`);
  }
}

/** Exit status of the stand's app container ("exited (1)" etc.), or null while it is running. */
export function appExitStatus(runPaths) {
  const res = run('docker', composeArgs(runPaths, 'ps', '-a', '--format', '{{.State}} {{.Status}}', 'app'), {
    cwd: runPaths.logHubDir,
    allowFail: true,
  });
  const line = res.stdout.trim().split(/\r?\n/)[0] || '';
  return /^(exited|dead)\b/.test(line) ? line.replace(/^\S+\s+/, '') : null;
}

/**
 * Saves `docker compose logs app` and `ps -a` to `_state/app-container.log`, so a boot crash
 * survives the teardown that removes the container. Never throws.
 */
export function saveAppLogs(runPaths) {
  try {
    const logs = run('docker', composeArgs(runPaths, 'logs', '--no-color', 'app'), { cwd: runPaths.logHubDir, allowFail: true });
    const ps = run('docker', composeArgs(runPaths, 'ps', '-a'), { cwd: runPaths.logHubDir, allowFail: true });
    fs.mkdirSync(path.dirname(runPaths.appContainerLog), { recursive: true });
    fs.writeFileSync(runPaths.appContainerLog, `${ps.stdout}\n${ps.stderr}\n===== app logs =====\n${logs.stdout}\n${logs.stderr}`);
  } catch {
    // best effort: teardown must still run
  }
}

/** Last `n` non-empty lines of the saved app container log, for an error message. */
function appLogTail(runPaths, n = 15) {
  try {
    return fs.readFileSync(runPaths.appContainerLog, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');
  } catch {
    return '';
  }
}

/**
 * Polls GET /api/v1/auth/config until it answers 200 with mode "password" (AC FR-5).
 * Resolves the response body; throws on a different mode or on timeout. With `runPaths`, it also
 * fails fast when the app container has exited, quoting the tail of its log.
 */
export async function waitReady({ url = STAND_URL, timeoutMs = TIMEOUTS.standReadyMs, pollMs = READY_POLL_MS, runPaths = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  for (;;) {
    try {
      const res = await fetch(`${url}/api/v1/auth/config`, { signal: AbortSignal.timeout(Math.max(pollMs, 5000)) });
      const text = await res.text();
      if (res.status === 200) {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        if (body && body.mode === 'password') return body;
        throw Object.assign(new Error(`stand answered auth/config with ${text.slice(0, 200)}, expected mode "password"`), {
          fatal: true,
        });
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      if (err.fatal) throw err;
      last = err.message;
    }
    const exited = runPaths ? appExitStatus(runPaths) : null;
    if (exited) {
      saveAppLogs(runPaths);
      throw new Error(`stand app container ${exited} before answering ${url}; log tail (${runPaths.appContainerLog}):\n${appLogTail(runPaths)}`);
    }
    if (Date.now() + pollMs > deadline) {
      throw new Error(`stand not ready at ${url} within ${Math.round(timeoutMs / 1000)} s (last: ${last})`);
    }
    await sleep(pollMs);
  }
}

/** `docker compose -p … down` without `-v` (data is bind-mounted inside the run-dir). */
export function down(runPaths) {
  const args = composeArgs(runPaths, 'down');
  const res = run('docker', args, { cwd: runPaths.logHubDir, allowFail: true, timeoutMs: TIMEOUTS.standReadyMs });
  appendLog(runPaths.standUpLog, `docker ${args.join(' ')}`, `${res.stdout}\n${res.stderr}`);
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout).trim().split(/\r?\n/).slice(-20).join('\n');
    throw new Error(`docker compose down exited with ${res.status}:\n${tail}`);
  }
}

/** Throws unless `docker compose -p … ps -a -q` lists no container (AC FR-11). */
export function assertDown(runPaths) {
  const res = run('docker', composeArgs(runPaths, 'ps', '-a', '-q'), { cwd: runPaths.logHubDir });
  const ids = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (ids.length > 0) {
    throw new Error(`compose project ${runPaths.composeProject} still has containers: ${ids.join(', ')}`);
  }
}

function listProcesses() {
  if (IS_WIN) {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const res = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { allowFail: true });
    if (res.status !== 0 || !res.stdout.trim()) return [];
    const parsed = JSON.parse(res.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine || '' }));
  }
  const res = run('ps', ['-eo', 'pid=,args='], { allowFail: true });
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
}

/**
 * Kills the hook's `otel-receiver.js` node processes whose command line mentions `runDir`.
 * Returns the killed pids.
 */
export function killOtelReceivers(runDir) {
  const norm = (s) => (IS_WIN ? s.replace(/\\/g, '/').toLowerCase() : s);
  const dir = norm(runDir);
  const victims = listProcesses().filter((p) => {
    const cmd = norm(p.cmd);
    return cmd.includes(OTEL_RECEIVER_MARKER.toLowerCase()) && cmd.includes(dir) && p.pid !== process.pid;
  });
  for (const p of victims) killTree(p.pid);
  return victims.map((p) => p.pid);
}
