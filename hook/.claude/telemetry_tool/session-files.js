'use strict';
/**
 * Shared utility — resolve the current session's own log files.
 *
 * Extracted from `prompt-upload-hook.js` so the two narrow-scope upload paths share one
 * implementation:
 *   - `prompt-upload-hook.js`  — the throttled background upload on `UserPromptSubmit`
 *   - `send-logs-hook.js`      — the `SessionEnd` flush (the session's last chance to ship
 *                                its own files; the full multi-session scan stays on
 *                                `Stop`)
 *
 * Scope is deliberately the session's own files:
 *   artisyn    — <telemetryDir>/<sessionId>.jsonl
 *   claude     — ~/.claude/projects/<slug>/<sessionId>.jsonl
 *   tool-calls — <workDir>/tool-wrap/upload/<sessionId>.jsonl, assembled on the spot from the CLI
 *                tool wrapper's per-call files (tool-wrap-records.js); only when the session has
 *                wrapper data
 *
 * `claude-subagent` and `claude-otel` are out of scope here: sub-agent files are discovered by a
 * directory scan that only the full `Stop` run performs, and otel chunk files are collected
 * unfiltered by any session's `Stop` run (every file in the otel dir belongs to this project), so
 * they are not at risk of being stranded by one session ending.
 */

const fs = require('fs');
const path = require('path');
const { claudeConfigDir } = require('./claude-config-dir');

const { getGitRoot, getWorkDirPath } = require('./git-context');

// Upper bound on how much of a transcript `readTranscriptCwd` reads. The `cwd` field appears on
// the first user/assistant line, but a transcript can open with large non-message lines (file
// history snapshots, summaries), so the line budget alone does not bound the read.
const TRANSCRIPT_CWD_MAX_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_CWD_READ_CHUNK = 64 * 1024;

/**
 * Read the working directory a Claude Code transcript was recorded in: the first string `cwd`
 * field among its first `maxLines` lines.
 * @param {string} filePath
 * @param {number} [maxLines]
 * @returns {string|null} the cwd, or null when the file is unreadable or carries none
 */
function readTranscriptCwd(filePath, maxLines = 20) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(TRANSCRIPT_CWD_READ_CHUNK);
    let pending = '';
    let linesSeen = 0;
    let totalRead = 0;
    let eof = false;
    while (linesSeen < maxLines && !eof && totalRead < TRANSCRIPT_CWD_MAX_BYTES) {
      const n = fs.readSync(fd, buf, 0, buf.length, totalRead);
      if (n <= 0) {
        eof = true;
      } else {
        totalRead += n;
        pending += buf.toString('utf8', 0, n);
      }
      const parts = pending.split('\n');
      // The last element is a partial line unless the file has ended.
      pending = eof ? '' : parts.pop();
      for (const line of parts) {
        if (linesSeen >= maxLines) break;
        linesSeen++;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
        } catch {
          // malformed line — keep looking
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Whether `child` is `root` itself or lies inside it. Compares whole path segments (so
 * `/a/repo-b` is not inside `/a/repo`), case-insensitively on win32.
 * @param {string} child
 * @param {string} root
 * @param {string} [platform] defaults to `process.platform`
 * @returns {boolean}
 */
function isPathInside(child, root, platform = process.platform) {
  if (!child || !root) return false;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const toSegments = (value) => {
    let resolved = p.resolve(value);
    if (win) resolved = resolved.toLowerCase();
    return resolved.split(p.sep).filter((s) => s.length > 0);
  };
  const childSegs = toSegments(child);
  const rootSegs = toSegments(root);
  if (rootSegs.length > childSegs.length) return false;
  for (let i = 0; i < rootSegs.length; i++) {
    if (childSegs[i] !== rootSegs[i]) return false;
  }
  return true;
}

/**
 * Whether `dir` is (inside) a linked worktree of the repo whose main checkout is `gitRoot`: walks up
 * to the nearest `.git` and, when it is a file (`gitdir: <path>`), checks the target lies inside
 * `<gitRoot>/.git`. Filesystem reads only — no `git` spawn per transcript.
 * @param {string} dir
 * @param {string} gitRoot
 * @returns {boolean}
 */
function isLinkedWorktreeOf(dir, gitRoot) {
  try {
    let current = path.resolve(dir);
    for (;;) {
      const dotGit = path.join(current, '.git');
      let stat = null;
      try { stat = fs.statSync(dotGit); } catch { /* not here */ }
      if (stat) {
        if (!stat.isFile()) return false;
        const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!match) return false;
        const target = path.resolve(current, match[1].trim());
        return isPathInside(target, path.join(gitRoot, '.git'));
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  } catch {
    return false;
  }
}

/**
 * Find the `~/.claude/projects/<slug>` folders belonging to the repo at `gitRoot`. Claude Code
 * names a project folder by slugifying its cwd (every char outside `[a-zA-Z0-9-]` → `-`). A folder
 * whose name equals the root slug is this repo's. A folder that only starts with `<slug>-` may be a
 * subdirectory of the repo (`root/dist`) — or an unrelated sibling (`root-other`), since the slug is
 * lossy — so it is marked `prefixOnly` and each transcript in it goes through
 * `transcriptBelongsToRepo`. When nothing matches and `fallbackSessionId` is given, the first folder
 * holding `<fallbackSessionId>.jsonl` is used (not prefix-only: it is the current session's own).
 * @param {string} claudeProjectsDir
 * @param {string} gitRoot
 * @param {string|null} [fallbackSessionId]
 * @returns {{ dir: string, prefixOnly: boolean }[]}
 */
function findProjectSlugDirs(claudeProjectsDir, gitRoot, fallbackSessionId = null) {
  const subdirs = fs
    .readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  const gitRootSlug = gitRoot.replace(/[^a-zA-Z0-9-]/g, '-');
  const result = [];
  for (const subdir of subdirs) {
    const name = subdir.name;
    if (name === gitRootSlug) {
      result.push({ dir: path.join(claudeProjectsDir, name), prefixOnly: false });
    } else if (name.startsWith(gitRootSlug + '-')) {
      result.push({ dir: path.join(claudeProjectsDir, name), prefixOnly: true });
    }
  }

  if (result.length === 0 && fallbackSessionId) {
    for (const subdir of subdirs) {
      const candidate = path.join(claudeProjectsDir, subdir.name, `${fallbackSessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        result.push({ dir: path.join(claudeProjectsDir, subdir.name), prefixOnly: false });
        break;
      }
    }
  }
  return result;
}

/**
 * Prefix-folder rule (see `findProjectSlugDirs`): a transcript is kept when its recorded `cwd` is
 * inside `gitRoot` (or inside a linked worktree of it), or when it records no `cwd` at all.
 * @param {string} filePath
 * @param {string} gitRoot
 * @returns {boolean}
 */
function transcriptBelongsToRepo(filePath, gitRoot) {
  const cwd = readTranscriptCwd(filePath);
  if (cwd === null) return true;
  return isPathInside(cwd, gitRoot) || isLinkedWorktreeOf(cwd, gitRoot);
}

/**
 * Resolve exactly the current session's own candidate files — the artisyn telemetry file and
 * the current session's claude transcript file — mirroring send-logs-hook.js's §2.2 project-slug
 * resolution, without the subagent/workflow scan — plus the session's `tool-calls` upload when the
 * CLI tool wrapper recorded anything for it.
 * @param {string|null} cwd
 * @param {string} sessionId
 * @param {string} telemetryDir
 * @returns {{ namespace: 'artisyn'|'claude'|'tool-calls', filePath: string, size: number }[]}
 */
function collectScopedFiles(cwd, sessionId, telemetryDir) {
  const files = [];

  const artisynPath = path.join(telemetryDir, `${sessionId}.jsonl`);
  try {
    const stat = fs.statSync(artisynPath);
    if (stat.isFile() && stat.size > 0) {
      files.push({ namespace: 'artisyn', filePath: artisynPath, size: stat.size });
    }
  } catch {
    // artisyn file not present yet — nothing to upload for this namespace
  }

  const claudeProjectsDir = path.join(claudeConfigDir(), 'projects');
  try {
    // Same slug-matching convention as send-logs-hook.js's §2.2 (shared helper): the exact
    // root-project slug, or any slug prefixed by it (subdirectory projects, filtered per
    // transcript by its recorded cwd), falling back to a scan by current session id when
    // neither matches anything.
    const gitRoot = getGitRoot(cwd || process.cwd());
    const projectSlugDirs = findProjectSlugDirs(claudeProjectsDir, gitRoot, sessionId);

    for (const { dir: projectSlugDir, prefixOnly } of projectSlugDirs) {
      const claudeFilePath = path.join(projectSlugDir, `${sessionId}.jsonl`);
      try {
        const stat = fs.statSync(claudeFilePath);
        if (stat.isFile() && stat.size > 0) {
          if (prefixOnly && !transcriptBelongsToRepo(claudeFilePath, gitRoot)) continue;
          files.push({ namespace: 'claude', filePath: claudeFilePath, size: stat.size });
          break; // exactly one claude transcript file for this session id
        }
      } catch {
        // not under this slug dir — try the next candidate
      }
    }
  } catch {
    // ~/.claude/projects absent — nothing to do for the claude namespace
  }

  // The CLI tool wrapper's records of this session (lazy require, fail-open: a broken tool-wrap
  // module must never stop the artisyn / claude flush).
  try {
    const { assembleToolCallsUpload } = require('./tool-wrap-records');
    const toolCallsPath = assembleToolCallsUpload(getWorkDirPath(cwd), sessionId);
    if (toolCallsPath) {
      const stat = fs.statSync(toolCallsPath);
      if (stat.isFile() && stat.size > 0) {
        files.push({ namespace: 'tool-calls', filePath: toolCallsPath, size: stat.size });
      }
    }
  } catch {
    // no wrapper data for this session, or it could not be assembled — nothing to upload
  }

  return files;
}

module.exports = {
  collectScopedFiles,
  findProjectSlugDirs,
  transcriptBelongsToRepo,
  readTranscriptCwd,
  isPathInside,
};
