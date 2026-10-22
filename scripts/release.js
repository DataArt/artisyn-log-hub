#!/usr/bin/env node
// Builds one self-contained release bundle per CPU architecture. Each bundle is a folder plus a
// matching .zip holding the exported Docker image for that architecture, a standalone
// docker-compose.yml (app + Postgres), a ready-to-run .env (fresh random secrets, no editing
// required) plus .env.example for reference, and install instructions written for that
// architecture — everything needed to run on a clean Docker host.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { zipDir } = require('./zip-dir');

const repoRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(repoRoot, 'release');
const templateDir = path.join(repoRoot, 'release-template');

// One bundle per architecture, rather than one bundle holding both images. `docker save` can
// emit a multi-platform image, but `docker load` only accepts it on a daemon using the
// containerd image store — still not universal — so a combined image would fail to import on
// some perfectly current Docker installs. Single-arch bundles load anywhere, halve the download,
// and let INSTALL.md name exactly one file to load instead of asking the reader to choose.
const TARGETS = [
  {
    arch: 'amd64',
    platform: 'linux/amd64',
    label: 'Intel/AMD (x86_64)',
    uname: 'x86_64',
    hosts: 'most Linux servers, Windows, and Intel Macs',
  },
  {
    arch: 'arm64',
    platform: 'linux/arm64',
    label: 'Apple Silicon / ARM64 (aarch64)',
    uname: 'arm64 or aarch64',
    hosts: 'Apple Silicon Macs (M1-M4), Raspberry Pi, AWS Graviton',
  },
];

const DEFAULT_RELEASE_ARCHS = 'amd64,arm64';

// A release is identified by the UTC minute-and-second it was cut, not by a bumped package
// version: the zips are published side by side on a server and the app reports the same string
// back through /health/version, so the identity has to be generated (and shared) per run rather
// than committed to a package.json.
const RELEASE_STAMP_RE = /^\d{8}-\d{6}$/;

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

// `YYYYMMDD-HHMMSS` in UTC — 15 characters, lexicographically sortable, no separator that would
// be awkward in a file name.
function releaseStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// CI generates the stamp itself (one `date -u` shared by the zips and the deployed image) and
// passes it in; a local run generates its own. A malformed value is a hard error rather than a
// silently-regenerated one, so a broken CI expression can never produce zips whose names
// disagree with the image's build-info.json.
function resolveReleaseStamp(env = process.env) {
  const fromEnv = env.RELEASE_STAMP;
  if (fromEnv === undefined || fromEnv === '') {
    return releaseStamp();
  }
  if (!RELEASE_STAMP_RE.test(fromEnv)) {
    throw new Error(
      `RELEASE_STAMP must match YYYYMMDD-HHMMSS (UTC), got "${fromEnv}"`,
    );
  }
  return fromEnv;
}

function bundleName(stamp, arch) {
  return `artisyn-log-hub-${stamp}-${arch}`;
}

function imageFileName(stamp, arch) {
  return `${bundleName(stamp, arch)}.tar`;
}

function zipFileName(stamp, arch) {
  return `${bundleName(stamp, arch)}.zip`;
}

// Deliberately reads the unfiltered TARGETS: INSTALL.md points the reader at the other
// architecture's download, which exists on the release server even when this particular run was
// narrowed with RELEASE_ARCHS.
function otherTarget(arch) {
  return TARGETS.find((t) => t.arch !== arch);
}

// RELEASE_ARCHS narrows what gets built (comma list, default both). It exists as a one-line
// retreat for a runner whose daemon cannot emulate the non-native architecture — the inventory
// happily lists a single architecture.
function selectedTargets(env = process.env) {
  const raw = env.RELEASE_ARCHS === undefined || env.RELEASE_ARCHS === ''
    ? DEFAULT_RELEASE_ARCHS
    : env.RELEASE_ARCHS;
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((arch) => !TARGETS.some((t) => t.arch === arch));
  if (unknown.length > 0) {
    throw new Error(
      `RELEASE_ARCHS names unknown architecture(s) ${unknown.join(', ')} — `
      + `known: ${TARGETS.map((t) => t.arch).join(', ')}`,
    );
  }
  const selected = TARGETS.filter((t) => wanted.includes(t.arch));
  if (selected.length === 0) {
    throw new Error('RELEASE_ARCHS selected no architecture to build');
  }
  return selected;
}

function applyPlaceholders(content, values) {
  return Object.keys(values).reduce(
    (acc, key) => acc.split(`{{${key}}}`).join(values[key]),
    content,
  );
}

function docker(args) {
  execFileSync('docker', args, { cwd: repoRoot, stdio: 'inherit' });
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// Cross-building a non-native architecture needs QEMU binfmt handlers registered with the
// daemon (Docker Desktop ships them; a bare Linux daemon may not). Checking up front turns an
// otherwise cryptic mid-build "exec format error" into an actionable message — and does it
// before any image build has started.
function assertPlatformsBuildable(targets) {
  let supported = '';
  try {
    supported = execFileSync('docker', ['buildx', 'inspect', '--bootstrap'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`cannot inspect the buildx builder — is Docker running? (${err.message})`);
  }
  const missing = targets.filter((t) => !supported.includes(t.platform)).map((t) => t.platform);
  if (missing.length > 0) {
    throw new Error(
      `the active buildx builder cannot build ${missing.join(', ')}. Register QEMU emulation `
      + '("docker run --privileged --rm tonistiigi/binfmt --install all") or run the release on '
      + 'a builder that advertises those platforms.',
    );
  }
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

// Fills the bundle folder for one architecture: image tar, compose file, env files, and an
// INSTALL.md that names only this architecture's file and points at the other bundle by name.
function assembleBundle(target, context) {
  const {
    stamp, commit, imageTag, envExample, envContent,
  } = context;
  const name = bundleName(stamp, target.arch);
  const bundleDir = path.join(releaseDir, name);
  const imageFile = imageFileName(stamp, target.arch);
  const other = otherTarget(target.arch);

  fs.mkdirSync(bundleDir, { recursive: true });

  const emulated = target.arch !== hostArch();
  console.log(
    `Building ${target.platform} image ${imageTag} (commit ${commit}) -> ${name}/${imageFile}`
    + `${emulated ? ' — emulated, expect this to take a while' : ''}...`,
  );
  // `--output type=docker,dest=<file>` writes the tar straight out of BuildKit, so building the
  // non-native architecture never has to overwrite the local `latest` tag with an image this
  // machine cannot run. The tar carries a classic `manifest.json`, so it also loads on daemons
  // that predate the containerd image store.
  docker([
    'buildx', 'build',
    '--platform', target.platform,
    '--build-arg', `GIT_COMMIT=${commit}`,
    '--build-arg', `RELEASE_STAMP=${stamp}`,
    '-t', imageTag,
    '--output', `type=docker,dest=${path.join(bundleDir, imageFile)}`,
    '.',
  ]);

  fs.copyFileSync(
    path.join(templateDir, 'docker-compose.yml'),
    path.join(bundleDir, 'docker-compose.yml'),
  );
  fs.writeFileSync(path.join(bundleDir, '.env.example'), envExample);
  fs.writeFileSync(path.join(bundleDir, '.env'), envContent);
  fs.writeFileSync(
    path.join(bundleDir, 'INSTALL.md'),
    applyPlaceholders(fs.readFileSync(path.join(templateDir, 'INSTALL.md'), 'utf8'), {
      VERSION: stamp,
      GIT_COMMIT: commit,
      DATE: new Date().toISOString().slice(0, 10),
      IMAGE_FILE: imageFile,
      ARCH: target.arch,
      ARCH_LABEL: target.label,
      ARCH_UNAME: target.uname,
      ARCH_HOSTS: target.hosts,
      OTHER_ARCH_LABEL: other.label,
      OTHER_ZIP: zipFileName(stamp, other.arch),
    }),
  );

  const zipPath = path.join(releaseDir, `${name}.zip`);
  console.log(`Packing ${name}.zip...`);
  const zipBytes = zipDir(bundleDir, zipPath);

  return { bundleName: name, zipPath, zipBytes };
}

if (require.main === module) {
  try {
    const targets = selectedTargets();
    assertPlatformsBuildable(targets);

    const stamp = resolveReleaseStamp();
    const commit = gitCommit();
    const imageTag = 'artisyn-log-hub:latest';

    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.mkdirSync(releaseDir, { recursive: true });

    const envExample = fs.readFileSync(path.join(templateDir, '.env.example'), 'utf8');
    const context = {
      stamp,
      commit,
      imageTag,
      envExample,
      envContent: generateReleaseEnv(envExample),
    };

    const bundles = targets.map((target) => assembleBundle(target, context));

    // Leaves the local store holding a runnable `artisyn-log-hub:latest`, the way the previous
    // plain `docker build -t ... .` did. Everything is already in the build cache, so this is a
    // near-instant re-export rather than another build.
    console.log(`Loading the linux/${hostArch()} image into the local store as ${imageTag}...`);
    docker([
      'buildx', 'build',
      '--platform', `linux/${hostArch()}`,
      '--build-arg', `GIT_COMMIT=${commit}`,
      '--build-arg', `RELEASE_STAMP=${stamp}`,
      '-t', imageTag,
      '--load',
      '.',
    ]);

    console.log(`\nRelease ${stamp} assembled in ${releaseDir}:`);
    for (const bundle of bundles) {
      console.log(`  ${bundle.bundleName}.zip  (${mib(bundle.zipBytes)})`);
    }
  } catch (err) {
    console.error(`release failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  TARGETS,
  RELEASE_STAMP_RE,
  DEFAULT_RELEASE_ARCHS,
  releaseStamp,
  resolveReleaseStamp,
  bundleName,
  imageFileName,
  zipFileName,
  otherTarget,
  selectedTargets,
  hostArch,
  gitCommit,
  generateReleaseEnv,
};
