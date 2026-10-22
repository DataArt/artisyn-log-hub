#!/usr/bin/env node
// Local Docker install of Log Hub in the sibling folder `../local-loghub` (next to this repo),
// laid out exactly like a release bundle: docker-compose.yml + .env from release-template/, run
// with the `artisyn-log-hub:latest` image built from the current working tree.
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
  releaseStamp, gitCommit, hostArch, generateReleaseEnv,
} = require('./release');

const repoRoot = path.resolve(__dirname, '..');
const templateDir = path.join(repoRoot, 'release-template');
const installDir = path.resolve(repoRoot, '..', 'local-loghub');
const imageTag = 'artisyn-log-hub:latest';

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function isInstalled() {
  return fs.existsSync(path.join(installDir, 'docker-compose.yml'))
    && fs.existsSync(path.join(installDir, '.env'));
}

function copyTemplates() {
  fs.copyFileSync(path.join(templateDir, 'docker-compose.yml'), path.join(installDir, 'docker-compose.yml'));
  fs.copyFileSync(path.join(templateDir, '.env.example'), path.join(installDir, '.env.example'));
}

function buildImage() {
  const stamp = releaseStamp();
  const commit = gitCommit();
  process.stderr.write(`Building ${imageTag} (linux/${hostArch()}, commit ${commit}, stamp ${stamp})...\n`);
  run('docker', [
    'buildx', 'build',
    '--platform', `linux/${hostArch()}`,
    '--build-arg', `GIT_COMMIT=${commit}`,
    '--build-arg', `RELEASE_STAMP=${stamp}`,
    '-t', imageTag,
    '--load',
    '.',
  ], repoRoot);
  return stamp;
}

function composeUp() {
  run('docker', ['compose', 'up', '-d'], installDir);
}

function install() {
  if (isInstalled()) {
    throw new Error(`${installDir} is already installed — use "update"`);
  }
  fs.mkdirSync(installDir, { recursive: true });
  copyTemplates();
  const envExample = fs.readFileSync(path.join(templateDir, '.env.example'), 'utf8');
  fs.writeFileSync(path.join(installDir, '.env'), generateReleaseEnv(envExample), 'utf8');
  const stamp = buildImage();
  composeUp();
  process.stderr.write(`Installed release ${stamp} in ${installDir} — http://localhost:5003\n`);
}

function update() {
  if (!isInstalled()) {
    process.stderr.write(`${installDir} is not installed — nothing to update (run "npm run local-loghub:install").\n`);
    return;
  }
  copyTemplates();
  const stamp = buildImage();
  composeUp();
  process.stderr.write(`Updated ${installDir} to release ${stamp} — http://localhost:5003\n`);
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
