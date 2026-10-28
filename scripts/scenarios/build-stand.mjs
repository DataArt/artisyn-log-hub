#!/usr/bin/env node
// Builds the isolated scenario stand into tmp/scenarios/stand/ (impl-plan DD C1):
//
//   tmp/scenarios/stand/index.js               ncc bundle of server/src/main.ts (-s)
//   tmp/scenarios/stand/public/                vite build --outDir + precompress (the SPA)
//   tmp/scenarios/stand/public/static/         installer tarballs + installer-version.json
//   tmp/scenarios/stand/drizzle/migrations/    copy of server/drizzle/migrations
//   tmp/scenarios/stand/prebuilds/             argon2 prebuilds (scripts/copy-native.js)
//   tmp/scenarios/stand/wasm/                  tree-sitter WASM for the server Bash analysis (scripts/copy-wasm.js)
//   tmp/scenarios/stand/table.sql              connect-pg-simple session table DDL (as in Dockerfile)
//
// Never writes into dist/ or server/src/public/static. The rebuild is skipped when the sha256
// over every input file (git ls-files -co --exclude-standard in INPUT_DIRS, so untracked new
// files count too) matches the hash stored by the previous successful build.
//
// Side effect shared with `npm run build`: build-hooks-installer.js may bump
// artisyn-hooks-installer/package.json and compiles artisyn-hooks-installer/dist in place, so
// this script must never run concurrently with `npm run build` (both live in the `app` group).
//
// Usage: node scripts/scenarios/build-stand.mjs [--force]
// Exit codes: 0 built or up to date, 1 build failure.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCENARIOS_TMP = path.join(ROOT, 'tmp', 'scenarios');
export const STAND_DIR = path.join(SCENARIOS_TMP, 'stand');
export const HASH_FILE_NAME = '.inputs-hash';

/** Input trees whose content decides whether the stand must be rebuilt (DD C1). */
export const INPUT_DIRS = ['client', 'server/src', 'server/drizzle', 'hook', 'artisyn-hooks-installer', 'packages'];

/** The build scripts themselves: editing the builder must also invalidate the stand. */
export const BUILDER_FILES = [
  'scripts/scenarios/build-stand.mjs',
  'scripts/build-hooks-installer.js',
  'scripts/copy-native.js',
  'scripts/copy-wasm.js',
];

/** Repo-relative input files (forward slashes), sorted, de-duplicated. Read-only git call. */
export function listInputFiles(root = ROOT) {
  const res = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...INPUT_DIRS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw new Error(`git ls-files failed to run: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git ls-files exited with ${res.status}: ${res.stderr.trim()}`);
  const files = new Set(res.stdout.split('\0').filter(Boolean));
  for (const f of BUILDER_FILES) files.add(f);
  return [...files].sort();
}

/**
 * sha256 over (path, content) of every file. A listed file that no longer exists on disk
 * (tracked but deleted) contributes a distinct marker instead of failing.
 */
export function computeInputsHash(root, files) {
  const hash = crypto.createHash('sha256');
  for (const rel of [...new Set(files)].sort()) {
    hash.update(rel);
    hash.update('\0');
    let content = null;
    try {
      content = fs.readFileSync(path.join(root, rel));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err;
    }
    if (content === null) {
      hash.update('<missing>');
    } else {
      hash.update(String(content.length));
      hash.update('\0');
      hash.update(content);
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function readStoredHash(standDir = STAND_DIR) {
  try {
    return fs.readFileSync(path.join(standDir, HASH_FILE_NAME), 'utf8').trim();
  } catch {
    return null;
  }
}

/** True when the stand on disk is complete and was built from exactly these inputs. */
export function isStandUpToDate(hash, standDir = STAND_DIR) {
  return readStoredHash(standDir) === hash && fs.existsSync(path.join(standDir, 'index.js'));
}

/**
 * ncc writes the bundle's source-map sources as `.././server/src/...`, which resolves against the
 * map's own directory to a path that does not exist, so coverage of the stand (DD L1) could not be
 * remapped onto server/src. Rewrites every source that names a repo file to the correct path
 * relative to `mapDir`; synthetic sources (webpack/bootstrap ...) are left alone. Pure.
 */
export function rebaseSourceMapSources(map, mapDir, root = ROOT) {
  const sources = (map.sources || []).map((source) => {
    const stripped = source.replace(/\\/g, '/').replace(/^(?:\.\.?\/)+/, '');
    if (!/^server\/src\//.test(stripped)) return source;
    return path.relative(mapDir, path.join(root, stripped)).split(path.sep).join('/');
  });
  return { ...map, sources };
}

function rebaseStandSourceMaps(standDir) {
  for (const name of fs.readdirSync(standDir).filter((n) => n.endsWith('.js.map'))) {
    const file = path.join(standDir, name);
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(rebaseSourceMapSources(map, standDir)), 'utf8');
  }
}

function step(label, cmd, args, cwd) {
  process.stderr.write(`[build-stand] ${label}\n`);
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (res.error) throw new Error(`${label}: failed to run: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label}: exited with ${res.status ?? res.signal}`);
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) throw new Error(`${from} not found`);
  // Same rule as scripts/build-assets.js: repo housekeeping dotfiles are not shipped.
  fs.cpSync(from, to, { recursive: true, filter: (src) => src === from || !path.basename(src).startsWith('.') });
}

/** Builds the stand unconditionally into `standDir` (wiped first). */
export function buildStandFresh(standDir = STAND_DIR) {
  const node = process.execPath;
  fs.rmSync(standDir, { recursive: true, force: true });
  fs.mkdirSync(standDir, { recursive: true });

  // 1. Server bundle. ncc goes first so nothing it might clean in its output dir is lost.
  const nccCli = path.join(ROOT, 'node_modules', '@vercel', 'ncc', 'dist', 'ncc', 'cli.js');
  step('ncc build server/src/main.ts', node, [nccCli, 'build', 'server/src/main.ts', '-o', standDir, '-s'], ROOT);
  for (const leftover of ['src', 'test', 'drizzle.config.d.ts']) {
    fs.rmSync(path.join(standDir, leftover), { recursive: true, force: true });
  }
  rebaseStandSourceMaps(standDir);

  // 2. Client SPA into <stand>/public, then precompressed in place.
  const publicDir = path.join(standDir, 'public');
  const clientDir = path.join(ROOT, 'client');
  const viteCli = path.join(clientDir, 'node_modules', 'vite', 'bin', 'vite.js');
  step('vite build', node, [viteCli, 'build', '--outDir', publicDir, '--emptyOutDir'], clientDir);
  step('precompress', node, [path.join(clientDir, 'scripts', 'precompress.cjs'), publicDir], ROOT);

  // 3. Installer tarballs + installer-version.json into <stand>/public/static (resolveStaticDir).
  step(
    'build-hooks-installer --static-dir',
    node,
    [path.join(ROOT, 'scripts', 'build-hooks-installer.js'), '--static-dir', path.join(publicDir, 'static')],
    ROOT,
  );

  // 4. Migrations next to the bundle (resolveMigrationsFolder).
  process.stderr.write('[build-stand] copy migrations\n');
  copyTree(path.join(ROOT, 'server', 'drizzle', 'migrations'), path.join(standDir, 'drizzle', 'migrations'));

  // 5. argon2 native prebuilds next to the bundle.
  process.stderr.write('[build-stand] copy native prebuilds\n');
  require(path.join(ROOT, 'scripts', 'copy-native.js')).copyNative(standDir);

  // 5b. tree-sitter WASM (server Bash analysis, server-bash-parser.ts) into <stand>/wasm.
  process.stderr.write('[build-stand] copy tree-sitter wasm\n');
  require(path.join(ROOT, 'scripts', 'copy-wasm.js')).copyWasm(standDir);

  // 6. connect-pg-simple reads table.sql from the bundle's directory (createTableIfMissing);
  //    ncc does not bundle it — the Docker image copies it the same way (Dockerfile).
  process.stderr.write('[build-stand] copy connect-pg-simple table.sql\n');
  fs.copyFileSync(
    path.join(ROOT, 'server', 'node_modules', 'connect-pg-simple', 'table.sql'),
    path.join(standDir, 'table.sql'),
  );
}

/**
 * Builds the stand unless its stored input hash is current. Returns { built, hash }.
 * The hash is recomputed after the build (build-hooks-installer may bump the installer
 * package.json), so the stored value describes the inputs the stand was really built from.
 */
export function buildStand({ force = false, standDir = STAND_DIR } = {}) {
  const before = computeInputsHash(ROOT, listInputFiles(ROOT));
  if (!force && isStandUpToDate(before, standDir)) {
    process.stderr.write(`[build-stand] up to date (${before.slice(0, 12)}), skipping\n`);
    return { built: false, hash: before };
  }
  fs.rmSync(path.join(standDir, HASH_FILE_NAME), { force: true });
  buildStandFresh(standDir);
  const after = computeInputsHash(ROOT, listInputFiles(ROOT));
  fs.writeFileSync(path.join(standDir, HASH_FILE_NAME), `${after}\n`, 'utf8');
  process.stderr.write(`[build-stand] built (${after.slice(0, 12)})\n`);
  return { built: true, hash: after };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildStand({ force: process.argv.includes('--force') });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`build-stand error: ${err.message}\n`);
    process.exit(1);
  }
}
