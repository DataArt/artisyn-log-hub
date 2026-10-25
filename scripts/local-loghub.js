#!/usr/bin/env node
// Local Docker install of Log Hub in the sibling folder `../local-loghub` (next to this repo),
// laid out exactly like an install from the GitHub Release kit: docker-compose.yml + .env from
// release-template/, but running the image ghcr.io/dataart/artisyn-log-hub:local built from the
// current working tree (build version `local`) instead of a published one.
//
//   node scripts/local-loghub.js install   create the folder (fresh .env), build, start
//   node scripts/local-loghub.js update    if installed: rebuild the image from the code, refresh
//                                          docker-compose.yml/.env.example, `docker compose up -d`
//
// `.env` is written only on install and never touched afterwards — it holds the DB password of
// the running cluster.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  IMAGE, gitCommit, hostArch, generateReleaseEnv, applyPlaceholders,
} = require('./release-kit');

const repoRoot = path.resolve(__dirname, '..');
const templateDir = path.join(repoRoot, 'release-template');
const installDir = path.resolve(repoRoot, '..', 'local-loghub');
const VERSION = 'local';
const imageTag = `${IMAGE}:${VERSION}`;

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function isInstalled() {
  return fs.existsSync(path.join(installDir, 'docker-compose.yml'))
    && fs.existsSync(path.join(installDir, '.env'));
}

// docker-compose.yml gets its {{VERSION}} / {{GIT_COMMIT}} filled (image IMAGE:local);
// .env.example is copied verbatim.
function copyTemplates(commit) {
  const compose = fs.readFileSync(path.join(templateDir, 'docker-compose.yml'), 'utf8');
  fs.writeFileSync(
    path.join(installDir, 'docker-compose.yml'),
    applyPlaceholders(compose, { VERSION, GIT_COMMIT: commit }),
    'utf8',
  );
  fs.copyFileSync(path.join(templateDir, '.env.example'), path.join(installDir, '.env.example'));
}

function buildImage(commit) {
  process.stderr.write(`Building ${imageTag} (linux/${hostArch()}, commit ${commit}, version ${VERSION})...\n`);
  run('docker', [
    'buildx', 'build',
    '--platform', `linux/${hostArch()}`,
    '--build-arg', `VERSION=${VERSION}`,
    '--build-arg', `GIT_COMMIT=${commit}`,
    '-t', imageTag,
    '--load',
    '.',
  ], repoRoot);
}

function composeUp() {
  run('docker', ['compose', 'up', '-d'], installDir);
}

function install() {
  if (isInstalled()) {
    throw new Error(`${installDir} is already installed — use "update"`);
  }
  const commit = gitCommit();
  fs.mkdirSync(installDir, { recursive: true });
  copyTemplates(commit);
  const envExample = fs.readFileSync(path.join(templateDir, '.env.example'), 'utf8');
  fs.writeFileSync(path.join(installDir, '.env'), generateReleaseEnv(envExample), 'utf8');
  buildImage(commit);
  composeUp();
  process.stderr.write(`Installed version ${VERSION} (commit ${commit}) in ${installDir} — http://localhost:5003\n`);
}

function update() {
  if (!isInstalled()) {
    process.stderr.write(`${installDir} is not installed — nothing to update (run "npm run local-loghub:install").\n`);
    return;
  }
  const commit = gitCommit();
  copyTemplates(commit);
  buildImage(commit);
  composeUp();
  process.stderr.write(`Updated ${installDir} to version ${VERSION} (commit ${commit}) — http://localhost:5003\n`);
}

try {
  const command = process.argv[2];
  if (command === 'install') {
    install();
  } else if (command === 'update') {
    update();
  } else {
    throw new Error('usage: node scripts/local-loghub.js install|update');
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`local-loghub failed: ${err.message}\n`);
  process.exit(1);
}
