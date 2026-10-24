// Test repos: copy each fixture into the run-dir (mapping `dot-claude/` → `.claude/`)
// and turn it into a committed git repo with a fake `origin` remote.
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, REMOTE_URL, REPO_NAMES } from './config.mjs';
import { run } from './proc.mjs';

/** Fixture dir name that holds Claude harness files; renamed to `.claude` on copy. */
export const FIXTURE_HARNESS_DIR = 'dot-claude';
export const HARNESS_DIR = '.claude';

const GIT_USER_NAME = 'big-test';
const GIT_USER_EMAIL = 'big-test@example.com';
const GIT_BRANCH = 'main';
const CLAUDE_MD_RE = /^claude(\.local)?\.md$/i;

/**
 * Relative destination path for a fixture-relative path: only a leading `dot-claude` segment is
 * renamed, so a nested directory that happens to be called `dot-claude` is copied verbatim.
 */
export function mapFixturePath(relPath) {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (parts[0] === FIXTURE_HARNESS_DIR) parts[0] = HARNESS_DIR;
  return parts.join(path.sep);
}

/** Every file below `dir`, as paths relative to it (sorted, platform separators). */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

/** Every CLAUDE.md / CLAUDE.local.md below `dir` (relative paths). */
export function findClaudeMd(dir) {
  return listFiles(dir).filter((rel) => CLAUDE_MD_RE.test(path.basename(rel)));
}

/** Copies one fixture into `destDir`, returning the copied destination-relative paths. */
export function copyFixture(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) throw new Error(`fixture missing: ${srcDir}`);
  if (fs.existsSync(destDir)) throw new Error(`repo dir already exists: ${destDir}`);
  const copied = [];
  for (const rel of listFiles(srcDir)) {
    const destRel = mapFixturePath(rel);
    const dest = path.join(destDir, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), dest);
    copied.push(destRel);
  }
  // The installer prompts interactively when `.claude/` is missing.
  fs.mkdirSync(path.join(destDir, HARNESS_DIR), { recursive: true });
  return copied.sort();
}

function git(repoDir, args) {
  return run('git', args, { cwd: repoDir });
}

/** `git init`, local identity, fake origin, one commit. */
export function gitSetup(repoDir, remoteUrl) {
  git(repoDir, ['init', '-q', '-b', GIT_BRANCH]);
  git(repoDir, ['config', 'user.name', GIT_USER_NAME]);
  git(repoDir, ['config', 'user.email', GIT_USER_EMAIL]);
  git(repoDir, ['remote', 'add', 'origin', remoteUrl]);
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'fixture']);
  const head = git(repoDir, ['rev-parse', 'HEAD']).stdout.trim();
  const origin = git(repoDir, ['remote', 'get-url', 'origin']).stdout.trim();
  if (origin !== remoteUrl) {
    throw new Error(`${repoDir}: origin is "${origin}", expected "${remoteUrl}"`);
  }
  return { head, origin };
}

/**
 * Creates the test repos under the run-dir. Throws (infra step `repos`) on any failure,
 * including a `CLAUDE.md` anywhere in a fixture.
 * opts.beforeCommit(repo, dir): called after the fixture is copied and checked, before the
 * fixture commit, so files it writes (e.g. a generated CLAUDE.md, FR-4a) land in that commit.
 * Returns [{ repo, dir, remoteUrl, head, harnessFiles }], harnessFiles being the `.claude/…`
 * paths (relative to the repo, platform separators).
 */
export function createRepos(runPaths, { repos = REPO_NAMES, fixturesDir = FIXTURES_DIR, beforeCommit = null } = {}) {
  const result = [];
  for (const repo of repos) {
    const dir = runPaths.repoDir(repo);
    const copied = copyFixture(path.join(fixturesDir, repo), dir);
    // The fixtures themselves must never carry a CLAUDE.md; only beforeCommit may add one.
    const claudeMd = findClaudeMd(dir);
    if (claudeMd.length > 0) {
      throw new Error(`repo ${repo} must not contain CLAUDE.md, found: ${claudeMd.join(', ')}`);
    }
    if (beforeCommit) beforeCommit(repo, dir);
    const remoteUrl = REMOTE_URL(repo);
    const { head } = gitSetup(dir, remoteUrl);
    const harnessFiles = copied.filter((rel) => rel.split(path.sep)[0] === HARNESS_DIR);
    result.push({ repo, dir, remoteUrl, head, harnessFiles });
  }
  return result;
}

export const LEGACY_LOG_HUB_COMMIT_MSG = 'legacy log-hub config';

/**
 * FR-12: writes `json` as the pre-split `.artisyn/config/log-hub.json` into an already committed
 * repo and commits it as a second commit, so the current installer runs over a tracked legacy config.
 * Returns the new HEAD.
 */
export function seedLegacyLogHub(dir, json) {
  const rel = path.join('.artisyn', 'config', 'log-hub.json');
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}
`);
  git(dir, ['add', '--', rel.split(path.sep).join('/')]);
  git(dir, ['commit', '-q', '-m', LEGACY_LOG_HUB_COMMIT_MSG]);
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}
