#!/usr/bin/env node
// Builds a local test bundle — NOT a published release — one per CPU architecture, so the very
// latest working tree (uncommitted changes included) can be handed to a colleague for manual
// testing. Published releases come from .github/workflows/release.yml (GHCR image + the GitHub
// Release install kit built by scripts/release-kit.js); this script never touches either.
//
//   npm run local-release-bundle                       both architectures
//   BUNDLE_ARCHS=amd64 npm run local-release-bundle    only the named ones (comma list)
//   BUNDLE_STAMP=YYYYMMDD-HHMMSS npm run ...           reuse a given stamp instead of "now"
//
// Each bundle is a folder plus a matching .zip under release/ holding the exported Docker image
// for that architecture (tagged ghcr.io/dataart/artisyn-log-hub:local-<stamp>), the
// docker-compose.yml from release-template/ filled with VERSION=local-<stamp>, a ready-to-run
// .env (fresh random secrets, no editing required) plus .env.example for reference, and an
// INSTALL.md rendered from release-template/LOCAL-BUNDLE.md for that architecture — everything
// needed to run on a clean Docker host without pulling from a registry.
//
// The build context is the working tree (`.`), never a git checkout. GIT_COMMIT is the HEAD sha,
// suffixed `-dirty` when `git status --porcelain` reports changes, so the app's Build tile tells
// a tester whether the bundle carries uncommitted code.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { zipDir } = require('./zip-dir');
const {
  IMAGE, gitCommit, hostArch, applyPlaceholders, generateReleaseEnv,
} = require('./release-kit');

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

const DEFAULT_BUNDLE_ARCHS = 'amd64,arm64';

// A local bundle is identified by the UTC moment it was built: there is no published version to
// name it after, and two bundles cut from the same commit (with different uncommitted changes)
// still have to be told apart. The app reports `local-<stamp>` as its build version.
const BUNDLE_STAMP_RE = /^\d{8}-\d{6}$/;

// `GIT_COMMIT` for the image: HEAD, plus `-dirty` when the working tree has uncommitted changes.
function bundleCommit() {
  const head = gitCommit();
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    return status.trim() === '' ? head : `${head}-dirty`;
  } catch (_) {
    return head;
  }
}

// `YYYYMMDD-HHMMSS` in UTC — 15 characters, lexicographically sortable, no separator that would
// be awkward in a file name.
function bundleStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// BUNDLE_STAMP lets a caller reuse a stamp; otherwise the run generates its own. A malformed
// value is a hard error rather than a silently-regenerated one, so the zip names can never
// disagree with the image's build-info.json.
function resolveBundleStamp(env = process.env) {
  const fromEnv = env.BUNDLE_STAMP;
  if (fromEnv === undefined || fromEnv === '') {
    return bundleStamp();
  }
  if (!BUNDLE_STAMP_RE.test(fromEnv)) {
    throw new Error(
      `BUNDLE_STAMP must match YYYYMMDD-HHMMSS (UTC), got "${fromEnv}"`,
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
// architecture's bundle by name, even when this particular run was narrowed with BUNDLE_ARCHS.
function otherTarget(arch) {
  return TARGETS.find((t) => t.arch !== arch);
}

// BUNDLE_ARCHS narrows what gets built (comma list, default both) — handy when the daemon cannot
// emulate the non-native architecture, or when only the host's bundle is needed.
function selectedTargets(env = process.env) {
  const raw = env.BUNDLE_ARCHS === undefined || env.BUNDLE_ARCHS === ''
    ? DEFAULT_BUNDLE_ARCHS
    : env.BUNDLE_ARCHS;
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((arch) => !TARGETS.some((t) => t.arch === arch));
  if (unknown.length > 0) {
    throw new Error(
      `BUNDLE_ARCHS names unknown architecture(s) ${unknown.join(', ')} — `
      + `known: ${TARGETS.map((t) => t.arch).join(', ')}`,
    );
  }
  const selected = TARGETS.filter((t) => wanted.includes(t.arch));
  if (selected.length === 0) {
    throw new Error('BUNDLE_ARCHS selected no architecture to build');
  }
  return selected;
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
      + '("docker run --privileged --rm tonistiigi/binfmt --install all"), or narrow the run '
      + 'with BUNDLE_ARCHS to the platforms the builder advertises.',
    );
  }
}

// Fills the bundle folder for one architecture: image tar, compose file, env files, and an
// INSTALL.md that names only this architecture's file and points at the other bundle by name.
// The .env is generated once per run and shared by every bundle: the architectures are
// alternative downloads of the same build, so the secrets must not differ between them.
function assembleBundle(target, context) {
  const {
    stamp, version, commit, imageTag, envExample, envContent, composeContent,
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
  // non-native architecture never puts an image this machine cannot run into the local store.
  // The tar carries a classic `manifest.json`, so it also loads on daemons that predate the
  // containerd image store.
  docker([
    'buildx', 'build',
    '--platform', target.platform,
    '--build-arg', `VERSION=${version}`,
    '--build-arg', `GIT_COMMIT=${commit}`,
    '-t', imageTag,
    '--output', `type=docker,dest=${path.join(bundleDir, imageFile)}`,
    '.',
  ]);

  fs.writeFileSync(path.join(bundleDir, 'docker-compose.yml'), composeContent);
  fs.writeFileSync(path.join(bundleDir, '.env.example'), envExample);
  fs.writeFileSync(path.join(bundleDir, '.env'), envContent);
  fs.writeFileSync(
    path.join(bundleDir, 'INSTALL.md'),
    applyPlaceholders(fs.readFileSync(path.join(templateDir, 'LOCAL-BUNDLE.md'), 'utf8'), {
      VERSION: version,
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

    const stamp = resolveBundleStamp();
    const version = `local-${stamp}`;
    const commit = bundleCommit();
    const imageTag = `${IMAGE}:${version}`;

    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.mkdirSync(releaseDir, { recursive: true });

    const envExample = fs.readFileSync(path.join(templateDir, '.env.example'), 'utf8');
    const context = {
      stamp,
      version,
      commit,
      imageTag,
      envExample,
      envContent: generateReleaseEnv(envExample),
      composeContent: applyPlaceholders(
        fs.readFileSync(path.join(templateDir, 'docker-compose.yml'), 'utf8'),
        { VERSION: version, GIT_COMMIT: commit },
      ),
    };

    const bundles = targets.map((target) => assembleBundle(target, context));

    // Leaves the host-arch image in the local store under the same tag the bundle's compose file
    // names, so the bundle can also be tried right here. Everything is already in the build
    // cache, so this is a near-instant re-export rather than another build.
    console.log(`Loading the linux/${hostArch()} image into the local store as ${imageTag}...`);
    docker([
      'buildx', 'build',
      '--platform', `linux/${hostArch()}`,
      '--build-arg', `VERSION=${version}`,
      '--build-arg', `GIT_COMMIT=${commit}`,
      '-t', imageTag,
      '--load',
      '.',
    ]);

    console.log(`\nLocal test bundle ${version} (commit ${commit}) assembled in ${releaseDir}:`);
    for (const bundle of bundles) {
      console.log(`  ${bundle.bundleName}.zip  (${mib(bundle.zipBytes)})`);
    }
  } catch (err) {
    console.error(`local-release-bundle failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  TARGETS,
  BUNDLE_STAMP_RE,
  DEFAULT_BUNDLE_ARCHS,
  bundleStamp,
  resolveBundleStamp,
  bundleCommit,
  bundleName,
  imageFileName,
  zipFileName,
  otherTarget,
  selectedTargets,
};
