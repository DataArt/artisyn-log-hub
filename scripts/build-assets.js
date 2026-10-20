#!/usr/bin/env node
// Post-build asset phase: every copy step plus the postclean, in ONE node process.
//
// These were six separate npm scripts (build:copy:client, :static, :env, :native, :migrations and
// build:postclean). Their actual work is milliseconds each, but every `npm run` costs ~600ms of
// process startup on Windows — measured 3.6s total for six steps doing almost nothing. Collapsing
// them into one process takes that to ~0.7s. The individual npm scripts are kept for manual use.
//
// Layout is reproduced EXACTLY as `copyfiles` produced it, including the doubled path in
// dist/public/public/static (copyfiles -u 2 strips `server/src`, leaving `public/...` under the
// dist/public destination). server/src/common/static-dir.ts resolves that location at runtime, so
// this is load-bearing, not a typo to tidy up here.
const fs = require('fs');
const path = require('path');
const { copyNative } = require('./copy-native');

const ROOT = path.join(__dirname, '..');

// `copyfiles` skips dotfiles unless given --all, and its `**/*` globs therefore never shipped
// things like server/src/public/static/.gitkeep or .gitignore into dist/. fs.cpSync copies
// everything, so this filter restores the old behaviour — dist/ must not carry repo housekeeping
// files. The root directory itself is always accepted (its basename is never a dotfile here).
function skipDotfiles(src) {
  return !path.basename(src).startsWith('.');
}

// copyfiles -u 2 "client/dist/**/*" dist/public
function copyClient() {
  const from = path.join(ROOT, 'client', 'dist');
  if (!fs.existsSync(from)) {
    throw new Error('client/dist not found — build:client must run before the asset phase');
  }
  fs.cpSync(from, path.join(ROOT, 'dist', 'public'), { recursive: true, filter: skipDotfiles });
}

// copyfiles -u 2 "server/src/public/**/*" dist/public  →  dist/public/public/...
function copyStatic() {
  const from = path.join(ROOT, 'server', 'src', 'public');
  if (!fs.existsSync(from)) {
    throw new Error('server/src/public not found — build:hooks-installer must run before the asset phase');
  }
  fs.cpSync(from, path.join(ROOT, 'dist', 'public', 'public'), { recursive: true, filter: skipDotfiles });
}

// node -e "copyFileSync('.env.defaults', 'dist/.env')"
function copyEnv() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.env.defaults'), path.join(ROOT, 'dist', '.env'));
}

// copyfiles -u 3 "server/drizzle/migrations/**/*" dist/drizzle/migrations
function copyMigrations() {
  const from = path.join(ROOT, 'server', 'drizzle', 'migrations');
  if (!fs.existsSync(from)) {
    throw new Error('server/drizzle/migrations not found');
  }
  fs.cpSync(from, path.join(ROOT, 'dist', 'drizzle', 'migrations'), { recursive: true, filter: skipDotfiles });
}

// Strips ncc's leftover source/test output from dist/.
function postclean() {
  for (const leftover of ['src', 'test', 'drizzle.config.d.ts']) {
    try {
      fs.rmSync(path.join(ROOT, 'dist', leftover), { recursive: true, force: true });
    } catch (_) {
      // Best-effort, matching the original inline script's behaviour on Windows locks.
    }
  }
}

try {
  copyClient();
  copyStatic();
  copyEnv();
  copyNative();
  copyMigrations();
  postclean();
  process.exit(0);
} catch (err) {
  process.stderr.write(`build-assets error: ${err.message}\n`);
  process.exit(1);
}
