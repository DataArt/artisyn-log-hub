// Work Hub API contract tests (plan D13, D14): `npm run test:contract [-- <filter>...]` (from
// work-hub/).
//
//   1. checks that Docker answers;
//   2. builds the default image `artisyn-work-hub-default:<crate version>` when missing and the
//      fake-agent image `artisyn-work-hub-fake-agent:test` (tests/fake-agent/);
//   3. cleans up after earlier runs that were killed hard: each run writes
//      tmp/work-hub-contract/run-<hex>/run.json; for a run whose process is gone, the Docker
//      objects labelled with its instance are removed here and its schema is handed to the next
//      run (WORK_HUB_CONTRACT_STALE_SCHEMAS), which drops it;
//   4. runs `cargo test -p work-hub-server --test contract -- --test-threads=1 [<filter>...]`
//      with WORK_HUB_CONTRACT=1. The test binary (server/tests/contract/) starts the app in
//      process with its own schema whc_<hex> and instance whc-<hex> and removes both at the end.
//
// Env: WORK_HUB_TEST_DATABASE_URL (default postgresql://postgres:pw@localhost:5432/postgres; the
// root tests/scenarios/docker-compose.yml provides it). Docker must be running.
//
// The file is .mjs because work-hub/package.json is "type": "module"; the code itself stays
// synchronous and uses only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORK_HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(WORK_HUB, '..');
const RUNS_DIR = path.join(REPO_ROOT, 'tmp', 'work-hub-contract');
const FAKE_AGENT_IMAGE = 'artisyn-work-hub-fake-agent:test';
const DEFAULT_IMAGE_NAME = 'artisyn-work-hub-default';
const RUN_DIR_RE = /^run-[0-9a-f]{8}$/;
const SCHEMA_RE = /^whc_[0-9a-f]{8}$/;
const INSTANCE_RE = /^whc-[0-9a-f]{8}$/;

function log(text) {
  process.stderr.write(`contract: ${text}\n`);
}

function readCrateVersion() {
  const text = fs.readFileSync(path.join(WORK_HUB, 'server', 'Cargo.toml'), 'utf8');
  let inPackage = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inPackage = line === '[package]';
      continue;
    }
    const m = inPackage ? /^version\s*=\s*"([^"]+)"/.exec(line) : null;
    if (m) return m[1];
  }
  throw new Error('no [package] version in server/Cargo.toml');
}

/** `docker <args>` → { ok, stdout }; throws on failure unless allowFail. */
function docker(args, { allowFail = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  }
  return { ok: r.status === 0, stdout: (r.stdout || '').trim() };
}

function lines(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Runs a command with inherited stdio; throws on a non-zero exit. */
function run(cmd, args, options = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: WORK_HUB, stdio: 'inherit', ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${r.status}`);
}

function ensureImages() {
  const defaultTag = `${DEFAULT_IMAGE_NAME}:${readCrateVersion()}`;
  if (!docker(['image', 'inspect', defaultTag], { allowFail: true }).ok) {
    log(`${defaultTag} is missing; building it`);
    run(process.execPath, [path.join(WORK_HUB, 'scripts', 'image.mjs')]);
  }
  run('docker', [
    'build', '--build-arg', `BASE_IMAGE=${defaultTag}`, '-t', FAKE_AGENT_IMAGE,
    path.join(WORK_HUB, 'tests', 'fake-agent'),
  ]);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Removes every container, volume and image labelled with `instance`. */
function removeInstanceObjects(instance) {
  if (!INSTANCE_RE.test(instance)) throw new Error(`refusing to clean up unexpected instance "${instance}"`);
  const filters = ['--filter', 'label=artisyn.workhub=1', '--filter', `label=artisyn.workhub.instance=${instance}`];
  const containers = lines(docker(['ps', '-aq', ...filters]).stdout);
  if (containers.length > 0) docker(['rm', '-f', '-v', ...containers], { allowFail: true });
  const volumes = lines(docker(['volume', 'ls', '-q', ...filters]).stdout);
  if (volumes.length > 0) docker(['volume', 'rm', '-f', ...volumes], { allowFail: true });
  const images = [...new Set(lines(docker(['image', 'ls', '-q', ...filters]).stdout))];
  if (images.length > 0) docker(['rmi', '-f', ...images], { allowFail: true });
}

/** Cleans up the Docker objects of dead runs; returns their schemas for the next run to drop. */
function cleanupOrphans() {
  const schemas = [];
  if (!fs.existsSync(RUNS_DIR)) return schemas;
  for (const entry of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_DIR_RE.test(entry.name)) continue;
    const dir = path.join(RUNS_DIR, entry.name);
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    } catch {
      continue;
    }
    if (isAlive(info.pid)) continue;
    if (!SCHEMA_RE.test(info.schema) || !INSTANCE_RE.test(info.instance)) continue;
    log(`cleaning up after an earlier run (${info.schema}, ${info.instance})`);
    removeInstanceObjects(info.instance);
    schemas.push(info.schema);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return schemas;
}

try {
  if (!docker(['version', '--format', '{{.Server.Version}}'], { allowFail: true }).ok) {
    throw new Error('Docker is not reachable: start Docker and try again');
  }
  ensureImages();
  const staleSchemas = cleanupOrphans();
  const filters = process.argv.slice(2);
  const args = ['test', '-p', 'work-hub-server', '--test', 'contract', '--', '--test-threads=1', ...filters];
  log(`$ cargo ${args.join(' ')}`);
  const r = spawnSync('cargo', args, {
    cwd: WORK_HUB,
    stdio: 'inherit',
    env: {
      ...process.env,
      WORK_HUB_CONTRACT: '1',
      WORK_HUB_CONTRACT_STALE_SCHEMAS: staleSchemas.join(','),
    },
  });
  if (r.error) throw r.error;
  process.exit(r.status === null ? 1 : r.status);
} catch (err) {
  process.stderr.write(`contract error: ${err.message}\n`);
  process.exit(1);
}
