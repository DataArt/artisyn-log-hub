// One-time migration from the first layout (worktrees and state next to the repo, in
// `<repoParent>/<repoName>-worktrees/`) to the current one (`<repo>/.claude/worktrees/`, inside the
// clone, git-ignored). Runs at the start of every launcher command and is a no-op once done.
//
// Per sandbox: refuse while Claude sessions are live; remove the container (it is bound to the old
// path; volumes, DBs and ports are kept, the next start recreates it); `git worktree move` the
// worktree (relative links); move the state dir and point its `worktree` at the new path; rename
// the sandbox's Claude history dir in the shared profile (its slug comes from the container path).
// Directories are only renamed, never deleted; the emptied legacy dirs are removed with rmdir,
// which refuses anything not empty.
import fs from 'node:fs';
import path from 'node:path';
import { commonAncestor, CONTAINER_WORK_ROOT, containerPaths, resolvePaths, sandboxStateDir, validateName, worktreePath } from './config.mjs';
import { containerRemove, containerState, liveSessions, stopDevStack } from './docker.mjs';
import { moveWorktree } from './git.mjs';
import { readState, withLock, writeState } from './state.mjs';

const slug = (containerPath) => containerPath.replace(/[^a-zA-Z0-9]/g, '-');

/** The container path a sandbox had under the legacy layout (DD-7 relative to C). */
function legacyContainerWorktree(name, paths) {
  const c = commonAncestor(paths.repoRoot, paths.legacyWorktreesDir);
  const rel = path.relative(c, path.join(paths.legacyWorktreesDir, name)).split(path.sep).join('/');
  return `${CONTAINER_WORK_ROOT}/${rel}`;
}

function legacyNames(legacyStateDir) {
  try {
    return fs
      .readdirSync(legacyStateDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && validateName(e.name) === null)
      .filter((e) => fs.existsSync(path.join(legacyStateDir, e.name, 'state.json')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function tryRmdir(dir) {
  try {
    fs.rmdirSync(dir); // non-recursive: only an empty dir goes
  } catch {
    // not empty or already gone: leave it
  }
}

/** Migrates every legacy sandbox; prints one line per sandbox. Never throws for one sandbox. */
export async function migrateLegacyLayout(paths = resolvePaths()) {
  const legacy = paths.legacyWorktreesDir;
  if (!legacy) return;
  const legacyStateDir = path.join(legacy, '.sandboxes');
  const names = legacyNames(legacyStateDir);
  if (names.length === 0) return;
  process.stdout.write(`moving sandboxes from ${legacy} into ${paths.worktreesDir}…\n`);
  await withLock(async () => {
    for (const name of names) {
      try {
        const oldWt = path.join(legacy, name);
        const newWt = worktreePath(name, paths);
        const newStateDir = sandboxStateDir(name, paths);
        if (fs.existsSync(newStateDir) || fs.existsSync(newWt)) {
          process.stderr.write(`warning: ${name} exists in both layouts; left as is — resolve it by hand\n`);
          continue;
        }
        const cs = containerState(name);
        if (cs === 'running' && liveSessions(name) > 0) {
          process.stderr.write(`warning: ${name} has a live Claude session; close it and run the launcher again to move it\n`);
          continue;
        }
        if (cs !== 'missing') {
          stopDevStack(name);
          containerRemove(name);
        }
        if (fs.existsSync(oldWt)) {
          fs.mkdirSync(path.dirname(newWt), { recursive: true });
          moveWorktree(oldWt, newWt);
        }
        fs.mkdirSync(path.dirname(newStateDir), { recursive: true });
        fs.renameSync(path.join(legacyStateDir, name), newStateDir);
        const state = readState(name, paths);
        if (state) writeState({ ...state, worktree: newWt }, paths);
        const projects = path.join(paths.claudeHome, 'projects');
        const oldHistory = path.join(projects, slug(legacyContainerWorktree(name, paths)));
        const newHistory = path.join(projects, slug(containerPaths(name, paths).worktree));
        if (fs.existsSync(oldHistory) && !fs.existsSync(newHistory)) fs.renameSync(oldHistory, newHistory);
        process.stdout.write(`moved ${name}: ${oldWt} → ${newWt} (its container is recreated on the next start)\n`);
      } catch (err) {
        process.stderr.write(`warning: could not move ${name}: ${err.message.split('\n')[0]}\n`);
      }
    }
  }, paths);
  tryRmdir(legacyStateDir);
  tryRmdir(legacy);
}
