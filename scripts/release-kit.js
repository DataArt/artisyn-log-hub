#!/usr/bin/env node
// Builds the install kit published as the assets of a GitHub Release (release job `kit` in
// .github/workflows/release.yml). Algorithm and examples: docs/knowledgebase/algorithms/release-assets.md.
//
// From release-template/ it writes into --out:
//   README.md            INSTALL.md with {{VERSION}} / {{GIT_COMMIT}} filled
//   docker-compose.yml   with {{VERSION}} / {{GIT_COMMIT}} filled (image ghcr.io/dataart/artisyn-log-hub:X.Y.Z)
//   env.example          .env.example unchanged — GitHub renames release assets whose names start with '.'
//   install.sh           unchanged
//   install.ps1          unchanged
//   artisyn-log-hub-<version>.zip   the same five files, packed by scripts/zip-dir.js under one
//                        folder `artisyn-log-hub/`, with env.example named .env.example again
//   SHA256SUMS           `<sha256>  <name>` for the zip and every loose file, sorted by name
// release-template/LOCAL-BUNDLE.md belongs to scripts/local-release-bundle.js and is never shipped.
//
// Modes:
//   node scripts/release-kit.js --version X.Y.Z --commit <sha> --out <dir>
//
//   require('scripts/release-kit.js') exports IMAGE, kitFiles, sha256sums and the helpers shared
//   with scripts/local-release-bundle.js and scripts/local-loghub.js (gitCommit, hostArch,
//   applyPlaceholders, generateReleaseEnv).
//
// Exit codes: 0 after writing the kit, 1 on a usage or I/O error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { zipDir } = require('./zip-dir');

const repoRoot = path.resolve(__dirname, '..');
const templateDir = path.join(repoRoot, 'release-template');

const IMAGE = 'ghcr.io/dataart/artisyn-log-hub';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// Folder every zip entry sits under — the default install directory name, so unpacking the zip
// in the home directory gives the same layout the installers create.
const ZIP_FOLDER = 'artisyn-log-hub';

// Kit layout: template file -> loose asset name, name inside the zip, placeholders filled or not.
const KIT_LAYOUT = [
  { template: 'INSTALL.md', name: 'README.md', zipName: 'README.md', fill: true },
  { template: 'docker-compose.yml', name: 'docker-compose.yml', zipName: 'docker-compose.yml', fill: true },
  { template: '.env.example', name: 'env.example', zipName: '.env.example', fill: false },
  { template: 'install.sh', name: 'install.sh', zipName: 'install.sh', fill: false },
  { template: 'install.ps1', name: 'install.ps1', zipName: 'install.ps1', fill: false },
];

// Which TARGETS entry matches the machine running this script. That one is also loaded into the
// local image store at the end, so `artisyn-log-hub:latest` stays runnable here.
function hostArch() {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
}

function applyPlaceholders(content, values) {
  return Object.keys(values).reduce(
    (acc, key) => acc.split(`{{${key}}}`).join(values[key]),
    content,
  );
}

// Turns the checked-in .env.example template into a drop-in, ready-to-run .env for this
// release: real random secrets in place of the "change-me" placeholders, so `docker compose
// up -d` works with no manual editing. Only for fresh installs — an upgrade must keep the
// existing .env instead of overwriting it with a new one full of different random secrets.
//
// Generated once and shared by every bundle: the architectures are alternative downloads of the
// same release, not separate installs, so a user who grabs the wrong one first and then the
// right one should not find the secrets have changed underneath them.
//
// It also pins NODE_ENV=production (passed to the app by docker-compose.yml), so the server's
// production-only behaviour applies even if the image's own ENV is ever overridden.
function generateReleaseEnv(templateContent) {
  const eol = templateContent.includes('\r\n') ? '\r\n' : '\n';
  const body = templateContent
    .replace('POSTGRES_PASSWORD=change-me', `POSTGRES_PASSWORD=${crypto.randomBytes(18).toString('hex')}`)
    .replace(
      'SESSION_SECRET=change-me-to-a-long-random-string',
      `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    );
  const separator = body.endsWith('\n') ? '' : eol;
  return `${body}${separator}${eol}NODE_ENV=production${eol}`;
}

// Pure: `templates` maps a release-template/ file name to its text. Returns the kit files as
// [{name, zipName, content}] in KIT_LAYOUT order. Only README.md and docker-compose.yml get
// their placeholders filled; the installers and .env.example are shipped byte for byte.
function kitFiles(templates, { version, commit }) {
  return KIT_LAYOUT.map((entry) => {
    const text = templates[entry.template];
    if (typeof text !== 'string') {
      throw new Error(`release-template/${entry.template} is missing`);
    }
    const content = entry.fill
      ? applyPlaceholders(text, { VERSION: version, GIT_COMMIT: commit })
      : text;
    return { name: entry.name, zipName: entry.zipName, content };
  });
}

// Pure: `files` is [{name, content}] (content a string or a Buffer). Returns the SHA256SUMS text,
// one `<hex>  <name>` line per file (two spaces, as `sha256sum -c` expects), sorted by name.
function sha256sums(files) {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${crypto.createHash('sha256').update(f.content).digest('hex')}  ${f.name}\n`)
    .join('');
}

function zipFileName(version) {
  return `artisyn-log-hub-${version}.zip`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--version' || a === '--commit' || a === '--out') && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${a}`);
    }
  }
  if (!args.version || !VERSION_RE.test(args.version)) {
    throw new Error(`--version must be X.Y.Z, got "${args.version || ''}"`);
  }
  if (!args.commit) throw new Error('--commit <sha> is required');
  if (!args.out) throw new Error('--out <dir> is required');
  return args;
}

function readTemplates() {
  const templates = {};
  for (const entry of KIT_LAYOUT) {
    templates[entry.template] = fs.readFileSync(path.join(templateDir, entry.template), 'utf8');
  }
  return templates;
}

function buildKit({ version, commit, out }) {
  const outDir = path.resolve(out);
  fs.mkdirSync(outDir, { recursive: true });
  const files = kitFiles(readTemplates(), { version, commit });

  for (const f of files) {
    fs.writeFileSync(path.join(outDir, f.name), f.content, 'utf8');
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'release-kit-'));
  try {
    const folder = path.join(stage, ZIP_FOLDER);
    fs.mkdirSync(folder);
    for (const f of files) {
      fs.writeFileSync(path.join(folder, f.zipName), f.content, 'utf8');
    }
    zipDir(folder, path.join(outDir, zipFileName(version)));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  const zipName = zipFileName(version);
  const sums = sha256sums([
    ...files.map((f) => ({ name: f.name, content: f.content })),
    { name: zipName, content: fs.readFileSync(path.join(outDir, zipName)) },
  ]);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), sums, 'utf8');
  return { outDir, names: [...files.map((f) => f.name), zipName, 'SHA256SUMS'] };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { outDir, names } = buildKit(args);
    process.stdout.write(`release-kit: v${args.version} (${args.commit}) -> ${outDir}\n`);
    for (const name of names) process.stdout.write(`  ${name}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`release-kit: ${err.message}\n`
      + 'Usage: node scripts/release-kit.js --version X.Y.Z --commit <sha> --out <dir>\n');
    process.exit(1);
  }
}

module.exports = {
  IMAGE,
  KIT_LAYOUT,
  gitCommit,
  hostArch,
  applyPlaceholders,
  generateReleaseEnv,
  kitFiles,
  sha256sums,
  zipFileName,
};
